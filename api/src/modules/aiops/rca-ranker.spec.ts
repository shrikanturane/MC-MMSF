import { rankCauses } from './rca-ranker';

describe('RCA cause ranker — deterministic top-k (thesis 5.1/5.4)', () => {
  test('CPU incident: cpu-saturation ranks #1 with metric + evidence corroboration', () => {
    const ranked = rankCauses(
      { title: 'High CPU: web-01 (cpu 96% gt 85)', metric: 'cpu', resourceName: 'web-01' },
      ['Hot resource: web-01 CPU 96% / Mem 40%', 'Event warning: Alert raised: High CPU on web-01', 'SIEM info: load average climbing (web-01)'],
    );
    expect(ranked[0]?.cause).toBe('cpu-saturation');
    expect(ranked[0]?.score).toBeGreaterThan(0.5);
  });

  test('disk-full incident recognized from evidence even without a subject metric', () => {
    const ranked = rankCauses(
      { title: 'Service degraded on db-02' },
      ['Event critical: volume /data no space left on device', 'SIEM warning: filesystem 98% (db-02)', 'Event warning: disk pressure db-02'],
    );
    expect(ranked[0]?.cause).toBe('disk-full');
  });

  test('power-state incident: vm_power_off signature wins over generic noise', () => {
    const ranked = rankCauses(
      { title: 'Device unreachable: app-07', metric: 'event' },
      ['Event critical: vm_power_off app-07', 'Event info: sync completed', 'SIEM info: agent offline app-07'],
    );
    expect(ranked[0]?.cause).toBe('power-state');
  });

  test('cost anomaly incident maps to cost-spike', () => {
    const ranked = rankCauses(
      { title: 'Cost anomaly: r5-large-3 — cost 3.5× cohort median', metric: 'cost' },
      ['Event warning: monthly spend jumped for r5-large-3', 'Event info: billing sync completed'],
    );
    expect(ranked[0]?.cause).toBe('cost-spike');
  });

  test('top-k shape: ≤5 candidates, sorted desc, deterministic', () => {
    const subject = { title: 'High CPU: web-01', metric: 'cpu' };
    const evidence = ['Hot resource: web-01 CPU 96%', 'SIEM warning: memory climbing', 'Event warning: disk 86%'];
    const a = rankCauses(subject, evidence);
    const b = rankCauses(subject, evidence);
    expect(a).toEqual(b);
    expect(a.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < a.length; i++) expect((a[i - 1] as { score: number }).score).toBeGreaterThanOrEqual((a[i] as { score: number }).score);
  });

  test('no signals → empty ranking (never invents a cause)', () => {
    expect(rankCauses({ title: 'quiet' }, [])).toHaveLength(0);
  });
});
