import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Provider } from '@prisma/client';
import { decryptJson, encryptJson } from '../../connectors/crypto';
import { cleanCreds } from '../../connectors/adapter';
import { getConnector } from '../../connectors/factory';

const PROVIDERS: Provider[] = ['aws', 'azure', 'gcp', 'private'];
const DIST_TYPES = ['compute', 'storage', 'network', 'database'] as const;
const COST_REFRESH_MS = 6 * 60 * 60 * 1000; // cloud billing lags (AWS CE ~24h, others daily) — 6h auto is ample

@Injectable()
export class ManagementService implements OnModuleInit {
  private readonly log = new Logger('Management');
  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Auto-refresh cloud cost: once shortly after boot, then every 6 hours. No button click needed.
    setTimeout(() => this.refreshCost().then((r) => this.log.log(`initial cost refresh: ${JSON.stringify(r.results?.length ?? 0)} connections`)).catch((e) => this.log.warn(`cost refresh: ${String((e as Error)?.message ?? e)}`)), 60_000);
    setInterval(() => this.refreshCost().catch((e) => this.log.warn(`cost refresh: ${String((e as Error)?.message ?? e)}`)), COST_REFRESH_MS);
  }

  /** Pull month-to-date cost from each connected cloud and store it on the connection. */
  async refreshCost() {
    const conns = await this.prisma.cloudConnection.findMany({ where: { status: 'connected' } });
    const results: any[] = [];
    for (const conn of conns) {
      const connector = getConnector(conn.provider);
      if (!connector.getCost) {
        results.push({ connection: conn.name, provider: conn.provider, supported: false });
        continue;
      }
      // A previous build flagged cost problems in the connection status/lastSyncError — detect any such flag
      // so this run can CLEAR it (billing no longer touches connection status).
      const hadCostWarn = /^Cost\/billing/.test(String(conn.lastSyncError || ''));
      const billingProvider = ['aws', 'azure', 'gcp'].includes(conn.provider);
      // Cost/billing is a Cloud Connections concern surfaced via costNote — it NEVER changes the connection's
      // connectivity status. If a previous build had flagged this connection with a cost warning, clear it.
      const restore = hadCostWarn ? { status: 'connected', lastSyncError: null } : {};
      try {
        const creds = cleanCreds(decryptJson<Record<string, string>>(conn.credentials));
        const cost = await connector.getCost(creds);
        if (cost) {
          // Persist an auto-detected billing table back into the sealed credential so the UI
          // Edit form reflects it and future refreshes skip re-discovery.
          const credPatch = cost.usedTable && !creds.billingTable
            ? { credentials: encryptJson({ ...creds, billingTable: cost.usedTable }) }
            : {};
          // A successful $0 query (billing API works, but no billable spend — free-tier / idle)
          // gets a POSITIVE confirmation note so the UI never confuses it with "not set up".
          const note = billingProvider && cost.total <= 0
            ? `✓ Billing connected — ${cost.currency} 0.00 month-to-date. No billable usage this period (free-tier / idle resources). This is not an error.`
            : '';
          await this.prisma.cloudConnection.update({
            where: { id: conn.id },
            data: { monthlyCost: cost.total, costByService: cost.byService as any, currency: cost.currency, costRefreshedAt: new Date(), costNote: note, ...credPatch, ...restore },
          });
          results.push({ connection: conn.name, provider: conn.provider, total: cost.total, currency: cost.currency, ...(cost.usedTable && !creds.billingTable ? { autoDetectedTable: cost.usedTable } : {}) });
        } else {
          // Cost empty (no billing export / permission not enabled yet) → record the reason in costNote only.
          const note = billingProvider ? this.costGuidance(conn.provider, creds) : '';
          await this.prisma.cloudConnection.update({ where: { id: conn.id }, data: { costRefreshedAt: new Date(), costNote: note, ...restore } }).catch(() => undefined);
          results.push({ connection: conn.name, provider: conn.provider, total: 0, note });
        }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        await this.prisma.cloudConnection.update({ where: { id: conn.id }, data: { costRefreshedAt: new Date(), costNote: msg.slice(0, 300), ...restore } }).catch(() => undefined);
        results.push({ connection: conn.name, provider: conn.provider, error: msg });
      }
    }
    await this.prisma.eventLog.create({ data: { type: 'cost', severity: 'info', title: 'Cloud cost refreshed' } }).catch(() => undefined);
    return { ok: true, results };
  }

  /** Provider-specific, actionable reason why month-to-date cost came back empty. */
  private costGuidance(provider: string, creds: { billingTable?: string } & Record<string, any>): string {
    if (provider === 'aws') return 'AWS cost is empty. Enable Cost Explorer once in the Billing console (Cost Explorer → Enable), and grant ce:GetCostAndUsage to the connection user (re-run the AWS grant script from Help → Cloud Setup). Cost Explorer data lags ~24h.';
    if (provider === 'gcp') return creds.billingTable
      ? `GCP BigQuery cost query failed for table "${creds.billingTable}". Confirm the table exists (billing export is enabled) and the service account has BigQuery Data Viewer + Job User on that project.`
      : 'GCP cost needs a BigQuery billing export. In GCP: Billing → Billing export → BigQuery export (standard usage cost) to a dataset, then set that "project.dataset.table" as the BigQuery billing export table on the GCP connection (Connections → edit).';
    if (provider === 'azure') return 'Azure cost is empty. Grant the app registration Cost Management Reader (or Reader) at the subscription scope.';
    return 'No cost data — enable the provider\'s cost/billing API for the connection.';
  }

  /** Executive overview — KPIs, distribution, security, compliance, cost drivers, incidents. */
  async summary() {
    const [resources, accounts, activeAlerts, findingsSev, conns, events, checklistItems] = await Promise.all([
      this.prisma.resource.findMany({ select: { provider: true, status: true, type: true } }),
      this.prisma.cloudAccount.count(),
      this.prisma.alert.count({ where: { status: { not: 'resolved' } } }),
      this.prisma.securityFinding.groupBy({ by: ['severity'], where: { status: { not: 'resolved' } }, _count: true }),
      this.prisma.cloudConnection.findMany({ select: { provider: true, monthlyCost: true, costByService: true, currency: true, compliance: true } }),
      this.prisma.eventLog.findMany({ where: { type: { in: ['alert', 'control', 'system', 'finding'] } }, orderBy: { ts: 'desc' }, take: 6 }),
      this.prisma.complianceItem.groupBy({ by: ['standard', 'status'], _count: true }),
    ]);

    const sev = (s: string) => (findingsSev.find((f) => f.severity === s)?._count ?? 0);
    const securityOverview = { critical: sev('critical'), high: sev('high'), medium: sev('medium'), low: sev('low') };

    // Real regulatory compliance (Defender) when available, else derived from open findings.
    const realStd = new Map<string, { score: number; passed: number; failed: number; n: number }>();
    for (const c of conns) {
      for (const s of ((c.compliance as { name: string; score: number; passed: number; failed: number }[] | null) ?? [])) {
        const e = realStd.get(s.name) ?? { score: 0, passed: 0, failed: 0, n: 0 };
        e.score += s.score; e.passed += s.passed; e.failed += s.failed; e.n++;
        realStd.set(s.name, e);
      }
    }
    // Editable checklist (ComplianceItem) is the primary source when present.
    const checklist = new Map<string, { passed: number; failed: number }>();
    for (const g of checklistItems) {
      if (g.status === 'na') continue;
      const e = checklist.get(g.standard) ?? { passed: 0, failed: 0 };
      if (g.status === 'passed') e.passed += g._count;
      else if (g.status === 'failed') e.failed += g._count;
      checklist.set(g.standard, e);
    }

    const derivedScore = Math.max(0, Math.min(100, Math.round(100 - securityOverview.critical * 8 - securityOverview.high * 2 - securityOverview.medium * 0.3)));
    let complianceOverview: { name: string; score: number; source: string }[];
    let complianceScore: number;
    if (checklist.size > 0) {
      complianceOverview = [...checklist.entries()].map(([name, e]) => ({ name, score: e.passed + e.failed ? Math.round((e.passed / (e.passed + e.failed)) * 100) : 100, source: 'checklist' })).sort((a, b) => b.score - a.score);
      complianceScore = Math.round(complianceOverview.reduce((s, f) => s + f.score, 0) / complianceOverview.length);
    } else if (realStd.size > 0) {
      complianceOverview = [...realStd.entries()].map(([name, e]) => ({ name, score: Math.round(e.score / e.n), source: 'defender' })).sort((a, b) => b.score - a.score);
      complianceScore = Math.round(complianceOverview.reduce((s, f) => s + f.score, 0) / complianceOverview.length);
    } else {
      const FRAMEWORKS = ['CIS Benchmark', 'ISO 27001', 'PCI DSS', 'HIPAA', 'NIST CSF'];
      complianceOverview = FRAMEWORKS.map((name, i) => ({ name, score: Math.max(0, Math.min(100, derivedScore + ((i * 7) % 9) - 4)), source: 'estimated' }));
      complianceScore = derivedScore;
    }

    // Cloud distribution by resource count.
    const total = resources.length || 1;
    const provCount = new Map<string, number>();
    for (const r of resources) provCount.set(r.provider, (provCount.get(r.provider) ?? 0) + 1);
    const cloudDistribution = [...provCount.entries()].map(([provider, count]) => ({ provider, count, pct: Math.round((count / total) * 1000) / 10 })).sort((a, b) => b.count - a.count);

    // Cost by provider + top cost drivers (by service).
    const costByProvider = new Map<string, number>();
    const costByService = new Map<string, number>();
    let monthlyCost = 0;
    let currency = 'USD';
    let maxConnCost = -1;
    for (const c of conns) {
      monthlyCost += c.monthlyCost ?? 0;
      costByProvider.set(c.provider, (costByProvider.get(c.provider) ?? 0) + (c.monthlyCost ?? 0));
      for (const s of ((c.costByService as { service: string; cost: number }[] | null) ?? [])) costByService.set(s.service, (costByService.get(s.service) ?? 0) + s.cost);
      if ((c.monthlyCost ?? 0) > maxConnCost && c.currency) { maxConnCost = c.monthlyCost ?? 0; currency = c.currency; }
    }
    const costDistribution = [...costByProvider.entries()].map(([provider, cost]) => ({ provider, cost: Math.round(cost * 100) / 100 })).sort((a, b) => b.cost - a.cost);
    const topCostDrivers = [...costByService.entries()].map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 })).sort((a, b) => b.cost - a.cost).slice(0, 5);

    const sevByEvent: Record<string, string> = { critical: 'critical', warning: 'high', info: 'low' };
    const recentIncidents = events.map((e) => ({ title: e.title, severity: sevByEvent[e.severity] ?? 'medium', resourceName: e.resourceName, ts: e.ts.toISOString() }));

    return {
      currency,
      kpis: {
        totalAssets: resources.length,
        runningResources: resources.filter((r) => r.status === 'running').length,
        cloudAccounts: accounts,
        securityAlerts: activeAlerts,
        complianceScore,
        monthlyCost: Math.round(monthlyCost * 100) / 100,
      },
      cloudDistribution,
      costDistribution,
      securityOverview,
      complianceOverview,
      complianceSource: checklist.size > 0 ? 'checklist' : realStd.size > 0 ? 'defender' : 'estimated',
      topCostDrivers,
      recentIncidents,
    };
  }

  async overview() {
    const [accounts, resources, costByType, regions, connections] = await Promise.all([
      this.prisma.cloudAccount.findMany(),
      this.prisma.resource.findMany({ select: { provider: true, type: true, monthlyCost: true, region: true } }),
      this.prisma.resource.groupBy({ by: ['type'], _sum: { monthlyCost: true } }),
      this.prisma.resource.findMany({ select: { region: true }, distinct: ['region'] }),
      this.prisma.cloudConnection.findMany({ select: { monthlyCost: true, costByService: true } }),
    ]);

    // Real cloud cost (from Cost Management / Cost Explorer) when available.
    const realCost = connections.reduce((s, c) => s + (c.monthlyCost ?? 0), 0);
    const totalMonthlyCost = realCost > 0 ? realCost : resources.reduce((s, r) => s + r.monthlyCost, 0);
    const privateNodes = resources.filter((r) => r.provider === 'private').length;

    // Resource distribution by provider, split by type (stacked bars).
    const distribution = PROVIDERS.map((provider) => {
      const forProvider = resources.filter((r) => r.provider === provider);
      const byType: Record<string, number> = {};
      for (const t of DIST_TYPES) byType[t] = forProvider.filter((r) => r.type === t).length;
      return {
        provider,
        total: forProvider.length,
        byType,
      };
    });

    // Cost allocation: prefer REAL cost-by-service from the cloud bill, else resource type.
    let allocation: { service: string; cost: number }[];
    if (realCost > 0) {
      const merged = new Map<string, number>();
      for (const c of connections) {
        for (const s of ((c.costByService as { service: string; cost: number }[] | null) ?? [])) {
          merged.set(s.service, (merged.get(s.service) ?? 0) + s.cost);
        }
      }
      const sorted = [...merged.entries()].map(([service, cost]) => ({ service, cost: Number(cost.toFixed(2)) })).sort((a, b) => b.cost - a.cost);
      const top = sorted.slice(0, 5);
      const other = sorted.slice(5).reduce((s, c) => s + c.cost, 0);
      allocation = other > 0 ? [...top, { service: 'Other', cost: Number(other.toFixed(2)) }] : top;
    } else {
      const known = new Set<string>(['compute', 'storage', 'network', 'database']);
      const costAllocation = costByType.map((c) => ({ service: c.type, cost: Number((c._sum.monthlyCost ?? 0).toFixed(2)) }));
      const other = costAllocation.filter((c) => !known.has(c.service)).reduce((s, c) => s + c.cost, 0);
      const primary = costAllocation.filter((c) => known.has(c.service));
      allocation = [...primary, { service: 'other', cost: Number(other.toFixed(2)) }];
    }

    // Governance & compliance per provider (mock posture derived from status).
    const governance = PROVIDERS.map((provider) => {
      const accs = accounts.filter((a) => a.provider === provider);
      const healthy = accs.filter((a) => a.status === 'connected').length;
      const score = accs.length ? Math.round((healthy / accs.length) * 100) : 100;
      return { provider, score, accounts: accs.length };
    });

    return {
      kpis: {
        totalAccounts: accounts.length,
        activeRegions: regions.length,
        totalResources: resources.length,
        privateCloudNodes: privateNodes,
        monthlyBill: Number(totalMonthlyCost.toFixed(2)),
      },
      distribution,
      costAllocation: allocation,
      governance,
    };
  }

  async accounts() {
    const accounts = await this.prisma.cloudAccount.findMany({ orderBy: { monthlyCost: 'desc' } });
    return accounts.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      accountRef: a.accountRef,
      region: a.region,
      status: a.status,
      resources: a.resourceCount,
      monthlyCost: Number(a.monthlyCost.toFixed(2)),
    }));
  }
}
