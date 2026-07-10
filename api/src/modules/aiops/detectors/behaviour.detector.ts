/**
 * Behavioural / traffic anomaly detector — per-host rolling baseline on the
 * agent-pushed metric series (CPU %, net Mbps, disk %). No SSH/console dependency:
 * the series comes straight from what agents already report.
 *
 * Rolling median + MAD over a sliding window; a finding requires K CONSECUTIVE
 * breaching samples (sustained deviation) so a single transient spike never flags.
 *
 * Pure and deterministic: same series → same output.
 */
import { round2, rollingMedianMad } from '../stats';
import { severityFromScore, type Detection } from './types';

export interface BehaviourDetectorCfg {
  /** Modified-z at/above which a sample counts as breaching. */
  zThreshold: number;
  /** Modified-z at/above which severity is high (2× → critical). */
  highAt: number;
  /** Rolling baseline window, in samples. */
  window: number;
  /** Consecutive breaching samples required before flagging. */
  kConsecutive: number;
}

export const DEFAULT_BEHAVIOUR_CFG: BehaviourDetectorCfg = {
  zThreshold: 3.5,
  highAt: 5,
  window: 60,
  kConsecutive: 5,
};

export interface BehaviourSeriesInput {
  resourceId: string;
  resourceName: string;
  provider: string;
  metric: string; // cpu | net | disk | memory
  /** Samples oldest→newest (agent-pushed, fixed cadence). */
  values: number[];
  nowIso: string;
  cfg?: Partial<BehaviourDetectorCfg>;
}

export function detectBehaviour(input: BehaviourSeriesInput): Detection | null {
  const cfg: BehaviourDetectorCfg = { ...DEFAULT_BEHAVIOUR_CFG, ...input.cfg };
  // Need a full window plus K samples on top for a sustained breach to even be possible.
  if (input.values.length < cfg.window + cfg.kConsecutive) return null;

  const scored = rollingMedianMad(input.values, cfg.window);

  // Walk from the newest sample backwards: the CURRENT state must be a sustained
  // breach (K consecutive at the tail) — historical excursions that already ended
  // are not re-flagged on every scan.
  let run = 0;
  let peak = 0;
  for (let i = scored.length - 1; i >= cfg.window; i--) {
    const z = (scored[i] as { z: number }).z;
    if (Math.abs(z) >= cfg.zThreshold) {
      run++;
      if (Math.abs(z) > Math.abs(peak)) peak = z;
    } else break;
  }
  if (run < cfg.kConsecutive) return null;

  const last = scored[scored.length - 1] as { z: number; value: number };
  const dir = peak >= 0 ? 'above' : 'below';
  return {
    resourceId: input.resourceId,
    resourceName: input.resourceName,
    provider: input.provider,
    detectorType: 'behaviour',
    metric: input.metric,
    score: round2(peak),
    baseline: 'self',
    threshold: cfg.zThreshold,
    value: round2(last.value),
    severity: severityFromScore(peak, cfg.zThreshold, cfg.highAt),
    reason: `${input.metric} sustained ${round2(Math.abs(peak))}σ ${dir} its rolling median for ${run} consecutive samples`,
    detectedAt: input.nowIso,
  };
}
