/** Shared detection output shape — one row per finding, storage-agnostic. */
export interface Detection {
  resourceId: string;
  resourceName: string;
  provider: string;
  detectorType: 'cost' | 'behaviour' | 'threshold';
  metric: string; // cost | cpu | net | disk | memory
  score: number; // modified z-score ('cost'/'behaviour') or the breached rule threshold distance ('threshold')
  baseline: 'self' | 'cohort' | 'rule';
  threshold: number; // the score/level that had to be exceeded to flag
  value: number; // the observed value that triggered the finding
  severity: 'critical' | 'high' | 'medium' | 'low';
  reason: string; // human-readable, e.g. "cost 3.1× cohort median for compute/azure (12 peers)"
  detectedAt: string; // ISO — passed in by the caller (keeps detectors deterministic)
}

/** Severity from a statistical score: configurable bands, identical across detectors. */
export function severityFromScore(score: number, zThreshold: number, highAt: number): Detection['severity'] {
  const abs = Math.abs(score);
  if (abs >= highAt * 2) return 'critical';
  if (abs >= highAt) return 'high';
  if (abs >= zThreshold) return 'medium';
  return 'low';
}
