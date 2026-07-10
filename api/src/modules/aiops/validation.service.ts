/**
 * Validation suites (thesis evidence generators) beyond the anomaly harness:
 *
 *  - RCA eval (5.1/5.4): seeds ≥15 incidents with KNOWN ground-truth causes
 *    (5 cause templates × 3 providers), runs the real /ai RCA path per incident,
 *    scores top-k accuracy (k=1,3,5) and precision@1, and times each diagnosis.
 *  - Correlation eval (5.3): seeds a synthetic cross-cloud incident (same metric,
 *    3 providers, minutes apart) + decoys, verifies the correlation engine links
 *    exactly the related alerts → correlation recall/precision.
 *  - Validation summary: maps thesis test IDs to their latest live evidence
 *    (anomaly trials, RCA eval, correlation eval, CIEM eval, inventory latency).
 *
 * All seeded artifacts are tagged and cleaned up; reports persist in the event log.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AiService } from '../ai/ai.service';
import { AiopsService } from './aiops.service';
import { correlateAlerts } from './correlation';

const RCA_TITLE = 'RCA eval trial';
const CORR_TITLE = 'Correlation eval trial';
const CIEM_TITLE = 'CIEM eval trial';
const EVAL_SRC = 'rca-eval';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Ground-truth incident templates — alert + evidence signature per cause. */
const RCA_TEMPLATES: {
  cause: string;
  metric: string;
  alertTitle: (host: string) => string;
  value: number;
  events: (host: string) => { severity: string; title: string }[];
  siem: (host: string) => { level: string; message: string }[];
}[] = [
  {
    cause: 'cpu-saturation', metric: 'cpu', value: 97,
    alertTitle: (h) => `High CPU: ${h} (cpu 97% gt 85%)`,
    events: (h) => [{ severity: 'warning', title: `CPU saturation building on ${h} — load average climbing` }],
    siem: (h) => [{ level: 'warning', message: `high cpu sustained on ${h}, runaway process suspected` }],
  },
  {
    cause: 'memory-pressure', metric: 'memory', value: 93,
    alertTitle: (h) => `High memory: ${h} (memory 93% gte 90%)`,
    events: (h) => [{ severity: 'warning', title: `Memory pressure on ${h} — swap usage rising` }],
    siem: (h) => [{ level: 'warning', message: `oom killer candidates observed on ${h}` }],
  },
  {
    cause: 'disk-full', metric: 'disk', value: 96,
    alertTitle: (h) => `Disk pressure: ${h} (disk 96% gte 95%)`,
    events: (h) => [{ severity: 'critical', title: `Volume nearly full on ${h} — no space left on device` }],
    siem: (h) => [{ level: 'critical', message: `filesystem 96% on ${h}, disk exhaustion imminent` }],
  },
  {
    cause: 'network-anomaly', metric: 'network', value: 0,
    alertTitle: (h) => `Network anomaly: ${h} (network throughput collapsed)`,
    events: (h) => [{ severity: 'critical', title: `Link latency spike and packet loss to ${h}` }],
    siem: (h) => [{ level: 'warning', message: `device ${h} unreachable intermittently, timeout on probes` }],
  },
  {
    cause: 'power-state', metric: 'event', value: 0,
    alertTitle: (h) => `Device unreachable: ${h}`,
    events: (h) => [{ severity: 'critical', title: `vm_power_off detected: ${h} powered off unexpectedly` }],
    siem: (h) => [{ level: 'critical', message: `agent offline on ${h} — host stopped` }],
  },
];

@Injectable()
export class ValidationService {
  private readonly log = new Logger('AiopsValidation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly aiops: AiopsService,
  ) {}

  // ── RCA eval: seeded ground-truth incidents → top-k accuracy (5.1/5.4) ────

