import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { sendMail } from '../../mail/mailer';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyEnvironment } from '../policies/policies.service';
import { ApiKeyService } from '../integration/api-key.service';

/** Available report data sources — drives the builder UI and the query layer. */
export const REPORT_SOURCES = [
  { key: 'resources', label: 'Cloud Inventory', columns: ['name', 'provider', 'type', 'region', 'environment', 'status', 'cpuPct', 'memoryPct', 'monthlyCost'], filters: ['provider', 'type', 'status', 'environment'] },
  { key: 'cost', label: 'Cost by Service', columns: ['provider', 'service', 'monthlyCost', 'currency'], filters: ['provider'] },
  { key: 'security', label: 'Security Findings', columns: ['title', 'severity', 'type', 'provider', 'status', 'resourceName'], filters: ['severity', 'type', 'provider'] },
  { key: 'compliance', label: 'Compliance Checklist', columns: ['standard', 'control', 'status', 'source'], filters: ['standard', 'status'] },
  { key: 'violations', label: 'Policy Violations', columns: ['policy', 'resourceName', 'provider', 'environment', 'detail'], filters: ['environment', 'provider'] },
  // Performance/availability across IP/Host monitors, network devices and guest agents — by scope/group.
  { key: 'monitoring', label: 'Performance & Uptime (IP/Host, Devices, Agents)', columns: ['name', 'kind', 'scope', 'status', 'uptimePct', 'latencyMs', 'jitterMs', 'bandwidthInMbps', 'bandwidthOutMbps', 'topInterface', 'cpuPct', 'memPct', 'diskPct'], filters: ['group', 'kind'] },
] as const;

