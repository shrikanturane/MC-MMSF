/**
 * Device uptime & SLA — pure arithmetic over state transitions. No I/O, no clock of its own.
 *
 * Uptime is stored as TRANSITIONS ("this host went down at 03:12, came back at 03:41"), never as
 * samples. A 60-second sampler across a few hundred devices writes half a million rows a month and
 * still cannot say when a device actually went down — only which minute we noticed. Transitions are
 * two rows per outage, and every number below is derived from them: daily hours up, when it was off,
 * availability, SLA attainment and remaining error budget.
 *
 * The distinction that matters for an SLA report is UNKNOWN versus DOWN. Before a device is first seen,
 * and across any gap where MCMF itself was not running, we do not know what the device was doing.
 * Counting that as uptime flatters the number; counting it as downtime invents outages that never
 * happened. It is carried separately and excluded from the availability denominator, and the report
 * says how much of the window it covers so nobody reads 100% off a window we mostly did not observe.
 */

export interface Transition {
  at: Date;
  up: boolean;
}

export interface Interval {
  from: Date;
  to: Date;
  /** null = not observed (before first sighting, or while the collector was down). */
  up: boolean | null;
}

export interface Outage {
  from: string;
  /** null = still down at the end of the window. */
  to: string | null;
  seconds: number;
  ongoing: boolean;
}

export interface DayRollup {
  /** YYYY-MM-DD in the report's timezone. */
  date: string;
  upSec: number;
  downSec: number;
  unknownSec: number;
  /** Up as a share of OBSERVED time. Null when nothing was observed that day. */
  availabilityPct: number | null;
  upHours: number;
  outages: Outage[];
}

export interface UptimeSummary {
  upSec: number;
  downSec: number;
  unknownSec: number;
  observedSec: number;
  windowSec: number;
  /** Share of the window we actually observed — the honesty check on availabilityPct. */
  coveragePct: number;
  availabilityPct: number | null;
  outages: number;
  longestOutageSec: number;
  totalDowntimeSec: number;
  slaTargetPct: number;
  /** Was enough of the window observed to judge an SLA at all? */
  rated: boolean;
  slaMet: boolean | null;
  /** Downtime the SLA still allows over this window. Negative once it has been overspent. */
  errorBudgetSec: number;
  errorBudgetUsedPct: number | null;
}

const SEC = 1000;

/**
 * Turn transitions into a contiguous timeline over [from, to). Transitions outside the window still
 * matter: the last one BEFORE it establishes the state the window opens in.
 */
export function buildIntervals(transitions: Transition[], from: Date, to: Date): Interval[] {
  const sorted = [...transitions].sort((a, b) => a.at.getTime() - b.at.getTime());
  const f = from.getTime();
  const t = to.getTime();
  if (t <= f) return [];

  const before = sorted.filter((x) => x.at.getTime() <= f);
  const inside = sorted.filter((x) => x.at.getTime() > f && x.at.getTime() < t);

  const out: Interval[] = [];
  // Nothing recorded before the window opens means the device was not being watched yet.
  let state: boolean | null = before.length ? before[before.length - 1].up : null;
  let cursor = f;
  for (const tr of inside) {
    const at = tr.at.getTime();
    if (at > cursor) out.push({ from: new Date(cursor), to: new Date(at), up: state });
    state = tr.up;
    cursor = at;
  }
  if (cursor < t) out.push({ from: new Date(cursor), to: new Date(t), up: state });
  return out.filter((i) => i.to.getTime() > i.from.getTime());
}

/** Local YYYY-MM-DD for a timestamp, at a fixed offset (minutes east of UTC). */
function dayKey(ms: number, tzOffsetMin: number): string {
  return new Date(ms + tzOffsetMin * 60_000).toISOString().slice(0, 10);
}

/** Midnight (as UTC ms) of the local day that contains `ms`. Exported: the day/hour views need it. */
export function dayStartMs(ms: number, tzOffsetMin: number): number {
  const shifted = ms + tzOffsetMin * 60_000;
  const floored = Math.floor(shifted / 86_400_000) * 86_400_000;
  return floored - tzOffsetMin * 60_000;
}

/**
 * Split the timeline into local days. Intervals are CUT at midnight rather than attributed to the day
 * they started in: an outage from 23:40 to 00:20 is twenty minutes of each day, and a report that put
 * all forty on the first one would misstate both.
 */
