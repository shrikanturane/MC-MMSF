import { inWindow, matchSuppression, parseSuppressions, type SuppressionWindow } from './suppression';

const W = (over: Partial<SuppressionWindow>): SuppressionWindow => ({
  id: 'w1', name: 'nightly batch', match: 'batch', metric: 'cpu', days: [], startHour: 1, endHour: 4, enabled: true, ...over,
});

const at = (hourUtc: number, dowOffset = 0) => new Date(Date.UTC(2026, 6, 5 + dowOffset, hourUtc, 30)); // 2026-07-05 = Sunday

describe('suppression windows (thesis 2.4 — legitimate sustained load)', () => {
  test('spike inside the declared window is suppressed', () => {
    expect(matchSuppression([W({})], 'nightly-batch-runner', 'cpu', at(2))?.id).toBe('w1');
  });

  test('same spike outside the window is NOT suppressed', () => {
    expect(matchSuppression([W({})], 'nightly-batch-runner', 'cpu', at(12))).toBeNull();
  });

  test('resource and metric filters must both match', () => {
    expect(matchSuppression([W({})], 'web-server', 'cpu', at(2))).toBeNull(); // name mismatch
    expect(matchSuppression([W({})], 'batch-runner', 'net', at(2))).toBeNull(); // metric mismatch
    expect(matchSuppression([W({ metric: '' })], 'batch-runner', 'net', at(2))?.id).toBe('w1'); // '' = any metric
  });

  test('day-of-week restriction (UTC)', () => {
    const sundayOnly = W({ days: [0] });
    expect(inWindow(sundayOnly, at(2, 0))).toBe(true); // Sunday
    expect(inWindow(sundayOnly, at(2, 1))).toBe(false); // Monday
  });

  test('overnight window (22→04) covers both sides of midnight', () => {
    const overnight = W({ startHour: 22, endHour: 4 });
    expect(inWindow(overnight, at(23))).toBe(true);
    expect(inWindow(overnight, at(2))).toBe(true);
    expect(inWindow(overnight, at(12))).toBe(false);
  });

  test('disabled window never matches; parse drops junk defensively', () => {
    expect(matchSuppression([W({ enabled: false })], 'batch', 'cpu', at(2))).toBeNull();
    expect(parseSuppressions('not json')).toEqual([]);
    expect(parseSuppressions(JSON.stringify([{ name: 'x', startHour: 99, endHour: -3, days: [9, 2] }]))[0]).toMatchObject({
      startHour: 23,
      endHour: 1,
      days: [2],
    });
  });
});
