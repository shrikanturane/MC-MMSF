/**
 * AIOps anomaly engine (v2) — orchestrates the pure detectors over live telemetry.
 *
 *   ClickHouse mcmf.metrics (fed each alerting tick)  ──►  detectors (pure, deterministic)
 *   fallback: Resource.metricHistory (≤90 pts)        ──►  AnomalyDetection rows (Postgres)
 *
 * High-severity statistical findings raise an IN-APP Alert only; external channels
 * (email/WhatsApp) fire when — and only when — an operator confirms the detection
 * (the human approval gate). Threshold signals never double-alert: the user-owned
 * AlertRule engine keeps alert delivery for capacity rules.
 *
 * Validation suite (thesis tests): the labelled eval harness supports batch trials
 * (2.2), multiple resource types with per-type MTTD (2.5), a threshold sweep that
 * produces precision-recall curve points (2.6), and a declared-suppression case
 * proving legitimate sustained load is not flagged (2.4). Suppression windows also
 * apply to the LIVE scan (Settings-managed, IntegrationSetting JSON).
 */
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { sysParams, pInt } from '../../system-params';
import { CH_DB, chInsertRows, chQuery, chTs } from '../../common/clickhouse';
import { AlertingEngine } from '../alerting/alerting.engine';
import { detectCost, type CohortPeer, type CostDetectorCfg } from './detectors/cost.detector';
import { detectBehaviour, type BehaviourDetectorCfg } from './detectors/behaviour.detector';
import { detectThreshold } from './detectors/threshold.detector';
import type { Detection } from './detectors/types';
import { scoreTrial, type TrialLabel, type TrialReport } from './eval';
import { correlateAlerts, type CorrGroup } from './correlation';
import { matchSuppression, parseSuppressions, type SuppressionWindow } from './suppression';

const DEDUP_HOURS = 6; // don't re-open an unreviewed finding for the same resource+detector+metric
const EVAL_TITLE = 'AIOps eval trial'; // EventLog marker for persisted trial reports
const SUPPRESSION_KEY = 'aiops.suppressions'; // IntegrationSetting key

interface MetricRow {
  ts: string; // 'YYYY-MM-DD HH:MM:SS'
  resource_id: string;
  cpu: number;
  net: number;
  disk: number;
  cost_hourly: number;
}

interface ScanResource {
  id: string;
  name: string;
  provider: string;
  type: string;
  service: string;
  status: string;
  cpuPct: number | null;
  diskPct: number | null;
  monthlyCost: number | null;
  metricHistory?: unknown;
}

interface DetectCfg {
  cost?: Partial<CostDetectorCfg>;
  behaviour?: Partial<BehaviourDetectorCfg>;
}

interface ScanOpts {
  source: 'live' | 'eval';
  resourceIds?: string[]; // eval: restrict to trial resources
  cursor?: Date; // eval: evaluate "as of" this instant (MTTD stepping)
  rows?: MetricRow[]; // eval fallback: in-memory series when ClickHouse is down
  suppressions?: SuppressionWindow[]; // eval: trial-scoped windows (live scan loads config)
}

export interface EvalParams {
  seed?: number;
  /** Repeat the trial N times (seed, seed+1, …) and aggregate — thesis 2.2 (≥30 trials). */
  trials?: number;
  /** Resource types to provision pairs for — thesis 2.5 (MTTD by type). */
  resourceTypes?: ('compute' | 'storage' | 'database')[];
  /** Also sweep the z-threshold and emit precision-recall curve points — thesis 2.6. */
  sweep?: boolean;
}

