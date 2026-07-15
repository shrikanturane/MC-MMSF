import {
  DEFAULT_RULES,
  dedupeKey,
  deriveCandidates,
  policyTightenCandidates,
  resourceCandidates,
  ruleGapCandidates,
  type AlertRuleRow,
  type AnomalyRow,
  type PolicyRow,
  type ViolationRow,
} from './rules';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

const policy = (over: Partial<PolicyRow> = {}): PolicyRow => ({ id: 'p1', name: 'Require Owner tag', effect: 'audit', ruleKind: 'require_tag', ...over });
const violation = (resourceId: string, over: Partial<ViolationRow> = {}): ViolationRow => ({ policyId: 'p1', resourceId, ts: hoursAgo(1), ...over });
const anomaly = (over: Partial<AnomalyRow> = {}): AnomalyRow => ({ resourceId: 'r1', resourceName: 'web-1', metric: 'cpu', value: 95, detectedAt: hoursAgo(1), ...over });

describe('Layer 12 optimisation rules (pure, deterministic)', () => {
  describe('policy-tighten (governance)', () => {
    test('3+ distinct resources breaching an audit-only policy → propose effect → alert', () => {
      const out = policyTightenCandidates([policy()], [violation('a'), violation('b'), violation('c')], NOW);
      expect(out).toHaveLength(1);
      expect(out[0].source).toBe('governance');
      expect(out[0].category).toBe('policy-tighten');
      expect(out[0].proposedChange).toEqual({ target: 'Policy', targetId: 'p1', field: 'effect', newValue: 'alert' });
    });

    test('below the threshold → no candidate', () => {
      expect(policyTightenCandidates([policy()], [violation('a'), violation('b')], NOW)).toEqual([]);
    });

    test('counts DISTINCT resources, not repeated rows for one resource', () => {
      const dupes = [violation('a'), violation('a'), violation('a'), violation('a')];
      expect(policyTightenCandidates([policy()], dupes, NOW)).toEqual([]);
    });

    test('a policy already at effect=alert has nothing to tighten', () => {
      const out = policyTightenCandidates([policy({ effect: 'alert' })], [violation('a'), violation('b'), violation('c')], NOW);
      expect(out).toEqual([]);
    });

    test('violations older than the window are ignored', () => {
      const stale = [violation('a', { ts: daysAgo(8) }), violation('b', { ts: daysAgo(9) }), violation('c', { ts: daysAgo(10) })];
      expect(policyTightenCandidates([policy()], stale, NOW)).toEqual([]);
    });

    test('no policies / no violations → empty, no throw', () => {
      expect(policyTightenCandidates([], [], NOW)).toEqual([]);
    });
  });

  describe('idle-rightsizing vs alert-rule-add (resource level)', () => {
    const idle = [anomaly({ value: 4 }), anomaly({ value: 6 }), anomaly({ value: 5 })];

    test('3+ detections averaging <= idleMax → idle-rightsizing proposing a DISABLED stop_vm workflow', () => {
      const out = resourceCandidates(idle, [], NOW);
      expect(out).toHaveLength(1);
      expect(out[0].category).toBe('idle-rightsizing');
      expect(out[0].source).toBe('finops');
      expect(out[0].proposedChange.target).toBe('AutomationWorkflow');
      expect(out[0].proposedChange.field).toBe('create');
      expect(out[0].proposedChange.newValue).toMatchObject({ actionType: 'stop_vm', status: 'disabled', resourceId: 'r1' });
    });

    test('3+ detections averaging >= spikeMin with no covering rule → alert-rule-add', () => {
      const out = resourceCandidates([anomaly({ value: 91 }), anomaly({ value: 97 }), anomaly({ value: 99 })], [], NOW);
      expect(out).toHaveLength(1);
      expect(out[0].category).toBe('alert-rule-add');
      expect(out[0].source).toBe('aiops');
      // threshold = lowest OBSERVED value, never invented
      expect(out[0].proposedChange.newValue).toMatchObject({ metric: 'cpu', comparator: 'gt', threshold: 91 });
    });

    test('spike already covered by an enabled threshold rule → no candidate', () => {
      const rules: AlertRuleRow[] = [{ metric: 'cpu', kind: 'threshold', enabled: true }];
      expect(resourceCandidates([anomaly({ value: 91 }), anomaly({ value: 97 }), anomaly({ value: 99 })], rules, NOW)).toEqual([]);
    });

    test('a DISABLED rule does not count as coverage', () => {
      const rules: AlertRuleRow[] = [{ metric: 'cpu', kind: 'threshold', enabled: false }];
      expect(resourceCandidates([anomaly({ value: 91 }), anomaly({ value: 97 }), anomaly({ value: 99 })], rules, NOW)).toHaveLength(1);
    });

    test('fewer than anomalyMin detections → no candidate', () => {
      expect(resourceCandidates([anomaly({ value: 4 }), anomaly({ value: 5 })], [], NOW)).toEqual([]);
    });

    test('the ambiguous middle band is left alone', () => {
      expect(resourceCandidates([anomaly({ value: 50 }), anomaly({ value: 55 }), anomaly({ value: 45 })], [], NOW)).toEqual([]);
    });

    test('detections outside the window are ignored', () => {
      const old = idle.map((a) => ({ ...a, detectedAt: hoursAgo(48) }));
      expect(resourceCandidates(old, [], NOW)).toEqual([]);
    });

    test('groups by resource+metric, so two metrics on one host are separate findings', () => {
      const rows = [...idle, anomaly({ metric: 'disk', value: 3 }), anomaly({ metric: 'disk', value: 2 }), anomaly({ metric: 'disk', value: 4 })];
      expect(resourceCandidates(rows, [], NOW)).toHaveLength(2);
    });

    test('non-resource metrics (cost) are not rightsized', () => {
      const cost = [anomaly({ metric: 'cost', value: 2 }), anomaly({ metric: 'cost', value: 3 }), anomaly({ metric: 'cost', value: 1 })];
      expect(resourceCandidates(cost, [], NOW)).toEqual([]);
    });
  });

  describe('alert-rule-add (fleet-wide metric gap)', () => {
    test('2+ detections on a metric with no covering rule → propose one', () => {
      const out = ruleGapCandidates([anomaly({ value: 88 }), anomaly({ resourceId: 'r2', resourceName: 'web-2', value: 93 })], [], NOW);
      expect(out).toHaveLength(1);
      expect(out[0].category).toBe('alert-rule-add');
      expect(out[0].proposedChange.newValue).toMatchObject({ metric: 'cpu', threshold: 88 });
    });

    test('covered metric → no candidate', () => {
      const rules: AlertRuleRow[] = [{ metric: 'cpu', kind: 'threshold', enabled: true }];
      expect(ruleGapCandidates([anomaly(), anomaly({ resourceId: 'r2' })], rules, NOW)).toEqual([]);
    });

    test('a single detection is not yet a gap', () => {
      expect(ruleGapCandidates([anomaly()], [], NOW)).toEqual([]);
    });

    test('idle-low detections never drive a "greater than" rule (would fire permanently)', () => {
      const idle = [anomaly({ value: 4 }), anomaly({ resourceId: 'r2', resourceName: 'web-2', value: 6 })];
      expect(ruleGapCandidates(idle, [], NOW)).toEqual([]);
    });

    test("aiops 'net' maps to the AlertRule 'network' metric", () => {
      const out = ruleGapCandidates([anomaly({ metric: 'net', value: 70 }), anomaly({ metric: 'net', value: 80 })], [], NOW);
      expect(out[0].proposedChange.newValue).toMatchObject({ metric: 'network' });
    });
  });

  describe('deriveCandidates + de-duplication', () => {
    test('collapses the same proposal reached by two different rules', () => {
      // A spiking host also constitutes a fleet-wide cpu gap — both rules propose the same cpu rule.
      const anomalies = [anomaly({ value: 91 }), anomaly({ value: 97 }), anomaly({ value: 99 })];
      const out = deriveCandidates({ policies: [], violations: [], anomalies, rules: [], now: NOW });
      expect(out.filter((c) => c.category === 'alert-rule-add')).toHaveLength(1);
    });

    test('an empty control plane yields no recommendations (no fabrication)', () => {
      expect(deriveCandidates({ policies: [], violations: [], anomalies: [], rules: [], now: NOW })).toEqual([]);
    });

    test('combines governance + aiops findings', () => {
      const out = deriveCandidates({
        policies: [policy()],
        violations: [violation('a'), violation('b'), violation('c')],
        anomalies: [anomaly({ value: 4 }), anomaly({ value: 6 }), anomaly({ value: 5 })],
        rules: [],
        now: NOW,
      });
      expect(out.map((c) => c.category).sort()).toEqual(['idle-rightsizing', 'policy-tighten']);
    });

    test('is deterministic — same input, same output', () => {
      const input = { policies: [policy()], violations: [violation('a'), violation('b'), violation('c')], anomalies: [], rules: [], now: NOW };
      expect(deriveCandidates(input)).toEqual(deriveCandidates(input));
    });

    test('dedupeKey is stable for an equivalent proposal and distinct across targets', () => {
      const base = { source: 'governance' as const, category: 'policy-tighten', title: 't', description: 'd', proposedChange: { target: 'Policy' as const, targetId: 'p1', field: 'effect', newValue: 'alert' } };
      expect(dedupeKey(base)).toBe(dedupeKey({ ...base, title: 'different title' }));
      expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, proposedChange: { ...base.proposedChange, targetId: 'p2' } }));
    });
  });

  test('DEFAULT_RULES matches the documented Layer 12 thresholds', () => {
    expect(DEFAULT_RULES).toMatchObject({ violationMin: 3, violationWindowDays: 7, anomalyMin: 3, ruleGapMin: 2 });
  });
});
