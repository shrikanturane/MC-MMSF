import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sendMail } from '../../mail/mailer';
import { sysParams, pInt } from '../../system-params';
import { classifyEnvironment } from '../policies/policies.service';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptJson } from '../../connectors/crypto';
import { cleanCreds } from '../../connectors/adapter';
import { getConnector } from '../../connectors/factory';
import { AzureMetrics } from '../../connectors/azure.metrics';
import { AwsMetrics } from '../../connectors/aws.metrics';
import { GcpMetrics } from '../../connectors/gcp.metrics';
import type { AlertRule, Alert, AutomationWorkflow, EscalationPolicy } from '@prisma/client';
import { CH_DB, chInsertRows, chTs } from '../../common/clickhouse';

interface NotifyMsg {
  id?: string;
  title: string;
  severity: string;
  resourceName?: string | null;
  metric?: string | null;
  value?: number | null;
}
interface ChannelLike {
  id: string;
  name: string;
  type: string;
  target: string;
}

const METRIC_LABEL: Record<string, string> = { cpu: 'High CPU', memory: 'High memory', disk: 'Disk pressure' };

// Retry policy for ALL failed notifications: 3 quick retries (every 3 min),
// then hourly, giving up after 3 days from the first attempt.
const FAST_RETRIES = 3;
const FAST_INTERVAL_MS = 3 * 60 * 1000;
const SLOW_INTERVAL_MS = 60 * 60 * 1000;
const RETRY_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
// Delivery-log retention is configurable in Settings (OrgSettings.logRetentionDays);
// this is only the fallback if that can't be read. Default 90 days (compliance).
const DEFAULT_RETENTION_DAYS = 90;
/** Delay before the next attempt given how many attempts have already happened. */
function retryDelayMs(attempts: number): number {
  return attempts <= FAST_RETRIES ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS;
}

/**
 * In-process alerting engine. On an interval it refreshes live VM CPU, evaluates every enabled
 * AlertRule against running resources, raises/resolves Alerts, runs matching automation
 * workflows, and escalates stale unresolved alerts. Everything is dynamic — no seeded data.
 */
