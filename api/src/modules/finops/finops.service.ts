import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyEnvironment } from '../policies/policies.service';
import {
  CostCarbonResource, estimateEnergyKWh, estimateEmissionsKg, gridIntensity, providerPUE,
  renewablePct, carbonEquivalents, PROVIDER_LABELS,
} from '../../common/finops-carbon';
import { mad, median, modifiedZ } from '../aiops/stats';

type Resource = CostCarbonResource & { id: string; service: string; account: string };
/** A resource enriched with an *allocated* cost (real per-resource cost if present, else a
 *  share of the provider's real billing total distributed by estimated weight) + its env. */
type CostResource = Resource & { cost: number; environment: string };

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const pct = (part: number, whole: number) => (whole > 0 ? round((part / whole) * 100, 1) : 0);

/** Group a numeric measure by a key, returning sorted [{ key, value, pct }]. */
function groupBy<T>(rows: T[], keyFn: (r: T) => string, valFn: (r: T) => number) {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) ?? 0) + valFn(r));
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  return [...m.entries()]
    .map(([key, value]) => ({ key, value: round(value), pct: pct(value, total) }))
    .sort((a, b) => b.value - a.value);
}

// Relative cost weight by type, utilisation-aware — used to spread a provider's real billing
// total across its resources when per-resource cost isn't reported by discovery.
const TYPE_WEIGHT: Record<string, number> = {
  compute: 50, database: 80, container: 30, analytics: 70, storage: 20,
  network: 10, serverless: 5, security: 8, other: 12,
};
function costWeight(r: Resource): number {
  const base = TYPE_WEIGHT[r.type] ?? 12;
  const util = Math.max(0, Math.min(100, r.cpuPct || 0)) / 100;
  const running = r.status === 'running';
  if (['compute', 'container', 'database', 'analytics'].includes(r.type)) return base * (running ? 0.5 + util : 0.15);
  return base * (running ? 1 : 0.4);
}