export function dailyRollup(intervals: Interval[], from: Date, to: Date, tzOffsetMin = 0): DayRollup[] {
  const days = new Map<string, DayRollup>();
  const touch = (key: string): DayRollup => {
    let d = days.get(key);
    if (!d) {
      d = { date: key, upSec: 0, downSec: 0, unknownSec: 0, availabilityPct: null, upHours: 0, outages: [] };
      days.set(key, d);
    }
    return d;
  };
  // Seed every day in the window, so a day with no data appears as unobserved rather than vanishing.
  for (let ms = dayStartMs(from.getTime(), tzOffsetMin); ms < to.getTime(); ms += 86_400_000) {
    if (ms + 86_400_000 > from.getTime()) touch(dayKey(Math.max(ms, from.getTime()), tzOffsetMin));
  }

  for (const iv of intervals) {
    let cur = iv.from.getTime();
    const end = iv.to.getTime();
    while (cur < end) {
      const midnight = dayStartMs(cur, tzOffsetMin) + 86_400_000;
      const chunkEnd = Math.min(end, midnight);
      const d = touch(dayKey(cur, tzOffsetMin));
      const sec = Math.round((chunkEnd - cur) / SEC);
      if (iv.up === true) d.upSec += sec;
      else if (iv.up === false) {
        d.downSec += sec;
        d.outages.push({
          from: new Date(cur).toISOString(),
          to: new Date(chunkEnd).toISOString(),
          seconds: sec,
          ongoing: chunkEnd === to.getTime(),
        });
      } else d.unknownSec += sec;
      cur = chunkEnd;
    }
  }

  const list = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const d of list) {
    const observed = d.upSec + d.downSec;
    d.availabilityPct = observed > 0 ? Math.round((d.upSec / observed) * 10_000) / 100 : null;
    d.upHours = Math.round((d.upSec / 3600) * 100) / 100;
  }
  return list;
}

export interface HourBucket {
  /** 0-23, local to the report timezone. */
  hour: number;
  upSec: number;
  downSec: number;
  unknownSec: number;
}

/**
 * One day split into its 24 hours. This is what the day chart draws: an hour is rarely all-up or
 * all-down, so each bucket carries seconds rather than a state — a host that died at 14:20 shows two
 * thirds of a green bar at 14:00, which is the truth, instead of a whole one or none.
 */
export function hourlyRollup(intervals: Interval[], dayStart: Date, tzOffsetMin = 0): HourBucket[] {
  const start = dayStartMs(dayStart.getTime(), tzOffsetMin);
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, upSec: 0, downSec: 0, unknownSec: 0 }));
  for (const iv of intervals) {
    const from = iv.from.getTime();
    const to = iv.to.getTime();
    for (let h = 0; h < 24; h++) {
      const hs = start + h * 3_600_000;
      const he = hs + 3_600_000;
      const overlap = Math.min(to, he) - Math.max(from, hs);
      if (overlap <= 0) continue;
      const sec = Math.round(overlap / SEC);
      if (iv.up === true) buckets[h].upSec += sec;
      else if (iv.up === false) buckets[h].downSec += sec;
      else buckets[h].unknownSec += sec;
    }
  }
  return buckets;
}

export interface DaySegment {
  /** Position within the day, 0..1 — so the strip can be drawn without knowing any dates. */
  start: number;
  end: number;
  up: boolean | null;
  fromIso: string;
  toIso: string;
}

/** The same day as a continuous strip, for the timeline under the hour bars. */
export function daySegments(intervals: Interval[], dayStart: Date, tzOffsetMin = 0): DaySegment[] {
  const start = dayStartMs(dayStart.getTime(), tzOffsetMin);
  const end = start + 86_400_000;
  const out: DaySegment[] = [];
  for (const iv of intervals) {
    const from = Math.max(iv.from.getTime(), start);
    const to = Math.min(iv.to.getTime(), end);
    if (to <= from) continue;
    out.push({
      start: (from - start) / 86_400_000,
      end: (to - start) / 86_400_000,
      up: iv.up,
      fromIso: new Date(from).toISOString(),
      toIso: new Date(to).toISOString(),
    });
  }
  return out;
}

