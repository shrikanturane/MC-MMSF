/** Canonical live-metrics shape returned by every provider's metrics collector. */
export interface TimePoint {
  ts: string;
  value: number;
}

export interface ResourceMetrics {
  available: boolean;
  cpu: TimePoint[]; // %
  networkMbps: TimePoint[];
  diskKBps: TimePoint[];
  memoryAvailGB: TimePoint[] | null;
  latest: {
    cpuPct: number | null;
    networkMbps: number | null;
    diskKBps: number | null;
    memoryAvailGB: number | null;
    memoryPct?: number | null; // agent-based
    diskPct?: number | null; // agent-based
  };
  note?: string;
}

export function emptyLatest() {
  return { cpuPct: null, networkMbps: null, diskKBps: null, memoryAvailGB: null, memoryPct: null, diskPct: null };
}

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function lastValue(a: { value: number }[]): number | null {
  return a.length ? a[a.length - 1].value : null;
}