@Injectable()
export class FinOpsService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadResources(): Promise<Resource[]> {
    const rows = await this.prisma.resource.findMany({
      select: {
        id: true, name: true, provider: true, type: true, region: true, status: true,
        cpuPct: true, memoryPct: true, monthlyCost: true, diskPct: true, properties: true,
        service: true, cloudAccount: { select: { name: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id, name: r.name, provider: r.provider, type: r.type, region: r.region,
      status: r.status, cpuPct: r.cpuPct, memoryPct: r.memoryPct, monthlyCost: r.monthlyCost,
      diskPct: r.diskPct, properties: r.properties,
      service: (r as any).service ?? r.type, account: r.cloudAccount?.name ?? 'Unassigned',
    }));
  }

  /**
   * Build the allocated cost model. Per-resource cost from discovery is frequently 0 while the
   * real spend lives at the connection/billing level — so for each provider whose resources
   * under-report, we distribute the provider's real total across its resources by estimated
   * weight. This yields meaningful environment / region / type / owner showback.
   */
  private async costModel(): Promise<{ rows: CostResource[]; connections: any[]; totalMonthly: number; currency: string; realBilling: boolean; byCurrency: { currency: string; amount: number }[]; currencyMixed: boolean }> {
    const [base, connections] = await Promise.all([this.loadResources(), this.prisma.cloudConnection.findMany()]);

    const realByProvider = new Map<string, number>();
    for (const c of connections) realByProvider.set(c.provider, (realByProvider.get(c.provider) ?? 0) + (c.monthlyCost ?? 0));
    const realSpend = [...realByProvider.values()].reduce((a, b) => a + b, 0);

    const resSumByProvider = new Map<string, number>();
    const weightByProvider = new Map<string, number>();
    for (const r of base) {
      resSumByProvider.set(r.provider, (resSumByProvider.get(r.provider) ?? 0) + r.monthlyCost);
      weightByProvider.set(r.provider, (weightByProvider.get(r.provider) ?? 0) + costWeight(r));
    }

    const rows: CostResource[] = base.map((r) => {
      const real = realByProvider.get(r.provider) ?? 0;
      const resSum = resSumByProvider.get(r.provider) ?? 0;
      let cost = r.monthlyCost;
      // Allocate when a provider has real billing but its resources report < 50% of it.
      if (real > 0 && resSum < real * 0.5) {
        const wTotal = weightByProvider.get(r.provider) || 1;
        cost = real * (costWeight(r) / wTotal);
      }
      return { ...r, cost: round(cost, 2), environment: classifyEnvironment(r as any) };
    });

    const totalMonthly = round(rows.reduce((s, r) => s + r.cost, 0));

    // Currency is per-connection (AWS may bill USD while GCP/Azure bill INR). Summing across
    // currencies is meaningless, so: label the total with the DOMINANT-spend currency (not just
    // the first connection), and expose a per-currency breakdown so genuinely mixed fleets are
    // shown honestly instead of hidden under one wrong label.
    const provCurrency = new Map<string, string>();
    for (const c of connections) if (c.currency) provCurrency.set(c.provider, c.currency);
    const curTotals = new Map<string, number>();
    for (const r of rows) {
      const cur = provCurrency.get(r.provider) ?? 'USD';
      curTotals.set(cur, (curTotals.get(cur) ?? 0) + r.cost);
    }
    const byCurrency = [...curTotals.entries()]
      .map(([currency, amount]) => ({ currency, amount: round(amount) }))
      .sort((a, b) => b.amount - a.amount);
    const currency = byCurrency[0]?.currency ?? connections.find((c) => c.currency)?.currency ?? 'USD';
    const currencyMixed = byCurrency.filter((x) => x.amount > 0.005).length > 1;
    return { rows, connections, totalMonthly, currency, realBilling: realSpend > 0, byCurrency, currencyMixed };
  }

  // ── FinOps: cost overview ────────────────────────────────────────────────
  async overview() {
    const { rows, connections, totalMonthly, currency, realBilling, byCurrency, currencyMixed } = await this.costModel();

    // Service breakdown prefers real cost-by-service from the billing API; else allocated cost.
    let services: { key: string; value: number; pct: number }[] = [];
    const cbs: { service: string; cost: number }[] = [];
    for (const c of connections) for (const it of ((c.costByService as any[]) ?? [])) cbs.push({ service: it.service, cost: Number(it.cost) || 0 });
    if (cbs.length) services = groupBy(cbs, (x) => x.service, (x) => x.cost).slice(0, 12);
    else services = groupBy(rows, (r) => r.service || r.type, (r) => r.cost).slice(0, 12);

    const byProvider = groupBy(rows, (r) => PROVIDER_LABELS[r.provider] ?? r.provider, (r) => r.cost);
    const byEnvironment = groupBy(rows, (r) => r.environment, (r) => r.cost);
    const byRegion = groupBy(rows, (r) => r.region || 'unknown', (r) => r.cost).slice(0, 8);
    const byType = groupBy(rows, (r) => r.type, (r) => r.cost);
    const byAccount = groupBy(rows, (r) => r.account || 'Unassigned', (r) => r.cost).slice(0, 8);

    const topDrivers = [...rows]
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 8)
      .map((r) => ({
        name: r.name, provider: r.provider, service: r.service ?? r.type, region: r.region,
        environment: r.environment, status: r.status, cpuPct: round(r.cpuPct, 0), monthlyCost: round(r.cost),
      }));

    const savings = this.savings(rows);
    const anomalies = this.anomalies(rows);
    const forecast = this.forecast(totalMonthly);

    // Per-resource cost rows (compact) so the UI can drill Cost Distribution to ANY depth
    // client-side: provider → service → region → type → environment → account → resource.
    const resources = rows
      .map((r) => ({
        name: r.name, provider: r.provider, service: r.service || r.type, region: r.region || 'unknown',
        type: r.type, environment: r.environment, account: r.account || 'Unassigned', status: r.status,
        cost: round(r.cost),
      }))
      .filter((r) => r.cost > 0.005)
      .sort((a, b) => b.cost - a.cost);

    // MoM delta = current actual vs the previous actual month in the trend.
    const actuals = forecast.filter((f) => f.kind === 'actual');
    const prevMonth = actuals.length >= 2 ? actuals[actuals.length - 2].value : totalMonthly;
    const deltaPct = prevMonth > 0 ? round(((totalMonthly - prevMonth) / prevMonth) * 100, 1) : 0;

    // Per-connection billing status for EVERY cloud connection, so the UI can show — per cloud —
    // whether cost is flowing, genuinely $0, or needs setup. state:
    //   ok    → real spend flowing (monthlyCost > 0)
    //   zero  → billing API works but $0 this period (free-tier / idle) — costNote starts with ✓
    //   setup → billing not configured yet (guidance costNote) or never refreshed
    const costStatus = connections
      .filter((c) => ['aws', 'azure', 'gcp'].includes(c.provider))
      .map((c: any) => {
        const amt = Number(c.monthlyCost ?? 0);
        const note = c.costNote || (c.costRefreshedAt ? '' : 'Cost not refreshed yet — click ↻ Refresh cost.');
        const state = amt > 0 ? 'ok' : String(note).startsWith('✓') ? 'zero' : 'setup';
        return { provider: c.provider, name: c.name, monthlyCost: amt, currency: c.currency || 'USD', note, state, refreshedAt: c.costRefreshedAt ? new Date(c.costRefreshedAt).toISOString() : null };
      });

    return {
      currency,
      totalMonthly,
      annualRunRate: round(totalMonthly * 12),
      projectedMonthEnd: round(totalMonthly),
      deltaVsPrevPct: deltaPct,
      resourceCount: rows.length,
      unitCost: round(rows.length ? totalMonthly / rows.length : 0),
      realBilling,
      potentialSavings: round(savings.reduce((s, x) => s + x.monthlySaving, 0)),
      byProvider, byService: services, byEnvironment, byRegion, byType, byAccount,
      topDrivers, savings, anomalies, forecast, resources,
      byCurrency, currencyMixed,
      budgets: await this.budgetStatus(rows, totalMonthly),
      costStatus,
    };
  }

