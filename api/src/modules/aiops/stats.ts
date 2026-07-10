/**
 * Robust statistics for anomaly detection — pure, deterministic, no I/O.
 *
 * Median + MAD (median absolute deviation) with the modified z-score
 * (0.6745 * (x - median) / MAD) instead of mean + SD, so a cohort dominated by
 * idle / near-zero-cost resources cannot drag the baseline toward zero and make
 * every ordinarily-billed resource look anomalous (the defect this module fixes).
 */

/** Median of a list. Returns 0 for an empty list. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Median absolute deviation around the median (unscaled). */
export function mad(xs: number[]): number {
  if (xs.length === 0) return 0;
  const med = median(xs);
  return median(xs.map((x) => Math.abs(x - med)));
}

/** Cap applied when MAD is 0 but the point deviates (a flat series then any deviation is "infinitely" surprising). */
export const MODIFIED_Z_CAP = 100;

/**
 * Modified z-score: 0.6745 * (x - median) / MAD.
 * MAD = 0 (flat history): 0 when x equals the median, ±MODIFIED_Z_CAP otherwise —
 * finite so scores stay sortable/serializable.
 */
export function modifiedZ(x: number, med: number, madValue: number): number {
  if (madValue === 0) return x === med ? 0 : x > med ? MODIFIED_Z_CAP : -MODIFIED_Z_CAP;
  return (0.6745 * (x - med)) / madValue;
}

/** Convenience: modified z of `x` against a sample. */
export function modifiedZOf(x: number, sample: number[]): number {
  return modifiedZ(x, median(sample), mad(sample));
}

/** Exponentially-weighted moving average of a series (alpha = weight of the newest point). */
export function ewma(xs: number[], alpha: number): number {
  if (xs.length === 0) return 0;
  let acc = xs[0] as number;
  for (let i = 1; i < xs.length; i++) acc = alpha * (xs[i] as number) + (1 - alpha) * acc;
  return acc;
}

export interface RollingPoint {
  /** Modified z of this sample vs the PRECEDING window (never includes itself). */
  z: number;
  value: number;
}

/**
 * Rolling median+MAD scoring: each sample from index `window` onward is scored
 * against the `window` samples before it. Deterministic — same series in, same
 * scores out. Points before a full window get z=0 (insufficient baseline).
 */
export function rollingMedianMad(series: number[], window: number): RollingPoint[] {
  return series.map((value, i) => {
    if (i < window) return { z: 0, value };
    const base = series.slice(i - window, i);
    return { z: modifiedZOf(value, base), value };
  });
}

export const round2 = (v: number): number => Math.round(v * 100) / 100;
