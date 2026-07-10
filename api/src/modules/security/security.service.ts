import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Provider, Severity } from '@prisma/client';
import { decryptJson } from '../../connectors/crypto';
import { cleanCreds } from '../../connectors/adapter';
import { getConnector } from '../../connectors/factory';

const PROVIDERS: Provider[] = ['aws', 'azure', 'gcp', 'private'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

@Injectable()
export class SecurityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pull real findings from every connected cloud (Defender / Security Hub / SCC) and upsert. */
  async refreshFindings() {
    const conns = await this.prisma.cloudConnection.findMany({ where: { status: 'connected' } });
    const results: any[] = [];
    let total = 0;
    for (const conn of conns) {
      const connector = getConnector(conn.provider);
      if (!connector.getFindings) {
        results.push({ connection: conn.name, provider: conn.provider, supported: false });
        continue;
      }
      try {
        const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
        const findings = await connector.getFindings(creds);
        const seen: string[] = [];
        for (const f of findings) {
          seen.push(f.externalId);
          const data = {
            title: f.title.slice(0, 300),
            type: f.type as any,
            severity: f.severity as any,
            status: f.status as any,
            provider: conn.provider,
            source: f.source,
            connectionId: conn.id,
            resourceName: f.resourceName ?? null,
            detectedAt: f.detectedAt ? new Date(f.detectedAt) : new Date(),
          };
          await this.prisma.securityFinding.upsert({
            where: { externalId: f.externalId },
            create: { externalId: f.externalId, ...data },
            update: { title: data.title, severity: data.severity, status: data.status, source: data.source, resourceName: data.resourceName },
          });
        }
        // Prune findings from this connection that are no longer reported.
        await this.prisma.securityFinding.deleteMany({
          where: { connectionId: conn.id, externalId: { notIn: seen.length ? seen : ['__none__'] } },
        });
        // Also refresh regulatory compliance standards (best-effort).
        if (connector.getCompliance) {
          try {
            const comp = await connector.getCompliance(creds);
            await this.prisma.cloudConnection.update({ where: { id: conn.id }, data: { compliance: comp as any } });
          } catch {
            /* compliance unavailable */
          }
        }
        total += findings.length;
        results.push({ connection: conn.name, provider: conn.provider, count: findings.length });
      } catch (err) {
        results.push({ connection: conn.name, provider: conn.provider, error: String((err as Error)?.message ?? err) });
      }
    }
    await this.prisma.eventLog
      .create({ data: { type: 'finding', severity: total > 0 ? 'warning' : 'info', title: `Security findings refreshed: ${total}` } })
      .catch(() => undefined);
    return { ok: true, total, results };
  }

  async overview() {
    const findings = await this.prisma.securityFinding.findMany({
      where: { status: { not: 'resolved' } },
      include: { resource: { select: { name: true, type: true } } },
    });

    const byType = (t: string) => findings.filter((f) => f.type === t);
    const sevBreakdown = (items: typeof findings) =>
      Object.fromEntries(SEVERITIES.map((s) => [s, items.filter((f) => f.severity === s).length]));

    // Findings by provider (stacked by severity) for the bar chart.
    const byProvider = PROVIDERS.map((provider) => {
      const items = findings.filter((f) => f.provider === provider);
      return { provider, total: items.length, ...sevBreakdown(items) };
    });

    // Recent threat detections.
    const recentThreats = findings
      .filter((f) => f.type === 'threat')
      .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())
      .slice(0, 6)
      .map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        provider: f.provider,
        resourceName: f.resource?.name ?? 'unknown',
        detectedAt: f.detectedAt.toISOString(),
      }));

    // Top exposed resources (most open findings).
    const byResource = new Map<string, { name: string; type: string; provider: Provider; count: number; maxSev: number }>();
    const sevRank: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    for (const f of findings) {
      if (!f.resourceId) continue;
      const e = byResource.get(f.resourceId) ?? {
        name: f.resource?.name ?? 'unknown',
        type: f.resource?.type ?? 'compute',
        provider: f.provider,
        count: 0,
        maxSev: 0,
      };
      e.count++;
      e.maxSev = Math.max(e.maxSev, sevRank[f.severity]);
      byResource.set(f.resourceId, e);
    }
    const topExposed = [...byResource.values()]
      .sort((a, b) => b.count - a.count || b.maxSev - a.maxSev)
      .slice(0, 6)
      .map((e) => ({
        name: e.name,
        type: e.type,
        provider: e.provider,
        findings: e.count,
        severity: SEVERITIES[4 - e.maxSev] ?? 'low',
      }));

    const frameworks = await this.prisma.complianceFramework.findMany({ orderBy: { score: 'desc' } });

    return {
      kpis: {
        openVulnerabilities: byType('vulnerability').length,
        misconfigurations: byType('misconfiguration').length,
        threatDetections: byType('threat').length,
        vulnBreakdown: sevBreakdown(byType('vulnerability')),
      },
      findingsByProvider: byProvider,
      frameworks: frameworks.map((f) => ({ name: f.name, score: f.score, passed: f.passed, total: f.total })),
      recentThreats,
      topExposed,
    };
  }

  async findings(params: { type?: string; severity?: string; status?: string }) {
    const where: any = {};
    if (params.type) where.type = params.type;
    if (params.severity) where.severity = params.severity;
    if (params.status) where.status = params.status;
    const findings = await this.prisma.securityFinding.findMany({
      where,
      include: { resource: { select: { name: true } } },
      orderBy: { detectedAt: 'desc' },
      take: 200,
    });
    return findings.map((f) => ({
      id: f.id,
      title: f.title,
      type: f.type,
      severity: f.severity,
      status: f.status,
      provider: f.provider,
      source: f.source ?? null,
      resourceName: f.resourceName ?? f.resource?.name ?? null,
      detectedAt: f.detectedAt.toISOString(),
    }));
  }
}
