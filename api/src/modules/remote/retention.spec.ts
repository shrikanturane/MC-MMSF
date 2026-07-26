import { DEFAULT_RETENTION, describePlan, fileOverAge, planRetention, sessionOverCap, type RecordingFile } from './retention';

const NOW = new Date('2026-08-01T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
const MB = 1024 * 1024;
const f = (path: string, mb: number, days: number): RecordingFile => ({ path, bytes: mb * MB, endedAt: daysAgo(days) });

describe('recording retention (pure) — the disk guard', () => {
  test('nothing to do when everything is fresh and small', () => {
    const plan = planRetention([f('a.mp4', 10, 1), f('b.mp4', 10, 2)], NOW);
    expect(plan.delete).toEqual([]);
    expect(plan.freedBytes).toBe(0);
    expect(describePlan(plan)).toMatch(/nothing to delete/);
  });

  test('deletes recordings past the age window', () => {
    const plan = planRetention([f('old.mp4', 10, 31), f('new.mp4', 10, 1)], NOW);
    expect(plan.delete.map((x) => x.path)).toEqual(['old.mp4']);
    expect(plan.reasons['old.mp4']).toBe('expired');
  });

  test('a recording exactly at the boundary is kept (only strictly older expires)', () => {
    const plan = planRetention([f('edge.mp4', 10, DEFAULT_RETENTION.maxAgeDays)], NOW);
    // endedAt == cutoff -> kept; being off-by-one here silently deletes a day of evidence
    expect(plan.delete).toEqual([]);
  });

  test('enforces the total cap even when everything is INSIDE the age window', () => {
    // 6 x 1GB, all recent: age alone would keep them all and fill a 5GB budget.
    const files = [1, 2, 3, 4, 5, 6].map((i) => f(`r${i}.mp4`, 1024, i));
    const plan = planRetention(files, NOW);
    expect(plan.delete.length).toBeGreaterThan(0);
    expect(plan.keptBytes).toBeLessThanOrEqual(DEFAULT_RETENTION.maxTotalMb * MB);
    for (const d of plan.delete) expect(plan.reasons[d.path]).toBe('over-quota');
  });

  test('over-quota deletes the OLDEST first — the newest recording is the one support needs', () => {
    const files = [1, 2, 3, 4, 5, 6].map((i) => f(`r${i}.mp4`, 1024, i));
    const plan = planRetention(files, NOW);
    // r6 is the oldest (6 days), r1 the newest (1 day)
    expect(plan.delete.map((x) => x.path)).toContain('r6.mp4');
    expect(plan.delete.map((x) => x.path)).not.toContain('r1.mp4');
  });

  test('age and quota combine: expired go first, then the oldest survivors if still over', () => {
    const files = [f('ancient.mp4', 2048, 40), ...[1, 2, 3, 4, 5].map((i) => f(`r${i}.mp4`, 1024, i))];
    const plan = planRetention(files, NOW);
    expect(plan.reasons['ancient.mp4']).toBe('expired');
    expect(plan.keptBytes).toBeLessThanOrEqual(DEFAULT_RETENTION.maxTotalMb * MB);
  });

  test('a single runaway session is caught while recording, not after', () => {
    expect(sessionOverCap(DEFAULT_RETENTION.maxSessionMb * MB + 1)).toBe(true);
    expect(sessionOverCap(10 * MB)).toBe(false);
  });

  test('empty input is safe', () => {
    expect(planRetention([], NOW).delete).toEqual([]);
  });

  test('is deterministic — same files, same plan', () => {
    const files = [1, 2, 3, 4, 5, 6].map((i) => f(`r${i}.mp4`, 1024, i));
    expect(planRetention(files, NOW)).toEqual(planRetention(files, NOW));
  });

  test('the log explains WHY things were deleted', () => {
    const files = [f('ancient.mp4', 2048, 40), ...[1, 2, 3, 4, 5].map((i) => f(`r${i}.mp4`, 1024, i))];
    const s = describePlan(planRetention(files, NOW));
    expect(s).toMatch(/expired/);
    expect(s).toMatch(/freeing .* MB/);
  });

  test('defaults are the documented ones', () => {
    expect(DEFAULT_RETENTION).toMatchObject({ maxAgeDays: 15, maxTotalMb: 5120, maxSessionMb: 100 });
  });
});

describe('per-FILE cap drives segmentation (not truncation)', () => {
  test('the cap is 100 MB and applies to one file, not one session', () => {
    // A session longer than the cap rolls into <id>-p2.mp4, -p3.mp4 … rather than stopping. Before
    // this, a session hit 512MB and silently stopped recording while still running for days.
    expect(DEFAULT_RETENTION.maxSessionMb).toBe(100);
    expect(sessionOverCap(100 * MB + 1)).toBe(true);
    expect(sessionOverCap(99 * MB)).toBe(false);
  });

  test('recordings are kept for 15 days', () => {
    expect(DEFAULT_RETENTION.maxAgeDays).toBe(15);
    const plan = planRetention([f('old.mp4', 10, 16), f('new.mp4', 10, 14)], NOW);
    expect(plan.delete.map((x) => x.path)).toEqual(['old.mp4']);
  });

  test('every part of one session is retained/expired on its own merits', () => {
    // Parts are independent files, so a long session's early parts can expire before its later ones.
    const parts = [f('s1-p1.mp4', 100, 16), f('s1-p2.mp4', 100, 16), f('s1-p3.mp4', 100, 2)];
    const plan = planRetention(parts, NOW);
    expect(plan.delete.map((x) => x.path).sort()).toEqual(['s1-p1.mp4', 's1-p2.mp4']);
  });
});

describe('fileOverAge', () => {
  const cfg = { ...DEFAULT_RETENTION };

  it('rolls to a new file once the current one has been open for the cap', () => {
    const opened = 1_000_000;
    expect(fileOverAge(opened, opened + 4 * 3_600_000, cfg)).toBe(true);
    expect(fileOverAge(opened, opened + 4 * 3_600_000 - 1, cfg)).toBe(false);
  });

  // Size alone would let a still screen record all day into one file nobody wants to scrub through.
  it('is independent of size — a tiny long file still rolls', () => {
    expect(sessionOverCap(1024, cfg)).toBe(false);
    expect(fileOverAge(0, 5 * 3_600_000, cfg)).toBe(true);
  });

  it('can be switched off with 0 hours', () => {
    expect(fileOverAge(0, 99 * 3_600_000, { ...cfg, maxFileHours: 0 })).toBe(false);
  });
});
