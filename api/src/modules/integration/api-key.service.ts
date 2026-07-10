import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Uptime % over the monitor's recent history sparkline. */
function uptimePct(history: any): number | null {
  const h = Array.isArray(history) ? history : [];
  if (!h.length) return null;
  return Math.round((h.filter((x: any) => x.up).length / h.length) * 100);
}

@Injectable()
export class ApiKeyService {
  constructor(private readonly prisma: PrismaService) {}

  // ── key management (admin) ─────────────────────────────────────────────
  async list() {
    const keys = await this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
    return keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes.split(','), lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null, createdAt: k.createdAt.toISOString() }));
  }

  /** Create a key. The full secret is returned ONCE (never stored in plaintext). */
  async create(name: string, scopes: string[], userId?: string) {
    const label = String(name ?? '').trim();
    if (!label) throw new BadRequestException('a name is required');
    const secret = `mcmf_${randomBytes(24).toString('hex')}`; // 48 hex chars
    const allowed = ['read', 'alerts'];
    const scs = (scopes?.length ? scopes : ['read', 'alerts']).filter((s) => allowed.includes(s));
    const key = await this.prisma.apiKey.create({ data: { name: label, prefix: secret.slice(0, 12), keyHash: sha(secret), scopes: scs.join(','), createdBy: userId ?? null } });
    return { id: key.id, name: key.name, scopes: scs, key: secret, note: 'Copy this key now — it is shown only once.' };
  }

  async revoke(id: string) {
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } }).catch(() => { throw new NotFoundException('key not found'); });
    return { ok: true };
  }

  /** Validate an incoming x-api-key. Returns the key row (with scopes) or null. */
  async validate(raw?: string) {
    if (!raw || !raw.startsWith('mcmf_')) return null;
    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: sha(raw) } });
    if (!key || key.revokedAt) return null;
    // best-effort last-used stamp (don't block the request)
    this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    return { id: key.id, scopes: key.scopes.split(',') };
  }

  // ── open data (consumed by /api/v1 and shared with the monitoring report) ──
  /** Unified monitoring rows across IP/Host monitors, network devices and guest agents. */
  async monitoringRows(opts: { group?: string; kind?: 'host' | 'device' | 'agent' } = {}) {
    const [monitors, agents] = await Promise.all([
      this.prisma.monitor.findMany({ where: { enabled: true } }),
      this.prisma.agent.findMany(),
    ]);
    const wantGroup = opts.group && opts.group !== 'all' ? opts.group : null;
    const rows: any[] = [];

    // Agent telemetry keyed by IP/hostname for host enrichment.
    const agentByKey = new Map<string, any>();
    for (const a of agents) {
      for (const ip of String(a.ips ?? '').split(',')) if (ip.trim()) agentByKey.set(ip.trim().toLowerCase(), a);
      if (a.hostname) agentByKey.set(a.hostname.trim().toLowerCase(), a);
    }

    for (const m of monitors) {
      if (wantGroup && m.group !== wantGroup) continue;
      const isDevice = (m.deviceKind ?? 'host') !== 'host';
      const kind = isDevice ? 'device' : 'host';
      if (opts.kind && opts.kind !== kind) continue;
      const ifaces = Array.isArray(m.interfaces) ? (m.interfaces as any[]) : [];
      const bwIn = ifaces.reduce((s, i) => s + (Number(i.inBps) || 0), 0);
      const bwOut = ifaces.reduce((s, i) => s + (Number(i.outBps) || 0), 0);
      const topIf = ifaces.slice().sort((a, b) => (Number(b.utilPct) || 0) - (Number(a.utilPct) || 0))[0];
      const agent = agentByKey.get(String(m.target).trim().toLowerCase());
      rows.push({
        name: m.name,
        kind,
        deviceKind: m.deviceKind ?? 'host',
        scope: m.group,
        target: m.target,
        protocol: m.type,
        status: m.status,
        uptimePct: uptimePct(m.history),
        latencyMs: m.lastLatencyMs ?? null,
        jitterMs: m.jitterMs ?? null,
        deviceUptimeSec: m.uptimeSec ?? null,
        bandwidthInMbps: isDevice ? Number((bwIn / 1e6).toFixed(2)) : null,
        bandwidthOutMbps: isDevice ? Number((bwOut / 1e6).toFixed(2)) : null,
        topInterface: topIf ? `${topIf.name} ${Math.round(Number(topIf.utilPct) || 0)}%` : null,
        cpuPct: agent?.cpuPct ?? null,
        memPct: agent?.memPct ?? null,
        diskPct: agent?.diskPct ?? null,
        lastCheckedAt: m.lastCheckedAt?.toISOString() ?? null,
      });
    }

    // Guest agents that aren't already represented by a monitor row.
    if (!opts.kind || opts.kind === 'agent') {
      const seen = new Set(rows.map((r) => r.target.trim().toLowerCase()));
      for (const a of agents) {
        const primary = (String(a.ips ?? '').split(',')[0] || a.hostname || '').trim();
        if (!primary || seen.has(primary.toLowerCase())) continue;
        const online = !!a.lastSeenAt && Date.now() - a.lastSeenAt.getTime() < 5 * 60_000;
        rows.push({
          name: a.displayName || a.name,
          kind: 'agent',
          deviceKind: 'host',
          scope: 'default',
          target: primary,
          protocol: 'agent',
          status: online ? 'up' : 'down',
          uptimePct: null,
          latencyMs: null,
          jitterMs: null,
          deviceUptimeSec: null,
          bandwidthInMbps: null,
          bandwidthOutMbps: null,
          topInterface: null,
          cpuPct: a.cpuPct ?? null,
          memPct: a.memPct ?? null,
          diskPct: a.diskPct ?? null,
          lastCheckedAt: a.lastSeenAt?.toISOString() ?? null,
        });
      }
    }
    return rows;
  }

  /** Per-scope/group SLA rollup. */
  async summary() {
    const rows = await this.monitoringRows();
    const byScope = new Map<string, { scope: string; total: number; up: number; uptimeSum: number; uptimeN: number }>();
    for (const r of rows) {
      const s = byScope.get(r.scope) ?? { scope: r.scope, total: 0, up: 0, uptimeSum: 0, uptimeN: 0 };
      s.total++;
      if (r.status === 'up') s.up++;
      if (typeof r.uptimePct === 'number') { s.uptimeSum += r.uptimePct; s.uptimeN++; }
      byScope.set(r.scope, s);
    }
    const scopes = [...byScope.values()].map((s) => ({ scope: s.scope, total: s.total, up: s.up, down: s.total - s.up, slaPct: s.uptimeN ? Math.round(s.uptimeSum / s.uptimeN) : null }));
    return { totals: { monitors: rows.length, up: rows.filter((r) => r.status === 'up').length, down: rows.filter((r) => r.status !== 'up').length }, scopes };
  }

  /** Active device/monitor alerts — the feed an ITSM tool turns into incidents. */
  async alerts() {
    const alerts = await this.prisma.alert.findMany({ where: { status: { not: 'resolved' } }, orderBy: { raisedAt: 'desc' }, take: 500 });
    return alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, source: a.source, resourceName: a.resourceName ?? null, metric: a.metric ?? null, value: a.value ?? null, raisedAt: a.raisedAt.toISOString() }));
  }
}
