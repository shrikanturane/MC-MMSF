/**
 * Layer 12 — Continuous Feedback & Optimisation: the pure, deterministic rule core.
 *
 * Derives optimisation candidates from the signal the control plane already produces (AIOps anomalies,
 * governance violations, alert rules). Kept free of I/O and Date.now() — every input is passed in — so the
 * rules are unit-testable and auditable, matching the interpretable style of the AIOps detectors/RCA
 * ranker rather than a black-box model. Nothing here invents data: a candidate only exists when the rows
 * that justify it exist.
 */

export type RecTarget = 'Policy' | 'AlertRule' | 'AutomationWorkflow';

export interface ProposedChange {
  target: RecTarget;
  targetId?: string; // set when mutating an existing row
  field: string; // the field being changed, or 'create' when proposing a new row
  newValue: unknown;
}

export interface Candidate {
  source: 'aiops' | 'governance' | 'finops';
  category: string; // policy-tighten | idle-rightsizing | alert-rule-add
  title: string;
  description: string;
  proposedChange: ProposedChange;
  /** Stable identity for de-duplication: source + category + what it targets. */
  key: string;
}

// ── Inputs (structural subsets of the Prisma rows, so tests need no DB) ──────

export interface PolicyRow { id: string; name: string; effect: string; ruleKind: string }
export interface ViolationRow { policyId: string; resourceId: string; ts: Date }
export interface AnomalyRow { resourceId: string; resourceName: string; metric: string; value: number; detectedAt: Date }
export interface AlertRuleRow { metric: string; kind: string; enabled: boolean }

export interface RuleConfig {
  /** Distinct resources in breach of one policy before proposing a tighten. */
  violationMin: number;
  /** Only count violations stamped within this window. */
  violationWindowDays: number;
  /** Detections of the same resource+metric before proposing a resource-level change. */
  anomalyMin: number;
  /** Detections of a metric before proposing a rule for it when none covers it. */
  ruleGapMin: number;
  /** Mean value at/below which a resource reads as idle (rightsizing candidate). */
  idleMax: number;
  /** Mean value at/above which a resource reads as a sustained spike. */
  spikeMin: number;
  /** How far back anomalies are considered. */
  anomalyWindowHours: number;
}

export const DEFAULT_RULES: RuleConfig = {
  violationMin: 3,
  violationWindowDays: 7,
  anomalyMin: 3,
  ruleGapMin: 2,
  idleMax: 20,
  spikeMin: 80,
  anomalyWindowHours: 24,
};

/** Metrics an AlertRule can express. AIOps reports 'net'; AlertRule calls the same thing 'network'. */
const RULE_METRICS: Record<string, string> = { cpu: 'cpu', memory: 'memory', disk: 'disk', net: 'network' };
/** Resource-level metrics the rightsizing/spike rules reason about (per the Layer 12 spec). */
const RESOURCE_METRICS = ['cpu', 'memory', 'disk'];

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round1 = (n: number): number => Math.round(n * 10) / 10;

export const dedupeKey = (c: Omit<Candidate, 'key'>): string =>
  `${c.source}|${c.category}|${c.proposedChange.target}:${c.proposedChange.targetId ?? c.proposedChange.field}:${
    c.proposedChange.targetId ? '' : String((c.proposedChange.newValue as any)?.metric ?? (c.proposedChange.newValue as any)?.resourceId ?? '')
  }`;

const withKey = (c: Omit<Candidate, 'key'>): Candidate => ({ ...c, key: dedupeKey(c) });

/**
 * GOVERNANCE — a policy that `violationMin`+ distinct resources are breaching, but whose effect is still
 * only 'audit', should be escalated to 'alert' so the breach actually reaches someone.
 *
 * NOTE on the window: PoliciesService.evaluate() deletes and recreates a policy's violations on every run,
 * so these rows are a *current snapshot*, not accumulated history — in practice this reads as "N resources
 * are in breach right now". The window filter is still applied so stale rows can never resurrect a proposal.
 * A policy already at effect='alert' has nothing left to tighten and yields no candidate.
 */