@Injectable()
export class AlertingEngine implements OnModuleInit {
  private readonly log = new Logger('AlertingEngine');
  private running = false;
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setTimeout(() => this.evalLoop(), 8000); // first run shortly after boot
    // Retry sweeper: every minute, re-send notifications whose nextRetryAt is due.
    setInterval(() => this.retryDue().catch(() => undefined), 60_000);
    // Retention: purge delivery logs older than 14 days (on boot, then every 6h).
    setTimeout(() => this.purgeOldLogs().catch(() => undefined), 20_000);
    setInterval(() => this.purgeOldLogs().catch(() => undefined), 6 * 60 * 60 * 1000);
    this.log.log('alerting engine started');
  }

  /** Self-rescheduling eval loop — re-reads "Alert evaluation interval" from Settings → System
   *  Parameters each tick, so a change applies live (no restart). */
  private async evalLoop() {
    await this.tick();
    const envMs = Number(process.env.EVAL_INTERVAL_MS);
    const sec = pInt(await sysParams(this.prisma), 'alertEvalSec', null, Number.isFinite(envMs) ? Math.round(envMs / 1000) : 60);
    setTimeout(() => this.evalLoop(), Math.max(10, sec) * 1000);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.evaluate();
    } catch (err) {
      this.log.warn(`eval error: ${String((err as Error)?.message ?? err)}`);
    } finally {
      this.running = false;
    }
  }

  async evaluate() {
    // Always refresh live metrics + snapshot fleet history, even with no rules yet.
    await this.refreshVmCpu();
    await this.snapshotFleet();

    const rules = await this.prisma.alertRule.findMany({ where: { enabled: true } });
    const eventRules = rules.filter((r) => (r as any).kind === 'event');
    const thresholdRules = rules.filter((r) => (r as any).kind !== 'event');
    await this.detectEvents(eventRules).catch((e) => this.log.warn(`event detect: ${String((e as Error)?.message ?? e)}`));
    if (thresholdRules.length === 0) {
      await this.checkEscalations();
      await this.checkWorkflowEscalations();
      return;
    }

    const resources = await this.prisma.resource.findMany({
      where: { OR: [{ type: 'compute' }, { provider: { in: ['linux', 'windows'] } }], status: 'running' },
    });

    for (const rule of thresholdRules) {
      const scoped = resources.filter((r) => (!rule.scopeProvider || r.provider === rule.scopeProvider) && (!(rule as any).scopeEnv || classifyEnvironment(r as any) === (rule as any).scopeEnv));
      for (const r of scoped) {
        const value = this.metricValue(rule.metric, r);
        if (value === null) continue;
        const breach = this.compare(value, rule.comparator, rule.threshold);
        const active = await this.prisma.alert.findFirst({
          where: { ruleId: rule.id, resourceId: r.id, status: { not: 'resolved' } },
        });
        if (breach && !active) {
          const alert = await this.prisma.alert.create({
            data: {
              title: `${rule.name}: ${r.name} (${rule.metric} ${Math.round(value)}% ${rule.comparator} ${rule.threshold}${rule.metric === 'cpu' || rule.metric === 'memory' || rule.metric === 'disk' ? '%' : ''})`,
              severity: rule.severity,
              source: `rule:${rule.name}`,
              status: 'active',
              ruleId: rule.id,
              resourceId: r.id,
              resourceName: r.name,
              metric: rule.metric,
              value,
            },
          });
          await this.runWorkflows(alert);
          await this.deliverRule(alert, rule as any);
          await this.logEvent({ type: 'alert', severity: rule.severity === 'critical' ? 'critical' : rule.severity === 'high' ? 'warning' : 'info', title: `Alert raised: ${alert.title}`, resourceName: r.name, provider: r.provider });
        } else if (breach && active) {
          await this.prisma.alert.update({ where: { id: active.id }, data: { value } });
        } else if (!breach && active) {
          await this.prisma.alert.update({ where: { id: active.id }, data: { status: 'resolved', resolvedAt: new Date() } });
          await this.logEvent({ type: 'alert', severity: 'info', title: `Alert resolved: ${active.title}`, resourceName: active.resourceName });
        }
      }
    }

    await this.checkEscalations();
    await this.checkWorkflowEscalations();
  }

  private metricValue(metric: string, r: { cpuPct: number; memoryPct: number; diskPct: number | null; networkMbps?: number | null }): number | null {
    if (metric === 'cpu') return r.cpuPct;
    if (metric === 'memory') return r.memoryPct > 0 ? r.memoryPct : null; // 0 = no agent data
    if (metric === 'disk') return r.diskPct != null && r.diskPct > 0 ? r.diskPct : null;
    if (metric === 'network') return r.networkMbps != null ? r.networkMbps : null;
    return null;
  }

  // ── Event rules (VM power on/off · device unreachable · agent offline) ──
  private prevRes = new Map<string, string>();
  private prevMon = new Map<string, string>();
  private prevAgent = new Map<string, boolean>();
  private snapInit = false;

  /** Detect infra transitions and fire matching event rules → alert + per-rule channel delivery. */
  private async detectEvents(eventRules: any[]) {
    const [resources, monitors, agents] = await Promise.all([
      this.prisma.resource.findMany({ where: { OR: [{ type: 'compute' }, { provider: { in: ['linux', 'windows', 'vmware', 'nutanix', 'proxmox', 'esxi', 'kvm'] } }] }, select: { id: true, name: true, provider: true, status: true } }),
      this.prisma.monitor.findMany({ select: { id: true, name: true, target: true, status: true, deviceKind: true } }),
      this.prisma.agent.findMany({ select: { id: true, name: true, lastSeenAt: true, active: true } }),
    ]);
    const now = Date.now();
    const online = (a: any) => !!(a.active && a.lastSeenAt && now - new Date(a.lastSeenAt).getTime() < 90_000);

    if (!this.snapInit) {
      for (const r of resources) this.prevRes.set(r.id, r.status);
      for (const m of monitors) this.prevMon.set(m.id, m.status);
      for (const a of agents) this.prevAgent.set(a.id, online(a));
      this.snapInit = true;
      return; // first pass after (re)start: snapshot only, no firing
    }
    if (eventRules.length === 0) {
      for (const r of resources) this.prevRes.set(r.id, r.status);
      for (const m of monitors) this.prevMon.set(m.id, m.status);
      for (const a of agents) this.prevAgent.set(a.id, online(a));
      return;
    }
    const forEvent = (ev: string) => eventRules.filter((r) => r.event === ev);

    for (const r of resources) {
      const prev = this.prevRes.get(r.id);
      if (prev && prev !== r.status) {
        if (prev === 'running' && r.status !== 'running') for (const rule of forEvent('vm_power_off')) await this.fireEvent(rule, r.provider, `VM powered off: ${r.name}`, r.name);
        if (prev !== 'running' && r.status === 'running') for (const rule of forEvent('vm_power_on')) await this.fireEvent(rule, r.provider, `VM powered on: ${r.name}`, r.name);
      }
      this.prevRes.set(r.id, r.status);
    }
    for (const m of monitors) {
      const prev = this.prevMon.get(m.id);
      if (prev && prev !== m.status && m.status === 'down') {
        const k = m.deviceKind && m.deviceKind !== 'host' ? m.deviceKind : 'device';
        for (const rule of forEvent('device_unreachable')) await this.fireEvent(rule, null, `${k[0].toUpperCase() + k.slice(1)} unreachable: ${m.name} (${m.target})`, m.target, `monitor:${m.id}`);
      }
      this.prevMon.set(m.id, m.status);
    }
    for (const a of agents) {
      const prev = this.prevAgent.get(a.id);
      const cur = online(a);
      if (prev === true && cur === false) for (const rule of forEvent('agent_offline')) await this.fireEvent(rule, null, `Agent offline: ${a.name}`, a.name);
      this.prevAgent.set(a.id, cur);
    }
  }

  /** Raise (or reuse) the event alert and deliver to the rule's channels — once per transition. */
  private async fireEvent(rule: any, provider: string | null, title: string, resourceName: string, reuseSource?: string) {
    let alert = reuseSource ? await this.prisma.alert.findFirst({ where: { source: reuseSource, status: { not: 'resolved' } } }) : null;
    if (!alert) {
      const src = `event:${rule.event}`;
      const dup = await this.prisma.alert.findFirst({ where: { source: src, resourceName, status: { not: 'resolved' } } });
      alert = dup ?? (await this.prisma.alert.create({ data: { title: `${rule.name}: ${title}`, severity: rule.severity, source: src, status: 'active', resourceName, metric: 'event' } }));
      if (!dup) await this.logEvent({ type: 'alert', severity: rule.severity === 'critical' ? 'critical' : 'warning', title: `Alert raised: ${alert.title}`, resourceName, provider: provider ?? undefined });
    }
    await this.deliverRule(alert, rule);
  }

  /** Deliver an alert to the rule's channels — per-rule email/phone first, then configured channels. */
  private async deliverRule(alert: Alert, rule: { notify?: any; notifyEmail?: string | null; notifyPhone?: string | null }) {
    const notify = Array.isArray(rule.notify) ? (rule.notify as string[]) : [];
    if (!notify.length) return;
    const m = this.toMsg(alert);
    if (notify.includes('email') && rule.notifyEmail) await this.dispatch({ id: 'rule', name: 'rule email', type: 'email', target: rule.notifyEmail }, m, 'rule');
    if (notify.includes('whatsapp') && rule.notifyPhone) await this.dispatch({ id: 'rule', name: 'rule whatsapp', type: 'whatsapp', target: rule.notifyPhone }, m, 'rule');
    const types: string[] = [];
    if (notify.includes('email')) types.push('email');
    if (notify.includes('whatsapp')) types.push('whatsapp');
    if (!types.length) return;
    const channels = await this.prisma.notificationChannel.findMany({ where: { enabled: true, type: { in: [...types, 'group'] } } });
    for (const ch of channels) await this.dispatch(ch as any, m, 'rule');
    if (notify.includes('email') && !rule.notifyEmail && !channels.some((c) => c.type === 'email' || c.type === 'group')) await this.mailAdmins(m).catch(() => undefined);
  }

  private async mailAdmins(m: NotifyMsg) {
    const admins = await this.prisma.user.findMany({ where: { role: 'admin', status: 'active' }, select: { email: true } });
    const to = admins.map((a) => a.email).filter(Boolean);
    if (!to.length) throw new Error('no active admin email to fall back to');
    await sendMail({ to: to.join(','), subject: `[MCMF] ${String(m.severity).toUpperCase()}: ${m.title}`, text: `${m.title}\nSeverity: ${m.severity}\nResource: ${m.resourceName ?? '—'}\nTime: ${new Date().toISOString()}` });
  }

  /** Send a TEST notification through a rule's selected channels and report per-target success/failure. */
  async testRule(cfg: { name?: string; severity?: string; notify?: string[]; notifyEmail?: string | null; notifyPhone?: string | null }) {
    const notify = Array.isArray(cfg.notify) ? cfg.notify : [];
    const m: NotifyMsg = { id: 'test', title: `TEST — ${cfg.name || 'Alert rule'} notification`, severity: (cfg.severity as any) || 'high', resourceName: 'test-resource', metric: 'test', value: null };
    const results: { channel: string; ok: boolean; detail: string }[] = [];
    const attempt = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); results.push({ channel: label, ok: true, detail: 'Sent ✓' }); }
      catch (e) { results.push({ channel: label, ok: false, detail: String((e as Error)?.message ?? e) }); }
    };

    if (notify.includes('popup')) results.push({ channel: 'Pop-up', ok: true, detail: 'Shows in-app instantly when the alert is active — no setup needed.' });

    if (notify.includes('email')) {
      const emailChannels = await this.prisma.notificationChannel.findMany({ where: { enabled: true, type: { in: ['email', 'group'] } } });
      if (cfg.notifyEmail) await attempt(`Email → ${cfg.notifyEmail}`, () => this.sendToChannel({ id: 'test', name: 'test', type: 'email', target: cfg.notifyEmail! }, m, 'test'));
      for (const c of emailChannels) await attempt(`Email channel "${c.name}"`, () => this.sendToChannel(c as any, m, 'test'));
      if (!cfg.notifyEmail && emailChannels.length === 0) await attempt('Email → admins (fallback)', () => this.mailAdmins(m));
    }

    if (notify.includes('whatsapp')) {
      const waChannels = await this.prisma.notificationChannel.findMany({ where: { enabled: true, type: { in: ['whatsapp', 'group'] } } });
      if (cfg.notifyPhone) await attempt(`WhatsApp → ${cfg.notifyPhone}`, () => this.sendToChannel({ id: 'test', name: 'test', type: 'whatsapp', target: cfg.notifyPhone! }, m, 'test'));
      for (const c of waChannels) await attempt(`WhatsApp channel "${c.name}"`, () => this.sendToChannel(c as any, m, 'test'));
      if (!cfg.notifyPhone && waChannels.length === 0) results.push({ channel: 'WhatsApp', ok: false, detail: 'No WhatsApp number on the rule and no WhatsApp channel configured — add a number above, or set WhatsApp in Settings → Integrations.' });
    }

    if (results.length === 0) results.push({ channel: '(none)', ok: false, detail: 'No delivery method selected — tick Pop-up, Email or WhatsApp.' });
    return { results, allOk: results.every((r) => r.ok) };
  }

  private async logEvent(e: { type: string; severity?: string; title: string; detail?: string; resourceName?: string | null; provider?: string | null }) {
    try {
      await this.prisma.eventLog.create({
        data: { type: e.type, severity: e.severity ?? 'info', title: e.title, detail: e.detail ?? null, resourceName: e.resourceName ?? null, provider: e.provider ?? null },
      });
    } catch {
      /* non-fatal */
    }
  }

  private compare(v: number, cmp: string, t: number): boolean {
    if (cmp === 'gt') return v > t;
    if (cmp === 'gte') return v >= t;
    if (cmp === 'lt') return v < t;
    if (cmp === 'lte') return v <= t;
    return false;
  }

  /** Pull latest CPU for running VMs so rules evaluate on live data. */
  private async refreshVmCpu() {
    const vms = await this.prisma.resource.findMany({
      where: { type: 'compute', status: 'running' },
      include: { cloudAccount: { select: { connectionId: true } } },
      take: 40,
    });
    const connCache = new Map<string, any>();
    for (const r of vms) {
      const connId = r.cloudAccount?.connectionId;
      if (!connId) continue;
      try {
        if (!connCache.has(connId)) {
          const conn = await this.prisma.cloudConnection.findUnique({ where: { id: connId } });
          connCache.set(connId, conn ? { provider: conn.provider, creds: cleanCreds(decryptJson<Record<string, string>>(conn.credentials)) } : null);
        }
        const c = connCache.get(connId);
        if (!c) continue;
        let m: any = null;
        if (c.provider === 'azure') m = await new AzureMetrics().collect(r.externalId, c.creds);
        else if (c.provider === 'aws') m = await new AwsMetrics().collect(r.externalId, c.creds, r.region);
        else if (c.provider === 'gcp') m = await new GcpMetrics().collect(r.externalId, c.creds);
        if (!m) continue;
        const data: any = {};
        if (m.latest.cpuPct != null) data.cpuPct = m.latest.cpuPct;
        if (m.latest.memoryPct != null) data.memoryPct = m.latest.memoryPct; // agent-based
        if (m.latest.diskPct != null) data.diskPct = m.latest.diskPct; // agent-based
        if (m.latest.networkMbps != null) data.networkMbps = m.latest.networkMbps;
        if (Object.keys(data).length) await this.prisma.resource.update({ where: { id: r.id }, data });
      } catch {
        /* best-effort */
      }
    }
  }

  /** Snapshot fleet-wide cpu/mem/disk/net/latency/error into MetricPoint so every Monitoring trend has real history. */
  private async snapshotFleet() {
    const running = await this.prisma.resource.findMany({
      where: { OR: [{ type: 'compute' }, { provider: { in: ['linux', 'windows'] } }], status: 'running' },
      select: {
        id: true, cpuPct: true, memoryPct: true, diskPct: true, networkMbps: true, metricHistory: true,
        // aiops metrics feed (ClickHouse mcmf.metrics) — cohort + cost fields:
        provider: true, type: true, service: true, region: true, status: true, monthlyCost: true,
      },
    });
    if (running.length === 0) return;
    const avg = (a: number[]) => (a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : 0);
    const netMbps = Math.round(running.reduce((s, r) => s + (r.networkMbps ?? 0), 0) * 100) / 100;
    // Reachability latency + jitter: averaged across monitors that are currently up.
    const mons = await this.prisma.monitor.findMany({ where: { status: 'up', lastLatencyMs: { not: null } }, select: { lastLatencyMs: true, jitterMs: true } });
    const latencyMs = mons.length ? Math.round(mons.reduce((s, m) => s + (m.lastLatencyMs ?? 0), 0) / mons.length) : null;
    const jit = mons.filter((m) => m.jitterMs != null);
    const jitterMs = jit.length ? Math.round((jit.reduce((s, m) => s + (m.jitterMs ?? 0), 0) / jit.length) * 10) / 10 : null;
    // Error rate: % of running resources with an unresolved alert.
    const active = await this.prisma.alert.findMany({ where: { status: { not: 'resolved' } }, select: { resourceId: true } });
    const alerted = new Set(active.map((a) => a.resourceId).filter(Boolean));
    const errorRate = running.length ? Math.round((running.filter((r) => alerted.has(r.id)).length / running.length) * 1000) / 10 : 0;
    await this.prisma.metricPoint.create({
      data: {
        ts: new Date(),
        avgCpu: avg(running.map((r) => r.cpuPct).filter((v) => v > 0)),
        avgMemory: avg(running.map((r) => r.memoryPct).filter((v) => v > 0)),
        avgDisk: avg(running.map((r) => r.diskPct ?? 0).filter((v) => v > 0)),
        networkMbps: netMbps,
        networkGbps: Math.round((netMbps / 1000) * 1000) / 1000,
        latencyMs,
        jitterMs,
        errorRate,
      },
    });
    await this.prisma.metricPoint.deleteMany({ where: { ts: { lt: new Date(Date.now() - 7 * 86400_000) } } });

    // Per-VM history (capped) so a selected VM's trends are real, not just the fleet average.
    const ts = new Date().toISOString();
    await Promise.all(
      running.map((r) => {
        const hist = Array.isArray((r as any).metricHistory) ? ((r as any).metricHistory as any[]) : [];
        const next = [...hist, { ts, cpu: r.cpuPct ?? 0, mem: r.memoryPct ?? 0, disk: r.diskPct ?? 0, net: r.networkMbps ?? 0 }].slice(-90);
        return this.prisma.resource.update({ where: { id: r.id }, data: { metricHistory: next as any } }).catch(() => undefined);
      }),
    );

    // aiops feed: per-resource sample into ClickHouse (mcmf.metrics) for the anomaly detectors'
    // long baselines (14–30d; metricHistory only keeps ~90 points). Best-effort — ClickHouse
    // being down must NEVER break the alerting tick (detectors fall back to metricHistory).
    const chTsNow = chTs(new Date());
    chInsertRows(
      `${CH_DB}.metrics`,
      running.map((r) => ({
        ts: chTsNow,
        resource_id: r.id,
        provider: String(r.provider),
        rtype: String(r.type),
        service: r.service ?? '',
        region: r.region ?? '',
        status: String(r.status),
        cpu: r.cpuPct ?? 0,
        mem: r.memoryPct ?? 0,
        disk: r.diskPct ?? 0,
        net: r.networkMbps ?? 0,
        cost_hourly: Math.round(((r.monthlyCost ?? 0) / 730) * 10000) / 10000,
      })),
    ).catch(() => undefined);
  }

  /**
   * aiops human gate: external delivery (email/WhatsApp/…) for an anomaly alert, invoked ONLY
   * after an operator confirms the detection. Detection time raises the in-app Alert alone.
   */
  async notifyExternal(alert: Alert, label = 'Anomaly confirmed'): Promise<void> {
    await this.deliverNotify(alert, label);
  }

  private async deliverNotify(alert: Alert, workflowName: string, channelIds?: string[]) {
    const where: any = { enabled: true };
    if (channelIds && channelIds.length) where.id = { in: channelIds };
    const channels = await this.prisma.notificationChannel.findMany({ where });
    for (const ch of channels) await this.dispatch(ch, this.toMsg(alert), workflowName);
  }

  private toMsg(alert: Alert): NotifyMsg {
    return { id: alert.id, title: alert.title, severity: alert.severity, resourceName: alert.resourceName, metric: alert.metric, value: alert.value };
  }

  /** Send to one channel and record the attempt (sent / failed + exact error). */
  private async dispatch(ch: ChannelLike, m: NotifyMsg, workflowName = '') {
    if (ch.type === 'group') return this.dispatchGroup(ch, m, workflowName);
    try {
      await this.sendToChannel(ch, m, workflowName);
      await this.logDelivery(ch, m.title, 'sent', null, { m, workflowName });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      this.log.warn(`notify channel ${ch.name} failed: ${msg}`);
      await this.logDelivery(ch, m.title, 'failed', msg, { m, workflowName });
    }
  }

  /** Group channel → fan out to each active member via the group's notifyVia (email/whatsapp/both). */
  private async dispatchGroup(ch: ChannelLike, m: NotifyMsg, wf: string) {
    const group = await this.prisma.group.findUnique({ where: { id: ch.target } });
    if (!group) return void this.logDelivery(ch, m.title, 'failed', 'group not found');
    const memberships = await this.prisma.groupMembership.findMany({ where: { groupId: group.id } });
    const users = await this.prisma.user.findMany({ where: { id: { in: memberships.map((x) => x.userId) }, status: 'active' } });
    if (users.length === 0) return void this.logDelivery(ch, m.title, 'failed', `group "${group.name}" has no active members`);
    const via = group.notifyVia;
    for (const u of users) {
      if ((via === 'email' || via === 'both') && u.email) await this.dispatch({ id: ch.id, name: `${ch.name} → ${u.name}`, type: 'email', target: u.email }, m, wf);
      if ((via === 'whatsapp' || via === 'both') && u.contact) await this.dispatch({ id: ch.id, name: `${ch.name} → ${u.name}`, type: 'whatsapp', target: u.contact }, m, wf);
    }
  }

  private async logDelivery(ch: ChannelLike, subject: string, status: 'sent' | 'failed', error: string | null, payload?: { m: NotifyMsg; workflowName: string }) {
    // Failed sends schedule the first auto-retry (+3 min); successful sends don't.
    const nextRetryAt = status === 'failed' ? new Date(Date.now() + FAST_INTERVAL_MS) : null;
    await this.prisma.notificationLog
      .create({
        data: {
          channelId: ch.id, channelName: ch.name, channelType: ch.type, target: ch.target, subject, status, error,
          attempts: 1, nextRetryAt, payload: payload ? (payload as any) : undefined,
        },
      })
      .catch(() => undefined);
  }

  /** Re-send a logged delivery (manual button or the auto-retry sweeper). Updates the same row. */
  async retryLog(id: string): Promise<{ ok: boolean; error: string | null }> {
    const row = await this.prisma.notificationLog.findUnique({ where: { id } });
    if (!row) return { ok: false, error: 'delivery not found' };
    const payload = row.payload as { m?: NotifyMsg; workflowName?: string } | null;
    if (!payload?.m) {
      await this.prisma.notificationLog.update({ where: { id }, data: { nextRetryAt: null } }).catch(() => undefined);
      return { ok: false, error: 'this delivery is too old to retry (no saved payload)' };
    }
    const ch: ChannelLike = { id: row.channelId ?? '', name: row.channelName, type: row.channelType, target: row.target };
    const attempts = row.attempts + 1;
    try {
      await this.sendToChannel(ch, payload.m, payload.workflowName ?? '');
      await this.prisma.notificationLog.update({ where: { id }, data: { status: 'sent', error: null, attempts, nextRetryAt: null } });
      return { ok: true, error: null };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const aged = Date.now() - new Date(row.firstTriedAt).getTime() >= RETRY_MAX_AGE_MS;
      const next = aged ? null : new Date(Date.now() + retryDelayMs(attempts));
      await this.prisma.notificationLog.update({
        where: { id },
        data: { status: aged ? 'gave_up' : 'failed', error: msg, attempts, nextRetryAt: next },
      });
      return { ok: false, error: msg };
    }
  }

  /** Auto-retry sweeper: re-send every failed delivery whose nextRetryAt is due. */
  private async retryDue() {
    const due = await this.prisma.notificationLog.findMany({
      where: { status: 'failed', nextRetryAt: { not: null, lte: new Date() } },
      take: 50,
    });
    for (const row of due) await this.retryLog(row.id).catch(() => undefined);
  }

  /** Retention: delete delivery logs older than the configured window (default 90 days). */
  private async purgeOldLogs() {
    const org = await this.prisma.orgSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const days = org?.logRetentionDays && org.logRetentionDays > 0 ? org.logRetentionDays : DEFAULT_RETENTION_DAYS;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Compliance: keep the security audit trail longer than operational logs.
    const auditDays = Math.max(days * 4, 365);
    const auditCutoff = new Date(Date.now() - auditDays * 24 * 60 * 60 * 1000);
    const del = await Promise.all([
      this.prisma.notificationLog.deleteMany({ where: { ts: { lt: cutoff } } }),
      this.prisma.eventLog.deleteMany({ where: { ts: { lt: cutoff } } }),
      this.prisma.siemEvent.deleteMany({ where: { ts: { lt: cutoff } } }),
      this.prisma.auditLog.deleteMany({ where: { ts: { lt: auditCutoff } } }),
    ]).catch((e) => { this.log.warn(`purge: ${String(e)}`); return [] as { count: number }[]; });
    const total = del.reduce((s, r) => s + (r?.count ?? 0), 0);
    if (total) this.log.log(`purged ${total} old log row(s) (events/siem/delivery > ${days}d, audit > ${auditDays}d)`);
  }

  /** Public: fire a test message through a channel and report success/exact error. */
  async testChannel(id: string): Promise<{ ok: boolean; error: string | null }> {
    const ch = await this.prisma.notificationChannel.findUnique({ where: { id } });
    if (!ch) return { ok: false, error: 'channel not found' };
    const m: NotifyMsg = { id: `test-${Date.now()}`, title: 'MCMF test notification', severity: 'low', resourceName: 'test', metric: null, value: null };
    if (ch.type === 'group') {
      await this.dispatchGroup(ch, m, 'test'); // fans out + logs per member
      return { ok: true, error: 'Fanned out to group members — see the Notification Delivery Log for each result.' };
    }
    try {
      await this.sendToChannel(ch, m, 'test');
      await this.logDelivery(ch, 'Test notification', 'sent', null);
      return { ok: true, error: null };
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      await this.logDelivery(ch, 'Test notification', 'failed', msg);
      return { ok: false, error: msg };
    }
  }

  private async sendToChannel(ch: ChannelLike, m: NotifyMsg, workflowName: string) {
    if (ch.type === 'slack') {
      await this.postOk(ch.target, { text: `🚨 ${m.title} (${m.severity}) — ${m.resourceName ?? ''}` });
    } else if (ch.type === 'pagerduty') {
      const sev: Record<string, string> = { critical: 'critical', high: 'error', medium: 'warning', low: 'info' };
      await this.postOk('https://events.pagerduty.com/v2/enqueue', {
        routing_key: ch.target,
        event_action: 'trigger',
        dedup_key: `mcmf-${m.id ?? Date.now()}`,
        payload: { summary: m.title, severity: sev[m.severity] ?? 'warning', source: m.resourceName ?? 'mcmf', custom_details: m },
      });
    } else if (ch.type === 'email') {
      await this.sendEmailMsg(ch.target, m);
    } else if (ch.type === 'whatsapp') {
      await this.sendWhatsappMsg(ch.target, m);
    } else {
      await this.postOk(ch.target, { event: 'alert.notify', workflow: workflowName, alert: m });
    }
  }

  private async post(url: string, body: unknown) {
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  /** POST that throws on non-2xx so the failure (with status) is logged. */
  private async postOk(url: string, body: unknown) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }

  private async sendWhatsappMsg(to: string, m: NotifyMsg) {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    if (!token || !phoneId) throw new Error('WhatsApp not configured — set WHATSAPP_TOKEN and WHATSAPP_PHONE_ID in Settings → Integrations.');
    const text = `*MCMF Alert* — ${m.severity.toUpperCase()}\n${m.title}\nResource: ${m.resourceName ?? '-'}\nMetric: ${m.metric ?? '-'} = ${m.value ?? '-'}`;
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/[^0-9]/g, ''), type: 'text', text: { body: text } }),
    });
    if (!res.ok) {
      const raw = await res.text();
      let code: number | undefined;
      let detail = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw);
        code = j?.error?.code;
        detail = j?.error?.message ?? detail;
      } catch {
        /* keep raw */
      }
      // Translate Meta's common error codes into actionable guidance.
      if (code === 131030) {
        throw new Error(`WhatsApp test number can only message pre-registered recipients. Add ${to.replace(/[^0-9]/g, '')} to the allowed list in Meta → WhatsApp → API Setup (or take the app Live with a verified business number).`);
      }
      if (code === 131026 || code === 131047) {
        throw new Error(`WhatsApp won't deliver: the recipient hasn't messaged you in the last 24h, so free-form text is blocked — use an approved message template (Meta error ${code}).`);
      }
      if (code === 190 || res.status === 401) {
        throw new Error('WhatsApp access token is invalid or expired — regenerate WHATSAPP_TOKEN (use a permanent System User token) in Settings → Integrations.');
      }
      throw new Error(`WhatsApp ${res.status}${code ? ` (#${code})` : ''}: ${detail}`);
    }
  }

  private async sendEmailMsg(to: string, m: NotifyMsg) {
    // Uses the external SMTP relay if configured, else MCMF's built-in sender.
    await sendMail({
      to,
      subject: `[MCMF] ${m.severity.toUpperCase()}: ${m.title}`,
      text: `${m.title}\n\nSeverity: ${m.severity}\nResource: ${m.resourceName ?? '-'}\nMetric: ${m.metric ?? '-'} = ${m.value ?? '-'}`,
    });
  }

  private async runWorkflows(alert: Alert) {
    const wfs = await this.prisma.automationWorkflow.findMany({ where: { status: 'enabled' } });
    for (const wf of wfs) {
      if (!this.matches(wf, alert)) continue;
      try {
        const steps = (wf.steps as any[]) ?? [];
        if (steps.length > 0) {
          // Multi-step: run each step in order; a failed step stops the sequence.
          for (const step of steps) await this.executeStep(step, wf, alert);
        } else {
          await this.executeAction(wf, alert); // legacy single action
        }
        await this.prisma.automationWorkflow.update({ where: { id: wf.id }, data: { runs: { increment: 1 }, lastRun: new Date() } });
      } catch (err) {
        this.log.warn(`workflow ${wf.name} failed: ${String((err as Error)?.message ?? err)}`);
      }
    }
  }

  private matches(wf: AutomationWorkflow, alert: Alert): boolean {
    // Legacy trigger gate.
    if (wf.triggerKind === 'severity' && alert.severity !== wf.triggerValue) return false;
    if (wf.triggerKind === 'metric' && alert.metric !== wf.triggerValue) return false;
    // Extra AND-conditions ([{field, op, value}]) over the alert.
    const conditions = (wf.conditions as any[]) ?? [];
    return conditions.every((c) => this.evalCondition(c, alert));
  }

  private evalCondition(c: { field?: string; op?: string; value?: any }, alert: Alert): boolean {
    const actual: any =
      c.field === 'severity' ? alert.severity :
      c.field === 'metric' ? alert.metric :
      c.field === 'source' ? alert.source :
      c.field === 'resourceName' ? alert.resourceName :
      c.field === 'value' ? alert.value :
      undefined;
    const want = c.value;
    switch (c.op) {
      case 'eq': return String(actual ?? '') === String(want ?? '');
      case 'neq': return String(actual ?? '') !== String(want ?? '');
      case 'gt': return Number(actual) > Number(want);
      case 'gte': return Number(actual) >= Number(want);
      case 'lt': return Number(actual) < Number(want);
      case 'contains': return String(actual ?? '').toLowerCase().includes(String(want ?? '').toLowerCase());
      default: return true;
    }
  }

  /** Execute one step of a multi-step workflow. */
  private async executeStep(step: { type?: string; config?: any }, wf: AutomationWorkflow, alert: Alert) {
    const cfg = step.config ?? {};
    switch (step.type) {
      case 'webhook':
        if (cfg.url) await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event: 'workflow.step', alert: this.alertPayload(alert), workflow: wf.name }) });
        break;
      case 'stop_vm':
      case 'restart_vm':
        if (alert.resourceId) await this.powerAction(alert.resourceId, step.type === 'stop_vm' ? 'stop' : 'reboot');
        break;
      case 'create_approval':
        await this.prisma.approvalRequest
          .create({
            data: {
              action: cfg.action ?? 'vm_stop',
              title: `Workflow "${wf.name}": ${cfg.title ?? `${(cfg.action ?? 'vm_stop').replace('_', ' ')} ${alert.resourceName ?? ''}`}`,
              resourceRef: alert.resourceId,
              resourceName: alert.resourceName,
              payload: { id: alert.resourceId, action: (cfg.action ?? 'vm_stop').replace('vm_', '') },
              requestedById: 'system',
              requestedByEmail: `workflow:${wf.name}`,
              expiresAt: new Date(Date.now() + 24 * 3600_000),
            },
          })
          .catch(() => undefined);
        break;
      case 'log':
        await this.prisma.eventLog
          .create({ data: { type: 'system', severity: cfg.severity ?? 'info', title: cfg.message ?? `Workflow "${wf.name}" ran`, resourceName: alert.resourceName ?? undefined } })
          .catch(() => undefined);
        break;
      case 'notify':
      default:
        await this.deliverNotify(alert, `${wf.name}${cfg.label ? ` · ${cfg.label}` : ''}`, Array.isArray(cfg.channelIds) ? cfg.channelIds : undefined);
    }
  }

  private async executeAction(wf: AutomationWorkflow, alert: Alert) {
    const cfg = (wf.actionConfig as any) ?? {};
    if (wf.actionType === 'webhook' && cfg.url) {
      await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'alert.raised', alert: this.alertPayload(alert), workflow: wf.name }),
      });
    } else if ((wf.actionType === 'stop_vm' || wf.actionType === 'restart_vm') && alert.resourceId) {
      await this.powerAction(alert.resourceId, wf.actionType === 'stop_vm' ? 'stop' : 'reboot');
    } else if (wf.actionType === 'notify') {
      await this.deliverNotify(alert, wf.name);
    }
  }

  private async powerAction(resourceId: string, action: 'stop' | 'reboot') {
    const r = await this.prisma.resource.findUnique({ where: { id: resourceId }, include: { cloudAccount: { select: { connectionId: true } } } });
    if (!r?.cloudAccount?.connectionId) return;
    const conn = await this.prisma.cloudConnection.findUnique({ where: { id: r.cloudAccount.connectionId } });
    if (!conn) return;
    const connector = getConnector(conn.provider);
    if (!connector.control) return;
    const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
    const p = (r.properties as any) ?? {};
    await connector.control(action, { externalId: r.externalId, name: r.name, region: r.region, zone: p.zone }, creds);
  }

  /**
   * Unified escalation: each enabled workflow can carry ordered escalation tiers
   * ([{ afterMinutes, steps }]). When a matching alert stays unresolved past a tier's
   * afterMinutes, that tier's steps run once (idempotent via alert.firedEscalations).
   */
  private async checkWorkflowEscalations() {
    const wfs = await this.prisma.automationWorkflow.findMany({ where: { status: 'enabled' } });
    const withTiers = wfs.filter((w) => Array.isArray(w.escalation) && (w.escalation as any[]).length > 0);
    if (withTiers.length === 0) return;

    const open = await this.prisma.alert.findMany({ where: { status: { not: 'resolved' } } });
    const now = Date.now();
    for (const wf of withTiers) {
      const tiers = (wf.escalation as any[]).filter((t) => Array.isArray(t?.steps) && t.steps.length > 0);
      for (const alert of open) {
        if (!this.matches(wf, alert)) continue;
        const fired: string[] = Array.isArray(alert.firedEscalations) ? (alert.firedEscalations as string[]) : [];
        const ageMin = (now - new Date(alert.raisedAt).getTime()) / 60_000;
        let changed = false;
        for (let i = 0; i < tiers.length; i++) {
          const key = `${wf.id}:${i}`;
          if (fired.includes(key)) continue;
          if (ageMin < Number(tiers[i].afterMinutes)) continue; // not due yet (tiers are sorted ascending)
          try {
            for (const step of tiers[i].steps) await this.executeStep(step, wf, alert);
            fired.push(key);
            changed = true;
            await this.logEvent({ type: 'alert', severity: 'critical', title: `Escalated: ${alert.title}`, detail: `workflow "${wf.name}" tier ${i + 1} (>${tiers[i].afterMinutes}m)`, resourceName: alert.resourceName });
          } catch (err) {
            this.log.warn(`workflow escalation ${wf.name} tier ${i + 1} failed: ${String((err as Error)?.message ?? err)}`);
          }
        }
        if (changed) {
          await this.prisma.alert
            .update({ where: { id: alert.id }, data: { firedEscalations: fired, escalated: true, escalatedAt: alert.escalatedAt ?? new Date() } })
            .catch(() => undefined);
        }
      }
    }
  }

  private async checkEscalations() {
    const policies = await this.prisma.escalationPolicy.findMany({ where: { enabled: true } });
    for (const p of policies) {
      const cutoff = new Date(Date.now() - p.afterMinutes * 60_000);
      const stale = await this.prisma.alert.findMany({
        where: { status: 'active', escalated: false, severity: p.severity, raisedAt: { lt: cutoff } },
      });
      for (const a of stale) {
        try {
          if (p.actionType === 'webhook' && p.target) {
            await fetch(p.target, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ event: 'alert.escalated', policy: p.name, alert: this.alertPayload(a) }),
            });
          }
          await this.prisma.alert.update({ where: { id: a.id }, data: { escalated: true, escalatedAt: new Date() } });
          await this.logEvent({ type: 'alert', severity: 'critical', title: `Escalated: ${a.title}`, detail: `policy ${p.name} (>${p.afterMinutes}m)`, resourceName: a.resourceName });
        } catch (err) {
          this.log.warn(`escalation ${p.name} failed: ${String((err as Error)?.message ?? err)}`);
        }
      }
    }
  }

  private alertPayload(a: Alert) {
    return { id: a.id, title: a.title, severity: a.severity, metric: a.metric, value: a.value, resource: a.resourceName, raisedAt: a.raisedAt };
  }
}
