/**
 * Cost anomaly detector — SELF + COHORT robust baselines, evaluated together.
 *
 * Fixes the classic false-positive defect: comparing a VM against a fleet-wide
 * MEAN dominated by idle/near-zero-cost resources flags every ordinarily-billed
 * resource. Here:
 *   - SELF:   modified z of the current hourly cost vs the resource's OWN rolling
 *             history (hourly buckets, last 14–30 days).
 *   - COHORT: modified z vs same-type/service/provider peers with idle and
 *             non-running members EXCLUDED from the statistics.
 *   - COLD-START: a brand-new resource (< coldStartHours of history) is never
 *             flagged on its own history — only if it exceeds the cohort MAD
 *             threshold. New != anomalous.
 *
 * Pure and deterministic: same input → same output. No I/O, no clock reads.
 */
import { mad, median, modifiedZ, round2 } from '../stats';
import { severityFromScore, type Detection } from './types';

export interface CostDetectorCfg {
  /** Modified-z at/above which a resource is flagged. */
  zThreshold: number;
  /** Modified-z at/above which severity is high (2× → critical). */
  highAt: number;
  /** Hourly cost below which a peer counts as idle and is excluded from cohort stats. */
  idleCostFloor: number;
  /** Minimum non-idle peers (excluding the subject) for the cohort baseline to apply. */
  minCohort: number;
  /** Self-history hours below which the resource is in cold-start (self baseline ignored). */
  coldStartHours: number;
}

export const DEFAULT_COST_CFG: CostDetectorCfg = {
  zThreshold: 3.5,
  highAt: 5,
  idleCostFloor: 0.05,
  minCohort: 4,
  coldStartHours: 24,
};

export interface CostResourceInput {
  id: string;
  name: string;
  provider: string;
  type: string; // ResourceType, cohort key
  service: string; // cohort key
  status: string; // only 'running' subjects are evaluated
  /** Current hourly cost of the subject. */
  costHourly: number;
}

export interface CohortPeer {
  resourceId: string;
  status: string;
  costHourly: number;
}

export interface CostDetectInput {
  resource: CostResourceInput;
  /** Subject's own hourly cost buckets, oldest→newest (14–30 days when available). */
  selfHourlyBuckets: { ts: string; cost: number }[];
  /** Same type+service(+provider) peers, subject excluded. */
  cohort: CohortPeer[];
  nowIso: string;
  cfg?: Partial<CostDetectorCfg>;
}

export function detectCost(input: CostDetectInput): Detection | null {
  const cfg: CostDetectorCfg = { ...DEFAULT_COST_CFG, ...input.cfg };
  const r = input.resource;
  if (r.status !== 'running') return null;

  // ── COHORT baseline: idle / non-running peers are excluded from the statistics ──
  const active = input.cohort.filter((p) => p.status === 'running' && p.costHourly >= cfg.idleCostFloor);
  let cohortZ: number | null = null;
  let cohortMed = 0;
  if (active.length >= cfg.minCohort) {
    const costs = active.map((p) => p.costHourly);
    cohortMed = median(costs);
    cohortZ = modifiedZ(r.costHourly, cohortMed, mad(costs));
  }

  // ── SELF baseline: only with enough of the resource's OWN history (cold-start rule) ──
  const coldStart = input.selfHourlyBuckets.length < cfg.coldStartHours;
  let selfZ: number | null = null;
  let selfMed = 0;
  if (!coldStart) {
    const hist = input.selfHourlyBuckets.map((b) => b.cost);
    selfMed = median(hist);
    selfZ = modifiedZ(r.costHourly, selfMed, mad(hist));
  }

  // Evaluate together: strongest applicable signal wins. In cold-start ONLY the
  // cohort can flag (a new resource is never anomalous merely for being new).
  const candidates: { baseline: 'self' | 'cohort'; z: number; med: number }[] = [];
  if (selfZ !== null) candidates.push({ baseline: 'self', z: selfZ, med: selfMed });
  if (cohortZ !== null) candidates.push({ baseline: 'cohort', z: cohortZ, med: cohortMed });
  if (candidates.length === 0) return null;

  const top = candidates.reduce((a, b) => (Math.abs(b.z) > Math.abs(a.z) ? b : a));
  if (Math.abs(top.z) < cfg.zThreshold) return null;

  const ratio = top.med > 0 ? round2(r.costHourly / top.med) : null;
  const against =
    top.baseline === 'cohort'
      ? `cohort median for ${r.type}/${r.provider} (${active.length} peers)`
      : `its own ${input.selfHourlyBuckets.length}h baseline`;
  const reason =
    (ratio !== null ? `cost ${ratio}× ${against}` : `cost deviates from ${against}`) +
    ` — $${round2(r.costHourly)}/h vs median $${round2(top.med)}/h (robust z ${round2(top.z)})` +
    (coldStart ? ' [cold-start: cohort-only]' : '');

  return {
    resourceId: r.id,
    resourceName: r.name,
    provider: r.provider,
    detectorType: 'cost',
    metric: 'cost',
    score: round2(top.z),
    baseline: top.baseline,
    threshold: cfg.zThreshold,
    value: round2(r.costHourly),
    severity: severityFromScore(top.z, cfg.zThreshold, cfg.highAt),
    reason,
    detectedAt: input.nowIso,
  };
}
