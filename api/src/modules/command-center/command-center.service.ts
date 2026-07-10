import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AGENT_VERSION } from '../agent/agent.service';

@Injectable()
export class CommandCenterService {
  constructor(private readonly prisma: PrismaService) {}

  async overview() {
    const [alerts, incidents, latest, totalResources, workflows, topCpu] = await Promise.all([
      this.prisma.alert.findMany({ orderBy: { raisedAt: 'desc' } }),
      this.prisma.incident.findMany({ where: { status: { not: 'resolved' } }, orderBy: { openedAt: 'desc' } }),
      this.prisma.metricPoint.findFirst({ orderBy: { ts: 'desc' } }),
      this.prisma.resource.count(),
      this.prisma.automationWorkflow.findMany({ orderBy: { runs: 'desc' } }),
      this.prisma.resource.findMany({
        where: { status: { not: 'stopped' } },
        orderBy: { cpuPct: 'desc' },
        take: 6,
        select: { id: true, name: true, provider: true, cpuPct: true, memoryPct: true },
      }),
    ]);

    const activeAlerts = alerts.filter((a) => a.status === 'active');
    const critical = activeAlerts.filter((a) => a.severity === 'critical').length;

    return {
      kpis: {
        totalResources,
        activeAlerts: activeAlerts.length,
        criticalAlerts: critical,
        activeIncidents: incidents.length,
        avgCpu: latest?.avgCpu ?? 0,
        avgMemory: latest?.avgMemory ?? 0,
        networkGbps: latest?.networkGbps ?? 0,
      },
      alerts: alerts.slice(0, 8).map((a) => ({
        id: a.id,
        title: a.title,
        severity: a.severity,
        source: a.source,
        status: a.status,
        raisedAt: a.raisedAt.toISOString(),
      })),
      incidents: incidents.slice(0, 6).map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        provider: i.provider,
        resourceName: i.resourceName,
        status: i.status,
        openedAt: i.openedAt.toISOString(),
      })),
      aiEngine: await this.aiEngine(),
      workflows: workflows.map((w) => ({
        id: w.id,
        name: w.name,
        trigger: w.trigger,
        status: w.status,
        runs: w.runs,
        lastRun: w.lastRun?.toISOString() ?? null,
      })),
      topConsumers: topCpu.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        cpu: r.cpuPct,
        memory: r.memoryPct,
      })),
      agents: await this.agents(),
      siem: await this.siem(),
    };
  }

  /** Connected guest agents + their latest telemetry. Each agent's monitor GROUP is joined from the
   *  IP/Host Monitor it was mirrored into, so Guest Agents and IP/Host Monitor share one group scope. */
  private async agents() {
    const [agents, monitors] = await Promise.all([
      this.prisma.agent.findMany({ orderBy: { lastSeenAt: 'desc' }, take: 50 }),
      this.prisma.monitor.findMany({ select: { target: true, altTargets: true, group: true } }),
    ]);
    const norm = (t: string) => (t || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].replace(/:\d+$/, '');
    const groupByKey = new Map<string, string>();
    for (const m of monitors) {
      for (const t of [m.target, ...String(m.altTargets ?? '').split(',')]) {
        const k = norm(t);
        if (k && !groupByKey.has(k)) groupByKey.set(k, m.group || 'default');
      }
    }
    const now = Date.now();
    return agents.map((a) => {
      const keys = [a.hostname ?? '', ...String(a.ips ?? '').split(','), ...String(a.altHosts ?? '').split(',')].map(norm).filter(Boolean);
      const group = keys.map((k) => groupByKey.get(k)).find(Boolean) ?? 'default';
      return {
        id: a.id, name: a.displayName || a.name, hostname: a.hostname, altHosts: a.altHosts, os: a.os, group,
        // displayName/machineName drive the edit form + the title; outbound drives the "outbound ✓" vs
        // "push (legacy)" badge — these were dropped here, so a real outbound agent showed as legacy.
        displayName: a.displayName ?? null, machineName: a.name,
        outbound: (a as any).outbound ?? false,
        version: (a as any).version ?? null, currentVersion: AGENT_VERSION,
        outdated: !!(a as any).version && (a as any).version !== AGENT_VERSION,
        cpuPct: a.cpuPct, memPct: a.memPct, diskPct: a.diskPct, netMbps: a.netMbps,
        services: Array.isArray(a.services) ? (a.services as any[]).length : 0,
        loggedInUser: a.loggedInUser ?? null, posture: a.posture ?? null,
        active: a.active, intervalSec: a.intervalSec, port: a.port, mode: a.mode,
        lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        online: !!a.lastSeenAt && now - a.lastSeenAt.getTime() < 5 * 60_000,
      };
    });
  }

  /** SIEM stream: recent events + counts by level (real, from agents/monitors/findings). */
  private async siem() {
    const events = await this.prisma.siemEvent.findMany({ orderBy: { ts: 'desc' }, take: 40 });
    const counts = { info: 0, warning: 0, error: 0, critical: 0 } as Record<string, number>;
    for (const e of events) counts[e.level] = (counts[e.level] ?? 0) + 1;
    return {
      counts,
      events: events.map((e) => ({ id: e.id, ts: e.ts.toISOString(), source: e.source, host: e.host, level: e.level, category: e.category, message: e.message })),
    };
  }

  /**
   * Real AIOps engine: anomaly detection (z-score over the live fleet) + a linear
   * forecast of fleet CPU from the metric-point history. No fabricated numbers.
   */
  private async aiEngine() {
    const [history, running, agents] = await Promise.all([
      this.prisma.metricPoint.findMany({ orderBy: { ts: 'desc' }, take: 30 }),
      this.prisma.resource.findMany({ where: { type: 'compute', status: 'running' }, select: { name: true, provider: true, cpuPct: true, memoryPct: true, diskPct: true } }),
      this.prisma.agent.findMany({ where: { lastSeenAt: { gte: new Date(Date.now() - 10 * 60_000) } } }),
    ]);

    // Anomalies: resources whose CPU is a statistical outlier (z>2) or absolute-high (>90%).
    const cpus = running.map((r) => r.cpuPct ?? 0);
    const mean = cpus.length ? cpus.reduce((a, b) => a + b, 0) / cpus.length : 0;
    const std = cpus.length ? Math.sqrt(cpus.reduce((a, b) => a + (b - mean) ** 2, 0) / cpus.length) : 0;
    const anomalies: { resource: string; provider: string; metric: string; value: number; note: string }[] = [];
    for (const r of running) {
      const cpu = r.cpuPct ?? 0;
      const z = std > 0 ? (cpu - mean) / std : 0;
      if (cpu >= 90) anomalies.push({ resource: r.name, provider: r.provider, metric: 'cpu', value: Number(cpu.toFixed(1)), note: `CPU ${cpu.toFixed(0)}% — critically high.` });
      else if (z >= 2 && cpu > 50) anomalies.push({ resource: r.name, provider: r.provider, metric: 'cpu', value: Number(cpu.toFixed(1)), note: `CPU ${cpu.toFixed(0)}% is ${z.toFixed(1)}σ above the fleet mean (${mean.toFixed(0)}%).` });
      if ((r.memoryPct ?? 0) >= 90) anomalies.push({ resource: r.name, provider: r.provider, metric: 'memory', value: Number((r.memoryPct ?? 0).toFixed(1)), note: `Memory ${(r.memoryPct ?? 0).toFixed(0)}% — risk of exhaustion.` });
      if ((r.diskPct ?? 0) >= 90) anomalies.push({ resource: r.name, provider: r.provider, metric: 'disk', value: Number((r.diskPct ?? 0).toFixed(1)), note: `Disk ${(r.diskPct ?? 0).toFixed(0)}% — nearly full.` });
    }
    for (const a of agents) {
      if ((a.memPct ?? 0) >= 90) anomalies.push({ resource: a.hostname ?? a.name, provider: 'agent', metric: 'memory', value: Number((a.memPct ?? 0).toFixed(1)), note: `Agent: memory ${(a.memPct ?? 0).toFixed(0)}%.` });
      if ((a.diskPct ?? 0) >= 90) anomalies.push({ resource: a.hostname ?? a.name, provider: 'agent', metric: 'disk', value: Number((a.diskPct ?? 0).toFixed(1)), note: `Agent: disk ${(a.diskPct ?? 0).toFixed(0)}%.` });
    }

    // Forecast: least-squares slope of fleet avgCpu over the (chronological) history.
    const series = [...history].reverse().map((h) => h.avgCpu ?? 0);
    let forecast: { metric: string; current: number; predicted: number; trend: string; horizon: string } | null = null;
    if (series.length >= 3) {
      const n = series.length;
      const xs = series.map((_, i) => i);
      const xm = (n - 1) / 2;
      const ym = series.reduce((a, b) => a + b, 0) / n;
      const slope = xs.reduce((a, x, i) => a + (x - xm) * (series[i] - ym), 0) / xs.reduce((a, x) => a + (x - xm) ** 2, 0 || 1);
      const current = series[n - 1];
      const predicted = Math.max(0, Math.min(100, current + slope * 10)); // ~10 intervals ahead
      forecast = {
        metric: 'fleet CPU',
        current: Number(current.toFixed(1)),
        predicted: Number(predicted.toFixed(1)),
        trend: slope > 0.3 ? 'rising' : slope < -0.3 ? 'falling' : 'stable',
        horizon: `next ~${10 * 1}m`,
      };
    }

    const confidence = Math.min(0.99, 0.4 + series.length * 0.02 + running.length * 0.02);
    const insight =
      anomalies.length > 0
        ? `${anomalies.length} anomaly(ies) detected: ${anomalies.slice(0, 2).map((a) => `${a.resource} ${a.metric}`).join(', ')}${anomalies.length > 2 ? '…' : ''}.${forecast && forecast.trend === 'rising' ? ` Fleet CPU trending up toward ${forecast.predicted}%.` : ''}`
        : forecast
          ? `No anomalies. Fleet CPU ${forecast.trend} (${forecast.current}% → ~${forecast.predicted}% ${forecast.horizon}).`
          : 'Collecting telemetry — connect a guest agent or sync clouds for predictions.';

    return {
      status: 'active',
      model: 'mcmf-aiops/v2 (statistical)',
      anomaliesDetected: anomalies.length,
      anomalies: anomalies.slice(0, 8),
      forecast,
      confidence: Number(confidence.toFixed(2)),
      insight,
    };
  }
}
