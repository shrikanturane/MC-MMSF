/**
 * Cross-cloud signal correlation — links alerts firing on the SAME metric within a
 * short window across DIFFERENT providers into one correlated group (thesis 5.3:
 * an incident spanning 2+ clouds must surface as one linked event, not N islands).
 *
 * Pure and deterministic: alerts in → groups out.
 */

export interface CorrAlert {
  id: string;
  title: string;
  metric?: string | null;
  provider?: string | null; // resolved from the alert's resource
  resourceName?: string | null;
  raisedAt: string; // ISO
}

export interface CorrGroup {
  key: string;
  metric: string;
  providers: string[]; // distinct, sorted
  crossCloud: boolean; // ≥2 distinct providers
  alertIds: string[];
  resources: string[];
  startedAt: string;
  spanMs: number;
}

export const DEFAULT_CORR_WINDOW_MS = 5 * 60_000;

/**
 * Cluster same-metric alerts by time proximity: a cluster grows while the next
 * alert (time-ordered) is within `windowMs` of the cluster's LAST member. Groups
 * of ≥2 alerts are returned; `crossCloud` marks ≥2 distinct providers.
 */
export function correlateAlerts(alerts: CorrAlert[], windowMs = DEFAULT_CORR_WINDOW_MS): CorrGroup[] {
  const byMetric = new Map<string, CorrAlert[]>();
  for (const a of alerts) {
    const metric = (a.metric ?? 'unknown').toLowerCase();
    const list = byMetric.get(metric) ?? [];
    list.push(a);
    byMetric.set(metric, list);
  }

  const groups: CorrGroup[] = [];
  for (const [metric, list] of byMetric) {
    const sorted = [...list].sort((a, b) => new Date(a.raisedAt).getTime() - new Date(b.raisedAt).getTime());
    let cluster: CorrAlert[] = [];
    const flush = () => {
      if (cluster.length < 2) return;
      const providers = [...new Set(cluster.map((a) => a.provider ?? 'unknown'))].sort();
      const start = new Date((cluster[0] as CorrAlert).raisedAt).getTime();
      const end = new Date((cluster[cluster.length - 1] as CorrAlert).raisedAt).getTime();
      groups.push({
        key: `${metric}:${(cluster[0] as CorrAlert).id}`,
        metric,
        providers,
        crossCloud: providers.filter((p) => p !== 'unknown').length >= 2,
        alertIds: cluster.map((a) => a.id),
        resources: [...new Set(cluster.map((a) => a.resourceName ?? '?'))],
        startedAt: new Date(start).toISOString(),
        spanMs: end - start,
      });
    };
    for (const a of sorted) {
      const last = cluster[cluster.length - 1];
      if (!last || new Date(a.raisedAt).getTime() - new Date(last.raisedAt).getTime() <= windowMs) cluster.push(a);
      else {
        flush();
        cluster = [a];
      }
    }
    flush();
  }
  // Cross-cloud first, then largest.
  return groups.sort((a, b) => Number(b.crossCloud) - Number(a.crossCloud) || b.alertIds.length - a.alertIds.length);
}
