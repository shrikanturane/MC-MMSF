import { correlateAlerts } from './correlation';

const t = (min: number) => new Date(Date.UTC(2026, 6, 6, 10, min)).toISOString();

describe('cross-cloud correlation (thesis 5.3)', () => {
  test('same metric within window across 3 providers → one cross-cloud group', () => {
    const groups = correlateAlerts([
      { id: 'a1', title: 'High CPU aws', metric: 'cpu', provider: 'aws', resourceName: 'aws-vm', raisedAt: t(0) },
      { id: 'a2', title: 'High CPU azure', metric: 'cpu', provider: 'azure', resourceName: 'az-vm', raisedAt: t(2) },
      { id: 'a3', title: 'High CPU gcp', metric: 'cpu', provider: 'gcp', resourceName: 'gcp-vm', raisedAt: t(4) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.crossCloud).toBe(true);
    expect(groups[0]?.providers).toEqual(['aws', 'azure', 'gcp']);
    expect(groups[0]?.alertIds).toHaveLength(3);
  });

  test('decoys (different metric / far in time) stay out of the group', () => {
    const groups = correlateAlerts([
      { id: 'a1', title: 'cpu aws', metric: 'cpu', provider: 'aws', raisedAt: t(0) },
      { id: 'a2', title: 'cpu azure', metric: 'cpu', provider: 'azure', raisedAt: t(3) },
      { id: 'd1', title: 'disk gcp', metric: 'disk', provider: 'gcp', raisedAt: t(1) }, // different metric
      { id: 'd2', title: 'cpu gcp late', metric: 'cpu', provider: 'gcp', raisedAt: t(40) }, // outside window
    ]);
    const cross = groups.filter((g) => g.crossCloud);
    expect(cross).toHaveLength(1);
    expect(cross[0]?.alertIds.sort()).toEqual(['a1', 'a2']);
  });

  test('same-provider burst is grouped but NOT marked cross-cloud', () => {
    const groups = correlateAlerts([
      { id: 'a1', title: 'cpu 1', metric: 'cpu', provider: 'aws', raisedAt: t(0) },
      { id: 'a2', title: 'cpu 2', metric: 'cpu', provider: 'aws', raisedAt: t(1) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.crossCloud).toBe(false);
  });

  test('chained clustering: each alert within window of the previous joins the cluster', () => {
    const groups = correlateAlerts(
      [
        { id: 'a1', title: '1', metric: 'net', provider: 'aws', raisedAt: t(0) },
        { id: 'a2', title: '2', metric: 'net', provider: 'azure', raisedAt: t(4) },
        { id: 'a3', title: '3', metric: 'net', provider: 'gcp', raisedAt: t(8) }, // 8 min from start but 4 from a2
      ],
      5 * 60_000,
    );
    expect(groups[0]?.alertIds).toHaveLength(3);
  });

  test('single alerts never form a group', () => {
    expect(correlateAlerts([{ id: 'a1', title: 'x', metric: 'cpu', provider: 'aws', raisedAt: t(0) }])).toHaveLength(0);
  });
});