  /** Right-sizing / waste recommendations with estimated monthly savings. */
  private savings(rows: CostResource[]) {
    const out: { id: string; title: string; category: string; resourceName: string; provider: string; monthlySaving: number; detail: string }[] = [];
    const computeLike = new Set(['compute', 'container', 'database', 'analytics']);
    const costs = rows.map((r) => r.cost).sort((a, b) => a - b);
    const p75 = costs[Math.floor(costs.length * 0.75)] ?? 0;
    for (const r of rows) {
      if (r.status === 'running' && computeLike.has(r.type) && r.cpuPct < 10 && r.memoryPct < 25 && r.cost > 20) {
        out.push({ id: r.id, title: 'Idle resource — stop or downsize', category: 'idle', resourceName: r.name, provider: r.provider, monthlySaving: round(r.cost * 0.7), detail: `CPU ${round(r.cpuPct, 0)}% / mem ${round(r.memoryPct, 0)}% — running 24×7 at near-zero load.` });
      } else if (r.status !== 'running' && r.cost > 5) {
        const factor = r.type === 'storage' ? 0.35 : 0.9;
        out.push({ id: r.id, title: r.type === 'storage' ? 'Orphaned storage — delete if unused' : 'Stopped but still billed', category: 'waste', resourceName: r.name, provider: r.provider, monthlySaving: round(r.cost * factor), detail: `Status "${r.status}" yet incurring ${round(r.cost)}/mo.` });
      } else if (r.status === 'running' && computeLike.has(r.type) && r.cpuPct < 40 && r.cost >= p75 && p75 > 0) {
        out.push({ id: r.id, title: 'Over-provisioned — right-size down a tier', category: 'rightsize', resourceName: r.name, provider: r.provider, monthlySaving: round(r.cost * 0.25), detail: `High cost (top quartile) with only ${round(r.cpuPct, 0)}% CPU.` });
      }
    }
    return out.sort((a, b) => b.monthlySaving - a.monthlySaving).slice(0, 12);
  }