/** Deterministic PRNG (mulberry32) so eval trials are reproducible from a seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
};

// ── Trial scenario (shared by the persisted trial, the batch trials and the sweep) ──

interface TrialResourceSpec {
  key: string; // stable within the trial, becomes externalId suffix
  name: string;
  provider: string;
  type: 'compute' | 'storage' | 'database';
  service: string;
  anomalous: boolean;
  kind: 'cost' | 'behaviour' | 'batch-legit'; // batch-legit = suppressed legitimate spike (2.4)
}

function trialSpecs(types: ('compute' | 'storage' | 'database')[]): TrialResourceSpec[] {
  const providers = ['aws', 'azure', 'gcp'] as const;
  const specs: TrialResourceSpec[] = [];
  for (const type of types) {
    const service = `Eval ${type} (std-class)`;
    providers.forEach((p, i) => {
      specs.push({ key: `${type}-normal-${i}`, name: `eval-${type}-normal-${i}`, provider: p, type, service, anomalous: false, kind: 'cost' });
      specs.push({ key: `${type}-anom-${i}`, name: `eval-${type}-anom-${i}`, provider: p, type, service, anomalous: true, kind: 'cost' });
    });
  }
  if (types.includes('compute')) {
    // Behavioural pair (sustained cpu/net deviation) + the declared-legitimate batch spike.
    specs.push({ key: 'beh-normal', name: 'eval-beh-normal', provider: 'aws', type: 'compute', service: 'Eval compute (std-class)', anomalous: false, kind: 'behaviour' });
    specs.push({ key: 'beh-anom', name: 'eval-beh-anom', provider: 'aws', type: 'compute', service: 'Eval compute (std-class)', anomalous: true, kind: 'behaviour' });
    specs.push({ key: 'batch-legit', name: 'eval-batch-legit', provider: 'azure', type: 'compute', service: 'Eval compute (std-class)', anomalous: false, kind: 'batch-legit' });
  }
  return specs;
}

/** Deterministic 14-day series for one trial resource (hourly + minute tail). */
function generateSeries(spec: TrialResourceSpec, rid: string, start: Date, end: Date, injectedAt: Date, rand: () => number): MetricRow[] {
  const rows: MetricRow[] = [];
  const baseCost = 0.5;
  const baseCpu = 30;
  const baseNet = 120;
  const sample = (ts: Date): MetricRow => {
    const active = ts >= injectedAt && (spec.anomalous || spec.kind === 'batch-legit');
    const costX = active && spec.anomalous && spec.kind === 'cost' ? 3.5 : 1;
    const behX = active && (spec.kind === 'behaviour' || spec.kind === 'batch-legit') ? 3.1 : 1;
    return {
      ts: chTs(ts),
      resource_id: rid,
      cpu: Math.min(99, baseCpu * behX + (rand() - 0.5) * 4),
      net: baseNet * (behX > 1 ? 3 : 1) + (rand() - 0.5) * 10,
      disk: 55 + (rand() - 0.5) * 2,
      cost_hourly: baseCost * costX * (1 + (rand() - 0.5) * 0.04),
    };
  };
  for (let h = 0; h < 14 * 24; h++) rows.push(sample(new Date(start.getTime() + h * 3600_000)));
  for (let m = 6 * 60; m > 0; m--) rows.push(sample(new Date(end.getTime() - m * 60_000)));
  return rows;
}