export function policyTightenCandidates(
  policies: PolicyRow[],
  violations: ViolationRow[],
  now: Date,
  cfg: RuleConfig = DEFAULT_RULES,
): Candidate[] {
  const cutoff = now.getTime() - cfg.violationWindowDays * 86_400_000;
  const byPolicy = new Map<string, Set<string>>();
  for (const v of violations) {
    if (v.ts.getTime() < cutoff) continue;
    if (!byPolicy.has(v.policyId)) byPolicy.set(v.policyId, new Set());
    byPolicy.get(v.policyId)!.add(v.resourceId); // distinct resources, not raw rows
  }
  const out: Candidate[] = [];
  for (const p of policies) {
    const breaching = byPolicy.get(p.id)?.size ?? 0;
    if (breaching < cfg.violationMin) continue;
    if (p.effect !== 'audit') continue; // already enforcing — nothing to tighten
    out.push(withKey({
      source: 'governance',
      category: 'policy-tighten',
      title: `Enforce policy "${p.name}" (${breaching} resources in breach)`,
      description:
        `${breaching} distinct resources breach "${p.name}" (${p.ruleKind}) but its effect is "audit", so the ` +
        `breaches are recorded silently. Escalate the effect to "alert" so violations raise an alert.`,
      proposedChange: { target: 'Policy', targetId: p.id, field: 'effect', newValue: 'alert' },
    }));
  }
  return out;
}

/**
 * AIOPS/FINOPS — a resource flagged `anomalyMin`+ times on the same metric within the window:
 *  - mean at/below idleMax  → 'idle-rightsizing': propose a DISABLED stop_vm workflow for operator review.
 *  - mean at/above spikeMin → 'alert-rule-add': propose a rule so the spike is caught by the alert engine.
 * Values between the two thresholds are deliberately left alone — an ambiguous middle is not a finding.
 */
