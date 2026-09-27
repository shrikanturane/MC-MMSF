import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import * as fs from 'node:fs';
import { PrismaService } from '../../prisma/prisma.service';
import { sysParams, pInt } from '../../system-params';
import {
  DEFAULT_CONSENT,
  auditLine,
  consentSecondsLeft,
  endLine,
  initialState,
  isTerminal,
  mayStream,
  reduce,
  type ConsentConfig,
  type SessionEvent,
  type SessionState,
  type SessionTimes,
} from './consent';
import { arbitrate, type CaptureClaim, type CaptureSource } from './capture-arbiter';
import { verifyTotp } from '../../auth/totp';
import { audioAuditLine, encodeOps, enqueue, inputAuditLine, sanitizeInput, type InputEvent } from './input';
import { savingsPct } from './motion';
import { kbps, profileOf, toQualityMode } from './quality';
import { DEFAULT_FPS } from './fps';
import { Recorder, partFile } from './recorder';
import { decideAgentAuth, REMOTE_AUTH_MIN_AGENT_VERSION, sharedAgentKey } from './agent-auth';
import { DEFAULT_RETENTION, describePlan, planRetention, type RetentionConfig } from './retention';
export { DEFAULT_FPS };

/**
 * Attended remote support — session lifecycle + consent gate (Phase 1: control plane only).
 *
 * The operator asks; the agent acknowledges and reports whether anyone is at the console; the person
 * there accepts, declines, or doesn't answer. Every outcome is persisted, including refusals — the
 * audit question is "who asked to watch this desktop, and what did the user say", and a refusal is the
 * most important answer to keep.
 *
 * Streaming/capture/recording arrive in later phases; this service owns WHETHER a session may stream
 * (see `mayStream`), never the pixels themselves.
 */
