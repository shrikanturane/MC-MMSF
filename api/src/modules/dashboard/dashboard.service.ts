import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface Dataset {
  key: string;
  label: string;
  kind: 'category' | 'series' | 'stat';
  data?: { label: string; value: number }[];
  series?: { ts: string; value: number }[];
  value?: number;
  unit?: string;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /** All available datasets the user can drop onto a custom widget, with current data. */
  async datasets(): Promise<Dataset[]> {
    const [byProvider, byType, byStatus, conns, findingsSev, alertsActive, points, totalResources, openFindings, vms] = await Promise.all([
      this.prisma.resource.groupBy({ by: ['provider'], _count: true }),
      this.prisma.resource.groupBy({ by: ['type'], _count: true }),
      this.prisma.resource.groupBy({ by: ['status'], where: { type: 'compute' }, _count: true }),
      this.prisma.cloudConnection.findMany({ select: { monthlyCost: true, costByService: true } }),
      this.prisma.securityFinding.groupBy({ by: ['severity'], where: { status: { not: 'resolved' } }, _count: true }),
      this.prisma.alert.findMany({ where: { status: { not: 'resolved' } }, select: { severity: true } }),
      this.prisma.metricPoint.findMany({ orderBy: { ts: 'asc' } }),
      this.prisma.resource.count(),
      this.prisma.securityFinding.count({ where: { status: { not: 'resolved' } } }),
      this.prisma.resource.findMany({ where: { type: 'compute' }, orderBy: { cpuPct: 'desc' }, take: 12, select: { name: true, cpuPct: true, memoryPct: true, networkMbps: true } }),
    ]);

    const costMerged = new Map<string, number>();
    let totalCost = 0;
    for (const c of conns) {
      totalCost += c.monthlyCost ?? 0;
      for (const s of (c.costByService as { service: string; cost: number }[] | null) ?? []) {
        costMerged.set(s.service, (costMerged.get(s.service) ?? 0) + s.cost);
      }
    }
    const costData = [...costMerged.entries()].map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 })).sort((a, b) => b.value - a.value).slice(0, 8);

    const alertSev = new Map<string, number>();
    for (const a of alertsActive) alertSev.set(a.severity, (alertSev.get(a.severity) ?? 0) + 1);

    return [
      { key: 'resources-by-provider', label: 'Resources by Provider', kind: 'category', data: byProvider.map((g) => ({ label: g.provider, value: g._count })) },
      { key: 'resources-by-type', label: 'Resources by Type', kind: 'category', data: byType.map((g) => ({ label: g.type, value: g._count })) },
      { key: 'vms-by-state', label: 'VMs by State', kind: 'category', data: byStatus.map((g) => ({ label: g.status, value: g._count })) },
      { key: 'cost-by-service', label: 'Cost by Service', kind: 'category', data: costData },
      { key: 'findings-by-severity', label: 'Findings by Severity', kind: 'category', data: findingsSev.map((g) => ({ label: g.severity, value: g._count })) },
      { key: 'alerts-by-severity', label: 'Active Alerts by Severity', kind: 'category', data: [...alertSev.entries()].map(([label, value]) => ({ label, value })) },
      { key: 'vm-cpu', label: 'CPU % by VM', kind: 'category', data: vms.map((v) => ({ label: v.name, value: Math.round(v.cpuPct) })) },
      { key: 'vm-network', label: 'Network Mbps by VM', kind: 'category', data: vms.map((v) => ({ label: v.name, value: Math.round((v.networkMbps ?? 0) * 100) / 100 })) },
      { key: 'fleet-cpu', label: 'Fleet CPU Trend', kind: 'series', series: points.map((p) => ({ ts: p.ts.toISOString(), value: p.avgCpu })) },
      { key: 'fleet-memory', label: 'Fleet Memory Trend', kind: 'series', series: points.map((p) => ({ ts: p.ts.toISOString(), value: p.avgMemory })) },
      { key: 'total-resources', label: 'Total Resources', kind: 'stat', value: totalResources },
      { key: 'monthly-cost', label: 'Monthly Cost', kind: 'stat', value: Math.round(totalCost * 100) / 100, unit: 'currency' },
      { key: 'active-alerts', label: 'Active Alerts', kind: 'stat', value: alertsActive.length },
      { key: 'open-findings', label: 'Open Findings', kind: 'stat', value: openFindings },
    ];
  }

  async getLayout(key = 'custom') {
    const row = await this.prisma.dashboardLayout.upsert({ where: { key }, update: {}, create: { key } });
    return { panels: (row.panels as any[]) ?? [] };
  }

  async saveLayout(key: string, panels: any[]) {
    await this.prisma.dashboardLayout.upsert({ where: { key }, update: { panels: panels as any }, create: { key, panels: panels as any } });
    return { ok: true };
  }
}
