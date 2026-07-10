import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Provider } from '@prisma/client';

const PROVIDERS: Provider[] = ['aws', 'azure', 'gcp', 'private'];

@Injectable()
export class MonitoringService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const [latest, resources, activeAlerts] = await Promise.all([
      this.prisma.metricPoint.findFirst({ orderBy: { ts: 'desc' } }),
      this.prisma.resource.findMany({
        where: { status: { not: 'stopped' } },
        select: { id: true, name: true, provider: true, service: true, type: true, cpuPct: true, memoryPct: true, diskPct: true, networkMbps: true, status: true },
      }),
      this.prisma.alert.findMany({ where: { status: { not: 'resolved' } }, select: { resourceId: true } }),
    ]);

    // Service health map: group by provider+service, mark degraded if any degraded.
    const serviceMap = new Map<string, { provider: Provider; service: string; total: number; degraded: number }>();
    for (const r of resources) {
      const key = `${r.provider}:${r.service}`;
      const entry = serviceMap.get(key) ?? { provider: r.provider, service: r.service, total: 0, degraded: 0 };
      entry.total++;
      if (r.status === 'degraded') entry.degraded++;
      serviceMap.set(key, entry);
    }
    const serviceHealth = [...serviceMap.values()].map((s) => ({
      provider: s.provider,
      service: s.service,
      total: s.total,
      health: s.degraded === 0 ? 'healthy' : s.degraded / s.total > 0.4 ? 'down' : 'degraded',
    }));

    // Top resource consumers by cpu and memory.
    const byCpu = [...resources].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 6);
    const byMem = [...resources].sort((a, b) => b.memoryPct - a.memoryPct).slice(0, 6);

    // Prefer REAL aggregates from discovered resources; fall back to the seeded MetricPoint.
    const avg = (a: number[]) => (a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : 0);
    const cpuVals = resources.map((r) => r.cpuPct).filter((v) => v > 0);
    const memVals = resources.map((r) => r.memoryPct).filter((v) => v > 0);
    const diskVals = resources.map((r) => r.diskPct ?? 0).filter((v) => v > 0);
    const netSum = resources.reduce((s, r) => s + (r.networkMbps ?? 0), 0);
    const avgCpu = cpuVals.length ? avg(cpuVals) : (latest?.avgCpu ?? 0);
    const avgMemory = memVals.length ? avg(memVals) : (latest?.avgMemory ?? 0);

    // Error rate proxy = share of running VMs currently breaching a rule (have an active alert).
    const running = resources.filter((r) => r.status === 'running' && (r.type === 'compute' || r.provider === 'linux' || r.provider === 'windows'));
    const alerted = new Set(activeAlerts.map((a) => a.resourceId).filter(Boolean));
    const errorRate = running.length ? Math.round((running.filter((r) => alerted.has(r.id)).length / running.length) * 1000) / 10 : 0;

    return {
      kpis: {
        avgCpu,
        avgMemory,
        avgDisk: diskVals.length ? avg(diskVals) : 0,
        diskHasData: diskVals.length > 0,
        memoryHasData: memVals.length > 0,
        networkMbps: Math.round(netSum * 100) / 100,
        latency: null, // application/LB metric — needs APM or a load balancer
        errorRate,
      },
      serviceHealth,
      topConsumers: {
        cpu: byCpu.map((r) => ({ id: r.id, name: r.name, provider: r.provider, value: r.cpuPct })),
        memory: byMem.map((r) => ({ id: r.id, name: r.name, provider: r.provider, value: r.memoryPct })),
      },
    };
  }

  /** Per-VM telemetry snapshot (latest stored metrics) for the telemetry table. */
  async telemetry() {
    const vms = await this.prisma.resource.findMany({
      where: { OR: [{ type: 'compute' }, { provider: { in: ['linux', 'windows'] } }] },
      orderBy: [{ status: 'asc' }, { cpuPct: 'desc' }],
      select: { id: true, name: true, provider: true, region: true, status: true, cpuPct: true, memoryPct: true, diskPct: true, networkMbps: true },
    });
    return vms.map((v) => ({
      id: v.id,
      name: v.name,
      provider: v.provider,
      region: v.region,
      status: v.status,
      cpuPct: v.cpuPct,
      memoryPct: v.memoryPct,
      diskPct: v.diskPct,
      networkMbps: v.networkMbps,
    }));
  }

  /** System event log feed. */
  async events(limit = 60) {
    const ev = await this.prisma.eventLog.findMany({ orderBy: { ts: 'desc' }, take: Math.min(limit, 200) });
    return ev.map((e) => ({
      id: e.id,
      ts: e.ts.toISOString(),
      type: e.type,
      severity: e.severity,
      title: e.title,
      detail: e.detail,
      resourceName: e.resourceName,
      provider: e.provider,
    }));
  }

  async timeseries(metric: string, vm?: string) {
    // Per-VM trend (cpu/memory/disk/network) from the resource's capped history.
    if (vm && vm !== 'all' && ['cpu', 'memory', 'disk', 'network'].includes(metric)) {
      const r = await this.prisma.resource.findUnique({ where: { id: vm }, select: { metricHistory: true } });
      const hist = Array.isArray(r?.metricHistory) ? (r!.metricHistory as any[]) : [];
      const key = metric === 'memory' ? 'mem' : metric === 'disk' ? 'disk' : metric === 'network' ? 'net' : 'cpu';
      return hist.map((p: any) => ({ ts: p.ts, value: Number(p[key]) || 0 }));
    }
    // Fleet trend (also used for latency/jitter/error, which aren't per-VM).
    const points = await this.prisma.metricPoint.findMany({ orderBy: { ts: 'asc' } });
    const pick = (p: any): number => {
      switch (metric) {
        case 'memory': return p.avgMemory;
        case 'disk': return p.avgDisk ?? 0;
        case 'network': return p.networkMbps ?? p.networkGbps ?? 0; // real Mbps (Gbps for legacy rows)
        case 'latency': return p.latencyMs ?? 0;
        case 'jitter': return p.jitterMs ?? 0;
        case 'error': return p.errorRate ?? 0;
        default: return p.avgCpu;
      }
    };
    return points.map((p) => ({ ts: p.ts.toISOString(), value: pick(p) }));
  }

  async incidents() {
    const incidents = await this.prisma.incident.findMany({ orderBy: { openedAt: 'desc' } });
    return incidents.map((i) => ({
      id: i.id,
      title: i.title,
      severity: i.severity,
      status: i.status,
      provider: i.provider,
      resourceName: i.resourceName,
      openedAt: i.openedAt.toISOString(),
    }));
  }
}