@Injectable()
export class RemoteService implements OnModuleInit {
  private readonly log = new Logger('Remote');
  /** Latest frame per session, in memory only. Pixels never touch the app disk un-encoded (Phase 3
   *  adds H.264 + retention); prod has hit 100% disk before and 10fps JPEG is ~500MB per 15 min. */
  private frames = new Map<string, { buf: Buffer; at: number; w: number; h: number }>();
  private recorder = new Recorder(() => this.retention);
  /** Refreshed from System Parameters on the sweep; defaults are the documented ones. */
  private retention: RetentionConfig = { ...DEFAULT_RETENTION };
  /** Which component is currently streaming a session, so two never interleave into one recording.
   *  In memory on purpose: a claim is renewed ~10x/second and must not be a database write. */
  private capture = new Map<string, CaptureClaim>();
  /** Keyboard/mouse waiting to be handed to the target. In memory and short-lived by design: input that
   *  did not reach the desktop within a second or two must be discarded, never replayed later. */
  private inputQ = new Map<string, InputEvent[]>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Advance pending sessions on a timer: a request the agent never answers must expire, and a consent
    // prompt nobody answers must resolve per policy rather than hang forever.
    setInterval(() => void this.tick().catch((e) => this.log.warn(`tick: ${String((e as Error)?.message ?? e)}`)), 5_000);
    // Retention runs hourly AND once shortly after boot: a server that was down while recordings piled
    // up must clean them before it fills its disk, not an hour later.
    setTimeout(() => void this.sweepRecordings().catch(() => undefined), 120_000);
    setInterval(() => void this.sweepRecordings().catch((e) => this.log.warn(`retention: ${String((e as Error)?.message ?? e)}`)), 3_600_000);
  }

  private async cfg(): Promise<ConsentConfig> {
    const p = await sysParams(this.prisma);
    return {
      consentTimeoutSec: pInt(p, 'remoteConsentTimeoutSec', 'REMOTE_CONSENT_TIMEOUT_SEC', DEFAULT_CONSENT.consentTimeoutSec),
      agentAckTimeoutSec: pInt(p, 'remoteAgentAckTimeoutSec', 'REMOTE_AGENT_ACK_TIMEOUT_SEC', DEFAULT_CONSENT.agentAckTimeoutSec),
      // Unattended by default (corporate-managed fleet). Set remoteRequireConsent=1 to restore prompting.
      requireConsent: pInt(p, 'remoteRequireConsent', 'REMOTE_REQUIRE_CONSENT', DEFAULT_CONSENT.requireConsent ? 1 : 0) === 1,
      targetIsServer: DEFAULT_CONSENT.targetIsServer, // overridden per-session in cfgFor() from the target's OS
      maxSessionSec: pInt(p, 'remoteMaxSessionSec', 'REMOTE_MAX_SESSION_SEC', DEFAULT_CONSENT.maxSessionSec),
      idleTimeoutSec: pInt(p, 'remoteIdleTimeoutSec', 'REMOTE_IDLE_TIMEOUT_SEC', DEFAULT_CONSENT.idleTimeoutSec),
      maxConcurrent: pInt(p, 'remoteMaxConcurrent', 'REMOTE_MAX_CONCURRENT', DEFAULT_CONSENT.maxConcurrent),
    };
  }

  /**
   * Per-session consent config: the global tunables PLUS this row's snapshot decision and OS class, so the
   * reducer's no-answer timeout is OS-aware (server → auto-approve, Windows 10/11 client → cancel) and a
   * mid-session settings change can't flip a live session.
   */
  private async cfgFor(row: any): Promise<ConsentConfig> {
    return {
      ...(await this.cfg()),
      requireConsent: !!row.consentRequired,
      targetIsServer: /server/i.test(String(row.targetOsVersion || '')),
    };
  }

  private stateOf(row: any): SessionState {
    return { status: row.status, consent: row.consent, autoAccepted: row.autoAccepted, consentUser: row.consentUser ?? null, endReason: row.endReason ?? '' };
  }
  private timesOf(row: any): SessionTimes {
    return { requestedAt: row.requestedAt, promptedAt: row.promptedAt ?? null, startedAt: row.startedAt ?? null, lastFrameAt: row.lastFrameAt ?? null };
  }

  /** Apply an event through the pure reducer and persist only what actually changed. */
  private async apply(id: string, event: SessionEvent, now = new Date()) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    const before = this.stateOf(row);
    if (isTerminal(before.status)) return row;
    const after = reduce(before, event, this.timesOf(row), now, await this.cfgFor(row));
    if (JSON.stringify(before) === JSON.stringify(after)) return row; // event didn't apply — ignore, don't churn

    const data: any = { status: after.status, consent: after.consent, autoAccepted: after.autoAccepted, consentUser: after.consentUser, endReason: after.endReason };
    if (before.status !== 'awaiting-consent' && after.status === 'awaiting-consent') data.promptedAt = now;
    if (before.status !== 'active' && after.status === 'active') data.startedAt = now;
    if (!isTerminal(before.status) && isTerminal(after.status)) {
      data.endedAt = now;
      const start = row.startedAt ?? row.requestedAt;
      data.durationSec = Math.max(0, Math.round((now.getTime() - start.getTime()) / 1000));
    }
    const saved = await this.prisma.remoteSession.update({ where: { id }, data });
    // Recording follows the consent verdict exactly: it starts only when the session becomes active and
    // is finalised the moment it stops being active. A declined session is never recorded at all.
    if (before.status !== 'active' && after.status === 'active') {
      this.recorder.start(id, DEFAULT_FPS);
      void this.wakeConsoleHelper(id, row.agentId);
    }
    if (!mayStream(after)) {
      this.frames.delete(id); // stop holding pixels the moment streaming is not allowed
      this.capture.delete(id);
      this.inputQ.delete(id); // queued keystrokes must never outlive the session that authorised them
      if (this.recorder.has(id)) {
        void this.recorder.stop(id).then((r) => {
          if (r) return this.prisma.remoteSession.update({ where: { id }, data: { recordingPath: r.files[0], recordingBytes: r.bytes, recordingParts: r.parts } }).catch(() => undefined);
          return undefined;
        });
      }
    }

    // Exactly one audit line per decisive moment, never two for the same fact:
    //  · consent resolved  -> the consent verdict (the line a reviewer actually looks for);
    //  · session finished  -> how it ended (only when the verdict was already logged, or never reached).
    const who = saved.operatorEmail || saved.operatorId || 'unknown';
    const target = saved.targetName || saved.agentId;
    const consentResolved = before.consent !== after.consent;
    const justTerminal = !isTerminal(before.status) && isTerminal(after.status);
    let line = '';
    let severity: 'info' | 'warning' = 'info';
    if (consentResolved) {
      line = auditLine(after, who, target);
      severity = after.consent === 'accepted' ? 'info' : 'warning';
    } else if (justTerminal) {
      line = endLine(after, who, target, data.durationSec ?? null);
      severity = after.status === 'ended' ? 'info' : 'warning';
    }
    if (line) {
      await this.prisma.eventLog.create({ data: { type: 'finding', severity, title: line.slice(0, 500) } }).catch(() => undefined);
    }
    return saved;
  }

  /**
   * Tell the target's SYSTEM service to spawn its console capture helper, now.
   *
   * This rides the agent's existing outbound command channel instead of being polled for, and the reason
   * is latency: the service spends its life parked in a ~35s long-poll, so a flag it had to notice on its
   * own would leave the operator watching a blank viewer for up to half a minute. A queued command makes
   * that long-poll return immediately.
   *
   * Best-effort by design. If it fails, the session still works wherever the tray can see the desktop —
   * the operator just loses the logon/lock screen. It must never throw into a consent transition: a
   * session that is already active must not be un-activated because a command insert failed.
   */
  private async wakeConsoleHelper(id: string, agentId: string) {
    try {
      await this.prisma.agentCommand.create({
        data: { agentId, kind: 'remote-console', payload: { sessionId: id } as any, createdById: '' },
      });
    } catch (e) {
      this.log.warn(`could not wake the console helper for ${id}: ${String((e as Error)?.message ?? e)} — falling back to tray capture`);
    }
  }

  /**
   * Apply the (pure, unit-tested) retention plan to what is actually on disk, and keep the DB honest by
   * clearing recordingPath on rows whose artefact we just deleted — a session that says it has a
   * recording when the file is gone is worse than one that admits it does not.
   */
  private async sweepRecordings() {
    const p = await sysParams(this.prisma);
    this.retention = {
      maxAgeDays: pInt(p, 'remoteRecordingDays', 'REMOTE_RECORDING_DAYS', DEFAULT_RETENTION.maxAgeDays),
      maxTotalMb: pInt(p, 'remoteRecordingTotalMb', 'REMOTE_RECORDING_TOTAL_MB', DEFAULT_RETENTION.maxTotalMb),
      maxSessionMb: pInt(p, 'remoteRecordingSessionMb', 'REMOTE_RECORDING_SESSION_MB', DEFAULT_RETENTION.maxSessionMb),
      maxFileHours: pInt(p, 'remoteRecordingFileHours', 'REMOTE_RECORDING_FILE_HOURS', DEFAULT_RETENTION.maxFileHours),
    };
    const onDisk = this.recorder.listFiles();
    if (!onDisk.length) return;
    // Prefer the session's real endedAt over the file mtime (mtime can be rewritten by a copy/restore).
    const rows = await this.prisma.remoteSession.findMany({ where: { recordingPath: { not: '' } }, select: { id: true, recordingPath: true, endedAt: true } });
    const endedByPath = new Map(rows.map((r) => [r.recordingPath, r.endedAt]));
    const files = onDisk.map((f) => ({ path: f.path, bytes: f.bytes, endedAt: endedByPath.get(f.path) ?? f.mtime }));
    const plan = planRetention(files, new Date(), this.retention);
    if (!plan.delete.length) return;
    for (const victim of plan.delete) {
      if (this.recorder.remove(victim.path)) {
        await this.prisma.remoteSession.updateMany({ where: { recordingPath: victim.path }, data: { recordingPath: '', recordingBytes: 0 } }).catch(() => undefined);
      }
    }
    this.log.log(describePlan(plan));
  }

  /** Drive time-based transitions (ack timeout, consent timeout) for everything still in flight. */
  private async tick() {
    // 'active' is included so the max-duration and idle ceilings are enforced: a live session that
    // nobody ends must not run forever (one was found still active after 167 hours).
    const open = await this.prisma.remoteSession.findMany({ where: { status: { in: ['requested', 'awaiting-consent', 'active'] } }, select: { id: true } });
    for (const s of open) await this.apply(s.id, { type: 'tick' }).catch(() => undefined);
  }

  /**
   * Operator asks to remote a host. Creates the session in `requested` — nothing is shown or captured
   * until the agent acknowledges and (if someone is there) they answer the prompt.
   */
  async request(body: any, user: { sub?: string; email?: string; role?: string }) {
    const agentId = String(body?.agentId || '').trim();
    if (!agentId) throw new BadRequestException('agentId is required');
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('agent not found');
    if (!/^win/i.test(String(agent.os || ''))) {
      throw new BadRequestException('Attended remote support is Windows-only in this release. Use the SSH console for Linux hosts.');
    }
    const reason = String(body?.reason || '').trim().slice(0, 300);
    if (!reason) throw new BadRequestException('A support reason is required — it is recorded in the audit trail.');

    // Access gate: an admin connects directly; any other operator must pass 2FA on THIS connection.
    // Watching (and driving) someone's machine is high-privilege, so a stolen operator session alone is
    // not enough — the second factor is re-checked every time the button is pressed. The verdict is
    // audited either way. No session is created until it passes.
    const target = agent.displayName || agent.hostname || agent.name || agentId;
    if (String(user?.role || '') !== 'admin') {
      const u = user?.sub ? await this.prisma.user.findUnique({ where: { id: String(user.sub) } }) : null;
      if (!u || !u.totpEnabled || !u.totpSecret) {
        throw new BadRequestException('Two-factor authentication must be enabled on your account to start a remote session. Set it up in your profile, then try again.');
      }
      const code = String(body?.twoFactorCode || '').trim();
      if (!verifyTotp(u.totpSecret, code)) {
        await this.prisma.eventLog
          .create({ data: { type: 'finding', severity: 'warning', title: `Remote connect 2FA ${code ? 'FAILED' : 'required'} — ${u.email} → ${target} (${reason})`.slice(0, 500) } })
          .catch(() => undefined);
        // No session created; the UI shows a code field and re-submits.
        return { twoFactorRequired: true, message: code ? 'That code was not valid — check your authenticator and try again.' : 'Enter your 6-digit authenticator code to connect.' } as any;
      }
      await this.prisma.eventLog
        .create({ data: { type: 'finding', severity: 'info', title: `Remote connect 2FA passed — ${u.email} → ${target}`.slice(0, 500) } })
        .catch(() => undefined);
    }

    // One SHARED session per host. If this PC already has a live session, JOIN it rather than starting a
    // new one: the console helper captures a single session, and the media relay fans it out to many
    // viewers — so several admins can watch (and drive) the same screen at once, and reopening after you
    // closed the tab lands you back on the SAME live session instead of a black screen. The viewer cap
    // (default 6) is enforced when the browser connects its media socket.
    const existing = await this.prisma.remoteSession.findFirst({
      where: { agentId, status: { in: ['requested', 'awaiting-consent', 'active'] } },
      orderBy: { requestedAt: 'desc' },
    });
    if (existing) {
      const who = user?.email || user?.sub || 'an administrator';
      await this.prisma.eventLog
        .create({ data: { type: 'finding', severity: 'info', title: `${who} joined the live remote session on ${target}`.slice(0, 500) } })
        .catch(() => undefined);
      this.log.log(`remote join: ${who} → ${target} (session ${existing.id})`);
      return this.view(existing);
    }

    // Refuse the 16th session rather than accept it and let every session degrade. Each live one costs
    // an ffmpeg encoder, so the failure mode without this is not "one session is slow", it is the whole
    // platform stuttering with no indication why.
    const { maxConcurrent } = await this.cfg();
    const live = await this.prisma.remoteSession.count({ where: { status: { in: ['requested', 'awaiting-consent', 'active'] } } });
    if (live >= maxConcurrent) {
      throw new BadRequestException(
        `${live} remote sessions are already open and the limit is ${maxConcurrent}. End one, or raise remoteMaxConcurrent in Settings → System Parameters if this server has the CPU for it.`,
      );
    }

    const s = initialState();
    // Snapshot the global "require the user to accept" policy + the target's OS at request time, so the
    // consent gate is deterministic for this session and the no-answer timeout can be OS-aware.
    const { requireConsent } = await this.cfg();
    const row = await this.prisma.remoteSession.create({
      data: {
        agentId,
        targetName: agent.displayName || agent.hostname || agent.name || agentId,
        operatorId: String(user?.sub || '').slice(0, 200),
        operatorEmail: String(user?.email || '').slice(0, 200),
        reason,
        status: s.status,
        consent: s.consent,
        quality: toQualityMode(body?.quality),
        consentRequired: requireConsent,
        targetOsVersion: String(agent.osVersion || agent.os || ''),
      },
    });
    this.log.log(`remote requested: ${row.operatorEmail || row.operatorId} → ${row.targetName} (${reason})`);
    return this.view(row);
  }

  /**
   * Tray poll: "is anyone asking to remote this box?" Authenticated by the agent's own token (the tray
   * already holds it), never a user session. Returns the oldest unanswered request for this host, or null.
   *
   * The tray is the ONLY component that can ask the person at the desk — it is the one that runs inside
   * the interactive session (the SYSTEM service sits in session 0 and has no desktop to draw on).
   */
  /**
   * The agent-facing session routes (ack / consent / frame) are @Public, so prove the caller IS this
   * session's agent: its own token or the shared key. Without this, whoever holds a session id — every
   * operator who requested one — could answer the consent prompt themselves or ack "nobody at the
   * console" to skip it. Agents older than the build that sends its key stay allowed (logged) until they
   * self-update, unless REMOTE_AGENT_AUTH_STRICT=1.
   */
  private async assertSessionAgent(id: string, key?: string): Promise<void> {
    const row = await this.prisma.remoteSession.findUnique({ where: { id }, select: { agentId: true } });
    if (!row) throw new NotFoundException('remote session not found');
    const agent = await this.prisma.agent.findUnique({ where: { id: row.agentId }, select: { token: true, version: true, hostname: true } as any }) as any;
    const verdict = decideAgentAuth({
      presentedKey: String(key ?? ''),
      sharedKey: sharedAgentKey(),
      agentToken: agent?.token ?? null,
      agentVersion: agent?.version ?? null,
      strict: ['1', 'true', 'yes'].includes(String(process.env.REMOTE_AGENT_AUTH_STRICT ?? '').toLowerCase()),
    });
    if (verdict === 'deny') throw new UnauthorizedException('agent key required for this remote session');
    if (verdict === 'legacy') this.log.warn(`remote ${String(id).slice(0, 8)}: keyless call from pre-${REMOTE_AUTH_MIN_AGENT_VERSION} agent ${agent?.hostname ?? row.agentId} (allowed until it self-updates)`);
  }

  async agentPoll(body: any) {
    const key = String(body?.key || '').trim();
    if (!key) throw new BadRequestException('key is required');
    const agent = await this.prisma.agent.findFirst({ where: { token: key } });
    if (!agent) throw new NotFoundException('unknown agent token');
    const rows = await this.prisma.remoteSession.findMany({
      where: { agentId: agent.id, status: { in: ['requested', 'awaiting-consent', 'active'] } },
      orderBy: { requestedAt: 'asc' },
    });
    const pendingRow = rows.find((r) => r.status !== 'active') ?? null;
    // The agent is told to capture ONLY for sessions the server has already flipped to active — i.e.
    // consent resolved. The agent never decides for itself that it may stream.
    const activeRow = rows.find((r) => r.status === 'active') ?? null;
    const activeProfile = activeRow ? profileOf(activeRow.quality) : null;
    return {
      pending: pendingRow
        ? {
            id: pendingRow.id,
            operator: pendingRow.operatorEmail || pendingRow.operatorId || 'an administrator',
            reason: pendingRow.reason,
            status: pendingRow.status,
            consentSecondsLeft: consentSecondsLeft(this.stateOf(pendingRow), this.timesOf(pendingRow), new Date(), DEFAULT_CONSENT),
          }
        : null,
      // The agent gets the whole profile so it can set frame rate, JPEG quality and downscale in one
      // step; it never has to know what a mode name means.
      active: activeRow ? { id: activeRow.id, fps: activeProfile!.fps, jpegQuality: activeProfile!.jpegQuality, maxHeight: activeProfile!.maxHeight, quality: activeProfile!.mode } : null,
    };
  }

  /**
   * A captured frame from the target, arriving over HTTP POST. Thin wrapper: decode the base64 JPEG and
   * hand the raw buffer to the shared frame core. The WebSocket media transport (media.hub.ts) calls the
   * same core with the binary frame directly, so both paths enforce consent, record, and return the same
   * control reply — the only difference is how the bytes arrive.
   */
  async ingestFrame(id: string, body: any, key?: string) {
    await this.assertSessionAgent(id, key);
    const b64 = String(body?.jpeg || '');
    if (!b64) throw new BadRequestException('jpeg (base64) is required');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new BadRequestException('empty frame');
    return this.handleFrame(id, buf, { w: Number(body?.w) || 0, h: Number(body?.h) || 0, skipped: Number(body?.skipped) || 0, source: body?.source === 'console' ? 'console' : 'tray' });
  }

  /**
   * The shared frame core, transport-agnostic. Enforces the consent gate at the point pixels actually
   * arrive (a session that isn't active drops the frame and tells the agent to stop), arbitrates the two
   * possible capturers, records to disk, counts, and returns the control reply the agent applies within
   * one frame: queued keyboard/mouse, the live quality profile, and whether two-way audio is enabled.
   *
   * Returns `ok:false, stop:true` to tell the capturer to stop — this is how a declined/ended session
   * halts capture on the target, over either transport.
   */
  async handleFrame(id: string, buf: Buffer, meta: { w: number; h: number; skipped: number; source: CaptureSource }): Promise<{ ok: boolean; stop: boolean; handover?: boolean; reason?: string; input?: number[]; q?: any; audio?: boolean }> {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) return { ok: false, stop: true, reason: 'remote session not found' };
    if (!mayStream(this.stateOf(row))) {
      // Never store pixels for a session that isn't active (declined/ended/expired/awaiting consent).
      return { ok: false, stop: true, reason: `session is ${row.status} — capture must stop` };
    }
    // Two capturers can be alive at once (the SYSTEM console helper and the tray). Let exactly one in:
    // interleaved frames make the viewer flicker between desktops and make the recording play double-speed.
    const source = meta.source;
    const now = Date.now();
    const verdict = arbitrate(this.capture.get(id), source, now);
    if (!verdict.accept) {
      // handover=true tells the loser to stop for good rather than restart its capture every few seconds.
      return { ok: false, stop: true, handover: true, reason: verdict.reason };
    }
    if (verdict.handover) {
      this.log.log(`session ${id}: capture handed to ${source} (${verdict.reason})`);
      await this.prisma.remoteSession.update({ where: { id }, data: { captureSource: source } }).catch(() => undefined);
    } else if (!this.capture.has(id)) {
      await this.prisma.remoteSession.update({ where: { id }, data: { captureSource: source } }).catch(() => undefined);
    }
    this.capture.set(id, verdict.claim!);

    if (!buf.length) return { ok: false, stop: false, reason: 'empty frame' };
    this.frames.set(id, { buf, at: now, w: meta.w, h: meta.h });
    this.recorder.write(id, buf); // H.264, never raw frames on disk
    // The target suppresses grabs whose pixels are identical to the previous one and tells us how many
    // it skipped. Recording that count is what lets the storage panel state a MEASURED saving rather
    // than an estimate.
    const skipped = Math.max(0, Math.min(1000, Math.floor(meta.skipped || 0)));
    // lastFrameAt drives the idle ceiling: without it an abandoned session looks alive forever.
    await this.prisma.remoteSession
      .update({ where: { id }, data: { frames: { increment: 1 }, lastFrameAt: new Date(now), bytesReceived: { increment: BigInt(buf.length) }, ...(skipped ? { framesSkipped: { increment: skipped } } : {}) } })
      .catch(() => undefined);

    // Hand back any queued keyboard/mouse on the frame response rather than making the target poll a
    // second endpoint. `inputEnabled` is re-read from the row here, so revoking control takes effect on
    // the very next frame even if the operator's browser keeps sending.
    let ops: number[] = [];
    if (row.inputEnabled) {
      const q = this.inputQ.get(id);
      if (q && q.length) {
        this.inputQ.set(id, []);
        ops = encodeOps(q);
      }
    } else if (this.inputQ.has(id)) {
      this.inputQ.delete(id);
    }
    // Carry the live quality profile + audio flag back on the frame response. The agent learns fps/quality
    // and whether to run two-way audio here, within one frame, instead of from a blocking side-poll.
    const prof = profileOf(row.quality);
    return { ok: true, stop: false, input: ops, q: { fps: prof.fps, jpegQuality: prof.jpegQuality, maxHeight: prof.maxHeight, quality: prof.mode }, audio: (row as any).audioEnabled === true };
  }

  /**
   * Turn keyboard/mouse control on or off for a live session.
   *
   * Kept apart from consent on purpose: agreeing to be watched is not agreeing to have someone type on
   * your machine. The flip is written to the audit trail either way, and any input already queued is
   * dropped when control is withdrawn so nothing lands after the operator gave it up.
   */
  async setInput(id: string, enabled: boolean, user: { sub?: string; email?: string }) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    if (row.status !== 'active') throw new BadRequestException(`session is ${row.status} — keyboard and mouse can only be handed over while it is active`);
    if (row.inputEnabled === enabled) return this.view(row);
    const saved = await this.prisma.remoteSession.update({ where: { id }, data: { inputEnabled: enabled } });
    if (!enabled) this.inputQ.delete(id);
    const who = user?.email || user?.sub || row.operatorEmail || 'unknown';
    const line = inputAuditLine(enabled, who, saved.targetName || saved.agentId);
    this.log.log(line);
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: enabled ? 'warning' : 'info', title: line.slice(0, 500) } })
      .catch(() => undefined);
    return this.view(saved);
  }

  /**
   * Turn two-way audio on or off for a live session.
   *
   * Mirrors setInput exactly and for the same reason: agreeing to be watched — or even typed on — is not
   * agreeing to have your microphone and speakers shared with a support engineer. Off until an operator
   * turns it on, audited both ways, and the agent stops capturing/playing the instant this goes false
   * (it re-reads the flag on every frame reply, so revocation lands within one frame).
   */
  async setAudio(id: string, enabled: boolean, user: { sub?: string; email?: string }) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    if (row.status !== 'active') throw new BadRequestException(`session is ${row.status} — audio can only be shared while it is active`);
    if (row.audioEnabled === enabled) return this.view(row);
    const saved = await this.prisma.remoteSession.update({ where: { id }, data: { audioEnabled: enabled } });
    const who = user?.email || user?.sub || row.operatorEmail || 'unknown';
    const line = audioAuditLine(enabled, who, saved.targetName || saved.agentId);
    this.log.log(line);
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: enabled ? 'warning' : 'info', title: line.slice(0, 500) } })
      .catch(() => undefined);
    return this.view(saved);
  }

  /**
   * Start or stop recording without ending the session.
   *
   * Deliberately a separate, audited action rather than a silent preference: a support session that is
   * NOT being recorded is a different thing from one that is, and the trail has to say when it stopped
   * and who stopped it. Resuming opens a new part, so a gap shows up as a part boundary instead of
   * being spliced invisibly into the middle of a file.
   */
  async setRecording(id: string, on: boolean, user: { sub?: string; email?: string }) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    if (row.status !== 'active') throw new BadRequestException(`session is ${row.status} — recording can only be changed while it is active`);
    if (row.recording === on) return this.view(row);
    if (on) {
      if (!this.recorder.resume(id) && !this.recorder.has(id)) this.recorder.start(id, DEFAULT_FPS);
    } else {
      await this.recorder.pause(id);
    }
    const saved = await this.prisma.remoteSession.update({ where: { id }, data: { recording: on } });
    const who = user?.email || user?.sub || row.operatorEmail || 'unknown';
    const target = saved.targetName || saved.agentId;
    const line = on
      ? `Remote session recording RESUMED by ${who} on ${target}`
      : `Remote session recording STOPPED by ${who} on ${target} — the rest of this session is not being recorded`;
    this.log.log(line);
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: on ? 'info' : 'warning', title: line.slice(0, 500) } })
      .catch(() => undefined);
    return this.view(saved);
  }

  /**
   * Change the console quality mode mid-session. Takes effect on the agent's next poll (~1s), so the
   * operator can dial bandwidth down the moment a link starts to struggle without dropping the session.
   */
  async setQuality(id: string, mode: unknown) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    if (row.status !== 'active') throw new BadRequestException(`session is ${row.status} — quality can only be changed while it is active`);
    const q = toQualityMode(mode);
    if (row.quality === q) return this.view(row);
    const saved = await this.prisma.remoteSession.update({ where: { id }, data: { quality: q } });
    this.log.log(`remote session ${id} quality -> ${q}`);
    return this.view(saved);
  }

  /**
   * Queue a batch of operator keyboard/mouse for the target. Refused unless the session is active AND
   * control is on — the UI hides the option, but the UI is not the control.
   */
  async queueInput(id: string, body: any) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    if (!mayStream(this.stateOf(row))) throw new BadRequestException(`session is ${row.status} — input is not accepted`);
    if (!row.inputEnabled) throw new BadRequestException('keyboard and mouse control is not enabled for this session');
    const events = sanitizeInput(body?.events);
    if (!events.length) return { ok: true, queued: 0 };
    this.inputQ.set(id, enqueue(this.inputQ.get(id) ?? [], events));
    await this.prisma.remoteSession.update({ where: { id }, data: { inputEvents: { increment: events.length } } }).catch(() => undefined);
    return { ok: true, queued: events.length };
  }

  /**
   * Stream ONE part of a finished recording to an admin. A session is segmented into fixed-size parts,
   * so `part` selects which (1-based, defaults to the first). Missing artefacts are reported honestly
   * rather than as an empty file.
   */
  async streamRecording(id: string, req: any, res: any, part = 1, download = false) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    if (!row.recordingPath) { res.status(404).json({ message: 'no recording for this session (it may have been declined, or retention removed it)' }); return; }
    const total = Math.max(1, row.recordingParts || 1);
    const n = Math.min(Math.max(1, Math.floor(part) || 1), total);
    // Older rows (pre-segmentation) stored a single <id>.mp4 — fall back to recordingPath for part 1.
    const file = row.recordingParts > 0 ? partFile(id, n) : row.recordingPath;
    if (!fs.existsSync(file)) {
      res.status(410).json({ message: `part ${n} of ${total} has been deleted by the retention policy` });
      return;
    }
    const size = fs.statSync(file).size;
    const name = `remote-${row.targetName || id}-part${n}.mp4`.replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'video/mp4');
    // Range support is not optional for <video>: Chrome/Safari issue a Range request to probe the file
    // and to seek, and a server that ignores it and streams the whole body back with a 200 leaves the
    // player unable to scrub -- and on Safari, often unable to start at all. Advertising byte ranges is
    // what makes the recording actually play in the browser rather than only download.
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`);

    const range = String(req?.headers?.range || '');
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m && !download) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
  }

  /**
   * Every session that has a recording on disk, newest first — the library an operator browses to
   * watch a past session back.
   *
   * Each part is checked against the filesystem rather than trusted from the row: retention deletes
   * files on its own schedule, and offering a play button for a video that is gone is worse than
   * saying plainly that it has aged out.
   */
  async recordings(limit = 100) {
    const rows = await this.prisma.remoteSession.findMany({
      where: { NOT: { recordingPath: '' } },
      orderBy: { requestedAt: 'desc' },
      take: Math.min(Math.max(Number(limit) || 100, 1), 500),
    });
    return rows.map((r) => {
      const total = Math.max(1, r.recordingParts || 1);
      const parts = [] as { part: number; bytes: number; missing: boolean }[];
      for (let i = 1; i <= total; i += 1) {
        const f = r.recordingParts > 0 ? partFile(r.id, i) : r.recordingPath;
        let bytes = 0;
        try { bytes = fs.statSync(f).size; } catch { bytes = 0; }
        parts.push({ part: i, bytes, missing: bytes === 0 });
      }
      const available = parts.filter((p) => !p.missing);
      return {
        id: r.id,
        targetName: r.targetName,
        operatorEmail: r.operatorEmail,
        reason: r.reason,
        startedAt: (r.startedAt ?? r.requestedAt).toISOString(),
        endedAt: r.endedAt ? r.endedAt.toISOString() : null,
        durationSec: r.durationSec,
        frames: r.frames,
        consent: r.consent,
        inputEnabled: r.inputEnabled,
        parts,
        partsAvailable: available.length,
        bytes: available.reduce((a, p) => a + p.bytes, 0),
        // Nothing left on disk: the row is kept for the audit trail, the video is not.
        expired: available.length === 0,
      };
    });
  }

  /** What recordings are costing on disk — powers the storage panel. */
  storageUsage() {
    const u = this.recorder.usage();
    return {
      files: u.files,
      bytes: u.bytes,
      mb: Math.round((u.bytes / 1048576) * 10) / 10,
      oldest: u.oldest ? u.oldest.toISOString() : null,
      retention: this.retention,
    };
  }

  /**
   * Clear recording storage. `olderThanDays` clears only what is older than that; omit it to clear
   * everything. Rows are updated to match so a session never claims a recording that is gone — the
   * mismatch that left a 538MB orphan on disk referenced by nothing.
   */
  async clearStorage(olderThanDays?: number) {
    const files = this.recorder.listFiles();
    const cutoff = olderThanDays && olderThanDays > 0 ? Date.now() - olderThanDays * 86_400_000 : null;
    const doomed = cutoff === null ? files : files.filter((f) => f.mtime.getTime() < cutoff);
    let freed = 0;
    let removed = 0;
    for (const f of doomed) {
      if (this.recorder.remove(f.path)) { removed += 1; freed += f.bytes; }
    }
    // Any row whose first part no longer exists must stop advertising a recording.
    const rows = await this.prisma.remoteSession.findMany({ where: { NOT: { recordingPath: '' } }, select: { id: true, recordingPath: true } });
    let cleared = 0;
    for (const r of rows) {
      if (!fs.existsSync(r.recordingPath)) {
        await this.prisma.remoteSession.update({ where: { id: r.id }, data: { recordingPath: '', recordingBytes: 0, recordingParts: 0 } }).catch(() => undefined);
        cleared += 1;
      }
    }
    const detail = `Cleared ${removed} recording file(s), freeing ${(freed / 1048576).toFixed(1)} MB${olderThanDays ? ` (older than ${olderThanDays} days)` : ''}; ${cleared} session row(s) updated.`;
    this.log.log(detail);
    await this.prisma.eventLog.create({ data: { type: 'finding', severity: 'info', title: `Remote-support recording storage cleared — ${detail}`.slice(0, 500) } }).catch(() => undefined);
    return { ok: true, removed, freedBytes: freed, freedMb: Math.round((freed / 1048576) * 10) / 10, rowsCleared: cleared, detail };
  }

  /**
   * Clear ONE session's recording — every part — and stop the row advertising a video. Lets an admin
   * tidy up a single session straight from the Recorded-sessions list instead of clearing by age/all.
   */
  async clearSessionRecording(id: string) {
    const row = await this.prisma.remoteSession.findUnique({
      where: { id },
      select: { id: true, recordingPath: true, recordingParts: true, targetName: true },
    });
    if (!row) throw new NotFoundException('remote session not found');
    const total = Math.max(1, row.recordingParts || 1);
    let freed = 0;
    let removed = 0;
    for (let i = 1; i <= total; i += 1) {
      const f = row.recordingParts > 0 ? partFile(row.id, i) : row.recordingPath;
      if (!f) continue;
      let bytes = 0;
      try { bytes = fs.statSync(f).size; } catch { bytes = 0; }
      if (this.recorder.remove(f)) { removed += 1; freed += bytes; }
    }
    await this.prisma.remoteSession
      .update({ where: { id }, data: { recordingPath: '', recordingBytes: 0, recordingParts: 0 } })
      .catch(() => undefined);
    const detail = `Cleared the recording for the ${row.targetName} session (${removed} file(s), ${(freed / 1048576).toFixed(1)} MB).`;
    this.log.log(detail);
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: 'info', title: `Remote-support recording cleared — ${detail}`.slice(0, 500) } })
      .catch(() => undefined);
    return { ok: true, removed, freedBytes: freed, freedMb: Math.round((freed / 1048576) * 10) / 10, detail };
  }

  /** Latest frame for the viewer (Phase 4 renders these; kept in memory, never on the app disk). */
  latestFrame(id: string): { buf: Buffer; at: number; w: number; h: number } | null {
    return this.frames.get(id) ?? null;
  }

  /** Agent acknowledges and reports who (if anyone) is at the console. Drives prompt-vs-proceed. */
  async agentAck(id: string, body: any, key?: string) {
    await this.assertSessionAgent(id, key);
    const interactiveUser = String(body?.interactiveUser || '').trim() || null;
    const row = await this.apply(id, { type: 'agent-ack', interactiveUser });
    return this.view(row);
  }

  /** The person at the console answered. */
  async consentAnswer(id: string, body: any, key?: string) {
    await this.assertSessionAgent(id, key);
    const accept = body?.accept === true;
    const user = String(body?.user || '').trim() || undefined;
    const row = await this.apply(id, accept ? { type: 'user-accept', user } : { type: 'user-decline', user });
    return this.view(row);
  }

  async end(id: string) {
    return this.view(await this.apply(id, { type: 'operator-end' }));
  }

  async agentLost(id: string, detail?: string) {
    return this.view(await this.apply(id, { type: 'agent-lost', detail }));
  }

  async get(id: string) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('remote session not found');
    return this.view(row);
  }

  /** Session history — newest first. Optional filters mirror the anomaly/insights query style. */
  async list(q: { agentId?: string; status?: string; limit?: number }) {
    const where: any = {};
    if (q.agentId) where.agentId = q.agentId;
    if (q.status && ['requested', 'awaiting-consent', 'active', 'ended', 'declined', 'expired', 'failed'].includes(q.status)) where.status = q.status;
    const rows = await this.prisma.remoteSession.findMany({ where, orderBy: { requestedAt: 'desc' }, take: Math.min(Math.max(Number(q.limit) || 100, 1), 500) });
    return rows.map((r) => this.view(r));
  }

  private view(row: any) {
    const secondsLeft = consentSecondsLeft(this.stateOf(row), this.timesOf(row), new Date(), DEFAULT_CONSENT);
    return {
      ...row,
      consentSecondsLeft: secondsLeft,
      // Server → auto-approves on the no-answer timeout; Windows 10/11 client → the request is cancelled.
      // Lets the operator UI word the wait ("cancels in Ns" vs "starts automatically in Ns").
      targetIsServer: /server/i.test(String(row.targetOsVersion || '')),
      mayStream: row.status === 'active',
      // Measured, not estimated: frames the target never had to send because the screen was unchanged.
      motionSavingsPct: savingsPct(row.frames ?? 0, row.framesSkipped ?? 0),
      quality: toQualityMode(row.quality),
      // Live throughput over the whole active window. BigInt -> number for JSON; a support recording is
      // nowhere near 2^53 bytes, so the conversion is safe.
      bytesReceived: Number(row.bytesReceived ?? 0),
      bandwidthKbps: row.startedAt ? kbps(Number(row.bytesReceived ?? 0), Date.now() - new Date(row.startedAt).getTime()) : 0,
    };
  }
}
