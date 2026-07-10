import { ewma, mad, median, modifiedZ, modifiedZOf, MODIFIED_Z_CAP, rollingMedianMad } from './stats';

describe('aiops stats (robust, deterministic)', () => {
  test('median: odd, even, empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  test('MAD ignores extreme outliers where SD would not', () => {
    const xs = [10, 11, 9, 10, 12, 10, 1000];
    expect(median(xs)).toBe(10);
    expect(mad(xs)).toBe(1); // the 1000 outlier barely moves MAD
  });

  test('modified z-score = 0.6745*(x-med)/MAD', () => {
    expect(modifiedZ(14, 10, 1)).toBeCloseTo(2.698, 3);
    expect(modifiedZ(10, 10, 1)).toBe(0);
  });

  test('MAD=0: z is 0 at the median, capped (finite) off it', () => {
    expect(modifiedZ(5, 5, 0)).toBe(0);
    expect(modifiedZ(9, 5, 0)).toBe(MODIFIED_Z_CAP);
    expect(modifiedZ(1, 5, 0)).toBe(-MODIFIED_Z_CAP);
  });

  test('deterministic: same series → same score', () => {
    const series = [5, 6, 5, 7, 5, 6, 5, 40];
    const a = modifiedZOf(series[series.length - 1] as number, series.slice(0, -1));
    const b = modifiedZOf(series[series.length - 1] as number, series.slice(0, -1));
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(3.5);
  });

  test('ewma converges toward sustained new level', () => {
    expect(ewma([10, 10, 10], 0.3)).toBe(10);
    expect(ewma([10, 10, 100, 100, 100, 100], 0.5)).toBeGreaterThan(80);
    expect(ewma([], 0.5)).toBe(0);
  });

  test('rollingMedianMad scores each point against the preceding window only', () => {
    const flat = Array(10).fill(50) as number[];
    const scored = rollingMedianMad([...flat, 90], 10);
    expect((scored[10] as { z: number }).z).toBe(MODIFIED_Z_CAP); // flat window, big jump
    expect(scored.slice(0, 10).every((p) => p.z === 0)).toBe(true); // no full window yet
  });
});
