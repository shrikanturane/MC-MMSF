import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { mergeHostResources } from '../../common/host-identity';

/** Least-squares slope/intercept of (x,y); x in minutes. Returns null if too few points. */
function linreg(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
  const n = xs.length;
  if (n < 4) return null;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const d = n * sxx - sx * sx;
  if (d === 0) return null;
  const slope = (n * sxy - sx * sy) / d;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}
const fmtEta = (min: number) => {
  if (min < 90) return `~${Math.max(1, Math.round(min))} min`;
  if (min < 36 * 60) return `~${Math.round(min / 60)} h`;
  return `~${Math.round(min / 1440)} d`;
};

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(params: { type?: string; severity?: string; provider?: string; q?: string; limit?: number }) {
    const where: any = {};
    if (params.type && params.type !== 'all') where.type = params.type;
    if (params.severity && params.severity !== 'all') where.severity = params.severity;
    if (params.provider && params.provider !== 'all') where.provider = params.provider;
    if (params.q) {
      where.OR = [
        { title: { contains: params.q, mode: 'insensitive' } },
        { resourceName: { contains: params.q, mode: 'insensitive' } },
        { detail: { contains: params.q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.eventLog.findMany({ where, orderBy: { ts: 'desc' }, take: Math.min(params.limit ?? 200, 500) });
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts.toISOString(),
      type: r.type,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      resourceName: r.resourceName,
      provider: r.provider,
    }));
  }

  async summary() {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [total, last24h, byTypeRaw, bySevRaw] = await Promise.all([
      this.prisma.eventLog.count(),
      this.prisma.eventLog.count({ where: { ts: { gt: since } } }),
      this.prisma.eventLog.groupBy({ by: ['type'], _count: true }),
      this.prisma.eventLog.groupBy({ by: ['severity'], _count: true }),
    ]);
    return {
      total,
      last24h,
      byType: byTypeRaw.map((t) => ({ type: t.type, count: t._count })).sort((a, b) => b.count - a.count),
      bySeverity: bySevRaw.map((s) => ({ severity: s.severity, count: s._count })),
    };
  }

  /** Recent SIEM stream (agent/cloud/monitor/alerting events) — consolidated into Activity. */
  async siem(limit = 100) {
    const rows = await this.prisma.siemEvent.findMany({ orderBy: { ts: 'desc' }, take: Math.min(limit, 300) });
    return rows.map((r) => ({ id: r.id, ts: r.ts.toISOString(), source: r.source, host: r.host, level: r.level, category: r.category, message: r.message }));
  }

  /** Security audit trail — login / user / password actions (compliance log). */
  async audit(limit = 100) {
    const rows = await this.prisma.auditLog.findMany({ orderBy: { ts: 'desc' }, take: Math.min(limit, 300) });
    return rows.map((r) => ({ id: r.id, ts: r.ts.toISOString(), action: r.action, actorEmail: r.actorEmail, targetEmail: r.targetEmail, ip: r.ip, detail: r.detail }));
  }

  /**
   * Predictive alerting: fit a trend to the fleet metric history and project threshold crossings
   * (e.g. "disk hits 90% in ~2 days"), flag z-score anomalies, forecast the next hour's alert volume,
   * and list resources already at risk. Heuristic/statistical — no external ML dependency.
   */
  async predictive() {
    const PtsAgo = (h: number) => new Date(Date.now() - h * 3600_000);
    const [pointsDesc, recentAlerts, activeAlerts, resourcesRaw] = await Promise.all([
      this.prisma.metricPoint.findMany({ orderBy: { ts: 'desc' }, take: 240 }),
      this.prisma.alert.count({ where: { raisedAt: { gt: PtsAgo(6) } } }),
      this.prisma.alert.count({ where: { status: 'active' } }),
      this.prisma.resource.findMany({ where: { OR: [{ type: 'compute' }, { provider: { in: ['linux', 'windows', 'docker'] } }] } }),
    ]);
    const series = [...pointsDesc].reverse(); // oldest -> newest
    const t0 = series.length ? new Date(series[0].ts).getTime() : Date.now();
    const xs = series.map((p) => (new Date(p.ts).getTime() - t0) / 60000); // minutes

    const METRICS: { key: 'avgCpu' | 'avgMemory' | 'avgDisk' | 'errorRate' | 'latencyMs'; label: string; unit: string; threshold: number }[] = [
      { key: 'avgDisk', label: 'Fleet disk', unit: '%', threshold: 90 },
      { key: 'avgCpu', label: 'Fleet CPU', unit: '%', threshold: 90 },
      { key: 'avgMemory', label: 'Fleet memory', unit: '%', threshold: 90 },
      { key: 'errorRate', label: 'Error rate', unit: '%', threshold: 5 },
      { key: 'latencyMs', label: 'Reachability latency', unit: 'ms', threshold: 200 },
    ];
    const HORIZON_MIN = 7 * 24 * 60;
    const predictions = METRICS.map((m) => {
      const ys = series.map((p) => Number((p as any)[m.key] ?? 0));
      const reg = linreg(xs, ys);
      const current = ys.length ? ys[ys.length - 1] : 0;
      const mean = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
      const sd = ys.length ? Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length) : 0;
      const z = sd > 0 ? (current - mean) / sd : 0;
      if (!reg) return { metric: m.key, label: m.label, unit: m.unit, current: Number(current.toFixed(1)), trend: 'flat', slopePerHr: 0, threshold: m.threshold, eta: null as string | null, willBreach: false, severity: 'info', anomaly: false };
      const slopePerHr = reg.slope * 60;
      const trend = slopePerHr > 0.05 ? 'rising' : slopePerHr < -0.05 ? 'falling' : 'flat';
      let eta: string | null = null;
      let willBreach = false;
      if (slopePerHr > 0 && current < m.threshold) {
        const etaMin = (m.threshold - current) / reg.slope;
        if (etaMin > 0 && etaMin <= HORIZON_MIN) { eta = fmtEta(etaMin); willBreach = true; }
      }
      const severity = current >= m.threshold ? 'critical' : willBreach ? (eta && eta.includes('min') ? 'critical' : 'high') : Math.abs(z) >= 2 ? 'warning' : 'info';
      return { metric: m.key, label: m.label, unit: m.unit, current: Number(current.toFixed(1)), trend, slopePerHr: Number(slopePerHr.toFixed(2)), threshold: m.threshold, eta, willBreach, severity, anomaly: Math.abs(z) >= 2 };
    });

    // Resources already at risk (current snapshot) — deduped to one row per host.
    const resources = mergeHostResources(resourcesRaw as any);
    const atRisk = resources
      .map((r: any) => {
        const p = r.properties ?? {};
        const disk = Number(r.diskPct ?? p.diskPct ?? 0);
        const cpu = Number(r.cpuPct ?? 0);
        const mem = Number(r.memoryPct ?? 0);
        const worst = Math.max(disk, cpu, mem);
        const which = worst === disk ? 'disk' : worst === cpu ? 'cpu' : 'memory';
        return { id: r.id, name: r.name, provider: r.provider, cpu: Number(cpu.toFixed(0)), memory: Number(mem.toFixed(0)), disk: Number(disk.toFixed(0)), worst: Number(worst.toFixed(0)), which };
      })
      .filter((r) => r.worst >= 80)
      .sort((a, b) => b.worst - a.worst)
      .slice(0, 12);

    // Per-resource capacity forecast: fit each host's OWN history (cpu/mem/disk) and project when it
    // crosses 90% — "web-01 disk → 90% in ~2 days". Pure CPU on the capped per-resource metricHistory.
    const RES_METRICS: { key: 'cpu' | 'mem' | 'disk'; label: string; threshold: number }[] = [
      { key: 'disk', label: 'disk', threshold: 90 },
      { key: 'cpu', label: 'CPU', threshold: 90 },
      { key: 'mem', label: 'memory', threshold: 90 },
    ];
    const fc: Record<string, { id: string; name: string; provider: string; metric: string; current: number; threshold: number; slopePerHr: number; eta: string; etaMin: number }> = {};
    for (const r of resourcesRaw as any[]) {
      const hist = Array.isArray(r.metricHistory) ? r.metricHistory : [];
      if (hist.length < 4) continue;
      const rt0 = new Date(hist[0].ts).getTime();
      const rxs = hist.map((p: any) => (new Date(p.ts).getTime() - rt0) / 60000);
      for (const m of RES_METRICS) {
        const rys = hist.map((p: any) => Number(p[m.key] ?? 0));
        const reg = linreg(rxs, rys);
        if (!reg || reg.slope <= 0) continue;
        const current = rys[rys.length - 1];
        if (current >= m.threshold) continue; // already over → covered by atRisk
        const etaMin = (m.threshold - current) / reg.slope;
        if (etaMin <= 0 || etaMin > HORIZON_MIN) continue;
        const cand = { id: r.id, name: r.name, provider: r.provider, metric: m.label, current: Math.round(current), threshold: m.threshold, slopePerHr: Number((reg.slope * 60).toFixed(2)), eta: fmtEta(etaMin), etaMin: Math.round(etaMin) };
        if (!fc[r.name] || cand.etaMin < fc[r.name].etaMin) fc[r.name] = cand; // soonest breach per host
      }
    }
    const resourceForecasts = Object.values(fc).sort((a, b) => a.etaMin - b.etaMin).slice(0, 12);

    // Next-hour alert forecast from the recent rate (alerts/hr over the last 6h).
    const ratePerHr = recentAlerts / 6;
    const forecastNextHour = Math.round(ratePerHr * (predictions.some((p) => p.severity === 'critical' || p.willBreach) ? 1.5 : 1));

    const anomalies = predictions.filter((p) => p.anomaly || p.severity === 'critical' || p.willBreach);
    const riskScore = Math.min(100, Math.round(
      anomalies.length * 12 + atRisk.length * 6 + (predictions.filter((p) => p.willBreach).length) * 15 + Math.min(activeAlerts, 10) * 2,
    ));

    const imminent = resourceForecasts.filter((f) => f.etaMin < 1440).length; // breaching within 24h
    return {
      generatedAt: new Date().toISOString(),
      dataPoints: series.length,
      kpis: { riskScore: Math.min(100, riskScore + imminent * 6), activeAlerts, forecastNextHour, atRisk: atRisk.length, anomalies: anomalies.length, forecastBreaches: resourceForecasts.length },
      predictions,
      atRisk,
      resourceForecasts,
      series: series.slice(-60).map((p) => ({ ts: p.ts.toISOString(), cpu: p.avgCpu, memory: p.avgMemory, disk: p.avgDisk, latencyMs: p.latencyMs ?? 0, errorRate: p.errorRate })),
    };
  }

  /** Correlate everything that happened around a resource: its events + active alerts. */
  async resourceTimeline(name: string) {
    const [events, alerts] = await Promise.all([
      this.prisma.eventLog.findMany({ where: { resourceName: name }, orderBy: { ts: 'desc' }, take: 50 }),
      this.prisma.alert.findMany({ where: { resourceName: name }, orderBy: { raisedAt: 'desc' }, take: 20 }),
    ]);
    return {
      resourceName: name,
      events: events.map((e) => ({ id: e.id, ts: e.ts.toISOString(), type: e.type, severity: e.severity, title: e.title, detail: e.detail })),
      alerts: alerts.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, raisedAt: a.raisedAt.toISOString(), resolvedAt: a.resolvedAt?.toISOString() ?? null })),
    };
  }
}
