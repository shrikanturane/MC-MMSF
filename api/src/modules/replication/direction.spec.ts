import {
  activeHost,
  activeRole,
  guardDirection,
  isDir,
  needsReconcile,
  reconcileDirection,
  resolveEndpoints,
  scheduledDirection,
  type Dir,
  type SetShape,
} from './direction';

const set = (over: Partial<SetShape> = {}): SetShape => ({
  state: 'primary-active',
  dataType: 'files',
  primaryHost: '98.89.5.236', // mcmf-repl-aws
  secondaryHost: '20.115.6.242', // mcmf-repl-azure
  tertiaryHost: '10.0.0.9',
  reverseReplication: false,
  ...over,
});

describe('replication direction — endpoint resolution', () => {
  test('every direction resolves to the hosts its name says', () => {
    const s = set();
    expect(resolveEndpoints(s, 'p2s')).toMatchObject({ srcHost: s.primaryHost, tgtHost: s.secondaryHost });
    expect(resolveEndpoints(s, 'p2t')).toMatchObject({ srcHost: s.primaryHost, tgtHost: s.tertiaryHost });
    expect(resolveEndpoints(s, 's2t')).toMatchObject({ srcHost: s.secondaryHost, tgtHost: s.tertiaryHost });
    expect(resolveEndpoints(s, 's2p')).toMatchObject({ srcHost: s.secondaryHost, tgtHost: s.primaryHost });
  });

  test('s2p is the exact reverse of p2s', () => {
    const s = set();
    const f = resolveEndpoints(s, 'p2s');
    const b = resolveEndpoints(s, 's2p');
    expect(b.srcHost).toBe(f.tgtHost);
    expect(b.tgtHost).toBe(f.srcHost);
  });

  test('an unknown direction THROWS instead of falling back to primary -> secondary', () => {
    // This is the whole point of the module. The old engines used
    //   direction === 'p2t' ? ... : direction === 's2t' ? ... : [primary, secondary]
    // so any unrecognised direction silently ran p2s. With rsync --delete behind it, a typo'd or
    // half-added direction would have wiped the secondary instead of replicating from it.
    expect(() => resolveEndpoints(set(), 'nonsense' as Dir)).toThrow(/Unknown replication direction/);
  });

  test('isDir accepts only the four real directions', () => {
    expect(['p2s', 'p2t', 's2t', 's2p'].every(isDir)).toBe(true);
    expect(isDir('s2p ')).toBe(false);
    expect(isDir('S2P')).toBe(false);
    expect(isDir(undefined)).toBe(false);
  });
});

describe('active node', () => {
  test('the live node follows state, not the label "primary"', () => {
    expect(activeRole('primary-active')).toBe('primary');
    expect(activeRole('failed-over')).toBe('secondary');
    expect(activeRole('tertiary-active')).toBe('tertiary');
    expect(activeHost(set({ state: 'failed-over' }))).toBe('20.115.6.242');
  });
});

describe('guard — never overwrite the node that is serving', () => {
  test('THE BUG: "Sync now" mid-outage is refused', () => {
    // Reproduces trial 12 exactly. Set is failed over, secondary is live and taking writes; the operator
    // presses the only button available. Previously this ran p2s from the stale primary and rsync
    // --delete removed the operator's work ("Number of deleted files: 1"). It must now be refused.
    const g = guardDirection(set({ state: 'failed-over' }), 'p2s');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/currently serving/);
    expect(g.reason).toMatch(/--delete/);
  });

  test('the refusal tells the operator what to do instead', () => {
    const g = guardDirection(set({ state: 'failed-over' }), 'p2s');
    expect(g.reason).toMatch(/Fail back to primary first|s2p/);
  });

  test('s2p is ALLOWED while failed over — that is the whole point', () => {
    expect(guardDirection(set({ state: 'failed-over' }), 's2p').ok).toBe(true);
  });

  test('s2p is REFUSED while primary-active — it would overwrite the live primary', () => {
    const g = guardDirection(set({ state: 'primary-active' }), 's2p');
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/currently serving/);
  });

  test('REGRESSION: normal p2s while primary-active is unaffected', () => {
    expect(guardDirection(set(), 'p2s').ok).toBe(true);
  });

  test('REGRESSION: p2t while primary-active is unaffected', () => {
    expect(guardDirection(set(), 'p2t').ok).toBe(true);
  });

  test('REGRESSION: s2t is refused while primary-active (source is not live), allowed while failed over', () => {
    // s2t copies FROM the secondary. While primary-active the secondary is a replica, so shipping it to
    // tertiary propagates a stale copy; while failed-over the secondary is live and it is correct.
    expect(guardDirection(set(), 's2t').ok).toBe(false);
    expect(guardDirection(set({ state: 'failed-over' }), 's2t').ok).toBe(true);
  });

  test('DRBD (block) sets are not guarded — they have no one-way copy to misdirect', () => {
    expect(guardDirection(set({ dataType: 'block', state: 'failed-over' }), 'p2s').ok).toBe(true);
  });

  test('blank or identical hosts are refused before any ssh happens', () => {
    expect(guardDirection(set({ secondaryHost: '' }), 'p2s').ok).toBe(false);
    expect(guardDirection(set({ secondaryHost: '98.89.5.236' }), 'p2s').ok).toBe(false);
  });

  test('an unknown direction is refused, not guessed', () => {
    expect(guardDirection(set(), 'oops' as Dir).ok).toBe(false);
  });
});

