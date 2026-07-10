import { detectCost, type CostDetectInput } from './cost.detector';

const NOW = '2026-07-06T12:00:00.000Z';

/** n hourly self-history buckets around a base cost (deterministic ±2% wobble). */
function selfHistory(n: number, base: number): { ts: string; cost: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    ts: new Date(Date.UTC(2026, 5, 1, i)).toISOString(),
    cost: base * (1 + 0.02 * Math.sin(i)),
  }));
}

function input(over: Omit<Partial<CostDetectInput>, 'resource'> & { resource?: Partial<CostDetectInput['resource']> }): CostDetectInput {
  return {
    resource: {
      id: 'vm-subject',
      name: 'subject',
      provider: 'azure',
      type: 'compute',
      service: 'Virtual Machines',
      status: 'running',
      costHourly: 0.5,
      ...(over.resource ?? {}),
    },
    selfHourlyBuckets: over.selfHourlyBuckets ?? selfHistory(72, 0.5),
    cohort: over.cohort ?? [],
    nowIso: NOW,
    cfg: over.cfg,
  };
}

describe('cost detector — robust SELF + COHORT baselines', () => {
  test('IDLE-DOMINATED COHORT: ordinary new VM among idle peers is NOT flagged (the old mean+SD defect)', () => {
    // 40 idle ($0/h — stopped VMs, empty buckets, NICs) + 4 normally-billed peers (~$0.50/h);
    // subject is a NEW normal VM at $0.52/h. Fleets are dominated by near-zero-cost rows.
    const cohort = [
      ...Array.from({ length: 40 }, (_, i) => ({ resourceId: `idle-${i}`, status: 'running', costHourly: 0 })),
      { resourceId: 'p1', status: 'running', costHourly: 0.48 },
      { resourceId: 'p2', status: 'running', costHourly: 0.51 },
      { resourceId: 'p3', status: 'running', costHourly: 0.5 },
      { resourceId: 'p4', status: 'running', costHourly: 0.53 },
    ];
    const newNormalVm = input({
      resource: { costHourly: 0.52 },
      selfHourlyBuckets: [], // brand-new: no history at all
      cohort,
    });
    expect(detectCost(newNormalVm)).toBeNull();

    // Document the defect being fixed: under fleet-wide mean+SD (idle included),
    // this same VM scores z ≥ 2 — i.e. the old detector WOULD have flagged it.
    const all = [...cohort.map((c) => c.costHourly), 0.52];
    const mean = all.reduce((s, v) => s + v, 0) / all.length;
    const sd = Math.sqrt(all.reduce((s, v) => s + (v - mean) ** 2, 0) / all.length);
    expect((0.52 - mean) / sd).toBeGreaterThanOrEqual(2);
  });

  test('COLD-START SUPPRESSION: <24h history + ordinary cohort standing → not flagged on cost alone', () => {
    const res = detectCost(
      input({
        resource: { costHourly: 0.55 },
        selfHourlyBuckets: selfHistory(6, 0.55), // 6h old — under the 24h cold-start bar
        cohort: [
          { resourceId: 'p1', status: 'running', costHourly: 0.5 },
          { resourceId: 'p2', status: 'running', costHourly: 0.52 },
          { resourceId: 'p3', status: 'running', costHourly: 0.49 },
          { resourceId: 'p4', status: 'running', costHourly: 0.51 },
        ],
      }),
    );
    expect(res).toBeNull();
  });

  test('cold-start resource that DOES exceed the cohort MAD threshold is flagged (cohort baseline)', () => {
    const res = detectCost(
      input({
        resource: { costHourly: 2.6 }, // ~5× its peers
        selfHourlyBuckets: selfHistory(3, 2.6),
        cohort: [
          { resourceId: 'p1', status: 'running', costHourly: 0.5 },
          { resourceId: 'p2', status: 'running', costHourly: 0.52 },
          { resourceId: 'p3', status: 'running', costHourly: 0.49 },
          { resourceId: 'p4', status: 'running', costHourly: 0.51 },
        ],
      }),
    );
    expect(res).not.toBeNull();
    expect(res?.baseline).toBe('cohort');
    expect(res?.reason).toContain('cold-start');
    expect(res?.reason).toContain('× cohort median');
  });

  test('TWO-VM DISCRIMINATION: same-size twins — anomalous one flagged, normal one not (pilot case)', () => {
    const twins = (subjectCost: number) =>
      input({
        resource: { costHourly: subjectCost },
        selfHourlyBuckets: selfHistory(21 * 24, 0.5), // 21 days of ~$0.50/h history for BOTH
        cohort: [
          { resourceId: 'twin', status: 'running', costHourly: 0.5 },
          { resourceId: 'p2', status: 'running', costHourly: 0.51 },
          { resourceId: 'p3', status: 'running', costHourly: 0.49 },
          { resourceId: 'p4', status: 'running', costHourly: 0.5 },
        ],
      });

    const anomalous = detectCost(twins(0.5 * 3.5)); // cost jumped 3.5×
    const normal = detectCost(twins(0.5));

    expect(anomalous).not.toBeNull();
    expect(anomalous?.severity).toMatch(/high|critical/);
    expect(normal).toBeNull();
  });

  test('SELF baseline catches a spike vs own history and says so in the reason', () => {
    const res = detectCost(
      input({
        resource: { costHourly: 1.6 },
        selfHourlyBuckets: selfHistory(30 * 24, 0.5),
        cohort: [], // no usable cohort — self must carry it
      }),
    );
    expect(res).not.toBeNull();
    expect(res?.baseline).toBe('self');
    expect(res?.detectorType).toBe('cost');
  });

  test('non-running subject and too-small cohorts are never evaluated', () => {
    expect(detectCost(input({ resource: { status: 'stopped', costHourly: 99 } }))).toBeNull();
    const tinyCohort = detectCost(
      input({
        resource: { costHourly: 9 },
        selfHourlyBuckets: [],
        cohort: [{ resourceId: 'p1', status: 'running', costHourly: 0.5 }],
      }),
    );
    expect(tinyCohort).toBeNull(); // 1 peer < minCohort → no cohort; cold-start → no self
  });

  test('deterministic: identical input → identical score', () => {
    const a = detectCost(input({ resource: { costHourly: 1.7 } }));
    const b = detectCost(input({ resource: { costHourly: 1.7 } }));
    expect(a?.score).toBe(b?.score);
  });
});