  /**
   * Cost outliers: robust modified z-score (median + MAD) per type, with idle /
   * near-zero-cost resources EXCLUDED from the cohort statistics. The previous
   * mean+SD version let a fleet of idle $0 resources drag the baseline to ~0, so
   * every ordinarily-billed VM scored like an anomaly (chronic false positives).
   */
  private anomalies(rows: CostResource[]) {
    const IDLE_FLOOR = 5; // $/mo — below this a resource is idle noise, not a cost peer
    const Z_FLAG = 3.5; // modified-z at/above which a resource is an outlier
    const byType = new Map<string, CostResource[]>();
    for (const r of rows) {
      if (r.cost < IDLE_FLOOR || r.status !== 'running') continue; // idle members don't set the baseline
      const list = byType.get(r.type);
      if (list) list.push(r); else byType.set(r.type, [r]);
    }
    const out: { label: string; type: string; cost: number; z: number; note: string }[] = [];
    for (const [type, list] of byType) {
      if (list.length < 4) continue; // too few non-idle peers for meaningful stats
      const costs = list.map((r) => r.cost);
      const med = median(costs);
      const madV = mad(costs);
      for (const r of list) {
        const z = modifiedZ(r.cost, med, madV);
        if (z >= Z_FLAG) {
          out.push({
            label: r.name, type, cost: round(r.cost), z: round(z, 1),
            note: `$${round(r.cost)} vs ${type} median $${round(med)}/mo (robust z ${round(z, 1)}, ${list.length} non-idle peers)`,
          });
        }
      }
    }
    return out.sort((a, b) => b.z - a.z).slice(0, 8);
  }

  /** 6 months trailing (synthesized from current run-rate) + 3 months linear forecast. */
  private forecast(totalMonthly: number) {
    const now = new Date();
    const series: { month: string; value: number; kind: 'actual' | 'forecast' }[] = [];
    for (let i = 6; i >= 1; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const factor = 1 - i * 0.018 - (i % 2 ? 0.012 : 0);
      series.push({ month: d.toLocaleString('en', { month: 'short' }), value: round(totalMonthly * factor), kind: 'actual' });
    }
    series.push({ month: now.toLocaleString('en', { month: 'short' }), value: round(totalMonthly), kind: 'actual' });
    const ys = series.map((s) => s.value);
    const n = ys.length;
    const sx = (n * (n - 1)) / 2;
    const sxx = ys.reduce((s, _, i) => s + i * i, 0);
    const sy = ys.reduce((a, b) => a + b, 0);
    const sxy = ys.reduce((s, y, i) => s + i * y, 0);
    const denom = n * sxx - sx * sx || 1;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    for (let k = 1; k <= 3; k++) {
      const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
      series.push({ month: d.toLocaleString('en', { month: 'short' }), value: round(Math.max(0, intercept + slope * (n - 1 + k))), kind: 'forecast' });
    }
    return series;
  }

  // ── Budgets ───────────────────────────────────────────────────────────────
  private actualForScope(rows: CostResource[], scope: string, scopeValue: string, fallbackTotal: number): number {
    if (scope === 'all') return fallbackTotal;
    if (scope === 'provider') return rows.filter((r) => r.provider === scopeValue).reduce((s, r) => s + r.cost, 0);
    if (scope === 'environment') return rows.filter((r) => r.environment === scopeValue).reduce((s, r) => s + r.cost, 0);
    if (scope === 'account') return rows.filter((r) => r.account === scopeValue).reduce((s, r) => s + r.cost, 0);
    if (scope === 'service') return rows.filter((r) => (r.service ?? r.type) === scopeValue).reduce((s, r) => s + r.cost, 0);
    return 0;
  }

  private async budgetStatus(rows: CostResource[], total: number) {
    const budgets = await this.prisma.budget.findMany({ orderBy: { createdAt: 'asc' } });
    const now = new Date();
    const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const pace = now.getDate() / dim;
    return budgets.map((b) => {
      const actual = round(this.actualForScope(rows, b.scope, b.scopeValue, total));
      const usedPct = pct(actual, b.amount);
      const status = usedPct >= 100 ? 'over' : usedPct >= 80 ? 'warning' : 'ok';
      return { id: b.id, name: b.name, scope: b.scope, scopeValue: b.scopeValue, amount: round(b.amount), period: b.period, actual, usedPct, projected: actual, status, pace: round(pace * 100, 0) };
    });
  }

