import { Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RemoteService } from './remote.service';
import { verifyJwt } from '../../auth/jwt';

/**
 * Persistent WebSocket media relay for attended remote support.
 *
 * The old transport sent ONE JPEG per HTTPS POST; a probe on real hardware showed a single round-trip
 * costs ~105 ms of connection/TLS setup, which capped the frame rate at a few fps no matter how the
 * capture code was tuned. This replaces that with one long-lived socket per side: the agent dials in
 * (pure outbound, like the console tunnel) and pushes frames; the operator's browser dials in and
 * receives them. Removing the per-frame handshake is what makes the video smooth AND makes real-time
 * two-way audio possible at all.
 *
 * Wire format — every media message is BINARY with a 1-byte channel tag:
 *   'V' (0x56) video  : [tag][w u16le][h u16le][skipped u16le][jpeg...]   agent -> viewers
 *   'A' (0x41) audio  : [tag][pcm16le mono...]                            agent -> viewers  (Phase 2)
 *   'D' (0x44) audio  : [tag][pcm16le mono...]                            viewer -> agent   (Phase 2)
 * Control travels as TEXT JSON: the hub replies to each video frame with { stop, input, q, audio } —
 * exactly the reply the HTTP frame path returned, so input/quality/audio-enable keep working unchanged.
 *
 * The hub is deliberately a dumb per-session pipe (modelled on AgentTunnelHub): it broadcasts every agent
 * binary to the viewers and forwards every viewer binary to the agent, and only the video tag triggers
 * the record/count/reply side-effect (via RemoteService.handleFrame). That is why Phase 2 audio needs no
 * changes here — the audio tags ride the same relay.
 */

const TAG_VIDEO = 0x56; // 'V'
/** How many admins may watch/drive one shared session at once. */
const MAX_VIEWERS = 6;
/** Grace period after the last viewer leaves before the session is ended (survives a reconnect/tab
 *  refresh, but stops the capture + recording once nobody is actually watching). */
const EMPTY_GRACE_MS = 45_000;

interface MediaSession {
  agentWs: any | null;
  viewers: Set<any>;
  sweep: NodeJS.Timeout | null;
  hadViewer: boolean;        // at least one viewer has connected — arms the auto-end-when-empty
  emptyTimer: NodeJS.Timeout | null;
}

