import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { pInt, sysParams } from '../../system-params';
import {
  buildIntervals,
  businessHoursUptime,
  dailyRollup,
  dayStartMs,
  daySegments,
  hourlyRollup,
  outages,
  summarize,
  type Transition,
} from './uptime';

/**
 * Device uptime & SLA.
 *
 * Three kinds of thing count as a "device" here, because all three are things an operator is asked to
 * account for and none of them is covered by the others:
 *   · agent   — a VM or physical host with the guest agent installed (up = it is still heartbeating);
 *   · monitor — an IP/host/network device being probed (up = its last probe answered);
 *   · resource— a cloud VM known only through the provider API (up = the provider says it is running).
 *
 * The collector's only job is to notice CHANGES and write one row when one happens. Everything the
 * reports show — hours up per day, when it was off, availability, SLA attainment, remaining error
 * budget — is derived from those rows by the pure code in uptime.ts.
 *
 * Restarts are handled honestly rather than optimistically. On boot the collector re-reads the last
 * known state per device but does NOT assume the device kept that state while MCMF was down; a gap
 * shows up as unobserved time, is excluded from the availability denominator, and is reported as
 * reduced coverage. An SLA number that quietly counts an outage we were not around to see is worse
 * than no number at all.
 */
@Injectable()
export class UptimeService implements OnModuleInit {
  private readonly log = new Logger('Uptime');
  /** Last state we WROTE per device, so a steady device costs one comparison and no writes. */
  private lastState = new Map<string, boolean>();
  private booted = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // First pass shortly after boot (agents need a moment to check in), then on the configured cadence.
    setTimeout(() => void this.collect().catch((e) => this.log.warn(`first collect: ${String((e as Error)?.message ?? e)}`)), 45_000);
    void this.loop();
    // Materialise the day records shortly after boot, then every 15 minutes. Today's row is rewritten
    // as the day goes on; a finished day is recomputed once more the next time round and then settles.
    setTimeout(() => void this.rollupDays(35).catch((e) => this.log.warn(`first rollup: ${String((e as Error)?.message ?? e)}`)), 90_000);
    setInterval(() => void this.rollupDays(2).catch((e) => this.log.warn(`rollup: ${String((e as Error)?.message ?? e)}`)), 900_000);
  }

  /** Self-rescheduling so the interval can be changed in Settings without a restart. */
  private async loop() {
    const sec = await this.intervalSec();
    setTimeout(() => {
      void this.collect()
        .catch((e) => this.log.warn(`collect: ${String((e as Error)?.message ?? e)}`))
        .finally(() => void this.loop());
    }, Math.max(30, sec) * 1000);
  }

  private async intervalSec(): Promise<number> {
    return pInt(await sysParams(this.prisma), 'uptimeCollectSec', 'UPTIME_COLLECT_SEC', 60);
  }

  /** How long an agent may go quiet before we call it down. Generous: a missed beat is not an outage. */
  private async staleSec(): Promise<number> {
    return pInt(await sysParams(this.prisma), 'uptimeAgentStaleSec', 'UPTIME_AGENT_STALE_SEC', 300);
  }

  private async slaTarget(): Promise<number> {
    const p = await sysParams(this.prisma);
    // Stored as tenths so it survives the integer-only system-parameter helper: 999 = 99.9%.
    return pInt(p, 'uptimeSlaTargetTenths', 'UPTIME_SLA_TARGET_TENTHS', 995) / 10;
  }

  /** Minutes east of UTC for day boundaries in reports. Defaults to IST, where this platform runs. */
  private async tzOffsetMin(): Promise<number> {
    return pInt(await sysParams(this.prisma), 'uptimeTzOffsetMin', 'UPTIME_TZ_OFFSET_MIN', 330);
  }

  // ── collection ────────────────────────────────────────────────────────────

  /** Everything we track, with its CURRENT up/down verdict. */
  private async currentDevices(): Promise<{ key: string; type: string; name: string; group: string; up: boolean; detail: string }[]> {
    const staleMs = (await this.staleSec()) * 1000;
    const now = Date.now();
    const out: { key: string; type: string; name: string; group: string; up: boolean; detail: string }[] = [];

    const agents = await this.prisma.agent.findMany({ where: { active: true } }).catch(() => [] as any[]);
    for (const a of agents) {
      const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
      const up = seen > 0 && now - seen < staleMs;
      const mins = seen ? Math.round((now - seen) / 60_000) : null;
      out.push({
        key: `agent:${a.id}`,
        type: 'agent',
        name: a.displayName || a.hostname || a.name || a.id,
        group: String(a.os || 'unknown'),
        up,
        detail: up ? 'agent heartbeat current' : mins === null ? 'agent has never checked in' : `no agent heartbeat for ${mins}m`,
      });
    }

    const monitors = await this.prisma.monitor.findMany({ where: { enabled: true } }).catch(() => [] as any[]);
    for (const m of monitors) {
      // 'unknown' means it has not been probed yet — not a device that is down.
      if (m.status !== 'up' && m.status !== 'down') continue;
      out.push({
        key: `monitor:${m.id}`,
        type: 'monitor',
        name: m.name || m.target,
        group: m.group || 'default',
        up: m.status === 'up',
        detail: m.status === 'up' ? `${m.type} check answered from ${m.lastAddress || m.target}` : `${m.type} check to ${m.target} failed`,
      });
    }

    const resources = await this.prisma.resource
      .findMany({ where: { type: 'compute' }, select: { id: true, name: true, provider: true, status: true } })
      .catch(() => [] as any[]);
    for (const r of resources) {
      if (!r.status) continue;
      out.push({
        key: `resource:${r.id}`,
        type: 'resource',
        name: r.name,
        group: String(r.provider),
        up: r.status === 'running',
        detail: `provider reports ${r.status}`,
      });
    }
    return out;
  }

  /** Load the newest state per device once, so a restart does not re-write every device as "changed". */
  private async primeState() {
    const rows = await this.prisma.deviceUptimeEvent.findMany({ orderBy: { at: 'desc' }, take: 5000, select: { deviceKey: true, up: true } });
    for (const r of rows) if (!this.lastState.has(r.deviceKey)) this.lastState.set(r.deviceKey, r.up);
    this.booted = true;
  }

  /** One pass: write a row only where the verdict actually changed. */
  async collect(): Promise<{ devices: number; transitions: number }> {
    if (!this.booted) await this.primeState();
    const devices = await this.currentDevices();
    let transitions = 0;
    for (const d of devices) {
      const before = this.lastState.get(d.key);
      if (before === d.up) continue;
      await this.prisma.deviceUptimeEvent
        .create({ data: { deviceKey: d.key, deviceType: d.type, deviceName: d.name, deviceGroup: d.group, up: d.up, detail: d.detail } })
        .catch(() => undefined);
      this.lastState.set(d.key, d.up);
      transitions += 1;
      if (before !== undefined) this.log.log(`${d.name} is ${d.up ? 'UP' : 'DOWN'} — ${d.detail}`);
    }
    return { devices: devices.length, transitions };
  }

  // ── daily record ──────────────────────────────────────────────────────────

  /**
   * Materialise the last `daysBack` days into DeviceUptimeDay, one row per device per day.
   *
   * Recomputed from transitions every time rather than accumulated, so the row can never drift from
   * the events that produced it — an accumulator that misses one restart is wrong forever, and nobody
   * would notice until an SLA report was already in someone's hands.
   */
  async rollupDays(daysBack = 2): Promise<{ devices: number; rows: number }> {
    const tz = await this.tzOffsetMin();
    const now = new Date();
    const to = new Date(dayStartMs(now.getTime(), tz) + 86_400_000); // through the end of today
    const from = new Date(dayStartMs(now.getTime(), tz) - (Math.max(1, daysBack) - 1) * 86_400_000);
    const devices = await this.currentDevices();
    // Devices that have gone away still have history worth keeping, so roll up anything with events
    // in the window too, not just what is currently being watched.
    const seen = new Map(devices.map((d) => [d.key, d]));
    const historic = await this.prisma.deviceUptimeEvent.findMany({
      where: { at: { gte: from } },
      select: { deviceKey: true, deviceType: true, deviceName: true, deviceGroup: true },
      distinct: ['deviceKey'],
    });
    for (const h of historic) {
      if (!seen.has(h.deviceKey)) {
        seen.set(h.deviceKey, { key: h.deviceKey, type: h.deviceType, name: h.deviceName, group: h.deviceGroup, up: false, detail: 'no longer monitored' });
      }
    }

    const keys = [...seen.keys()];
    if (!keys.length) return { devices: 0, rows: 0 };
    const byKey = await this.transitionsFor(keys, from);
    let rows = 0;
    for (const key of keys) {
      const d = seen.get(key)!;
      const days = dailyRollup(buildIntervals(byKey.get(key) ?? [], from, to), from, to, tz);
      for (const day of days) {
        // A day with nothing observed at all is not worth a row — it would say only "we were not
        // watching", which the absence of a row already says.
        if (day.upSec + day.downSec === 0) continue;
        await this.prisma.deviceUptimeDay
          .upsert({
            where: { deviceKey_date: { deviceKey: key, date: day.date } },
            create: {
              deviceKey: key, date: day.date, deviceType: d.type, deviceName: d.name, deviceGroup: d.group,
              upSec: day.upSec, downSec: day.downSec, unknownSec: day.unknownSec, upHours: day.upHours,
              availabilityPct: day.availabilityPct, outages: day.outages as any,
            },
            update: {
              deviceName: d.name, deviceGroup: d.group,
              upSec: day.upSec, downSec: day.downSec, unknownSec: day.unknownSec, upHours: day.upHours,
              availabilityPct: day.availabilityPct, outages: day.outages as any, computedAt: new Date(),
            },
          })
          .catch(() => undefined);
        rows += 1;
      }
    }
    this.log.log(`daily uptime record updated: ${rows} day-row(s) across ${keys.length} device(s)`);
    return { devices: keys.length, rows };
  }

  /**
   * The 30-day bar chart: one entry per day with the hours it was on.
   *
   * Served from the stored day records, with today computed live — today's row is only as fresh as the
   * last 15-minute rollup, and a chart that is a quarter of an hour behind on the current day looks
   * broken to the person watching a host they just rebooted.
   */
  async deviceDays(key: string, days = 30) {
    const tz = await this.tzOffsetMin();
    const n = Math.min(Math.max(Math.floor(Number(days) || 30), 1), 365);
    const todayStart = dayStartMs(Date.now(), tz);
    const from = new Date(todayStart - (n - 1) * 86_400_000);
    const to = new Date(todayStart + 86_400_000);

    const stored = await this.prisma.deviceUptimeDay.findMany({
      where: { deviceKey: key, date: { gte: this.dateKey(from, tz) } },
      orderBy: { date: 'asc' },
    });
    const live = dailyRollup(buildIntervals((await this.transitionsFor([key], from)).get(key) ?? [], from, to), from, to, tz);
    const liveToday = live[live.length - 1];
    const byDate = new Map(stored.map((r) => [r.date, {
      date: r.date, upSec: r.upSec, downSec: r.downSec, unknownSec: r.unknownSec,
      upHours: r.upHours, availabilityPct: r.availabilityPct, outages: (r.outages as any) ?? [],
    }]));
    if (liveToday) byDate.set(liveToday.date, liveToday as any);

    // Every day in the window appears, so a gap in the chart reads as "not watched" instead of the bars
    // silently shifting along.
    type DayBar = { date: string; upSec: number; downSec: number; unknownSec: number; upHours: number; availabilityPct: number | null; outages: unknown[] };
    const out: DayBar[] = [];
    for (let i = 0; i < n; i++) {
      const date = this.dateKey(new Date(todayStart - (n - 1 - i) * 86_400_000), tz);
      out.push(byDate.get(date) ?? { date, upSec: 0, downSec: 0, unknownSec: 86_400, upHours: 0, availabilityPct: null, outages: [] });
    }
    return { key, tzOffsetMin: tz, days: out };
  }

  /** One day, hour by hour — the 24-bar chart plus the continuous strip beneath it. */
  async deviceDay(key: string, date?: string) {
    const tz = await this.tzOffsetMin();
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? ''))
      // Parse the requested date AS a local day: 'YYYY-MM-DD' read as UTC would land on the previous
      // day for anyone east of Greenwich, which is where this platform runs.
      ? new Date(Date.parse(`${date}T00:00:00Z`) - tz * 60_000)
      : new Date();
    const start = new Date(dayStartMs(anchor.getTime(), tz));
    const end = new Date(start.getTime() + 86_400_000);
    const trans = (await this.transitionsFor([key], start)).get(key) ?? [];
    const iv = buildIntervals(trans, start, end);
    const day = dailyRollup(iv, start, end, tz)[0] ?? null;
    const current = (await this.currentDevices()).find((d) => d.key === key);
    return {
      key,
      name: current?.name ?? key,
      date: this.dateKey(start, tz),
      tzOffsetMin: tz,
      from: start.toISOString(),
      to: end.toISOString(),
      upSec: day?.upSec ?? 0,
      downSec: day?.downSec ?? 0,
      unknownSec: day?.unknownSec ?? 86_400,
      upHours: day?.upHours ?? 0,
      availabilityPct: day?.availabilityPct ?? null,
      hours: hourlyRollup(iv, start, tz),
      segments: daySegments(iv, start, tz),
      outages: day?.outages ?? [],
    };
  }

  private dateKey(d: Date, tz: number): string {
    return new Date(d.getTime() + tz * 60_000).toISOString().slice(0, 10);
  }

  // ── reporting ─────────────────────────────────────────────────────────────

  private window(days?: number): { from: Date; to: Date } {
    const d = Math.min(Math.max(Math.floor(Number(days) || 30), 1), 365);
    const to = new Date();
    return { from: new Date(to.getTime() - d * 86_400_000), to };
  }

  private async transitionsFor(keys: string[], from: Date): Promise<Map<string, Transition[]>> {
    // The transition that PRECEDES the window establishes the state it opens in, so it is fetched too.
    const rows = await this.prisma.deviceUptimeEvent.findMany({
      where: { deviceKey: { in: keys } },
      orderBy: { at: 'asc' },
      select: { deviceKey: true, up: true, at: true },
    });
    const byKey = new Map<string, Transition[]>();
    for (const r of rows) {
      const list = byKey.get(r.deviceKey) ?? [];
      // Collapse everything before the window into a single "state on entry" marker.
      if (r.at < from && list.length && list[list.length - 1].at < from) list.pop();
      list.push({ at: r.at, up: r.up });
      byKey.set(r.deviceKey, list);
    }
    return byKey;
  }

  /** Fleet list: one row per device with its availability, downtime and SLA verdict for the window. */
  async devices(q: { days?: number; type?: string; sla?: number }) {
    const { from, to } = this.window(q.days);
    const sla = Number.isFinite(Number(q.sla)) && Number(q.sla) > 0 ? Number(q.sla) : await this.slaTarget();
    const current = await this.currentDevices();
    const wanted = q.type && ['agent', 'monitor', 'resource'].includes(q.type) ? current.filter((d) => d.type === q.type) : current;
    const byKey = await this.transitionsFor(wanted.map((d) => d.key), from);
    const tz = await this.tzOffsetMin();

    const rows = wanted.map((d) => {
      const iv = buildIntervals(byKey.get(d.key) ?? [], from, to);
      const s = summarize(iv, from, to, sla);
      const biz = businessHoursUptime(iv, { startHour: 9, endHour: 18, tzOffsetMin: tz });
      const days = dailyRollup(iv, from, to, tz);
      const observedDays = days.filter((x) => x.upSec + x.downSec > 0);
      return {
        key: d.key,
        type: d.type,
        name: d.name,
        group: d.group,
        up: d.up,
        detail: d.detail,
        ...s,
        // "how many hours is it up on an average day" — the device-productivity question.
        avgUpHoursPerDay: observedDays.length
          ? Math.round((observedDays.reduce((a, x) => a + x.upSec, 0) / observedDays.length / 3600) * 100) / 100
          : null,
        businessHoursAvailabilityPct: biz.availabilityPct,
      };
    });
    // Worst first: an SLA list exists to show what is failing, not to be read alphabetically.
    rows.sort((a, b) => (a.availabilityPct ?? 101) - (b.availabilityPct ?? 101));
    return { from: from.toISOString(), to: to.toISOString(), slaTargetPct: sla, devices: rows };
  }

  /** Drill-down for one device: per-day hours up, and exactly when it was off. */
  async device(key: string, q: { days?: number; sla?: number }) {
    const { from, to } = this.window(q.days);
    const sla = Number.isFinite(Number(q.sla)) && Number(q.sla) > 0 ? Number(q.sla) : await this.slaTarget();
    const tz = await this.tzOffsetMin();
    const current = (await this.currentDevices()).find((d) => d.key === key);
    const byKey = await this.transitionsFor([key], from);
    const trans = byKey.get(key) ?? [];
    if (!current && !trans.length) throw new NotFoundException('no uptime history for this device');

    const iv = buildIntervals(trans, from, to);
    const s = summarize(iv, from, to, sla);
    const days = dailyRollup(iv, from, to, tz);
    return {
      key,
      name: current?.name ?? key,
      type: current?.type ?? key.split(':')[0],
      group: current?.group ?? '',
      up: current?.up ?? null,
      detail: current?.detail ?? 'device is no longer being monitored',
      from: from.toISOString(),
      to: to.toISOString(),
      tzOffsetMin: tz,
      summary: s,
      days,
      outages: outages(iv, to),
      businessHours: businessHoursUptime(iv, { startHour: 9, endHour: 18, tzOffsetMin: tz }),
    };
  }

  /** Fleet SLA rollup for the widget: how many devices are meeting the promise, and who is worst. */
  async summary(q: { days?: number; sla?: number }) {
    const r = await this.devices(q);
    // "Rated" means we observed enough of the window to judge, NOT merely that a number could be
    // computed. Averaging in a device we watched for a minute drags the fleet figure to nonsense.
    const rated = r.devices.filter((d) => d.rated);
    const met = rated.filter((d) => d.slaMet === true).length;
    const avg = rated.length ? rated.reduce((a, d) => a + (d.availabilityPct ?? 0), 0) / rated.length : null;
    return {
      from: r.from,
      to: r.to,
      slaTargetPct: r.slaTargetPct,
      devices: r.devices.length,
      // Devices with no observed time are counted separately rather than folded into "failing": we
      // cannot judge an SLA we did not observe.
      rated: rated.length,
      unrated: r.devices.length - rated.length,
      meetingSla: met,
      breachingSla: rated.length - met,
      avgAvailabilityPct: avg === null ? null : Math.round(avg * 100) / 100,
      currentlyDown: r.devices.filter((d) => !d.up).length,
      totalDowntimeSec: r.devices.reduce((a, d) => a + d.totalDowntimeSec, 0),
      // Worst-first among devices we can actually judge; unrated ones are not "the worst", they are
      // simply not yet known.
      worst: [...r.devices].sort((a, b) => Number(b.rated) - Number(a.rated)).slice(0, 5).map((d) => ({
        key: d.key, name: d.name, type: d.type, group: d.group, up: d.up,
        availabilityPct: d.availabilityPct, totalDowntimeSec: d.totalDowntimeSec,
        outages: d.outages, slaMet: d.slaMet, rated: d.rated, avgUpHoursPerDay: d.avgUpHoursPerDay,
      })),
    };
  }
}