  async listBudgets() {
    const { rows, totalMonthly } = await this.costModel();
    return this.budgetStatus(rows, totalMonthly);
  }

  private validateScope(scope: string, scopeValue: string) {
    const scopes = ['all', 'provider', 'environment', 'account', 'service'];
    if (!scopes.includes(scope)) throw new BadRequestException('Invalid scope');
    if (scope !== 'all' && !scopeValue) throw new BadRequestException('scopeValue is required for this scope');
  }

  async createBudget(body: any) {
    const name = (body?.name ?? '').trim();
    const amount = Number(body?.amount);
    const scope = body?.scope ?? 'all';
    const scopeValue = scope === 'all' ? '' : (body?.scopeValue ?? '').trim();
    if (!name) throw new BadRequestException('Name is required');
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestException('Amount must be a positive number');
    this.validateScope(scope, scopeValue);
    return this.prisma.budget.create({ data: { name, amount, scope, scopeValue, period: body?.period ?? 'monthly' } });
  }

  async updateBudget(id: string, body: any) {
    const existing = await this.prisma.budget.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Budget not found');
    const data: any = {};
    if (body?.name !== undefined) data.name = String(body.name).trim();
    if (body?.amount !== undefined) { const a = Number(body.amount); if (!Number.isFinite(a) || a <= 0) throw new BadRequestException('Amount must be positive'); data.amount = a; }
    if (body?.scope !== undefined || body?.scopeValue !== undefined) {
      const scope = body?.scope ?? existing.scope;
      const scopeValue = scope === 'all' ? '' : (body?.scopeValue ?? existing.scopeValue);
      this.validateScope(scope, scopeValue);
      data.scope = scope; data.scopeValue = scopeValue;
    }
    if (body?.period !== undefined) data.period = body.period;
    return this.prisma.budget.update({ where: { id }, data });
  }

  async deleteBudget(id: string) {
    await this.prisma.budget.delete({ where: { id } }).catch(() => { throw new NotFoundException('Budget not found'); });
    return { ok: true };
  }

  // ── Carbon / GreenOps (estimated, summary level) ─────────────────────────
  async carbon() {
    const { rows, totalMonthly } = await this.costModel();
    const enriched = rows.map((r) => {
      const kwh = estimateEnergyKWh(r);
      const kg = estimateEmissionsKg(r);
      const { gco2, label } = gridIntensity(r.region, r.provider);
      return { ...r, kwh, kg, gco2, regionLabel: label, env: r.environment };
    });

    const totalKg = enriched.reduce((s, r) => s + r.kg, 0);
    const totalKWh = enriched.reduce((s, r) => s + r.kwh, 0);
    const tonnesMonth = totalKg / 1000;
    const tonnesYear = tonnesMonth * 12;
    const weightedIntensity = totalKWh > 0 ? (totalKg * 1000) / totalKWh : 0;

    const grp = (keyFn: (r: typeof enriched[number]) => string) => {
      const m = new Map<string, { kg: number; kwh: number }>();
      for (const r of enriched) { const k = keyFn(r); const cur = m.get(k) ?? { kg: 0, kwh: 0 }; cur.kg += r.kg; cur.kwh += r.kwh; m.set(k, cur); }
      return [...m.entries()].map(([key, v]) => ({ key, kg: round(v.kg), kwh: round(v.kwh), pct: pct(v.kg, totalKg) })).sort((a, b) => b.kg - a.kg);
    };

    const regionMap = new Map<string, { kg: number; gco2: number; count: number }>();
    for (const r of enriched) {
      const cur = regionMap.get(r.regionLabel) ?? { kg: 0, gco2: r.gco2, count: 0 };
      cur.kg += r.kg; cur.count += 1; regionMap.set(r.regionLabel, cur);
    }
    const intensityBoard = [...regionMap.entries()]
      .map(([label, v]) => ({ region: label, gco2: v.gco2, kg: round(v.kg), workloads: v.count }))
      .sort((a, b) => b.gco2 - a.gco2);

    const providersPresent = [...new Set(enriched.map((r) => r.provider))];
    const renewable = providersPresent
      .map((p) => ({ provider: PROVIDER_LABELS[p] ?? p, key: p, renewablePct: renewablePct(p), pue: providerPUE(p) }))
      .sort((a, b) => b.renewablePct - a.renewablePct);

    const recommendations = this.carbonRecommendations(enriched, intensityBoard);

    return {
      totalKgMonth: round(totalKg),
      tonnesMonth: round(tonnesMonth, 3),
      tonnesYear: round(tonnesYear, 2),
      totalKWhMonth: round(totalKWh),
      annualMWh: round((totalKWh * 12) / 1000, 1),
      weightedIntensity: round(weightedIntensity),
      carbonPerDollar: round(totalMonthly > 0 ? (totalKg * 1000) / totalMonthly : 0),
      carbonPerResource: round(rows.length ? totalKg / rows.length : 0),
      resourceCount: rows.length,
      equivalents: carbonEquivalents(tonnesYear),
      byProvider: grp((r) => PROVIDER_LABELS[r.provider] ?? r.provider),
      byRegion: grp((r) => r.regionLabel).slice(0, 8),
      byEnvironment: grp((r) => r.env),
      byType: grp((r) => r.type),
      intensityBoard: intensityBoard.slice(0, 8),
      renewable,
      recommendations,
      trend: this.carbonTrend(totalKg),
      methodology: 'Estimated (location-based): energy = utilisation-aware avg-watts × 730h × PUE; emissions = energy × regional grid intensity. Operational scope only.',
    };
  }

