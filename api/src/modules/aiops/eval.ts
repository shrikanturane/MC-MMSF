/**
 * Eval scorer — turns a labelled control trial into thesis metrics:
 * precision, recall, false-positive rate, and mean-time-to-detect (MTTD).
 *
 * Pure: labels + detections in, metrics out. The harness (service layer) injects
 * the synthetic series and runs the detectors; this file only does the math.
 */

export interface TrialLabel {
  resourceId: string;
  resourceName: string;
  label: 'normal' | 'anomalous';
  /** For anomalous resources: when the anomaly was injected (ISO). MTTD is measured from here. */
  injectedAt?: string;
}

export interface TrialDetection {
  resourceId: string;
  detectorType: string;
  detectedAt: string;
  score: number;
  reason: string;
}

export interface TrialCase {
  resourceId: string;
  resourceName: string;
  label: 'normal' | 'anomalous';
  flagged: boolean;
  outcome: 'TP' | 'FP' | 'TN' | 'FN';
  detectSeconds: number | null; // anomalous+flagged: seconds from injectedAt to first detection
  detail: string;
}

export interface TrialReport {
  precision: number | null; // TP / (TP+FP) — null when nothing was flagged
  recall: number | null; // TP / (TP+FN) — null when nothing anomalous was labelled
  fpRate: number | null; // FP / (FP+TN) — null when nothing normal was labelled
  mttdSeconds: number | null; // mean over detected anomalous cases
  counts: { tp: number; fp: number; tn: number; fn: number };
  cases: TrialCase[];
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function scoreTrial(labels: TrialLabel[], detections: TrialDetection[]): TrialReport {
  const byResource = new Map<string, TrialDetection[]>();
  for (const d of detections) {
    const list = byResource.get(d.resourceId) ?? [];
    list.push(d);
    byResource.set(d.resourceId, list);
  }

  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  const detectTimes: number[] = [];

  const cases: TrialCase[] = labels.map((l) => {
    const hits = (byResource.get(l.resourceId) ?? []).sort(
      (a, b) => new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime(),
    );
    const flagged = hits.length > 0;
    const first = hits[0];

    let outcome: TrialCase['outcome'];
    if (l.label === 'anomalous') outcome = flagged ? 'TP' : 'FN';
    else outcome = flagged ? 'FP' : 'TN';
    if (outcome === 'TP') tp++;
    else if (outcome === 'FP') fp++;
    else if (outcome === 'TN') tn++;
    else fn++;

    let detectSeconds: number | null = null;
    if (outcome === 'TP' && first && l.injectedAt) {
      detectSeconds = Math.max(0, (new Date(first.detectedAt).getTime() - new Date(l.injectedAt).getTime()) / 1000);
      detectTimes.push(detectSeconds);
    }

    const detail =
      outcome === 'TP'
        ? `flagged by ${first?.detectorType} (${first?.reason})`
        : outcome === 'FN'
          ? 'anomalous but never flagged'
          : outcome === 'FP'
            ? `normal but flagged by ${first?.detectorType} (${first?.reason})`
            : 'normal, not flagged (correct)';

    return {
      resourceId: l.resourceId,
      resourceName: l.resourceName,
      label: l.label,
      flagged,
      outcome,
      detectSeconds: detectSeconds !== null ? Math.round(detectSeconds) : null,
      detail,
    };
  });

  return {
    precision: tp + fp > 0 ? r3(tp / (tp + fp)) : null,
    recall: tp + fn > 0 ? r3(tp / (tp + fn)) : null,
    fpRate: fp + tn > 0 ? r3(fp / (fp + tn)) : null,
    mttdSeconds: detectTimes.length ? Math.round(detectTimes.reduce((s, v) => s + v, 0) / detectTimes.length) : null,
    counts: { tp, fp, tn, fn },
    cases,
  };
}
