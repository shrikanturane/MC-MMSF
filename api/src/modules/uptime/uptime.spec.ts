import { buildIntervals, businessHoursUptime, dailyRollup, daySegments, hourlyRollup, outages, summarize, type Transition } from './uptime';

const D = (s: string) => new Date(s);

describe('buildIntervals', () => {
  it('carries the state the window opened in from the last transition BEFORE it', () => {
    const tr: Transition[] = [{ at: D('2026-07-01T00:00:00Z'), up: true }];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    expect(iv).toHaveLength(1);
    expect(iv[0].up).toBe(true);
  });

  // The distinction the whole report rests on: not-yet-observed is neither up nor down.
  it('marks time before the first sighting as unknown, not as uptime', () => {
    const tr: Transition[] = [{ at: D('2026-07-10T12:00:00Z'), up: true }];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    expect(iv[0].up).toBeNull();
    expect(iv[1].up).toBe(true);
  });

  it('splits the window at each transition', () => {
    const tr: Transition[] = [
      { at: D('2026-07-10T00:00:00Z'), up: true },
      { at: D('2026-07-10T03:00:00Z'), up: false },
      { at: D('2026-07-10T04:00:00Z'), up: true },
    ];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    expect(iv.map((x) => x.up)).toEqual([true, false, true]);
  });

  it('returns nothing for an inverted or empty window', () => {
    expect(buildIntervals([], D('2026-07-11T00:00:00Z'), D('2026-07-10T00:00:00Z'))).toEqual([]);
  });
});