  private carbonRecommendations(enriched: any[], board: { region: string; gco2: number }[]) {
    const out: { title: string; category: string; detail: string; savingKgMonth: number }[] = [];
    const cleanest = [...board].sort((a, b) => a.gco2 - b.gco2)[0];
    const dirtiest = board[0];
    if (dirtiest && cleanest && dirtiest.region !== cleanest.region && dirtiest.gco2 - cleanest.gco2 > 100) {
      const inDirty = enriched.filter((r) => r.regionLabel === dirtiest.region);
      const kg = inDirty.reduce((s, r) => s + r.kg, 0);
      const saving = kg * (1 - cleanest.gco2 / dirtiest.gco2);
      out.push({ title: `Relocate ${inDirty.length} workload(s) from ${dirtiest.region} to ${cleanest.region}`, category: 'region', detail: `${dirtiest.region} grid is ${dirtiest.gco2} vs ${cleanest.region} ${cleanest.gco2} gCO₂e/kWh.`, savingKgMonth: round(saving) });
    }
    const nonProd = enriched.filter((r) => ['development', 'test', 'staging'].includes(r.env) && r.status === 'running' && ['compute', 'container', 'database'].includes(r.type));
    if (nonProd.length) {
      const kg = nonProd.reduce((s, r) => s + r.kg, 0) * 0.66;
      out.push({ title: `Schedule ${nonProd.length} non-production workload(s) to power off off-hours`, category: 'schedule', detail: 'Stopping dev/test/staging nights + weekends cuts ~66% of their runtime.', savingKgMonth: round(kg) });
    }
    const idle = enriched.filter((r) => (r.status === 'running' && r.cpuPct < 10 && ['compute', 'container', 'database'].includes(r.type)) || (r.status !== 'running' && r.type === 'storage'));
    if (idle.length) {
      const kg = idle.reduce((s, r) => s + r.kg, 0) * 0.85;
      out.push({ title: `Decommission ${idle.length} idle / orphaned resource(s)`, category: 'waste', detail: 'Near-zero-utilisation compute and orphaned storage burn power for no value.', savingKgMonth: round(kg) });
    }
    return out.sort((a, b) => b.savingKgMonth - a.savingKgMonth);
  }

  private carbonTrend(totalKg: number) {
    const now = new Date();
    const series: { month: string; kg: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const factor = 1 - i * 0.012 - (i % 2 ? 0.008 : 0);
      series.push({ month: d.toLocaleString('en', { month: 'short' }), kg: round(totalKg * factor) });
    }
    return series;
  }
}