@Injectable()
export class AiopsService implements OnModuleInit {
  private readonly log = new Logger('Aiops');
  private chReady = false;
  private scanning = false;
  private suppressionCache: { at: number; windows: SuppressionWindow[] } = { at: 0, windows: [] };

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerting: AlertingEngine,
  ) {}

  onModuleInit() {
    setTimeout(() => void this.ensureMetricsTable().catch((e) => this.log.warn(`metrics table deferred: ${String((e as Error)?.message ?? e)}`)), 15_000);
    setTimeout(() => void this.scanLoop(), 45_000);
  }

  /** Idempotent mcmf.metrics store (same pattern as the mcmf.logs table). */
  async ensureMetricsTable(): Promise<void> {
    await chQuery(`CREATE DATABASE IF NOT EXISTS ${CH_DB}`);
    await chQuery(
      `CREATE TABLE IF NOT EXISTS ${CH_DB}.metrics (` +
        `ts DateTime, resource_id String, provider LowCardinality(String), rtype LowCardinality(String), ` +
        `service LowCardinality(String), region String, status LowCardinality(String), ` +
        `cpu Float32, mem Float32, disk Float32, net Float32, cost_hourly Float32` +
        `) ENGINE = MergeTree ORDER BY (resource_id, ts) ` +
        `TTL ts + INTERVAL 30 DAY SETTINGS index_granularity = 8192`,
    );
    if (!this.chReady) this.log.log(`ClickHouse metrics store ready (${CH_DB}.metrics, 30d TTL)`);
    this.chReady = true;
  }

  /** Self-rescheduling scan loop — interval is operator-tunable (System Parameters: anomalyScanSec). */
  private async scanLoop(): Promise<void> {
    try {
      await this.scan({ source: 'live' });
    } catch (err) {
      this.log.warn(`scan failed: ${String((err as Error)?.message ?? err)}`);
    }
    const sec = pInt(await sysParams(this.prisma), 'anomalyScanSec', 'ANOMALY_SCAN_SEC', 300);
    setTimeout(() => void this.scanLoop(), Math.max(30, sec) * 1000);
  }

  // ── Suppression windows (declared legitimate load — thesis 2.4) ───────────

  async getSuppressions(): Promise<SuppressionWindow[]> {
    const row = await this.prisma.integrationSetting.findUnique({ where: { key: SUPPRESSION_KEY } });
    return parseSuppressions(row?.value);
  }

  async setSuppressions(windows: unknown): Promise<SuppressionWindow[]> {
    const clean = parseSuppressions(JSON.stringify(windows ?? []));
    await this.prisma.integrationSetting.upsert({
      where: { key: SUPPRESSION_KEY },
      update: { value: JSON.stringify(clean) },
      create: { key: SUPPRESSION_KEY, value: JSON.stringify(clean), secret: false },
    });
    this.suppressionCache = { at: 0, windows: [] }; // apply immediately
    return clean;
  }

  private async liveSuppressions(): Promise<SuppressionWindow[]> {
    if (Date.now() - this.suppressionCache.at < 30_000) return this.suppressionCache.windows;
    const windows = await this.getSuppressions().catch(() => [] as SuppressionWindow[]);
    this.suppressionCache = { at: Date.now(), windows };
    return windows;
  }

  // ── Detection core (in-memory; scan persists, harness/sweep reuse it dry) ──

  /** Group + bucket the series once per scan. */
  private buildSeries(rows: MetricRow[]): { byResource: Map<string, MetricRow[]>; costBuckets: Map<string, { ts: string; cost: number }[]> } {
    const byResource = new Map<string, MetricRow[]>();
    for (const row of rows) {
      const list = byResource.get(row.resource_id) ?? [];
      list.push(row);
      byResource.set(row.resource_id, list);
    }
    const costBuckets = new Map<string, { ts: string; cost: number }[]>();
    for (const [rid, list] of byResource) {
      const byHour = new Map<string, { sum: number; n: number }>();
      for (const row of list) {
        const hour = row.ts.slice(0, 13);
        const b = byHour.get(hour) ?? { sum: 0, n: 0 };
        b.sum += row.cost_hourly;
        b.n++;
        byHour.set(hour, b);
      }
      costBuckets.set(
        rid,
        [...byHour.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([h, b]) => ({ ts: h, cost: b.sum / b.n })),
      );
    }
    return { byResource, costBuckets };
  }

  /** Run all three detectors over prepared series — pure w.r.t. the DB. */
  private detectAll(
    resources: ScanResource[],
    byResource: Map<string, MetricRow[]>,
    costBuckets: Map<string, { ts: string; cost: number }[]>,
    cursor: Date,
    cfg?: DetectCfg,
  ): Detection[] {
    const nowIso = cursor.toISOString();
    const cursorTs = chTs(cursor);
    const upTo = (rid: string) => (byResource.get(rid) ?? []).filter((r) => r.ts <= cursorTs);
    const bucketsUpTo = (rid: string) => (costBuckets.get(rid) ?? []).filter((b) => b.ts <= cursorTs.slice(0, 13));
    const currentCost = (r: ScanResource): number => {
      const buckets = bucketsUpTo(r.id);
      if (buckets.length) return (buckets[buckets.length - 1] as { cost: number }).cost;
      return (r.monthlyCost ?? 0) / 730;
    };

    const detections: Detection[] = [];
    for (const r of resources) {
      const peers: CohortPeer[] = resources
        .filter((p) => p.id !== r.id && p.type === r.type && p.service === r.service && p.provider === r.provider)
        .map((p) => ({ resourceId: p.id, status: String(p.status), costHourly: currentCost(p) }));

      const buckets = bucketsUpTo(r.id);
      const cost = detectCost({
        resource: {
          id: r.id, name: r.name, provider: String(r.provider), type: String(r.type),
          service: r.service, status: String(r.status), costHourly: currentCost(r),
        },
        selfHourlyBuckets: buckets.slice(0, -1), // history excludes the bucket under test
        cohort: peers,
        nowIso,
        cfg: cfg?.cost,
      });
      if (cost) detections.push(cost);

      // Behaviour: series samples; fallback to the capped metricHistory JSON.
      const series = upTo(r.id);
      const src = series.length
        ? { cpu: series.map((s) => s.cpu), net: series.map((s) => s.net), disk: series.map((s) => s.disk) }
        : this.historyFallback(r.metricHistory);
      for (const metric of ['cpu', 'net', 'disk'] as const) {
        const values = src[metric].slice(-240);
        const hit = detectBehaviour({
          resourceId: r.id, resourceName: r.name, provider: String(r.provider), metric, values, nowIso, cfg: cfg?.behaviour,
        });
        if (hit) detections.push(hit);
      }

      // Threshold / capacity signals — latest observed values, clearly rule-labelled.
      const latest = series.length ? (series[series.length - 1] as MetricRow) : null;
      detections.push(
        ...detectThreshold({
          resourceId: r.id, resourceName: r.name, provider: String(r.provider),
          latest: { cpu: latest ? latest.cpu : (r.cpuPct ?? 0), disk: latest ? latest.disk : (r.diskPct ?? 0) },
          nowIso,
        }),
      );
    }
    return detections;
  }

  // ── Detection scan (persisting) ────────────────────────────────────────────

  async scan(opts: ScanOpts): Promise<{ created: number; suppressed: number; resources: number; chUsed: boolean }> {
    if (opts.source === 'live') {
      if (this.scanning) return { created: 0, suppressed: 0, resources: 0, chUsed: this.chReady };
      this.scanning = true;
    }
    try {
      return await this.runScan(opts);
    } finally {
      if (opts.source === 'live') this.scanning = false;
    }
  }

  private async runScan(opts: ScanOpts): Promise<{ created: number; suppressed: number; resources: number; chUsed: boolean }> {
    const cursor = opts.cursor ?? new Date();

    const resources: ScanResource[] = await this.prisma.resource.findMany({
      where:
        opts.source === 'eval'
          ? { id: { in: opts.resourceIds ?? [] } }
          : { status: 'running', NOT: { source: 'eval-harness' } }, // trial VMs never pollute the live feed
      select: {
        id: true, name: true, provider: true, type: true, service: true, status: true,
        cpuPct: true, diskPct: true, monthlyCost: true, metricHistory: true,
      },
    }) as unknown as ScanResource[];
    if (resources.length === 0) return { created: 0, suppressed: 0, resources: 0, chUsed: false };

    // Series: ClickHouse first, in-memory rows (eval) or metricHistory as fallback.
    const ids = resources.map((r) => r.id);
    let rows: MetricRow[] | null = opts.rows ?? null;
    let chUsed = false;
    if (!rows) {
      try {
        const idList = ids.map((i) => `'${i.replace(/'/g, '')}'`).join(',');
        const res = await chQuery(
          `SELECT toString(ts) AS ts, resource_id, cpu, net, disk, cost_hourly FROM ${CH_DB}.metrics ` +
            `WHERE resource_id IN (${idList}) AND ts > '${chTs(new Date(cursor.getTime() - 30 * 86400_000))}' ` +
            `AND ts <= '${chTs(cursor)}' ORDER BY ts ASC FORMAT JSON`,
          true,
        );
        rows = ((res?.data ?? []) as any[]).map((d) => ({
          ts: String(d.ts), resource_id: String(d.resource_id),
          cpu: Number(d.cpu), net: Number(d.net), disk: Number(d.disk), cost_hourly: Number(d.cost_hourly),
        }));
        chUsed = true;
      } catch {
        rows = null; // ClickHouse down → detectors degrade below, never fail the scan
      }
    }

    const { byResource, costBuckets } = this.buildSeries(rows ?? []);
    const detections = this.detectAll(resources, byResource, costBuckets, cursor, undefined);
    const suppressions = opts.suppressions ?? (opts.source === 'live' ? await this.liveSuppressions() : []);

    let created = 0;
    let suppressedCount = 0;
    for (const d of detections) {
      // Declared legitimate load (batch jobs, backups) is not an anomaly — thesis 2.4.
      const supp = matchSuppression(suppressions, d.resourceName, d.metric, new Date(d.detectedAt));
      if (supp) {
        suppressedCount++;
        continue;
      }

      const dup = await this.prisma.anomalyDetection.findFirst({
        where: {
          resourceId: d.resourceId, detectorType: d.detectorType, metric: d.metric, source: opts.source,
          ...(opts.source === 'live'
            ? { isConfirmed: null, detectedAt: { gte: new Date(cursor.getTime() - DEDUP_HOURS * 3600_000) } }
            : {}), // eval: one row per resource+detector+metric per trial (first detection = MTTD)
        },
      });
      if (dup) continue;

      const row = await this.prisma.anomalyDetection.create({
        data: {
          resourceId: d.resourceId, resourceName: d.resourceName, provider: d.provider as any,
          detectorType: d.detectorType, metric: d.metric, score: d.score, baseline: d.baseline,
          threshold: d.threshold, value: d.value, severity: d.severity as any, reason: d.reason,
          source: opts.source, detectedAt: new Date(d.detectedAt),
        },
      });
      created++;

      // Human gate: high-severity statistical findings raise an IN-APP alert only.
      // External channels wait for confirm(). Threshold signals never alert here —
      // the user-configured AlertRule engine owns capacity alerting.
      if (opts.source === 'live' && d.detectorType !== 'threshold' && (d.severity === 'high' || d.severity === 'critical')) {
        const alert = await this.prisma.alert
          .create({
            data: {
              title: `${d.detectorType === 'cost' ? 'Cost' : 'Behaviour'} anomaly: ${d.resourceName} — ${d.reason.slice(0, 160)}`,
              severity: d.severity, source: 'aiops-anomaly', status: 'active',
              resourceId: d.resourceId, resourceName: d.resourceName, metric: d.metric, value: d.value,
            },
          })
          .catch(() => null);
        if (alert) await this.prisma.anomalyDetection.update({ where: { id: row.id }, data: { alertId: alert.id } });
      }
    }

    if (opts.source === 'live' && (created > 0 || suppressedCount > 0)) {
      this.log.log(`scan: ${created} new detection(s), ${suppressedCount} suppressed, ${resources.length} resources (ch=${chUsed})`);
    }
    return { created, suppressed: suppressedCount, resources: resources.length, chUsed };
  }

  /** Behaviour fallback series from the capped Resource.metricHistory JSON. */
  private historyFallback(hist: unknown): { cpu: number[]; net: number[]; disk: number[] } {
    const list = Array.isArray(hist) ? (hist as { cpu?: number; net?: number; disk?: number }[]) : [];
    return {
      cpu: list.map((h) => Number(h.cpu ?? 0)),
      net: list.map((h) => Number(h.net ?? 0)),
      disk: list.map((h) => Number(h.disk ?? 0)),
    };
  }

  // ── Cross-cloud correlation (thesis 5.3) ──────────────────────────────────

  async correlations(windowMinutes?: number): Promise<{ groups: CorrGroup[]; scanned: number }> {
    const since = new Date(Date.now() - 24 * 3600_000);
    const alerts = await this.prisma.alert.findMany({
      where: { raisedAt: { gte: since } },
      select: { id: true, title: true, metric: true, resourceId: true, resourceName: true, raisedAt: true },
      orderBy: { raisedAt: 'desc' },
      take: 500,
    });
    const rids = [...new Set(alerts.map((a) => a.resourceId).filter(Boolean))] as string[];
    const resources = rids.length
      ? await this.prisma.resource.findMany({ where: { id: { in: rids } }, select: { id: true, provider: true } })
      : [];
    const providerOf = new Map(resources.map((r) => [r.id, String(r.provider)]));
    const groups = correlateAlerts(
      alerts.map((a) => ({
        id: a.id, title: a.title, metric: a.metric,
        provider: a.resourceId ? (providerOf.get(a.resourceId) ?? null) : null,
        resourceName: a.resourceName, raisedAt: a.raisedAt.toISOString(),
      })),
      windowMinutes ? windowMinutes * 60_000 : undefined,
    );
    return { groups, scanned: alerts.length };
  }

  // ── Feed + review (human labels) ─────────────────────────────────────────

  async feed(q: { detector?: string; status?: string; source?: string; limit?: number }) {
    const where: any = { source: q.source === 'eval' ? 'eval' : 'live' };
    if (q.detector && ['cost', 'behaviour', 'threshold'].includes(q.detector)) where.detectorType = q.detector;
    if (q.status === 'unreviewed') where.isConfirmed = null;
    else if (q.status === 'confirmed') where.isConfirmed = true;
    else if (q.status === 'dismissed') where.isConfirmed = false;
    return this.prisma.anomalyDetection.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: Math.min(Math.max(Number(q.limit) || 200, 1), 500),
    });
  }

  /** Confirm = real anomaly. THIS is the human approval gate for external notifications. */
  async confirm(id: string, user: { sub?: string; email?: string }) {
    const det = await this.prisma.anomalyDetection.findUnique({ where: { id } });
    if (!det) throw new NotFoundException('detection not found');
    if (det.source !== 'live') throw new BadRequestException('eval detections are trial data — not reviewable');

    const updated = await this.prisma.anomalyDetection.update({
      where: { id },
      data: { isConfirmed: true, confirmedBy: user.email ?? user.sub ?? 'unknown' },
    });

    // Dispatch external channels now (and only now). Reuse or raise the linked alert.
    let alert = det.alertId ? await this.prisma.alert.findUnique({ where: { id: det.alertId } }) : null;
    if (!alert) {
      alert = await this.prisma.alert.create({
        data: {
          title: `${det.detectorType === 'cost' ? 'Cost' : det.detectorType === 'threshold' ? 'Capacity' : 'Behaviour'} anomaly confirmed: ${det.resourceName} — ${det.reason.slice(0, 160)}`,
          severity: det.severity, source: 'aiops-anomaly', status: 'active',
          resourceId: det.resourceId, resourceName: det.resourceName, metric: det.metric, value: det.value,
        },
      });
      await this.prisma.anomalyDetection.update({ where: { id }, data: { alertId: alert.id } });
    }
    this.alerting.notifyExternal(alert, 'Anomaly confirmed').catch((e) => this.log.warn(`confirm notify failed: ${String(e)}`));
    return updated;
  }

  /** Dismiss = false positive (feeds the live precision metric); resolves the in-app alert. */
  async dismiss(id: string, user: { sub?: string; email?: string }) {
    const det = await this.prisma.anomalyDetection.findUnique({ where: { id } });
    if (!det) throw new NotFoundException('detection not found');
    if (det.source !== 'live') throw new BadRequestException('eval detections are trial data — not reviewable');

    const updated = await this.prisma.anomalyDetection.update({
      where: { id },
      data: { isConfirmed: false, confirmedBy: user.email ?? user.sub ?? 'unknown' },
    });
    if (det.alertId) {
      await this.prisma.alert
        .update({ where: { id: det.alertId }, data: { status: 'resolved', resolvedAt: new Date() } })
        .catch(() => undefined);
    }
    return updated;
  }

  // ── Quality metrics ──────────────────────────────────────────────────────

  /**
   * Live labels give precision (confirmed / reviewed); recall & MTTD need ground
   * truth, which only the eval harness has — the response says which is which.
   */
  async quality() {
    const [confirmed, dismissed, unreviewed, byDetector] = await Promise.all([
      this.prisma.anomalyDetection.count({ where: { source: 'live', isConfirmed: true } }),
      this.prisma.anomalyDetection.count({ where: { source: 'live', isConfirmed: false } }),
      this.prisma.anomalyDetection.count({ where: { source: 'live', isConfirmed: null } }),
      this.prisma.anomalyDetection.groupBy({ by: ['detectorType'], where: { source: 'live' }, _count: { _all: true } }),
    ]);
    const reviewed = confirmed + dismissed;
    const latest = await this.latestEvalReport();
    return {
      live: {
        confirmed, dismissed, unreviewed, reviewed,
        precision: reviewed > 0 ? r3(confirmed / reviewed) : null,
        fpShare: reviewed > 0 ? r3(dismissed / reviewed) : null,
        byDetector: Object.fromEntries(byDetector.map((d) => [d.detectorType, d._count._all])),
        note: 'precision/FP share from operator confirm–dismiss labels; recall & MTTD require ground truth (see eval)',
      },
      eval: latest
        ? { precision: latest.report.precision, recall: latest.report.recall, fpRate: latest.report.fpRate, mttdSeconds: latest.report.mttdSeconds, ranAt: latest.ranAt, note: 'from the latest labelled control trial' }
        : null,
    };
  }

  async latestEvalReport(): Promise<{ report: TrialReport & Record<string, any>; ranAt: string } | null> {
    const row = await this.prisma.eventLog.findFirst({ where: { type: 'system', title: EVAL_TITLE }, orderBy: { ts: 'desc' } });
    if (!row?.detail) return null;
    try {
      return { report: JSON.parse(row.detail), ranAt: row.ts.toISOString() };
    } catch {
      return null;
    }
  }

  // ── Eval harness: labelled control trials (thesis 1.2/1.3/2.1/2.2/2.4/2.5/2.6) ──

  /**
   * Trial #1 runs through the REAL pipeline (resources + ClickHouse + persisted
   * eval detections). Additional trials (2.2 batch) and the threshold sweep (2.6)
   * replay the same generator fully in memory — identical math, no storage churn.
   */
  async runEvalTrial(params?: EvalParams) {
    const seed = Number.isFinite(params?.seed) && (params?.seed as number) > 0 ? Math.floor(params?.seed as number) : 42;
    const trials = Math.min(Math.max(Number(params?.trials) || 1, 1), 30);
    const types = (params?.resourceTypes?.length ? params.resourceTypes : ['compute', 'storage', 'database']) as ('compute' | 'storage' | 'database')[];
    const end = new Date(Math.floor(Date.now() / 3600_000) * 3600_000); // top of the current hour
    const start = new Date(end.getTime() - 14 * 86400_000);
    const injectedAt = new Date(end.getTime() - 48 * 3600_000);

    // Trial-scoped suppression window covering the declared batch job (2.4).
    const trialSuppressions: SuppressionWindow[] = [
      { id: 'trial-batch', name: 'declared batch window (eval)', match: 'eval-batch-legit', metric: '', days: [], startHour: 0, endHour: 24, enabled: true },
    ];

    // ── Trial 1: real pipeline, persisted ──
    const first = await this.runPersistedTrial(seed, types, start, end, injectedAt, trialSuppressions);

    // ── Trials 2..n: in-memory replay (batch stats — thesis 2.2) ──
    const perTrial: { seed: number; precision: number | null; recall: number | null; fpRate: number | null; mttdSeconds: number | null }[] = [
      { seed, precision: first.report.precision, recall: first.report.recall, fpRate: first.report.fpRate, mttdSeconds: first.report.mttdSeconds },
    ];
    for (let tIdx = 1; tIdx < trials; tIdx++) {
      const s = seed + tIdx;
      const sim = this.simulateTrial(s, types, start, end, injectedAt, trialSuppressions, undefined);
      perTrial.push({ seed: s, precision: sim.precision, recall: sim.recall, fpRate: sim.fpRate, mttdSeconds: sim.mttdSeconds });
    }
    const agg = (k: 'precision' | 'recall' | 'fpRate' | 'mttdSeconds') => {
      const vals = perTrial.map((p) => p[k]).filter((v): v is number => v !== null);
      return vals.length ? { mean: r3(mean(vals)), sd: r3(sd(vals)), n: vals.length } : null;
    };

    // ── Threshold sweep → precision-recall curve points (thesis 2.6) ──
    let prCurve: { threshold: number; precision: number | null; recall: number | null; fpRate: number | null }[] | undefined;
    if (params?.sweep) {
      prCurve = [];
      for (const z of [2, 2.5, 3, 3.5, 4, 5]) {
        const sim = this.simulateTrial(seed, types, start, end, injectedAt, trialSuppressions, {
          cost: { zThreshold: z }, behaviour: { zThreshold: z },
        });
        prCurve.push({ threshold: z, precision: sim.precision, recall: sim.recall, fpRate: sim.fpRate });
      }
    }

    const full = {
      ...first.report,
      seed, trials, resourceTypes: types, chUsed: first.chUsed,
      pilotCase: first.pilotCase, suppressionCase: first.suppressionCase,
      mttdByType: first.mttdByType,
      aggregate: trials > 1 ? { precision: agg('precision'), recall: agg('recall'), fpRate: agg('fpRate'), mttdSeconds: agg('mttdSeconds') } : undefined,
      perTrial: trials > 1 ? perTrial : undefined,
      prCurve,
    };
    await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: EVAL_TITLE, detail: JSON.stringify(full) } });
    this.log.log(
      `eval (seed ${seed}, trials ${trials}, types ${types.join('/')}): precision=${first.report.precision} recall=${first.report.recall} ` +
        `fp=${first.report.fpRate} mttd=${first.report.mttdSeconds}s — ${first.pilotCase}; ${first.suppressionCase}`,
    );
    return full;
  }

  /** One full-pipeline trial: provision, inject to CH, step scans, score, clean up. */
  private async runPersistedTrial(
    seed: number,
    types: ('compute' | 'storage' | 'database')[],
    start: Date,
    end: Date,
    injectedAt: Date,
    suppressions: SuppressionWindow[],
  ) {
    const rand = prng(seed);
    const tag = `eval-${seed}-${end.getTime()}`;
    await this.prisma.anomalyDetection.deleteMany({ where: { source: 'eval' } });
    await this.prisma.resource.deleteMany({ where: { source: 'eval-harness' } });

    const specs = trialSpecs(types);
    const labels: (TrialLabel & { type: string; kind: string })[] = [];
    const created: { id: string; spec: TrialResourceSpec }[] = [];
    const rows: MetricRow[] = [];
    for (const spec of specs) {
      const r = await this.prisma.resource.create({
        data: {
          name: spec.name, externalId: `${tag}-${spec.key}`, provider: spec.provider as any,
          type: spec.type as any, region: 'eval-lab', status: 'running', service: spec.service,
          source: 'eval-harness', monthlyCost: 365, cpuPct: 30,
        },
      });
      created.push({ id: r.id, spec });
      labels.push({
        resourceId: r.id, resourceName: spec.name, label: spec.anomalous ? 'anomalous' : 'normal',
        injectedAt: spec.anomalous ? injectedAt.toISOString() : undefined,
        type: spec.type, kind: spec.kind,
      });
      rows.push(...generateSeries(spec, r.id, start, end, injectedAt, rand));
      if (spec.anomalous && spec.kind === 'cost') {
        await this.prisma.resource.update({ where: { id: r.id }, data: { monthlyCost: 365 * 3.5 } });
      }
    }

    // Exercise the real pipeline when ClickHouse is up; otherwise score off the in-memory series.
    let chUsed = false;
    try {
      await this.ensureMetricsTable();
      await chInsertRows(`${CH_DB}.metrics`, rows as unknown as Record<string, any>[]);
      chUsed = true;
    } catch (e) {
      this.log.warn(`eval: ClickHouse unavailable (${String((e as Error)?.message ?? e)}) — scoring from in-memory series`);
    }

    // Step the detector hourly across the injection window (deterministic MTTD).
    const ids = created.map((c) => c.id);
    for (let h = 0; h <= 48; h++) {
      const cursor = new Date(injectedAt.getTime() + h * 3600_000);
      if (cursor > end) break;
      const cursorTs = chTs(cursor);
      await this.scan({
        source: 'eval', resourceIds: ids, cursor, suppressions,
        rows: chUsed ? undefined : rows.filter((row) => row.ts <= cursorTs),
      });
    }

    const detections = await this.prisma.anomalyDetection.findMany({ where: { source: 'eval' } });
    const statistical = detections.filter((d) => d.detectorType !== 'threshold');
    const report = scoreTrial(
      labels,
      statistical.map((d) => ({ resourceId: d.resourceId, detectorType: d.detectorType, detectedAt: d.detectedAt.toISOString(), score: d.score, reason: d.reason })),
    );

    // Named acceptance cases.
    const twinBad = report.cases.find((c) => c.resourceName === `eval-${types[0]}-anom-0`);
    const twinOk = report.cases.find((c) => c.resourceName === `eval-${types[0]}-normal-0`);
    const pilotCase =
      twinBad?.outcome === 'TP' && twinOk?.outcome === 'TN'
        ? 'PASS — anomalous twin flagged, identical normal twin not flagged'
        : `FAIL — anomalous twin ${twinBad?.outcome ?? '?'}, normal twin ${twinOk?.outcome ?? '?'}`;
    const batch = report.cases.find((c) => c.resourceName === 'eval-batch-legit');
    const suppressionCase = !types.includes('compute')
      ? 'SKIPPED — no compute resources in this trial'
      : batch?.outcome === 'TN'
        ? 'PASS — declared batch spike suppressed (not flagged)'
        : `FAIL — declared batch spike outcome ${batch?.outcome ?? '?'}`;

    // MTTD per resource type (thesis 2.5).
    const typeOf = new Map(labels.map((l) => [l.resourceId, l.type]));
    const mttdByType: Record<string, number | null> = {};
    for (const t of types) {
      const times = report.cases.filter((c) => typeOf.get(c.resourceId) === t && c.detectSeconds !== null).map((c) => c.detectSeconds as number);
      mttdByType[t] = times.length ? Math.round(mean(times)) : null;
    }

    await this.prisma.resource.deleteMany({ where: { source: 'eval-harness' } });
    return { report, chUsed, pilotCase, suppressionCase, mttdByType };
  }

  /** Fully in-memory trial replay (no DB/CH) — used for batch trials + the threshold sweep. */
  private simulateTrial(
    seed: number,
    types: ('compute' | 'storage' | 'database')[],
    start: Date,
    end: Date,
    injectedAt: Date,
    suppressions: SuppressionWindow[],
    cfg?: DetectCfg,
  ): TrialReport {
    const rand = prng(seed);
    const specs = trialSpecs(types);
    const resources: ScanResource[] = [];
    const labels: TrialLabel[] = [];
    const rows: MetricRow[] = [];
    specs.forEach((spec, i) => {
      const id = `sim-${seed}-${i}`;
      resources.push({
        id, name: spec.name, provider: spec.provider, type: spec.type, service: spec.service,
        status: 'running', cpuPct: 30, diskPct: 55,
        monthlyCost: spec.anomalous && spec.kind === 'cost' ? 365 * 3.5 : 365,
      });
      labels.push({
        resourceId: id, resourceName: spec.name, label: spec.anomalous ? 'anomalous' : 'normal',
        injectedAt: spec.anomalous ? injectedAt.toISOString() : undefined,
      });
      rows.push(...generateSeries(spec, id, start, end, injectedAt, rand));
    });

    const { byResource, costBuckets } = this.buildSeries(rows);
    // First (statistical, unsuppressed) detection per resource+detector+metric = MTTD.
    const firstHit = new Map<string, { resourceId: string; detectorType: string; detectedAt: string; score: number; reason: string }>();
    for (let h = 0; h <= 48; h++) {
      const cursor = new Date(injectedAt.getTime() + h * 3600_000);
      if (cursor > end) break;
      for (const d of this.detectAll(resources, byResource, costBuckets, cursor, cfg)) {
        if (d.detectorType === 'threshold') continue;
        if (matchSuppression(suppressions, d.resourceName, d.metric, cursor)) continue;
        const key = `${d.resourceId}:${d.detectorType}:${d.metric}`;
        if (!firstHit.has(key)) firstHit.set(key, { resourceId: d.resourceId, detectorType: d.detectorType, detectedAt: d.detectedAt, score: d.score, reason: d.reason });
      }
    }
    return scoreTrial(labels, [...firstHit.values()]);
  }

  async latestEval() {
    const latest = await this.latestEvalReport();
    if (!latest) return { report: null, ranAt: null };
    return { report: latest.report, ranAt: latest.ranAt };
  }
}
