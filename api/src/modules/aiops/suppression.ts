/**
 * Suppression windows — declare EXPECTED sustained load (scheduled batch jobs,
 * backups, month-end runs) so a legitimate spike is not flagged as a behavioural
 * anomaly (thesis 2.4: sustained-but-legitimate traffic must not alert).
 *
 * Matching is pure; windows are stored by the service (IntegrationSetting JSON).
 * Hours are UTC. days: JS getUTCDay() numbers (0=Sun..6=Sat); empty = every day.
 */

export interface SuppressionWindow {
  id: string;
  name: string;
  /** Substring of the resource name ('' = every resource). */
  match: string;
  /** Metric to suppress ('' = every metric). */
  metric: string;
  /** UTC days-of-week (0-6); empty = all days. */
  days: number[];
  startHour: number; // inclusive, 0-23 UTC
  endHour: number; // exclusive, 1-24 UTC; supports overnight (start > end)
  enabled: boolean;
}

/** Is `at` inside the window's schedule? Handles overnight ranges (e.g. 22→04). */
export function inWindow(w: SuppressionWindow, at: Date): boolean {
  if (!w.enabled) return false;
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const dayOk = (dow: number) => w.days.length === 0 || w.days.includes(dow);
  if (w.startHour < w.endHour) return dayOk(day) && hour >= w.startHour && hour < w.endHour;
  // Overnight: [start..24) belongs to `day`; [0..end) belongs to the PREVIOUS day's window.
  if (hour >= w.startHour) return dayOk(day);
  if (hour < w.endHour) return dayOk((day + 6) % 7);
  return false;
}

/** First window suppressing this (resourceName, metric) at `at`, or null. */
export function matchSuppression(
  windows: SuppressionWindow[],
  resourceName: string,
  metric: string,
  at: Date,
): SuppressionWindow | null {
  for (const w of windows) {
    if (w.match && !resourceName.toLowerCase().includes(w.match.toLowerCase())) continue;
    if (w.metric && w.metric !== metric) continue;
    if (inWindow(w, at)) return w;
  }
  return null;
}

/** Parse the stored JSON config defensively (bad rows dropped, fields coerced). */
export function parseSuppressions(raw: string | null | undefined): SuppressionWindow[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((w) => w && typeof w === 'object')
      .map((w, i) => ({
        id: String(w.id ?? i),
        name: String(w.name ?? `window-${i}`),
        match: String(w.match ?? ''),
        metric: String(w.metric ?? ''),
        days: Array.isArray(w.days) ? w.days.map(Number).filter((d: number) => d >= 0 && d <= 6) : [],
        startHour: Math.min(23, Math.max(0, Number(w.startHour) || 0)),
        endHour: Math.min(24, Math.max(1, Number(w.endHour) || 24)),
        enabled: w.enabled !== false,
      }));
  } catch {
    return [];
  }
}