describe('fail-back reconciliation', () => {
  test('THE BUG: returning to primary from failed-over needs reconciliation', () => {
    // All 7 measured fail-back trials lost the secondary's writes because nothing carried them back.
    expect(needsReconcile(set({ state: 'failed-over' }), 'primary')).toBe(true);
    expect(reconcileDirection(set({ state: 'failed-over' }))).toBe('s2p');
  });

  test('a normal failover needs no reconciliation', () => {
    expect(needsReconcile(set({ state: 'primary-active' }), 'secondary')).toBe(false);
  });

  test('DRBD fail-back needs no reconciliation — the kernel already did it', () => {
    expect(needsReconcile(set({ state: 'failed-over', dataType: 'block' }), 'primary')).toBe(false);
    expect(reconcileDirection(set({ state: 'failed-over', dataType: 'block' }))).toBeNull();
  });

  test('every copy engine is covered, not just files', () => {
    for (const dataType of ['files', 'database', 'docker']) {
      expect(needsReconcile(set({ state: 'failed-over', dataType }), 'primary')).toBe(true);
    }
  });

  test('re-promoting to primary when already primary-active is a no-op', () => {
    expect(needsReconcile(set({ state: 'primary-active' }), 'primary')).toBe(false);
  });
});

describe('scheduler direction', () => {
  test('primary-active schedules p2s, exactly as before', () => {
    expect(scheduledDirection(set())).toBe('p2s');
  });

  test('THE BUG: failed-over scheduled NOTHING — no replication ran in either direction', () => {
    // Measured: two trials waited a full 17 minutes (longer than the 15-minute interval) and observed
    // "NONE within 17m". With reverse replication off, that stays true — but now it is a choice.
    expect(scheduledDirection(set({ state: 'failed-over' }))).toBeNull();
  });

  test('opting in schedules s2p while failed over', () => {
    expect(scheduledDirection(set({ state: 'failed-over', reverseReplication: true }))).toBe('s2p');
  });

  test('reverse replication defaults OFF, because a DRILL also parks a set in failed-over', () => {
    // promote(mode='simulated') writes state='failed-over' while the primary may still be live and
    // serving. Automatic s2p would then overwrite it — trading one data-loss bug for another.
    expect(set().reverseReplication).toBe(false);
    expect(scheduledDirection(set({ state: 'failed-over' }))).toBeNull();
  });

  test('DRBD is never scheduled for a copy', () => {
    expect(scheduledDirection(set({ dataType: 'block' }))).toBeNull();
    expect(scheduledDirection(set({ dataType: 'block', state: 'failed-over', reverseReplication: true }))).toBeNull();
  });

  test('tertiary-active schedules nothing automatically', () => {
    expect(scheduledDirection(set({ state: 'tertiary-active' }))).toBeNull();
  });

  test('whatever the scheduler picks always passes the guard', () => {
    // The scheduler must never propose a copy the guard would refuse — that would be a permanent
    // error loop rather than replication.
    for (const state of ['primary-active', 'failed-over', 'tertiary-active']) {
      for (const reverseReplication of [true, false]) {
        const s = set({ state, reverseReplication });
        const d = scheduledDirection(s);
        if (d) expect(guardDirection(s, d)).toMatchObject({ ok: true });
      }
    }
  });
});
