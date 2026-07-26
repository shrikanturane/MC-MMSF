/**
 * Replication direction + endpoint resolution — pure, no I/O, no Date.now().
 *
 * This module exists because of a measured defect. Before it, direction was a bare union and every
 * engine resolved its own hosts with the same shape of ternary:
 *
 *     direction === 'p2t' ? [primary, tertiary] : direction === 's2t' ? [secondary, tertiary]
 *                                                                     : [primary, secondary]
 *
 * The catch-all `else` is what made this dangerous: an unrecognised direction did not fail, it silently
 * ran primary -> secondary. So adding a reverse direction while missing any one of the three call sites
 * would have DESTROYED the secondary rather than saved it. Resolution now happens in exactly one place,
 * every direction is explicit, and an unknown direction throws instead of guessing.
 *
 * Measured behaviour that motivated this (15 trials, dev, 15-16 Jul 2026): all 7 fail-back trials lost
 * the data written on the secondary, including trials that waited longer than the replication interval.
 * There was no secondary-to-primary direction anywhere in the codebase, so no scheduled or manual
 * mechanism could carry that data back. Related: pressing "Sync now" mid-outage ran p2s from the stale
 * primary and rsync's own `--delete` removed the live secondary's data (observed: "Number of deleted
 * files: 1").
 *
 * NOTE ON SCOPE: none of this applies to dataType 'block' (DRBD). DRBD replicates continuously in the
 * kernel and promote() flips roles, so writes on the new Primary already flow back on their own. The
 * defect is confined to the COPY engines, which snapshot one host onto another on a timer.
 */

export type Dir = 'p2s' | 'p2t' | 's2t' | 's2p';

export type Role = 'primary' | 'secondary' | 'tertiary';

/** Sets whose replication is a periodic one-way copy. 'block' (DRBD) is continuous and excluded. */
export const COPY_ENGINES = ['files', 'database', 'docker'] as const;

export const isCopyEngine = (dataType: string): boolean => (COPY_ENGINES as readonly string[]).includes(dataType);

/** Structural subset of ReplicationSet — keeps this testable without a database. */
export interface SetShape {
  state: string; // primary-active | failed-over | tertiary-active
  dataType: string;
  primaryHost: string;
  secondaryHost: string;
  tertiaryHost?: string | null;
  sourcePath?: string | null; // where the data lives ON THE PRIMARY
  targetPath?: string | null; // where the copy lands on secondary/tertiary
  reverseReplication?: boolean;
}

/**
 * The replicated path is a property of the ROLE, not of the direction: the primary keeps its data at
 * sourcePath, the replicas hold theirs at targetPath. p2s reads sourcePath and writes targetPath, so
 * s2p must do the exact opposite. Getting this backwards would read a path that does not exist on the
 * secondary and write the wrong one on the primary — invisible whenever the two paths happen to match
 * (they do on the dev set), and silently wrong the moment they differ.
 */
export function pathOf(set: SetShape, role: Role): string {
  const source = set.sourcePath || '/var/www';
  if (role === 'primary') return source;
  return set.targetPath || source;
}

/** Which node is serving right now. This — not "primary" — is the node that must never be overwritten. */
export function activeRole(state: string): Role {
  if (state === 'failed-over') return 'secondary';
  if (state === 'tertiary-active') return 'tertiary';
  return 'primary';
}

export function hostOf(set: SetShape, role: Role): string {
  return (role === 'primary' ? set.primaryHost : role === 'secondary' ? set.secondaryHost : set.tertiaryHost) || '';
}

export const activeHost = (set: SetShape): string => hostOf(set, activeRole(set.state));

const ENDPOINTS: Record<Dir, { src: Role; tgt: Role }> = {
  p2s: { src: 'primary', tgt: 'secondary' },
  p2t: { src: 'primary', tgt: 'tertiary' },
  s2t: { src: 'secondary', tgt: 'tertiary' },
  s2p: { src: 'secondary', tgt: 'primary' }, // the direction that did not exist
};

export const isDir = (d: unknown): d is Dir => typeof d === 'string' && d in ENDPOINTS;

/**
 * The single place hosts are resolved. Throws on an unknown direction rather than falling back to
 * primary -> secondary, which is the specific failure the old ternary made possible.
 */
