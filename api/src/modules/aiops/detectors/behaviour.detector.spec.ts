import { detectBehaviour, type BehaviourSeriesInput } from './behaviour.detector';

const NOW = '2026-07-06T12:00:00.000Z';

function series(values: number[], over?: Partial<BehaviourSeriesInput>): BehaviourSeriesInput {
  return {
    resourceId: 'vm-1',
    resourceName: 'web-01',
    provider: 'aws',
    metric: 'cpu',
    values,
    nowIso: NOW,
    ...over,
  };
}

/** Deterministic baseline around `base` (±1 wobble, no RNG). */
const baseline = (n: number, base: number) => Array.from({ length: n }, (_, i) => base + Math.sin(i));

describe('behaviour detector — rolling median+MAD, K consecutive breaches', () => {
  test('single transient spike does NOT flag', () => {
    const values = [...baseline(60, 30), 95, 31, 30, 29, 30]; // one spike, then back to normal
    expect(detectBehaviour(series(values))).toBeNull();
  });

  test('sustained deviation (K=5 consecutive) DOES flag', () => {
    const values = [...baseline(60, 30), 92, 94, 93, 95, 94];
    const res = detectBehaviour(series(values));
    expect(res).not.toBeNull();
    expect(res?.detectorType).toBe('behaviour');
    expect(res?.baseline).toBe('self');
    expect(res?.reason).toContain('consecutive samples');
  });

  test('4 consecutive breaches (one short of K) does NOT flag', () => {
    // 65 samples so the length precondition passes — the run length is what stops it.
    const values = [...baseline(60, 30), 30.5, 92, 94, 93, 95];
    expect(detectBehaviour(series(values))).toBeNull();
  });

  test('breach that already ended is not re-flagged (tail must be breaching)', () => {
    const values = [...baseline(60, 30), 92, 94, 93, 95, 94, 30, 31]; // excursion over
    expect(detectBehaviour(series(values))).toBeNull();
  });

  test('sustained DROP flags too (negative deviation, e.g. traffic falls off a cliff)', () => {
    const net = Array.from({ length: 60 }, (_, i) => 400 + 5 * Math.sin(i));
    const values = [...net, 2, 1, 2, 1, 2];
    const res = detectBehaviour(series(values, { metric: 'net' }));
    expect(res).not.toBeNull();
    expect(res?.score).toBeLessThan(0);
    expect(res?.reason).toContain('below');
  });

  test('too little history → null (needs window + K samples)', () => {
    expect(detectBehaviour(series(baseline(30, 50)))).toBeNull();
  });

  test('deterministic: same series → same score', () => {
    const values = [...baseline(60, 30), 92, 94, 93, 95, 94];
    expect(detectBehaviour(series(values))?.score).toBe(detectBehaviour(series(values))?.score);
  });
});