/** Contiguous outages across the whole window (not split by day) — the "what time was it off" answer. */
export function outages(intervals: Interval[], windowEnd: Date): Outage[] {
  const out: Outage[] = [];
  for (const iv of intervals) {
    if (iv.up !== false) continue;
    const ongoing = iv.to.getTime() >= windowEnd.getTime();
    const last = out[out.length - 1];
    // Merge intervals that touch: the timeline is already contiguous, so adjacent down blocks are one
    // outage that happened to be split by a bookkeeping boundary.
    if (last && !last.ongoing && last.to && new Date(last.to).getTime() === iv.from.getTime()) {
      last.to = ongoing ? null : iv.to.toISOString();
      last.seconds += Math.round((iv.to.getTime() - iv.from.getTime()) / SEC);
      last.ongoing = ongoing;
      continue;
    }
    out.push({
      from: iv.from.toISOString(),
      to: ongoing ? null : iv.to.toISOString(),
      seconds: Math.round((iv.to.getTime() - iv.from.getTime()) / SEC),
      ongoing,
    });
  }
  return out;
}

/**
 * Roll a timeline up into the SLA answer. `slaTargetPct` is the promise (99.9 and so on); the error
 * budget is what that promise still permits over this window, and goes negative once it is overspent —
 * which is exactly the number an operator needs, so it is not clamped at zero.
 */
export const MIN_COVERAGE_PCT = 5;

export function summarize(
  intervals: Interval[],
  from: Date,
  to: Date,
  slaTargetPct = 99.5,
  minCoveragePct = MIN_COVERAGE_PCT,
): UptimeSummary {
  let upSec = 0;
  let downSec = 0;
  let unknownSec = 0;
  for (const iv of intervals) {
    const sec = Math.round((iv.to.getTime() - iv.from.getTime()) / SEC);
    if (iv.up === true) upSec += sec;
    else if (iv.up === false) downSec += sec;
    else unknownSec += sec;
  }
  const observedSec = upSec + downSec;
  const windowSec = Math.max(0, Math.round((to.getTime() - from.getTime()) / SEC));
  const os = outages(intervals, to);
  const availabilityPct = observedSec > 0 ? Math.round((upSec / observedSec) * 10_000) / 100 : null;
  const budgetSec = Math.round((windowSec * (100 - slaTargetPct)) / 100);
  const coveragePct = windowSec > 0 ? Math.round((observedSec / windowSec) * 1000) / 10 : 0;
  // A percentage computed from a sliver of the window is arithmetic, not evidence. A device first seen
  // a minute ago is at "0% availability over 7 days" only in the sense that we watched it for a minute
  // and it happened to be down — calling that an SLA breach would be a lie told with a true number.
  const rated = observedSec > 0 && coveragePct >= minCoveragePct;
  return {
    upSec,
    downSec,
    unknownSec,
    observedSec,
    windowSec,
    coveragePct,
    availabilityPct,
    outages: os.length,
    longestOutageSec: os.reduce((m, o) => Math.max(m, o.seconds), 0),
    totalDowntimeSec: downSec,
    slaTargetPct,
    rated,
    slaMet: rated ? (availabilityPct as number) >= slaTargetPct : null,
    errorBudgetSec: budgetSec - downSec,
    errorBudgetUsedPct: budgetSec > 0 ? Math.round((downSec / budgetSec) * 1000) / 10 : null,
  };
}

/**
 * "Device productivity": the share of the working day a device was actually available, which is the
 * question behind "how many hours is this machine up each day". Weekends and out-of-hours time are
 * excluded rather than counted as downtime — a desktop that is off overnight is not an incident.
 */
export function businessHoursUptime(
  intervals: Interval[],
  opts: { startHour: number; endHour: number; tzOffsetMin: number; days?: number[] },
): { upSec: number; downSec: number; unknownSec: number; availabilityPct: number | null } {
  const workDays = opts.days ?? [1, 2, 3, 4, 5]; // Mon-Fri
  let upSec = 0;
  let downSec = 0;
  let unknownSec = 0;
  for (const iv of intervals) {
    // Walk in minutes: an interval can span days, and a whole-interval test would either include or
    // exclude the entire thing on the strength of when it happened to start.
    let cur = iv.from.getTime();
    const end = iv.to.getTime();
    while (cur < end) {
      const step = Math.min(60_000, end - cur);
      const local = new Date(cur + opts.tzOffsetMin * 60_000);
      const h = local.getUTCHours();
      if (workDays.includes(local.getUTCDay()) && h >= opts.startHour && h < opts.endHour) {
        const sec = Math.round(step / SEC);
        if (iv.up === true) upSec += sec;
        else if (iv.up === false) downSec += sec;
        else unknownSec += sec;
      }
      cur += step;
    }
  }
  const observed = upSec + downSec;
  return { upSec, downSec, unknownSec, availabilityPct: observed > 0 ? Math.round((upSec / observed) * 10_000) / 100 : null };
}