@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly log = new Logger('Reports');
  constructor(private readonly prisma: PrismaService, private readonly monitoring: ApiKeyService) {}

  onModuleInit() {
    // Check scheduled reports every 30 min.
    setInterval(() => void this.runScheduled().catch(() => undefined), 30 * 60_000);
    setTimeout(() => void this.runScheduled().catch(() => undefined), 40_000);
  }

  sources() {
    return REPORT_SOURCES;
  }

  list() {
    return this.prisma.report.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async runs(reportId: string) {
    return this.prisma.reportRun.findMany({ where: { reportId }, orderBy: { ts: 'desc' }, take: 50 });
  }

  async create(body: any) {
    if (!body?.name?.trim()) throw new BadRequestException('name is required');
    if (!REPORT_SOURCES.some((s) => s.key === body.source)) throw new BadRequestException('invalid source');
    const r = await this.prisma.report.create({
      data: {
        name: body.name.trim(),
        description: body.description ?? '',
        source: body.source,
        config: body.config ?? {},
        format: body.format === 'json' ? 'json' : 'csv',
        schedule: ['daily', 'weekly'].includes(body.schedule) ? body.schedule : 'manual',
        recipients: body.recipients ?? '',
      },
    });
    return { id: r.id };
  }

  async update(id: string, body: any) {
    const exists = await this.prisma.report.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('report not found');
    const data: any = {};
    for (const k of ['name', 'description', 'source', 'config', 'format', 'schedule', 'recipients']) {
      if (body[k] !== undefined) data[k] = body[k];
    }
    await this.prisma.report.update({ where: { id }, data });
    return { ok: true };
  }

  async remove(id: string) {
    await this.prisma.reportRun.deleteMany({ where: { reportId: id } });
    await this.prisma.report.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  }

  /** Run a report → returns the row set (for preview) and records a run. */
  async run(id: string, trigger: 'manual' | 'scheduled' = 'manual') {
    const report = await this.prisma.report.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('report not found');
    try {
      const rows = await this.buildRows(report);
      await this.prisma.report.update({ where: { id }, data: { lastRunAt: new Date(), lastRowCount: rows.length } });
      await this.prisma.reportRun.create({ data: { reportId: id, status: 'ok', rowCount: rows.length, trigger } });
      return { columns: this.columnsFor(report.source), rows };
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      await this.prisma.reportRun.create({ data: { reportId: id, status: 'error', trigger, detail } });
      throw err;
    }
  }

  /** Render a report to a downloadable file. */
  async download(id: string): Promise<{ filename: string; content: string; contentType: string }> {
    const report = await this.prisma.report.findUnique({ where: { id } });
    if (!report) throw new NotFoundException('report not found');
    const rows = await this.buildRows(report);
    const cols = this.columnsFor(report.source);
    const stamp = new Date().toISOString().slice(0, 10);
    const safe = report.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await this.prisma.reportRun.create({ data: { reportId: id, status: 'ok', rowCount: rows.length, trigger: 'manual' } });
    await this.prisma.report.update({ where: { id }, data: { lastRunAt: new Date(), lastRowCount: rows.length } }).catch(() => undefined);
    if (report.format === 'json') {
      return { filename: `${safe}-${stamp}.json`, content: JSON.stringify(rows, null, 2), contentType: 'application/json' };
    }
    return { filename: `${safe}-${stamp}.csv`, content: this.toCsv(cols, rows), contentType: 'text/csv' };
  }

  private columnsFor(source: string): string[] {
    return [...(REPORT_SOURCES.find((s) => s.key === source)?.columns ?? [])];
  }

  // ── Query layer ──
  private async buildRows(report: { source: string; config: any }): Promise<Record<string, any>[]> {
    const f = (report.config ?? {}) as Record<string, any>;
    switch (report.source) {
      case 'resources': {
        const where: any = {};
        if (f.provider && f.provider !== 'all') where.provider = f.provider;
        if (f.type && f.type !== 'all') where.type = f.type;
        if (f.status) where.status = f.status;
        const rows = await this.prisma.resource.findMany({ where, orderBy: { monthlyCost: 'desc' } });
        let mapped = rows.map((r) => ({
          name: r.name,
          provider: r.provider,
          type: r.type,
          region: r.region,
          environment: classifyEnvironment(r as any),
          status: r.status,
          cpuPct: Math.round(r.cpuPct),
          memoryPct: Math.round(r.memoryPct),
          monthlyCost: Number(r.monthlyCost.toFixed(2)),
        }));
        if (f.environment && f.environment !== 'all') mapped = mapped.filter((m) => m.environment === f.environment);
        return mapped;
      }
      case 'cost': {
        // Real cost lives on the connection (Cost Management / Cost Explorer / BigQuery).
        const conns = await this.prisma.cloudConnection.findMany();
        const rows: Record<string, any>[] = [];
        for (const c of conns) {
          if (f.provider && f.provider !== 'all' && c.provider !== f.provider) continue;
          const cbs = (c.costByService as { service: string; cost: number }[] | null) ?? [];
          for (const item of cbs) {
            rows.push({ provider: c.provider, service: item.service, monthlyCost: Number(Number(item.cost).toFixed(2)), currency: (c as any).currency ?? 'USD' });
          }
        }
        return rows.sort((a, b) => b.monthlyCost - a.monthlyCost);
      }
      case 'security': {
        const where: any = {};
        if (f.severity) where.severity = f.severity;
        if (f.type) where.type = f.type;
        if (f.provider && f.provider !== 'all') where.provider = f.provider;
        const rows = await this.prisma.securityFinding.findMany({ where, orderBy: { detectedAt: 'desc' }, take: 1000 });
        return rows.map((r) => ({ title: r.title, severity: r.severity, type: r.type, provider: r.provider, status: r.status, resourceName: r.resourceName ?? '' }));
      }
      case 'compliance': {
        const where: any = {};
        if (f.standard) where.standard = f.standard;
        if (f.status) where.status = f.status;
        const rows = await this.prisma.complianceItem.findMany({ where, orderBy: [{ standard: 'asc' }, { sort: 'asc' }] });
        return rows.map((r) => ({ standard: r.standard, control: r.control, status: r.status, source: r.source }));
      }
      case 'violations': {
        const rows = await this.prisma.policyViolation.findMany({ orderBy: { ts: 'desc' }, take: 1000 });
        const policies = await this.prisma.policy.findMany({ select: { id: true, name: true } });
        const pmap = new Map(policies.map((p) => [p.id, p.name]));
        let mapped = rows.map((r) => ({ policy: pmap.get(r.policyId) ?? r.policyId, resourceName: r.resourceName, provider: r.provider, environment: r.environment, detail: r.detail ?? '' }));
        if (f.environment && f.environment !== 'all') mapped = mapped.filter((m) => m.environment === f.environment);
        if (f.provider && f.provider !== 'all') mapped = mapped.filter((m) => m.provider === f.provider);
        return mapped;
      }
      case 'monitoring': {
        const kind = f.kind && f.kind !== 'all' ? f.kind : undefined;
        const rows = await this.monitoring.monitoringRows({ group: f.group, kind });
        return rows.map((r) => ({
          name: r.name, kind: r.kind, scope: r.scope, status: r.status,
          uptimePct: r.uptimePct ?? '', latencyMs: r.latencyMs ?? '', jitterMs: r.jitterMs ?? '',
          bandwidthInMbps: r.bandwidthInMbps ?? '', bandwidthOutMbps: r.bandwidthOutMbps ?? '', topInterface: r.topInterface ?? '',
          cpuPct: r.cpuPct ?? '', memPct: r.memPct ?? '', diskPct: r.diskPct ?? '',
        }));
      }
      default:
        throw new BadRequestException('unknown report source');
    }
  }

  private toCsv(cols: string[], rows: Record<string, any>[]): string {
    const esc = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = cols.join(',');
    const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
    return `${header}\n${body}`;
  }

  // ── Scheduling ──
  private async runScheduled() {
    const reports = await this.prisma.report.findMany({ where: { schedule: { in: ['daily', 'weekly'] } } });
    const now = Date.now();
    for (const r of reports) {
      const dueMs = r.schedule === 'daily' ? 24 * 3600_000 : 7 * 24 * 3600_000;
      if (r.lastRunAt && now - r.lastRunAt.getTime() < dueMs) continue;
      try {
        const file = await this.download(r.id);
        await this.emailReport(r, file);
      } catch (err) {
        this.log.warn(`scheduled report "${r.name}" failed: ${String((err as Error)?.message ?? err)}`);
      }
    }
  }

  private async emailReport(report: { name: string; recipients: string }, file: { filename: string; content: string }) {
    const to = (report.recipients || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (to.length === 0) {
      this.log.warn(`scheduled report "${report.name}" generated (${file.filename}) but not emailed (no recipients set)`);
      return;
    }
    // Sends via external SMTP relay if configured, else the built-in MCMF sender.
    await sendMail({
      to: to.join(','),
      subject: `[MCMF] Scheduled report: ${report.name}`,
      text: `Attached is your scheduled MCMF report "${report.name}".`,
      attachments: [{ filename: file.filename, content: file.content }],
    });
  }
}
