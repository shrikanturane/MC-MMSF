import { scoreTrial, type TrialDetection, type TrialLabel } from './eval';

describe('eval scorer — precision / recall / FP-rate / MTTD', () => {
  const labels: TrialLabel[] = [
    { resourceId: 'a', resourceName: 'anom-1', label: 'anomalous', injectedAt: '2026-07-06T10:00:00.000Z' },
    { resourceId: 'b', resourceName: 'anom-2', label: 'anomalous', injectedAt: '2026-07-06T10:00:00.000Z' },
    { resourceId: 'c', resourceName: 'norm-1', label: 'normal' },
    { resourceId: 'd', resourceName: 'norm-2', label: 'normal' },
  ];

  test('mixed outcome: TP, FN, FP, TN all counted; metrics exact', () => {
    const detections: TrialDetection[] = [
      { resourceId: 'a', detectorType: 'cost', detectedAt: '2026-07-06T10:05:00.000Z', score: 6, reason: 'spike' },
      { resourceId: 'c', detectorType: 'behaviour', detectedAt: '2026-07-06T10:07:00.000Z', score: 4, reason: 'noise' },
    ];
    const r = scoreTrial(labels, detections);
    expect(r.counts).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    expect(r.precision).toBe(0.5); // 1 / (1+1)
    expect(r.recall).toBe(0.5); // 1 / (1+1)
    expect(r.fpRate).toBe(0.5); // 1 / (1+1)
    expect(r.mttdSeconds).toBe(300); // 10:00 → 10:05
  });

  test('perfect run: precision/recall 1, fpRate 0; MTTD = mean of first detections', () => {
    const detections: TrialDetection[] = [
      { resourceId: 'a', detectorType: 'cost', detectedAt: '2026-07-06T10:02:00.000Z', score: 6, reason: 'x' },
      { resourceId: 'a', detectorType: 'cost', detectedAt: '2026-07-06T11:00:00.000Z', score: 6, reason: 'later dup' },
      { resourceId: 'b', detectorType: 'behaviour', detectedAt: '2026-07-06T10:06:00.000Z', score: 5, reason: 'y' },
    ];
    const r = scoreTrial(labels, detections);
    expect(r.counts).toEqual({ tp: 2, fp: 0, tn: 2, fn: 0 });
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.fpRate).toBe(0);
    expect(r.mttdSeconds).toBe(240); // mean(120, 360) — first detection per resource
  });

  test('nothing flagged: precision null (undefined), recall 0, fpRate 0', () => {
    const r = scoreTrial(labels, []);
    expect(r.precision).toBeNull();
    expect(r.recall).toBe(0);
    expect(r.fpRate).toBe(0);
    expect(r.mttdSeconds).toBeNull();
  });

  test('two-VM pilot case is representable: anomalous twin TP, normal twin TN', () => {
    const twins: TrialLabel[] = [
      { resourceId: 't-bad', resourceName: 'twin-anomalous', label: 'anomalous', injectedAt: '2026-07-06T10:00:00.000Z' },
      { resourceId: 't-ok', resourceName: 'twin-normal', label: 'normal' },
    ];
    const r = scoreTrial(twins, [
      { resourceId: 't-bad', detectorType: 'cost', detectedAt: '2026-07-06T10:04:00.000Z', score: 7, reason: '3.5× spike' },
    ]);
    expect(r.cases.find((c) => c.resourceId === 't-bad')?.outcome).toBe('TP');
    expect(r.cases.find((c) => c.resourceId === 't-ok')?.outcome).toBe('TN');
    expect(r.precision).toBe(1);
    expect(r.fpRate).toBe(0);
  });
});
