/**
 * Recording retention — pure, deterministic, no I/O.
 *
 * Session recordings are the one part of this feature that can take a server down: 10 fps of a 1080p
 * desktop is ~500 MB per 15 minutes as JPEG, and even H.264 accumulates. This platform has already hit
 * 100% disk in production once, which broke a deploy and stalled Postgres mid-restore. So retention is
 * not a nice-to-have bolted on later — it decides, up front, what gets deleted, and it is unit-tested.
 *
 * Two independent limits, because either alone fails:
 *   · maxAgeDays  — the compliance answer ("we keep support recordings for N days"). Default 15.
 *   · maxTotalMb  — the operational answer (a burst of sessions inside the window can still fill a disk).
 * Age is applied first; if the cap is still exceeded, the OLDEST recordings go until it fits.
 */

export interface RecordingFile {
  path: string;
  bytes: number;
  /** When the session that produced it ended (not the file mtime — that can be rewritten). */
  endedAt: Date;
}

export interface RetentionConfig {
  maxAgeDays: number;
  maxTotalMb: number;
  /** A single runaway session must never be able to fill the disk on its own. */
  maxSessionMb: number;
  /** Wall-clock cap on ONE file. A long session keeps recording, into the next part. */
  maxFileHours: number;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  maxAgeDays: 15,
  maxTotalMb: 5120, // 5 GB across all recordings
  // Size of ONE FILE, not one session. A session that outgrows this rolls to the next part
  // (<id>-p2.mp4, -p3.mp4 …) rather than being truncated — see Recorder.write. Measured on the
  // ENCODED mp4, never on the JPEGs fed in.
  maxSessionMb: 100,
  // Four hours per file. Size alone is not enough: a mostly-still screen compresses so well that a
  // whole day could land in one file, and nobody wants to scrub through that to find one incident.
  // Whichever cap is hit first rolls to the next part; recording never stops.
  maxFileHours: 4,
};

export interface RetentionPlan {
  /** Files to delete, oldest first. */
  delete: RecordingFile[];
  /** Why each one goes — surfaced in the log so deletions are never mysterious. */
  reasons: Record<string, 'expired' | 'over-quota'>;
  keptBytes: number;
  freedBytes: number;
}

const MB = 1024 * 1024;

/**
 * Decide what to delete. Pure: same inputs, same plan. Nothing is deleted for being merely old *and*
 * within quota — both rules are explicit, so an operator can always explain a missing recording.
 */
export function planRetention(
  files: RecordingFile[],
  now: Date,
  cfg: RetentionConfig = DEFAULT_RETENTION,
): RetentionPlan {
  const reasons: Record<string, 'expired' | 'over-quota'> = {};
  const byOldest = [...files].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
  const cutoff = now.getTime() - cfg.maxAgeDays * 86_400_000;

  const expired = byOldest.filter((f) => f.endedAt.getTime() < cutoff);
  for (const f of expired) reasons[f.path] = 'expired';

  let kept = byOldest.filter((f) => f.endedAt.getTime() >= cutoff);
  const overQuota: RecordingFile[] = [];
  let keptBytes = kept.reduce((a, f) => a + f.bytes, 0);
  const capBytes = cfg.maxTotalMb * MB;
  // Still too big after expiry: drop the OLDEST survivors until it fits. Newest recordings are the ones
  // an operator is most likely to need, so they are the last to go.
  while (keptBytes > capBytes && kept.length) {
    const victim = kept.shift() as RecordingFile;
    overQuota.push(victim);
    reasons[victim.path] = 'over-quota';
    keptBytes -= victim.bytes;
  }

  const del = [...expired, ...overQuota].sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());
  return { delete: del, reasons, keptBytes, freedBytes: del.reduce((a, f) => a + f.bytes, 0) };
}

/** Has a single session's recording outgrown its cap? (Checked while recording, not afterwards.) */
export const sessionOverCap = (bytes: number, cfg: RetentionConfig = DEFAULT_RETENTION): boolean =>
  bytes > cfg.maxSessionMb * MB;

/** Has the current file been open too long? The other half of "when do we start a new file". */
export const fileOverAge = (openedAtMs: number, nowMs: number, cfg: RetentionConfig = DEFAULT_RETENTION): boolean =>
  cfg.maxFileHours > 0 && nowMs - openedAtMs >= cfg.maxFileHours * 3_600_000;

/** Human summary for the log — deletions must be explainable months later. */
export function describePlan(plan: RetentionPlan): string {
  if (!plan.delete.length) return 'retention: nothing to delete';
  const exp = plan.delete.filter((f) => plan.reasons[f.path] === 'expired').length;
  const quo = plan.delete.length - exp;
  const mb = (plan.freedBytes / MB).toFixed(1);
  const bits = [exp ? `${exp} expired` : '', quo ? `${quo} over quota` : ''].filter(Boolean).join(', ');
  return `retention: deleting ${plan.delete.length} recording(s) (${bits}) — freeing ${mb} MB`;
}