/** Shared agent key — same source AgentTunnelHub uses, so the agent presents one credential everywhere. */
function sharedAgentKey(): string {
  return (process.env.AGENT_KEY || String(process.env.APP_ENCRYPTION_KEY || '').slice(0, 24)).trim();
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length > 0 && ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Injectable()
export class RemoteMediaHub {
  private readonly log = new Logger('RemoteMedia');
  private sessions = new Map<string, MediaSession>();
  /** Above this queued-bytes level a viewer is falling behind: drop its video frames rather than grow
   *  the socket buffer without bound (a slow operator link must not balloon server memory). */
  private static readonly VIEWER_BACKPRESSURE = 4 * 1024 * 1024;

  constructor(private readonly prisma: PrismaService, private readonly remote: RemoteService) {}

  private slot(id: string): MediaSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = { agentWs: null, viewers: new Set(), sweep: null, hadViewer: false, emptyTimer: null };
      // Drop the whole session slot once nobody is attached, so the map cannot leak.
      s.sweep = setInterval(() => {
        const cur = this.sessions.get(id);
        if (!cur) return;
        if (!cur.agentWs && cur.viewers.size === 0) this.drop(id);
      }, 30_000);
      this.sessions.set(id, s);
    }
    return s;
  }

  private drop(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    if (s.sweep) { try { clearInterval(s.sweep); } catch { /* */ } }
    if (s.emptyTimer) { try { clearTimeout(s.emptyTimer); } catch { /* */ } }
    try { s.agentWs?.close(); } catch { /* */ }
    for (const v of s.viewers) { try { v.close(); } catch { /* */ } }
  }

  /** Does this key authorise acting as the given agent? Accepts the shared agent key or the agent's own
   *  per-agent token — the same two credentials every other agent-facing route accepts. */
  private async agentAuthorized(agentId: string, key: string): Promise<boolean> {
    const k = String(key || '').trim();
    if (!k) return false;
    if (safeEq(k, sharedAgentKey())) return true;
    const agent = await this.prisma.agent.findFirst({ where: { token: k }, select: { id: true } });
    return !!agent && agent.id === agentId;
  }

  // ── agent side ─────────────────────────────────────────────────────────────
  /** The target's agent dialled its outbound media socket for this session. */
  async attachAgent(id: string, key: string, ws: any) {
    const row = await this.prisma.remoteSession.findUnique({ where: { id }, select: { id: true, agentId: true, status: true } });
    if (!row) { this.log.warn(`media/agent: unknown session ${String(id).slice(0, 8)}`); try { ws.close(); } catch { /* */ } return; }
    if (!(await this.agentAuthorized(row.agentId, key))) { this.log.warn(`media/agent: bad key for ${String(id).slice(0, 8)}`); try { ws.close(); } catch { /* */ } return; }
    const s = this.slot(id);
    // One agent socket per session; a reconnect supersedes the old one.
    if (s.agentWs && s.agentWs !== ws) { try { s.agentWs.close(); } catch { /* */ } }
    s.agentWs = ws;
    this.log.log(`media/agent attached ${String(id).slice(0, 8)} (${s.viewers.size} viewer(s))`);

    ws.on('message', (data: any, isBinary?: boolean) => {
      // 'ws' passes a Buffer; text control frames (chat / fs-list / file.end) arrive as non-binary.
      const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (isBinary === false) { this.onAgentText(id, buf.toString('utf8')); return; }
      if (!buf.length) return;
      if (buf[0] === TAG_VIDEO) { void this.onVideo(id, buf, ws); }
      // Broadcast EVERY agent binary (video + audio-up + file-download chunks) to the viewers unchanged.
      this.broadcast(id, buf, buf[0] === TAG_VIDEO);
    });
    ws.on('close', () => { const cur = this.sessions.get(id); if (cur && cur.agentWs === ws) cur.agentWs = null; });
    ws.on('error', () => { try { ws.close(); } catch { /* */ } });
  }

  /** Run the record/count side-effect for a video frame and reply to the agent with the control JSON
   *  (queued input, live quality profile, audio-enabled) — the same reply the HTTP frame path gave. */
  private async onVideo(id: string, buf: Buffer, ws: any) {
    // Header: [tag][w u16le][h u16le][skipped u16le][jpeg...]
    if (buf.length < 7) return;
    const w = buf.readUInt16LE(1);
    const h = buf.readUInt16LE(3);
    const skipped = buf.readUInt16LE(5);
    const jpeg = buf.subarray(7);
    let reply: any;
    try {
      reply = await this.remote.handleFrame(id, jpeg, { w, h, skipped, source: 'console' });
    } catch (e) {
      reply = { ok: false, stop: false, reason: String((e as Error)?.message ?? e) };
    }
    try { ws.send(JSON.stringify({ t: 'ctrl', stop: !!reply.stop, input: reply.input ?? [], q: reply.q ?? null, audio: reply.audio === true })); } catch { /* */ }
    if (reply.stop) { try { ws.close(); } catch { /* */ } }
  }

  private broadcast(id: string, buf: Buffer, isVideo: boolean) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const v of s.viewers) {
      try {
        // Shed video (never audio) to a viewer that is falling behind, so one slow link cannot grow the
        // server's socket buffers without bound.
        if (isVideo && (v.bufferedAmount || 0) > RemoteMediaHub.VIEWER_BACKPRESSURE) continue;
        v.send(buf);
      } catch { /* */ }
    }
  }

  // ── viewer side ────────────────────────────────────────────────────────────
  /** The operator's browser dialled its media socket. It must send an auth message first (JWT in the WS
   *  body, never the URL — a token in a query string leaks into logs) before it is wired to the relay. */
  async attachViewer(id: string, ws: any) {
    let authed = false;
    const s = this.slot(id);

    const wire = () => {
      s.viewers.add(ws);
      s.hadViewer = true;
      if (s.emptyTimer) { clearTimeout(s.emptyTimer); s.emptyTimer = null; } // a viewer is back before the grace expired
      ws.on('close', () => this.onViewerGone(id, ws));
      ws.on('error', () => { try { ws.close(); } catch { /* */ } });
    };

    ws.on('message', async (data: any, isBinary?: boolean) => {
      if (!authed) {
        // First message must be the auth handshake (text JSON with a bearer token).
        try {
          const msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
          if (msg?.t !== 'auth') { ws.close(); return; }
          const payload = (await verifyJwt(String(msg.token || ''))) as any; // await: sync in repo, async (jose) on deployed
          if (!payload || (payload.role !== 'admin' && payload.role !== 'operator') || payload.scope === '2fa') { ws.close(); return; }
          const row = await this.prisma.remoteSession.findUnique({ where: { id }, select: { id: true } });
          if (!row) { ws.close(); return; }
          // Cap concurrent admins on one shared session.
          if (s.viewers.size >= MAX_VIEWERS) {
            try { ws.send(JSON.stringify({ t: 'error', message: `This session already has the maximum of ${MAX_VIEWERS} viewers watching.` })); } catch { /* */ }
            ws.close(); return;
          }
          authed = true;
          wire();
          try { ws.send(JSON.stringify({ t: 'ready' })); } catch { /* */ }
        } catch { try { ws.close(); } catch { /* */ } }
        return;
      }
      // Post-auth. TEXT = a control request for the agent: chat / fs.list / file.get / file.put /
      // file.end. BINARY = admin audio ('D') or a file-upload chunk ('F'), both destined for the agent.
      const cur = this.sessions.get(id);
      if (isBinary === false) {
        const str = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        if (cur?.agentWs) { try { cur.agentWs.send(str); } catch { /* */ } }
        // Audit operator-initiated chat / file offers so the trail is complete (auditFile covers completed transfers).
        try {
          const m = JSON.parse(str);
          if (m?.t === 'chat') void this.auditEvent(id, `chat → user: "${String(m.text ?? '').slice(0, 200)}"`);
          else if (m?.t === 'chat.file') void this.auditEvent(id, `offered ${m.kind === 'folder' ? 'folder' : 'file'} "${String(m.name ?? '').slice(0, 200)}" (${Number(m.size) || 0} bytes) — waiting for the user to Download`);
        } catch { /* not JSON / nothing to audit */ }
        return;
      }
      const buf: Buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!buf.length) return;
      if (cur?.agentWs) { try { cur.agentWs.send(buf); } catch { /* */ } }
    });

    // A viewer that never authenticates is dropped so it cannot sit half-open.
    setTimeout(() => { if (!authed) { try { ws.close(); } catch { /* */ } } }, 10_000);
  }

  /** A viewer disconnected. When the LAST one leaves, end the session after a grace period — a tab
   *  refresh or brief drop reconnects within it, but a genuinely abandoned session stops capturing and
   *  recording (this is also what keeps a session from lingering "active" forever and black-screening
   *  the next connection, now that new connections JOIN rather than supersede). */
  private onViewerGone(id: string, ws: any) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.viewers.delete(ws);
    if (s.viewers.size > 0 || !s.hadViewer || s.emptyTimer) return;
    s.emptyTimer = setTimeout(() => {
      const cur = this.sessions.get(id);
      if (cur) cur.emptyTimer = null;
      if (cur && cur.viewers.size === 0) void this.remote.end(id).catch(() => undefined);
    }, EMPTY_GRACE_MS);
  }

  /** A text control frame from the agent (chat reply, fs listing, file.end). Broadcast it to the viewers,
   *  stamping chat direction, and audit completed file transfers (who moved what, to/from this host). */
  private onAgentText(id: string, str: string) {
    let msg: any;
    try { msg = JSON.parse(str); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;
    if (msg.t === 'chat') { void this.auditEvent(id, `chat ← user: "${String(msg.text ?? '').slice(0, 200)}"`); this.broadcastText(id, JSON.stringify({ t: 'chat', from: 'user', text: String(msg.text ?? '').slice(0, 4000) })); return; }
    if (msg.t === 'file.pull') void this.auditEvent(id, `user accepted the file offer, saving to ${String(msg.path ?? '').slice(0, 300)}`);
    if (msg.t === 'file.end') void this.auditFile(id, msg);
    // fs listings, file.end, transfer progress — forward verbatim to the operator's browser.
    this.broadcastText(id, str);
  }

  /** Audit a remote-support activity (chat, offer, download choice) to the event log for the audit trail. */
  private async auditEvent(id: string, what: string, severity: 'info' | 'warning' = 'info') {
    try {
      const row = await this.prisma.remoteSession.findUnique({ where: { id }, select: { operatorEmail: true, operatorId: true, targetName: true, agentId: true } });
      const who = row?.operatorEmail || row?.operatorId || 'operator';
      const target = row?.targetName || row?.agentId || id;
      await this.prisma.eventLog.create({ data: { type: 'finding', severity, title: `Remote ${target} · ${who}: ${what}`.slice(0, 500) } }).catch(() => undefined);
    } catch { /* audit is best-effort — never break the relay */ }
  }

  private broadcastText(id: string, str: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const v of s.viewers) { try { v.send(str); } catch { /* */ } }
  }

  /** Audit a completed file transfer — a security-relevant fact (a file left or entered this desktop). */
  private async auditFile(id: string, msg: any) {
    try {
      const row = await this.prisma.remoteSession.findUnique({ where: { id }, select: { operatorEmail: true, operatorId: true, targetName: true, agentId: true } });
      if (!row) return;
      const who = row.operatorEmail || row.operatorId || 'operator';
      const target = row.targetName || row.agentId;
      const dir = msg.dir === 'up' ? 'UPLOADED to' : 'DOWNLOADED from';
      const bytes = Number(msg.bytes) || 0;
      const ok = msg.ok !== false;
      const line = `Remote file ${dir} ${target} by ${who}: ${String(msg.path ?? '').slice(0, 300)} (${bytes} bytes)${ok ? '' : ' — FAILED'}`;
      await this.prisma.eventLog.create({ data: { type: 'finding', severity: 'warning', title: line.slice(0, 500) } }).catch(() => undefined);
    } catch { /* */ }
  }
}
