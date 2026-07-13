/**
 * Pure, deterministic helpers for failover-trial evidence (RTO/RPO/outcome + DRBD role parsing).
 *
 * Kept free of I/O, SSH, and Date.now() so the timing/verification maths can be unit-tested with
 * fixed inputs — the numbers a controlled DR trial produces must be reproducible and auditable.
 *
 *   RPO (Recovery Point Objective) = the data-loss window: how far behind the last known-good
 *                                    replication (set.lastOkAt) the failover happened.
 *   RTO (Recovery Time Objective)  = the recovery time: trigger → new primary verified live.
 */

/** Round to whole seconds, never negative (clock skew / out-of-order stamps clamp to 0). */
function toSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.round(ms / 1000);
}

/**
 * RPO in seconds = (trigger time) − (last successful replication). Derived from the set's
 * lastOkAt captured at trigger time. Returns null when the set never replicated successfully
 * (no baseline → the data-loss window is genuinely unknown, not zero).
 */
export function computeRpoSeconds(
  lastOkAt: Date | null | undefined,
  triggeredAt: Date,
): number | null {
  if (!lastOkAt) return null;
  return toSeconds(triggeredAt.getTime() - lastOkAt.getTime());
}

/**
 * RTO in seconds = (verified-live time) − (trigger time). Returns null when the new primary was
 * never verified (the trial did not reach a confirmed-live state, so recovery time is undefined).
 */
export function computeRtoSeconds(
  triggeredAt: Date,
  verifiedAt: Date | null | undefined,
): number | null {
  if (!verifiedAt) return null;
  return toSeconds(verifiedAt.getTime() - triggeredAt.getTime());
}

/**
 * Parse `drbdadm status` output for the LOCAL node's role and disk state. Handles both the modern
 * tree format (`<res> role:Primary` / `disk:UpToDate`) and the legacy /proc/drbd style
 * (`ro:Primary/Secondary` / `ds:UpToDate/UpToDate`). The local role sits on the resource header
 * line, before any indented `peer` block — so we look at the text preceding the first "peer".
 */
export function parseDrbdRole(statusText: string): { primary: boolean; upToDate: boolean } {
  const text = String(statusText || '');
  const head = text.split(/\bpeer\b/i)[0] || '';
  const primary = /\brole:\s*Primary\b/i.test(head) || /\bro:\s*Primary\b/i.test(text);
  // Modern: local disk state on the header block; legacy: ds:<local>/<peer>.
  const upToDate =
    /\bdisk:\s*UpToDate\b/i.test(head) || /\bds:\s*UpToDate\b/i.test(text);
  return { primary, upToDate };
}

export interface OutcomeInput {
  /** The promote command completed (new active side was made primary). */
  promoted: boolean;
  /** This set uses DRBD block replication (verification re-parses drbdadm status). */
  isBlock: boolean;
  /** Verification found the new primary in role:Primary. */
  drbdPrimary: boolean;
  /** Verification found the local disk UpToDate. */
  drbdUpToDate: boolean;
  /** An app-level health check was performed against the promoted host. */
  healthChecked: boolean;
  /** The app-level health check passed. */
  healthOk: boolean;
}

/**
 * Classify a trial: 'success' (promoted + verified live), 'partial' (promoted but verification
 * incomplete — e.g. primary but not confirmed UpToDate, or health check failed), or 'failed'
 * (promotion itself did not complete). Verification never trusts the SSH exit code alone.
 */
export function deriveOutcome(v: OutcomeInput): 'success' | 'partial' | 'failed' {
  if (!v.promoted) return 'failed';
  if (v.isBlock) {
    if (v.drbdPrimary && v.drbdUpToDate) {
      return v.healthChecked && !v.healthOk ? 'partial' : 'success';
    }
    if (v.drbdPrimary) return 'partial'; // primary role confirmed, but disk not confirmed UpToDate
    return 'failed'; // promoted but the node did not actually take the Primary role
  }
  // Non-block (files/database/docker): no DRBD role to inspect — fall back to the health check.
  if (v.healthChecked) return v.healthOk ? 'success' : 'partial';
  return 'success';
}