export function resolveEndpoints(
  set: SetShape,
  direction: Dir,
): { srcRole: Role; tgtRole: Role; srcHost: string; tgtHost: string; srcPath: string; tgtPath: string } {
  const e = ENDPOINTS[direction];
  if (!e) throw new Error(`Unknown replication direction "${direction}".`);
  return {
    srcRole: e.src, tgtRole: e.tgt,
    srcHost: hostOf(set, e.src), tgtHost: hostOf(set, e.tgt),
    srcPath: pathOf(set, e.src), tgtPath: pathOf(set, e.tgt),
  };
}

export interface Guard {
  ok: boolean;
  reason?: string;
}

/**
 * Refuse any copy whose TARGET is the node currently serving traffic.
 *
 * Stated this way on purpose. A check like "block Sync now while failed-over" would fix the one case we
 * caught and leave the next one open; this refuses the whole class, in one place, for every caller —
 * scheduler, operator button, and fail-back reconciliation alike. The engines run `rsync -az --delete`,
 * so writing to the active node does not merely add stale files, it removes the live ones.
 */
export function guardDirection(set: SetShape, direction: Dir): Guard {
  if (!isDir(direction)) return { ok: false, reason: `Unknown replication direction "${direction}".` };
  if (!isCopyEngine(set.dataType)) return { ok: true }; // DRBD: no one-way copy, nothing to guard
  const { srcRole, tgtRole, srcHost, tgtHost } = resolveEndpoints(set, direction);
  if (!srcHost || !tgtHost) return { ok: false, reason: 'Source and/or target host is not set on this replication set.' };
  if (srcHost === tgtHost) return { ok: false, reason: 'Source and target resolve to the same host.' };

  const live = activeRole(set.state);
  if (tgtRole === live) {
    return {
      ok: false,
      reason:
        `Refusing to replicate ${srcRole} -> ${tgtRole}: ${tgtRole} (${tgtHost}) is the node currently serving ` +
        `(set state "${set.state}"). This copy uses rsync --delete, so it would overwrite live data with ` +
        `${srcRole}'s older copy and delete anything written since the failover. ` +
        (live === 'secondary'
          ? 'Fail back to primary first — that reconciles the secondary\'s changes back — or run direction "s2p" to push them to the primary now.'
          : 'Promote the intended source to active first.'),
    };
  }
  if (srcRole !== live) {
    // Copying from a node that is not live is not destructive, but it is almost never what was meant.
    return {
      ok: false,
      reason:
        `Refusing to replicate ${srcRole} -> ${tgtRole}: ${srcRole} is not the node currently serving ` +
        `(${live} is, per state "${set.state}"), so this would propagate a stale copy.`,
    };
  }
  return { ok: true };
}

/** The direction that carries the live node's data back toward the original primary. */
export function reconcileDirection(set: SetShape): Dir | null {
  if (!isCopyEngine(set.dataType)) return null; // DRBD reconciles itself
  if (set.state === 'failed-over') return 's2p';
  return null;
}

/**
 * Does promoting back to `to` need a reconciliation sync first?
 *
 * Only when returning to primary from a failed-over copy-engine set: that is exactly the case where the
 * secondary has been taking writes that nothing has carried back. Every other promotion either has no
 * accumulated divergence or (DRBD) has already replicated it.
 */
export function needsReconcile(set: SetShape, to: Role): boolean {
  return to === 'primary' && set.state === 'failed-over' && isCopyEngine(set.dataType);
}

/** Direction the scheduler should run for a set, or null when it must stay out of the way. */
export function scheduledDirection(set: SetShape): Dir | null {
  if (!isCopyEngine(set.dataType)) return null;
  if (set.state === 'primary-active') return 'p2s';
  // Failed over: the secondary is live. Carrying its writes back is correct, but it overwrites the
  // primary, and promote(mode='simulated') also parks a set in 'failed-over' during a DRILL — where the
  // primary may still be live and serving. So it is opt-in per set rather than silently automatic.
  if (set.state === 'failed-over') return set.reverseReplication ? 's2p' : null;
  return null; // tertiary-active: no automatic copy defined
}