  async runRcaEval() {
    const providers = ['aws', 'azure', 'gcp'] as const;
    const startedAt = Date.now();
    const cases: {
      host: string; provider: string; truth: string;
      top1: string | null; topk: string[]; rankOfTruth: number | null; ms: number;
    }[] = [];

    // Clean any previous seeded artifacts first (idempotent re-runs).
    await this.cleanupRcaSeeds();

    try {
      for (const provider of providers) {
        for (const tpl of RCA_TEMPLATES) {
          const host = `rcaeval-${provider}-${tpl.cause}`;
          // Seed the evidence trail the RCA engine will correlate (30-min window).
          await this.prisma.eventLog.createMany({
            data: tpl.events(host).map((e) => ({ type: 'alert', severity: e.severity, title: e.title, resourceName: host, provider, detail: EVAL_SRC })),
          });
          await this.prisma.siemEvent.createMany({
            data: tpl.siem(host).map((s) => ({ source: EVAL_SRC, level: s.level, category: 'eval', host, message: s.message })),
          });
          const alert = await this.prisma.alert.create({
            data: { title: tpl.alertTitle(host), severity: 'high', source: EVAL_SRC, status: 'active', resourceName: host, metric: tpl.metric, value: tpl.value },
          });

          const t0 = Date.now();
          // skipLlm: top-k scoring uses the deterministic ranker only; the LLM narrative
          // adds minutes per incident and nothing to the metric.
          const rca = (await this.ai.rca({ alertId: alert.id, skipLlm: true })) as { candidates?: { cause: string }[] };
          const ms = Date.now() - t0;
          const topk = (rca.candidates ?? []).map((c) => c.cause);
          const rank = topk.indexOf(tpl.cause);
          cases.push({ host, provider, truth: tpl.cause, top1: topk[0] ?? null, topk, rankOfTruth: rank >= 0 ? rank + 1 : null, ms });
        }
      }
    } finally {
      await this.cleanupRcaSeeds();
    }

    const n = cases.length;
    const within = (k: number) => cases.filter((c) => c.rankOfTruth !== null && (c.rankOfTruth as number) <= k).length;
    const report = {
      incidents: n,
      topK: { k1: r3(within(1) / n), k3: r3(within(3) / n), k5: r3(within(5) / n) },
      precisionAt1: r3(within(1) / n), // single-label ground truth → same as top-1 accuracy
      falseCauseRate: r3((n - within(1)) / n),
      meanDiagnosisMs: Math.round(cases.reduce((s, c) => s + c.ms, 0) / Math.max(1, n)),
      totalMs: Date.now() - startedAt,
      cases,
    };
    await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: RCA_TITLE, detail: JSON.stringify(report) } });
    this.log.log(`RCA eval: ${n} seeded incidents — top1=${report.topK.k1} top3=${report.topK.k3} top5=${report.topK.k5} (${report.meanDiagnosisMs}ms/diagnosis)`);
    return report;
  }

  private async cleanupRcaSeeds() {
    await this.prisma.alert.deleteMany({ where: { source: EVAL_SRC } });
    await this.prisma.siemEvent.deleteMany({ where: { source: EVAL_SRC } });
    await this.prisma.eventLog.deleteMany({ where: { detail: EVAL_SRC } });
  }

  // ── Correlation eval: seeded cross-cloud incident + decoys (5.3) ──────────

  async runCorrelationEval() {
    const tag = 'correval';
    await this.cleanupCorrSeeds();

    const mkResource = (provider: string, name: string) =>
      this.prisma.resource.create({
        data: {
          name, externalId: `${tag}-${name}-${Date.now()}`, provider: provider as any, type: 'compute',
          region: 'eval-lab', status: 'running', service: 'Correlation eval VM', source: 'eval-harness',
        },
      });

    try {
      const now = Date.now();
      // The cross-cloud incident: same metric, 3 providers, 2 minutes apart.
      const related: string[] = [];
      let i = 0;
      for (const provider of ['aws', 'azure', 'gcp']) {
        const r = await mkResource(provider, `${tag}-${provider}`);
        const a = await this.prisma.alert.create({
          data: {
            title: `High CPU: ${r.name}`, severity: 'high', source: tag, status: 'active',
            resourceId: r.id, resourceName: r.name, metric: 'cpu', value: 95,
            raisedAt: new Date(now - (10 - i * 2) * 60_000),
          },
        });
        related.push(a.id);
        i++;
      }
      // Decoys: different metric in-window, and same metric far outside the window.
      const d1r = await mkResource('aws', `${tag}-decoy-disk`);
      await this.prisma.alert.create({
        data: { title: `Disk pressure: ${d1r.name}`, severity: 'medium', source: tag, status: 'active', resourceId: d1r.id, resourceName: d1r.name, metric: 'disk', value: 91, raisedAt: new Date(now - 9 * 60_000) },
      });
      const d2r = await mkResource('gcp', `${tag}-decoy-late`);
      await this.prisma.alert.create({
        data: { title: `High CPU: ${d2r.name}`, severity: 'high', source: tag, status: 'active', resourceId: d2r.id, resourceName: d2r.name, metric: 'cpu', value: 94, raisedAt: new Date(now - 5 * 3600_000) },
      });

      // Run the engine over the seeded window (same code path as GET /aiops/correlations).
      const alerts = await this.prisma.alert.findMany({ where: { source: tag }, select: { id: true, title: true, metric: true, resourceId: true, resourceName: true, raisedAt: true } });
      const rids = alerts.map((a) => a.resourceId).filter(Boolean) as string[];
      const resources = await this.prisma.resource.findMany({ where: { id: { in: rids } }, select: { id: true, provider: true } });
      const providerOf = new Map(resources.map((r) => [r.id, String(r.provider)]));
      const groups = correlateAlerts(
        alerts.map((a) => ({ id: a.id, title: a.title, metric: a.metric, provider: a.resourceId ? (providerOf.get(a.resourceId) ?? null) : null, resourceName: a.resourceName, raisedAt: a.raisedAt.toISOString() })),
      );

      const cross = groups.find((g) => g.crossCloud && g.metric === 'cpu');
      const linked = cross ? related.filter((id) => cross.alertIds.includes(id)).length : 0;
      const strays = cross ? cross.alertIds.filter((id) => !related.includes(id)).length : 0;
      const report = {
        seededRelated: related.length,
        linked,
        recall: r3(linked / related.length),
        precision: cross ? r3(linked / cross.alertIds.length) : null,
        decoysExcluded: strays === 0,
        providersLinked: cross?.providers ?? [],
        verdict:
          linked === related.length && strays === 0
            ? 'PASS — 3-provider incident linked into one group, decoys excluded'
            : `FAIL — linked ${linked}/${related.length}, ${strays} stray alert(s) in group`,
        groups: groups.map((g) => ({ metric: g.metric, providers: g.providers, crossCloud: g.crossCloud, alerts: g.alertIds.length, spanMs: g.spanMs })),
      };
      await this.prisma.eventLog.create({ data: { type: 'system', severity: 'info', title: CORR_TITLE, detail: JSON.stringify(report) } });
      this.log.log(`correlation eval: ${report.verdict}`);
      return report;
    } finally {
      await this.cleanupCorrSeeds();
    }
  }

  private async cleanupCorrSeeds() {
    await this.prisma.alert.deleteMany({ where: { source: 'correval' } });
    await this.prisma.resource.deleteMany({ where: { name: { startsWith: 'correval-' }, source: 'eval-harness' } });
  }

  // ── Validation summary: thesis test IDs → latest evidence ─────────────────

  async summary() {
    const latest = async (title: string) => {
      const row = await this.prisma.eventLog.findFirst({ where: { type: 'system', title }, orderBy: { ts: 'desc' } });
      if (!row?.detail) return null;
      try {
        return { ranAt: row.ts.toISOString(), ...JSON.parse(row.detail) };
      } catch {
        return null;
      }
    };
    const [anomaly, rca, corr, ciem, quality, suppressions] = await Promise.all([
      // `any`: trial reports carry harness-version-specific extras (trials, mttdByType,
      // prCurve, suppressionCase…) beyond the base TrialReport shape.
      this.aiops.latestEvalReport().then((r): any => (r ? { ranAt: r.ranAt, ...r.report } : null)),
      latest(RCA_TITLE),
      latest(CORR_TITLE),
      latest(CIEM_TITLE),
      this.aiops.quality(),
      this.aiops.getSuppressions(),
    ]);
    const inventoryLatency = await this.inventoryLatency();

    // Thesis test-ID map — status: evidence (automated result available), ready
    // (runnable now, no result yet), manual (human protocol on top of the platform).
    const has = (v: unknown) => (v ? 'evidence' : 'ready');
    const map = [
      { id: '1.2', name: 'Two-VM discrimination', status: has(anomaly), metric: anomaly?.pilotCase ?? null },
      { id: '1.3', name: 'Cold-start suppression', status: has(anomaly), metric: anomaly ? 'enforced in detector + unit tests' : null },
      { id: '1.5', name: 'Cohort robustness (median+MAD vs mean+SD)', status: 'evidence', metric: 'unit spec: old z=2.9 flags, robust z=0.67 does not' },
      { id: '2.1', name: 'Cost-anomaly recall', status: has(anomaly), metric: anomaly?.recall ?? null },
      { id: '2.2', name: `Precision / FP over ${anomaly?.trials ?? 0} trial(s)`, status: has(anomaly?.aggregate), metric: anomaly?.aggregate ?? anomaly?.precision ?? null },
      { id: '2.3', name: 'Behavioural anomaly MTTD/recall (agent-push only)', status: has(anomaly), metric: anomaly?.mttdSeconds ?? null },
      { id: '2.4', name: 'Legitimate sustained spike suppressed', status: has(anomaly?.suppressionCase), metric: anomaly?.suppressionCase ?? null },
      { id: '2.5', name: 'MTTD by resource type', status: has(anomaly?.mttdByType), metric: anomaly?.mttdByType ?? null },
      { id: '2.6', name: 'Precision-recall curve (threshold sweep)', status: has(anomaly?.prCurve), metric: anomaly?.prCurve ?? null },
      { id: '3.1', name: 'Inventory latency (cloud create → visible)', status: has(inventoryLatency.count > 0 ? inventoryLatency : null), metric: inventoryLatency },
      { id: '5.1', name: 'RCA top-k accuracy (seeded ground truth)', status: has(rca), metric: rca?.topK ?? null },
      { id: '5.2', name: 'Mean time per RCA diagnosis', status: has(rca), metric: rca?.meanDiagnosisMs ?? null },
      { id: '5.3', name: 'Cross-cloud correlation recall', status: has(corr), metric: corr?.verdict ?? null },
      { id: '5.4', name: 'RCA precision@1 / false-cause rate', status: has(rca), metric: rca ? { precisionAt1: rca.precisionAt1, falseCauseRate: rca.falseCauseRate } : null },
      { id: '6.3', name: 'Cross-cloud identity consistency (CIEM)', status: has(ciem), metric: ciem?.consistency ?? null },
      { id: '6.4', name: 'Over-provisioned/unused permission detection (CIEM)', status: has(ciem), metric: ciem ? { precision: ciem.precision, recall: ciem.recall } : null },
      { id: '1.1', name: 'Multi-provider cost coverage', status: 'manual', metric: 'connect all 3 providers; FinOps byProvider > 0 each' },
      { id: '1.4', name: 'Savings accuracy vs manual audit', status: 'manual', metric: 'FinOps savings list vs audited idle/oversized' },
      { id: '3.2/3.3/4.x/7.x', name: 'Timing & usability protocols', status: 'manual', metric: 'platform features live; human-timed trials' },
    ];

    return { anomaly, rca, correlation: corr, ciem, quality, suppressions, inventoryLatency, map };
  }

  /** 3.1 evidence: discovery latency for resources whose provider-side creation time is known. */
  private async inventoryLatency() {
    const rows = await this.prisma.resource.findMany({
      where: { source: 'discovered' },
      select: { createdAt: true, properties: true },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });
    const secs: number[] = [];
    for (const r of rows) {
      const p = (r.properties ?? {}) as Record<string, unknown>;
      const created = p.launchTime ?? p.timeCreated ?? p.creationTimestamp ?? p.createdTime ?? p.creationTime;
      if (!created) continue;
      const t = new Date(String(created)).getTime();
      if (!Number.isFinite(t)) continue;
      const lag = (r.createdAt.getTime() - t) / 1000;
      // Only meaningful for resources created AFTER MCMF was watching (else lag = age of resource).
      if (lag > 0 && lag < 3600) secs.push(lag);
    }
    secs.sort((a, b) => a - b);
    return {
      count: secs.length,
      meanSec: secs.length ? Math.round(secs.reduce((s, v) => s + v, 0) / secs.length) : null,
      medianSec: secs.length ? Math.round(secs[Math.floor(secs.length / 2)] as number) : null,
      note: 'discovery lag = MCMF first-seen minus provider creation time (only resources created while connected, <1h lag)',
    };
  }
}