describe('dailyRollup', () => {
  it('reports hours up per day', () => {
    const tr: Transition[] = [{ at: D('2026-07-09T00:00:00Z'), up: true }];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-12T00:00:00Z'));
    const days = dailyRollup(iv, D('2026-07-10T00:00:00Z'), D('2026-07-12T00:00:00Z'));
    expect(days).toHaveLength(2);
    expect(days[0].upHours).toBe(24);
    expect(days[0].availabilityPct).toBe(100);
  });

  // An outage spanning midnight belongs to both days, in the proportion it actually occupied each.
  it('cuts an outage at midnight instead of billing it all to one day', () => {
    const tr: Transition[] = [
      { at: D('2026-07-09T00:00:00Z'), up: true },
      { at: D('2026-07-10T23:40:00Z'), up: false },
      { at: D('2026-07-11T00:20:00Z'), up: true },
    ];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-12T00:00:00Z'));
    const days = dailyRollup(iv, D('2026-07-10T00:00:00Z'), D('2026-07-12T00:00:00Z'));
    expect(days[0].downSec).toBe(20 * 60);
    expect(days[1].downSec).toBe(20 * 60);
  });

  it('honours a timezone offset when deciding which day a moment belongs to', () => {
    const tr: Transition[] = [{ at: D('2026-07-09T00:00:00Z'), up: true }];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-10T12:00:00Z'));
    // IST is UTC+5:30, so 00:00Z is still 05:30 on the 10th locally.
    const days = dailyRollup(iv, D('2026-07-10T00:00:00Z'), D('2026-07-10T12:00:00Z'), 330);
    expect(days[0].date).toBe('2026-07-10');
  });

  it('leaves availability null for a day nothing was observed', () => {
    const days = dailyRollup([], D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    expect(days[0].availabilityPct).toBeNull();
  });
});

describe('outages', () => {
  it('reports when a device was off, and for how long', () => {
    const tr: Transition[] = [
      { at: D('2026-07-10T00:00:00Z'), up: true },
      { at: D('2026-07-10T03:12:00Z'), up: false },
      { at: D('2026-07-10T03:41:00Z'), up: true },
    ];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    const os = outages(iv, D('2026-07-11T00:00:00Z'));
    expect(os).toHaveLength(1);
    expect(os[0].from).toBe('2026-07-10T03:12:00.000Z');
    expect(os[0].seconds).toBe(29 * 60);
    expect(os[0].ongoing).toBe(false);
  });

  it('marks an outage that has not ended as ongoing with no end time', () => {
    const tr: Transition[] = [
      { at: D('2026-07-10T00:00:00Z'), up: true },
      { at: D('2026-07-10T22:00:00Z'), up: false },
    ];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    const os = outages(iv, D('2026-07-11T00:00:00Z'));
    expect(os[0].ongoing).toBe(true);
    expect(os[0].to).toBeNull();
  });
});

describe('summarize', () => {
  const window = { from: D('2026-07-01T00:00:00Z'), to: D('2026-07-31T00:00:00Z') };

  it('computes availability over OBSERVED time and reports coverage separately', () => {
    const tr: Transition[] = [
      { at: D('2026-07-01T00:00:00Z'), up: true },
      { at: D('2026-07-15T00:00:00Z'), up: false },
      { at: D('2026-07-15T12:00:00Z'), up: true },
    ];
    const s = summarize(buildIntervals(tr, window.from, window.to), window.from, window.to, 99.5);
    expect(s.coveragePct).toBe(100);
    expect(s.totalDowntimeSec).toBe(12 * 3600);
    expect(s.availabilityPct).toBeCloseTo(98.33, 1);
    expect(s.slaMet).toBe(false);
  });

  // Overspend must be visible as a negative number; clamping it at zero hides how far past the line it is.
  it('lets the error budget go negative once it has been overspent', () => {
    const tr: Transition[] = [
      { at: D('2026-07-01T00:00:00Z'), up: true },
      { at: D('2026-07-15T00:00:00Z'), up: false },
      { at: D('2026-07-15T12:00:00Z'), up: true },
    ];
    const s = summarize(buildIntervals(tr, window.from, window.to), window.from, window.to, 99.5);
    // 30 days at 99.5% allows ~3.6h; 12h of downtime is well past it.
    expect(s.errorBudgetSec).toBeLessThan(0);
    expect(s.errorBudgetUsedPct).toBeGreaterThan(100);
  });

  it('reports a met SLA when downtime stays inside the budget', () => {
    const tr: Transition[] = [
      { at: D('2026-07-01T00:00:00Z'), up: true },
      { at: D('2026-07-15T00:00:00Z'), up: false },
      { at: D('2026-07-15T00:10:00Z'), up: true },
    ];
    const s = summarize(buildIntervals(tr, window.from, window.to), window.from, window.to, 99.5);
    expect(s.slaMet).toBe(true);
    expect(s.errorBudgetSec).toBeGreaterThan(0);
  });

  // The defect this caught in real data: a device first seen 60 seconds ago showed "0% availability
  // over 7 days, SLA breached". True arithmetic, false claim.
  it('does not rate a device we have barely observed', () => {
    const tr: Transition[] = [{ at: D('2026-07-30T23:59:00Z'), up: false }]; // one minute of a month
    const s = summarize(buildIntervals(tr, window.from, window.to), window.from, window.to, 99.5);
    expect(s.availabilityPct).toBe(0); // the number is still reported...
    expect(s.rated).toBe(false); // ...but it is explicitly not a verdict
    expect(s.slaMet).toBeNull();
  });

  it('rates a device once enough of the window has been observed', () => {
    const tr: Transition[] = [{ at: D('2026-07-05T00:00:00Z'), up: true }]; // ~87% coverage
    const s = summarize(buildIntervals(tr, window.from, window.to), window.from, window.to, 99.5);
    expect(s.rated).toBe(true);
    expect(s.slaMet).toBe(true);
  });

  it('takes the coverage floor as a parameter', () => {
    const tr: Transition[] = [{ at: D('2026-07-29T00:00:00Z'), up: true }]; // ~7% coverage
    const iv = buildIntervals(tr, window.from, window.to);
    expect(summarize(iv, window.from, window.to, 99.5, 5).rated).toBe(true);
    expect(summarize(iv, window.from, window.to, 99.5, 50).rated).toBe(false);
  });

  it('refuses to claim 100% for a window it never observed', () => {
    const s = summarize([], window.from, window.to, 99.9);
    expect(s.availabilityPct).toBeNull();
    expect(s.slaMet).toBeNull();
    expect(s.rated).toBe(false);
    expect(s.coveragePct).toBe(0);
  });

  it('excludes unobserved time from the availability denominator but still reports it', () => {
    const tr: Transition[] = [{ at: D('2026-07-16T00:00:00Z'), up: true }]; // first seen halfway through
    const s = summarize(buildIntervals(tr, window.from, window.to), window.from, window.to);
    expect(s.availabilityPct).toBe(100);
    expect(s.coveragePct).toBeLessThan(60); // and the caller can see that 100% covers only half the month
    expect(s.unknownSec).toBeGreaterThan(0);
    expect(s.rated).toBe(true); // half a month IS enough to judge
  });
});

describe('businessHoursUptime', () => {
  it('ignores nights and weekends rather than counting them as downtime', () => {
    // Down all of Saturday; a desktop being off at the weekend is not an SLA breach.
    const tr: Transition[] = [
      { at: D('2026-07-10T00:00:00Z'), up: true }, // Friday
      { at: D('2026-07-11T00:00:00Z'), up: false }, // Saturday
      { at: D('2026-07-13T00:00:00Z'), up: true }, // Monday
    ];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-14T00:00:00Z'));
    const b = businessHoursUptime(iv, { startHour: 9, endHour: 18, tzOffsetMin: 0 });
    expect(b.downSec).toBe(0);
    expect(b.availabilityPct).toBe(100);
  });

  it('counts a working-hours outage', () => {
    const tr: Transition[] = [
      { at: D('2026-07-10T00:00:00Z'), up: true }, // Friday
      { at: D('2026-07-10T10:00:00Z'), up: false },
      { at: D('2026-07-10T11:00:00Z'), up: true },
    ];
    const iv = buildIntervals(tr, D('2026-07-10T00:00:00Z'), D('2026-07-11T00:00:00Z'));
    const b = businessHoursUptime(iv, { startHour: 9, endHour: 18, tzOffsetMin: 0 });
    expect(b.downSec).toBe(3600);
    expect(b.upSec).toBe(8 * 3600);
  });
});

describe('hourlyRollup', () => {
  const day = D('2026-07-10T00:00:00Z');

  it('gives a full up hour 3600 seconds', () => {
    const tr: Transition[] = [{ at: D('2026-07-09T00:00:00Z'), up: true }];
    const iv = buildIntervals(tr, day, D('2026-07-11T00:00:00Z'));
    const h = hourlyRollup(iv, day);
    expect(h).toHaveLength(24);
    expect(h[0].upSec).toBe(3600);
    expect(h[23].upSec).toBe(3600);
  });

  // The point of bucketing in seconds rather than states: an hour is rarely all one thing.
  it('splits an hour where the device died mid-hour', () => {
    const tr: Transition[] = [
      { at: D('2026-07-09T00:00:00Z'), up: true },
      { at: D('2026-07-10T14:20:00Z'), up: false },
    ];
    const iv = buildIntervals(tr, day, D('2026-07-11T00:00:00Z'));
    const h = hourlyRollup(iv, day);
    expect(h[14].upSec).toBe(20 * 60);
    expect(h[14].downSec).toBe(40 * 60);
    expect(h[15].upSec).toBe(0);
    expect(h[15].downSec).toBe(3600);
  });

  it('places hours against the report timezone, not UTC', () => {
    // Up from 18:30Z = 00:00 IST, so in IST this is hour 0 of the next local day.
    const tr: Transition[] = [{ at: D('2026-07-09T18:30:00Z'), up: true }];
    const localDayStart = D('2026-07-09T18:30:00Z');
    const iv = buildIntervals(tr, localDayStart, D('2026-07-10T18:30:00Z'));
    const h = hourlyRollup(iv, localDayStart, 330);
    expect(h[0].upSec).toBe(3600);
  });

  it('reports an unwatched day as unknown, not as downtime', () => {
    const h = hourlyRollup(buildIntervals([], day, D('2026-07-11T00:00:00Z')), day);
    expect(h[8].downSec).toBe(0);
    expect(h[8].unknownSec).toBe(3600);
  });
});

describe('daySegments', () => {
  const day = D('2026-07-10T00:00:00Z');

  it('positions each stretch as a fraction of the day', () => {
    const tr: Transition[] = [
      { at: D('2026-07-09T00:00:00Z'), up: true },
      { at: D('2026-07-10T12:00:00Z'), up: false },
    ];
    const seg = daySegments(buildIntervals(tr, day, D('2026-07-11T00:00:00Z')), day);
    expect(seg).toHaveLength(2);
    expect(seg[0]).toMatchObject({ start: 0, end: 0.5, up: true });
    expect(seg[1]).toMatchObject({ start: 0.5, end: 1, up: false });
  });

  it('clips a stretch that runs past midnight to the day being drawn', () => {
    const tr: Transition[] = [{ at: D('2026-07-08T00:00:00Z'), up: true }];
    const seg = daySegments(buildIntervals(tr, D('2026-07-09T00:00:00Z'), D('2026-07-12T00:00:00Z')), day);
    expect(seg[0].start).toBe(0);
    expect(seg[0].end).toBe(1);
  });
});