export function resourceCandidates(
  anomalies: AnomalyRow[],
  rules: AlertRuleRow[],
  now: Date,
  cfg: RuleConfig = DEFAULT_RULES,
): Candidate[] {
  const cutoff = now.getTime() - cfg.anomalyWindowHours * 3_600_000;
  const groups = new Map<string, AnomalyRow[]>();
  for (const a of anomalies) {
    if (a.detectedAt.getTime() < cutoff) continue;
    if (!RESOURCE_METRICS.includes(a.metric)) continue;
    const k = `${a.resourceId}|${a.metric}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(a);
  }
  const covered = new Set(rules.filter((r) => r.enabled && r.kind === 'threshold').map((r) => r.metric));
  const out: Candidate[] = [];
  for (const [, rows] of groups) {
    if (rows.length < cfg.anomalyMin) continue;
    const first = rows[0];
    const avg = round1(mean(rows.map((r) => r.value)));
    if (avg <= cfg.idleMax) {
      out.push(withKey({
        source: 'finops',
        category: 'idle-rightsizing',
        title: `Rightsize idle resource "${first.resourceName}" (${first.metric} avg ${avg}%)`,
        description:
          `"${first.resourceName}" was flagged ${rows.length} times on ${first.metric} in the last ` +
          `${cfg.anomalyWindowHours}h averaging ${avg}% — consistently idle. Applying adds a DISABLED ` +
          `stop_vm workflow for this resource so an operator can review and enable it rather than it acting on its own.`,
        proposedChange: {
          target: 'AutomationWorkflow',
          field: 'create',
          newValue: {
            name: `Rightsize idle: ${first.resourceName}`,
            trigger: `${first.metric} sustained below ${cfg.idleMax}% on ${first.resourceName}`,
            triggerKind: 'metric',
            triggerValue: first.metric,
            actionType: 'stop_vm',
            status: 'disabled',
            resourceId: first.resourceId,
          },
        },
      }));
    } else if (avg >= cfg.spikeMin && !covered.has(RULE_METRICS[first.metric])) {
      // Threshold derived from the lowest level the spike was actually observed at — never invented.
      const threshold = Math.round(Math.min(...rows.map((r) => r.value)));
      out.push(withKey({
        source: 'aiops',
        category: 'alert-rule-add',
        title: `Add ${first.metric} alert rule (spikes on "${first.resourceName}", avg ${avg}%)`,
        description:
          `"${first.resourceName}" was flagged ${rows.length} times on ${first.metric} in the last ` +
          `${cfg.anomalyWindowHours}h averaging ${avg}%, and no enabled threshold rule covers ${first.metric}. ` +
          `Applying adds a rule firing above ${threshold}% — the lowest level the spike was actually observed at.`,
        proposedChange: {
          target: 'AlertRule',
          field: 'create',
          newValue: { name: `${first.metric} high (auto)`, kind: 'threshold', metric: RULE_METRICS[first.metric], comparator: 'gt', threshold, severity: 'high' },
        },
      }));
    }
  }
  return out;
}

/**
 * AIOPS — a metric the detectors have fired on `ruleGapMin`+ times that no enabled threshold rule covers
 * at all. This is the fleet-wide counterpart to resourceCandidates(): the gap is the metric, not one host.
 *
 * Idle-low detections (value <= idleMax) are excluded: they're a rightsizing signal, not an alerting one.
 * Including them would derive a "greater than" threshold from an idle value (e.g. cpu > 4%) and produce a
 * rule that fires permanently.
 */
export function ruleGapCandidates(
  anomalies: AnomalyRow[],
  rules: AlertRuleRow[],
  now: Date,
  cfg: RuleConfig = DEFAULT_RULES,
): Candidate[] {
  const cutoff = now.getTime() - cfg.anomalyWindowHours * 3_600_000;
  const covered = new Set(rules.filter((r) => r.enabled && r.kind === 'threshold').map((r) => r.metric));
  const byMetric = new Map<string, AnomalyRow[]>();
  for (const a of anomalies) {
    if (a.detectedAt.getTime() < cutoff) continue;
    if (!RULE_METRICS[a.metric]) continue;
    if (covered.has(RULE_METRICS[a.metric])) continue;
    if (a.value <= cfg.idleMax) continue; // idle-low is a rightsizing signal, not an alert threshold
    if (!byMetric.has(a.metric)) byMetric.set(a.metric, []);
    byMetric.get(a.metric)!.push(a);
  }
  const out: Candidate[] = [];
  for (const [metric, rows] of byMetric) {
    if (rows.length < cfg.ruleGapMin) continue;
    const threshold = Math.round(Math.min(...rows.map((r) => r.value)));
    const hosts = new Set(rows.map((r) => r.resourceName)).size;
    out.push(withKey({
      source: 'aiops',
      category: 'alert-rule-add',
      title: `No alert rule covers "${metric}" (${rows.length} detections)`,
      description:
        `The detectors flagged ${metric} ${rows.length} times across ${hosts} resource(s) in the last ` +
        `${cfg.anomalyWindowHours}h, but no enabled threshold rule covers ${metric} — these never reach the ` +
        `alert engine. Applying adds a rule firing above ${threshold}%, the lowest observed level.`,
      proposedChange: {
        target: 'AlertRule',
        field: 'create',
        newValue: { name: `${metric} uncovered (auto)`, kind: 'threshold', metric: RULE_METRICS[metric], comparator: 'gt', threshold, severity: 'medium' },
      },
    }));
  }
  return out;
}

export interface RuleInput {
  policies: PolicyRow[];
  violations: ViolationRow[];
  anomalies: AnomalyRow[];
  rules: AlertRuleRow[];
  now: Date;
}

/**
 * Run every rule and collapse duplicates by key (two rules can legitimately propose the same alert rule —
 * the fleet-wide gap rule and the per-resource spike rule). First writer wins; order is deterministic.
 */
export function deriveCandidates(input: RuleInput, cfg: RuleConfig = DEFAULT_RULES): Candidate[] {
  const all = [
    ...policyTightenCandidates(input.policies, input.violations, input.now, cfg),
    ...resourceCandidates(input.anomalies, input.rules, input.now, cfg),
    ...ruleGapCandidates(input.anomalies, input.rules, input.now, cfg),
  ];
  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}
