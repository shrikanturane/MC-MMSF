import { detectThreshold } from './threshold.detector';

const NOW = '2026-07-06T12:00:00.000Z';

const input = (latest: Partial<Record<string, number>>) => ({
  resourceId: 'vm-1',
  resourceName: 'db-01',
  provider: 'gcp',
  latest,
  nowIso: NOW,
});

describe('threshold detector — rule breaches, never conflated with anomalies', () => {
  test('CPU breach labeled threshold/rule, not anomaly', () => {
    const [d] = detectThreshold(input({ cpu: 96 }));
    expect(d?.detectorType).toBe('threshold');
    expect(d?.baseline).toBe('rule');
    expect(d?.reason).toContain('rule breach, not a statistical anomaly');
  });

  test('disk capacity warning at 85, critical at 95 — highest rule wins, one row per metric', () => {
    expect(detectThreshold(input({ disk: 88 }))[0]?.severity).toBe('medium');
    const critical = detectThreshold(input({ disk: 97 }));
    expect(critical).toHaveLength(1);
    expect(critical[0]?.severity).toBe('critical');
  });

  test('under-threshold values and absent metrics produce nothing', () => {
    expect(detectThreshold(input({ cpu: 89.9, disk: 50 }))).toHaveLength(0);
    expect(detectThreshold(input({}))).toHaveLength(0);
  });

  test('multiple metrics can breach independently', () => {
    const out = detectThreshold(input({ cpu: 95, disk: 90 }));
    expect(out.map((d) => d.metric).sort()).toEqual(['cpu', 'disk']);
  });
});
