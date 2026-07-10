/**
 * Threshold / capacity signals — plain rule breaches (CPU ceiling, disk-capacity
 * warning). Deliberately SEPARATE from the statistical detectors: detectorType is
 * 'threshold' and baseline is 'rule', so a capacity breach is never presented as a
 * statistical anomaly (and vice versa).
 *
 * The user-configurable AlertRule engine keeps owning alert delivery for its own
 * rules; these signals only populate the anomaly feed / eval metrics.
 */
import { round2 } from '../stats';
import type { Detection } from './types';

export interface ThresholdRule {
  metric: string; // cpu | disk | memory | net
  level: number; // breach at/above this value
  severity: Detection['severity'];
  label: string; // e.g. "CPU saturation"
}

/** Built-in capacity signals (config-overridable at the service layer). */
export const DEFAULT_THRESHOLD_RULES: ThresholdRule[] = [
  { metric: 'cpu', level: 90, severity: 'high', label: 'CPU saturation' },
  { metric: 'disk', level: 85, severity: 'medium', label: 'Disk capacity warning' },
  { metric: 'disk', level: 95, severity: 'critical', label: 'Disk almost full' },
];

export interface ThresholdInput {
  resourceId: string;
  resourceName: string;
  provider: string;
  /** Latest observed values per metric (absent metric = not evaluated). */
  latest: Partial<Record<string, number>>;
  nowIso: string;
  rules?: ThresholdRule[];
}

export function detectThreshold(input: ThresholdInput): Detection[] {
  const rules = input.rules ?? DEFAULT_THRESHOLD_RULES;
  const out: Detection[] = [];
  // Highest breached level wins per metric (disk 96% → "almost full", not both rows).
  const byMetric = new Map<string, ThresholdRule>();
  for (const rule of rules) {
    const v = input.latest[rule.metric];
    if (v === undefined || v < rule.level) continue;
    const prev = byMetric.get(rule.metric);
    if (!prev || rule.level > prev.level) byMetric.set(rule.metric, rule);
  }
  for (const [metric, rule] of byMetric) {
    const v = input.latest[metric] as number;
    out.push({
      resourceId: input.resourceId,
      resourceName: input.resourceName,
      provider: input.provider,
      detectorType: 'threshold',
      metric,
      score: round2(v - rule.level), // distance over the line, NOT a z-score
      baseline: 'rule',
      threshold: rule.level,
      value: round2(v),
      severity: rule.severity,
      reason: `${rule.label}: ${metric} at ${round2(v)}% ≥ ${rule.level}% (rule breach, not a statistical anomaly)`,
      detectedAt: input.nowIso,
    });
  }
  return out;
}
