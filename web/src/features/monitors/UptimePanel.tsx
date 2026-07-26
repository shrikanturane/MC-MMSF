'use client';

import { useState } from 'react';
import { Badge, Modal, ProgressBar } from '@/components/ui';
import { useUptimeDevice, useUptimeDeviceDay, useUptimeDeviceDays, useUptimeDevices, useUptimeSummary, type UptimeDevice, type UptimeOutage } from '@/lib/hooks';

const WINDOWS = [7, 30, 90] as const;

/** Durations here are read by people writing incident reports, so they read as hours and minutes. */
function dur(sec: number): string {
  if (sec <= 0) return '0m';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Availability is coloured against the SLA, not against 100%: 99.4% is a failure on a 99.5% promise and
 * ought to look like one, while 97% on a 95% promise is fine.
 */
function availColor(pct: number | null, target: number): string {
  if (pct === null) return '#64748b';
  if (pct >= target) return '#22c55e';
  return pct >= target - 1 ? '#f59e0b' : '#ef4444';
}

function Avail({ pct, target, rated = true }: { pct: number | null; target: number; rated?: boolean }) {
  if (pct === null) return <span className="text-2xs text-muted" title="Nothing observed in this window">—</span>;
  // An unrated figure is shown, but greyed and parenthesised: it is arithmetic over a sliver of the
  // window, not a judgement, and it must not read like one.
  if (!rated) return <span className="text-muted" title="Too little of this window has been observed to judge">({pct.toFixed(2)}%)</span>;
  return <span style={{ color: availColor(pct, target) }}>{pct.toFixed(2)}%</span>;
}

/** When was it off, and for how long. The list an operator is actually asked for after an incident. */
function OutageList({ outages }: { outages: UptimeOutage[] }) {
  if (!outages.length) return <div className="text-2xs text-muted">No downtime recorded in this window.</div>;
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
      <table className="w-full text-2xs">
        <thead className="sticky top-0 bg-card text-muted">
          <tr>
            <th className="px-2 py-1 text-left font-medium">Went down</th>
            <th className="px-2 py-1 text-left font-medium">Came back</th>
            <th className="px-2 py-1 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {outages.map((o) => (
            <tr key={o.from} className="border-t border-border/60">
              <td className="px-2 py-1 text-white">{when(o.from)}</td>
              <td className="px-2 py-1 text-muted-light">{o.to ? when(o.to) : <span className="text-danger">still down</span>}</td>
              <td className="px-2 py-1 text-right text-muted-light">{dur(o.seconds)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const UP = '#22c55e';
const DOWN = '#ef4444';
const UNKNOWN = '#334155';

const hm = (sec: number) => `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;

/**
 * One day, hour by hour. 24 bars, green for the part of each hour the device was on.
 *
 * Each bar is a full hour tall and filled proportionally rather than being coloured by a single state:
 * a host that died at 14:20 gives a third-full bar at 14:00, which is what actually happened. Rounding
 * that to "up" or "down" would quietly move the outage by up to an hour.
 */
function DayChart({ deviceKey, date, onPickDate }: { deviceKey: string; date?: string; onPickDate: (d: string) => void }) {
  const { data, isLoading } = useUptimeDeviceDay(deviceKey, date);
  if (isLoading || !data) return <div className="p-4 text-2xs text-muted">Loading…</div>;
  const H = 3600;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-2xs">
        <label className="flex items-center gap-1.5 text-muted">
          Day
          <input
            type="date"
            value={data.date}
            onChange={(e) => e.target.value && onPickDate(e.target.value)}
            className="rounded-md border border-border bg-bg px-2 py-1 text-2xs text-white"
          />
        </label>
        <span className="text-muted">
          On for <b className="text-success">{data.upHours}h</b>
          {data.downSec > 0 ? <> · off {hm(data.downSec)}</> : null}
          {data.unknownSec > 0 ? <> · {hm(data.unknownSec)} not monitored</> : null}
        </span>
        <span className="ml-auto flex items-center gap-3 text-muted">
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: UP }} /> on</span>
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: DOWN }} /> off</span>
          <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm" style={{ background: UNKNOWN }} /> not monitored</span>
        </span>
      </div>

      {/* 24 hour bars. Each stacks up/down/unknown so the column always totals a full hour. */}
      <div className="flex h-32 items-end gap-[3px]">
        {data.hours.map((h) => (
          <div
            key={h.hour}
            className="flex h-full flex-1 flex-col justify-end overflow-hidden rounded-sm bg-bg"
            title={`${String(h.hour).padStart(2, '0')}:00 — on ${Math.round(h.upSec / 60)}m, off ${Math.round(h.downSec / 60)}m${h.unknownSec ? `, not monitored ${Math.round(h.unknownSec / 60)}m` : ''}`}
          >
            <div style={{ height: `${(h.unknownSec / H) * 100}%`, background: UNKNOWN }} />
            <div style={{ height: `${(h.downSec / H) * 100}%`, background: DOWN }} />
            <div style={{ height: `${(h.upSec / H) * 100}%`, background: UP }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[3px] text-[9px] text-muted">
        {data.hours.map((h) => (
          <div key={h.hour} className="flex-1 text-center">{h.hour % 3 === 0 ? String(h.hour).padStart(2, '0') : ''}</div>
        ))}
      </div>

      {/* The same day as one continuous strip — easier to read "it was off between these two times". */}
      <div className="relative mt-3 h-3 overflow-hidden rounded" style={{ background: UNKNOWN }}>
        {data.segments.map((s) => (
          <div
            key={s.fromIso}
            className="absolute top-0 h-full"
            style={{
              left: `${s.start * 100}%`,
              width: `${Math.max(0.15, (s.end - s.start) * 100)}%`,
              background: s.up === true ? UP : s.up === false ? DOWN : UNKNOWN,
            }}
            title={`${s.up === true ? 'On' : s.up === false ? 'Off' : 'Not monitored'} ${new Date(s.fromIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – ${new Date(s.toIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[9px] text-muted"><span>00:00</span><span>12:00</span><span>24:00</span></div>

      {data.outages.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 whitespace-nowrap text-2xs font-medium text-muted-light">Off during this day</div>
          <OutageList outages={data.outages} />
        </div>
      )}
    </div>
  );
}

/**
 * 30 days, one bar per day, length proportional to the hours the device was on, with the figure at the
 * end of each bar. Clicking a bar opens that day's 24-hour chart — which is the whole point: the month
 * view says which day looks wrong and the day view says what happened on it.
 */
function DaysChart({ deviceKey, days, selected, onSelect }: { deviceKey: string; days: number; selected?: string; onSelect: (d: string) => void }) {
  const { data, isLoading } = useUptimeDeviceDays(deviceKey, days);
  if (isLoading || !data) return <div className="p-4 text-2xs text-muted">Loading…</div>;
  return (
    <div className="max-h-72 space-y-[3px] overflow-y-auto pr-1">
      {data.days.map((d) => {
        const observed = d.upSec + d.downSec > 0;
        return (
          <button
            key={d.date}
            onClick={() => onSelect(d.date)}
            title={observed
              ? `${d.date}: on ${hm(d.upSec)}, off ${hm(d.downSec)}${d.unknownSec ? `, ${hm(d.unknownSec)} not monitored` : ''}`
              : `${d.date}: not monitored`}
            className={`flex w-full items-center gap-2 rounded px-1 py-[1px] text-left text-2xs hover:bg-bg/60 ${selected === d.date ? 'bg-bg' : ''}`}
          >
            <span className="w-16 shrink-0 text-muted">{d.date.slice(5)}</span>
            <span className="relative h-3 flex-1 overflow-hidden rounded-sm bg-bg">
              {/* Scale is a fixed 24h, never the max of the window: bars must be comparable between
                  days, and a day that was off for 20 hours must LOOK short. */}
              <span className="absolute left-0 top-0 h-full" style={{ width: `${(d.upSec / 86400) * 100}%`, background: UP }} />
              <span className="absolute top-0 h-full" style={{ left: `${(d.upSec / 86400) * 100}%`, width: `${(d.downSec / 86400) * 100}%`, background: DOWN }} />
            </span>
            <span className={`w-12 shrink-0 text-right ${observed ? 'text-white' : 'text-muted'}`}>
              {observed ? `${d.upHours}h` : '—'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Per-device drill-down: hours up each day, plus the exact outage times behind those numbers. */
function DeviceDetail({ deviceKey, days, onClose }: { deviceKey: string; days: number; onClose: () => void }) {
  const { data, isLoading } = useUptimeDevice(deviceKey, days);
  // Undefined means "today" — the day view resolves it server-side in the report timezone rather than
  // from the browser's clock, so a late-evening operator sees the same day the report does.
  const [day, setDay] = useState<string | undefined>(undefined);
  return (
    <Modal onClose={onClose} title={data ? `Uptime — ${data.name}` : 'Uptime'} wide>
      {isLoading || !data ? (
        <div className="p-6 text-2xs text-muted">Loading…</div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
            <Badge color={data.up ? '#22c55e' : '#ef4444'} tone="dot">{data.up ? 'up' : 'down'}</Badge>
            <span>{data.detail}</span>
            <span className="ml-auto">
              {new Date(data.from).toLocaleDateString()} – {new Date(data.to).toLocaleDateString()}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { l: 'Availability', v: data.summary.availabilityPct === null ? '—' : `${data.summary.availabilityPct.toFixed(2)}%` },
              { l: 'Total downtime', v: dur(data.summary.totalDowntimeSec) },
              { l: 'Outages', v: String(data.summary.outages) },
              { l: 'Working-hours uptime', v: data.businessHours.availabilityPct === null ? '—' : `${data.businessHours.availabilityPct.toFixed(2)}%` },
            ].map((k) => (
              <div key={k.l} className="rounded-lg border border-border bg-bg/50 p-2">
                <div className="text-2xs text-muted">{k.l}</div>
                <div className="text-sm text-white">{k.v}</div>
              </div>
            ))}
          </div>

          {/* Coverage is stated next to availability on purpose: a number derived from a window we
              barely observed must not be read as a clean bill of health. */}
          {data.summary.coveragePct < 99 && (
            <div className="rounded border border-warning/30 bg-warning/10 px-2 py-1 text-2xs text-warning">
              Only {data.summary.coveragePct}% of this window was observed ({dur(data.summary.unknownSec)} unmonitored — before this
              device was first seen, or while MCMF was not running). Availability is calculated over the observed time only.
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
            <div>
              <div className="mb-1 whitespace-nowrap text-2xs font-medium text-muted-light">Hours on per day ({days}d) — click a day</div>
              <DaysChart deviceKey={deviceKey} days={days} selected={day} onSelect={setDay} />
            </div>
            <div>
              <div className="mb-1 whitespace-nowrap text-2xs font-medium text-muted-light">Hour by hour</div>
              <DayChart deviceKey={deviceKey} date={day} onPickDate={setDay} />
            </div>
          </div>

          <div>
            <div className="mb-1 whitespace-nowrap text-2xs font-medium text-muted-light">Outages</div>
            <OutageList outages={data.outages} />
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Fleet uptime & SLA. Covers everything MCMF can see the state of — hosts with the guest agent, probed
 * IP/host monitors, and cloud VMs known only through the provider API — because an availability report
 * that silently omits a class of device is worse than none.
 */
export function UptimeSlaPanel({ bare = false }: { bare?: boolean }) {
  const [days, setDays] = useState<number>(30);
  const [type, setType] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading } = useUptimeDevices(days, type);
  const target = data?.slaTargetPct ?? 99.5;

  const rows: UptimeDevice[] = data?.devices ?? [];

  return (
    <div className={bare ? '' : 'rounded-xl border border-border bg-card p-4'}>
      <div className="mb-2 flex items-center gap-2">
        {!bare && <h3 className="shrink-0 whitespace-nowrap text-sm font-semibold text-white">Device uptime &amp; SLA</h3>}
        <div className="ml-auto flex items-center gap-1 overflow-x-auto whitespace-nowrap">
          {(['', 'agent', 'monitor', 'resource'] as const).map((t) => (
            <button
              key={t || 'all'}
              onClick={() => setType(t)}
              className={`shrink-0 rounded-md border px-2 py-0.5 text-2xs ${type === t ? 'border-brand bg-brand/15 text-white' : 'border-border bg-bg text-muted hover:text-white'}`}
            >
              {t === '' ? 'All' : t === 'agent' ? 'Agents' : t === 'monitor' ? 'Monitors' : 'Cloud VMs'}
            </button>
          ))}
          {WINDOWS.map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`shrink-0 rounded-md border px-2 py-0.5 text-2xs ${days === d ? 'border-brand bg-brand/15 text-white' : 'border-border bg-bg text-muted hover:text-white'}`}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-2xs text-muted">Loading…</div>
      ) : !rows.length ? (
        <div className="p-6 text-center text-2xs text-muted">
          Nothing is being tracked for uptime yet. Install a guest agent, add an IP/Host monitor, or connect a cloud account —
          the first state is recorded within a minute.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-2xs">
            <thead className="text-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Device</th>
                <th className="px-2 py-1 text-left font-medium">Now</th>
                <th className="px-2 py-1 text-left font-medium">Availability ({days}d)</th>
                <th className="px-2 py-1 text-right font-medium">Avg up/day</th>
                <th className="px-2 py-1 text-right font-medium">Downtime</th>
                <th className="px-2 py-1 text-right font-medium">Outages</th>
                <th className="px-2 py-1 text-right font-medium">Error budget</th>
                <th className="px-2 py-1 text-left font-medium">SLA {target}%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr
                  key={d.key}
                  onClick={() => setOpen(d.key)}
                  title="Click for the daily breakdown and exact outage times"
                  className="cursor-pointer border-t border-border/60 hover:bg-bg/60"
                >
                  <td className="px-2 py-1">
                    <span className="text-white">{d.name}</span>
                    <span className="ml-1 text-muted">· {d.group}</span>
                  </td>
                  <td className="px-2 py-1"><Badge color={d.up ? '#22c55e' : '#ef4444'} tone="dot">{d.up ? 'up' : 'down'}</Badge></td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-2">
                      <div className="w-20"><ProgressBar value={d.availabilityPct ?? 0} color={d.rated ? availColor(d.availabilityPct, target) : '#334155'} /></div>
                      <Avail pct={d.availabilityPct} target={target} rated={d.rated} />
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right text-muted-light">{d.avgUpHoursPerDay === null ? '—' : `${d.avgUpHoursPerDay}h`}</td>
                  <td className="px-2 py-1 text-right text-muted-light">{dur(d.totalDowntimeSec)}</td>
                  <td className="px-2 py-1 text-right text-muted-light">{d.outages}</td>
                  <td className="px-2 py-1 text-right" style={{ color: d.errorBudgetSec < 0 ? '#ef4444' : '#94a3b8' }}>
                    {d.errorBudgetSec < 0 ? `-${dur(-d.errorBudgetSec)}` : dur(d.errorBudgetSec)}
                  </td>
                  <td className="px-2 py-1">
                    {d.slaMet === null
                      ? <span className="text-muted" title={`Only ${d.coveragePct}% of this window has been observed — not enough to judge an SLA`}>not rated</span>
                      : <Badge color={d.slaMet ? '#22c55e' : '#ef4444'}>{d.slaMet ? 'met' : 'breached'}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && <DeviceDetail deviceKey={open} days={days} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Compact fleet SLA card — the tile version for a dashboard board. */
export function UptimeSummaryCard() {
  const { data } = useUptimeSummary(30);
  if (!data) return <div className="p-4 text-2xs text-muted">Loading…</div>;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {[
          { l: 'Avg availability (30d)', v: data.avgAvailabilityPct === null ? '—' : `${data.avgAvailabilityPct}%` },
          { l: `Meeting ${data.slaTargetPct}% SLA`, v: `${data.meetingSla}/${data.rated}` },
          { l: 'Currently down', v: String(data.currentlyDown) },
          { l: 'Fleet downtime (30d)', v: dur(data.totalDowntimeSec) },
        ].map((k) => (
          <div key={k.l} className="rounded-lg border border-border bg-bg/50 p-2">
            <div className="text-2xs text-muted">{k.l}</div>
            <div className="text-sm text-white">{k.v}</div>
          </div>
        ))}
      </div>
      {data.unrated > 0 && (
        <div className="text-2xs text-muted">
          {data.unrated} device{data.unrated === 1 ? '' : 's'} not rated — not yet observed long enough to judge against an SLA.
        </div>
      )}
      <div className="rounded-lg border border-border">
        <table className="w-full text-2xs">
          <thead className="text-muted">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Worst availability</th>
              <th className="px-2 py-1 text-right font-medium">30d</th>
              <th className="px-2 py-1 text-right font-medium">Downtime</th>
            </tr>
          </thead>
          <tbody>
            {data.worst.map((w) => (
              <tr key={w.key} className="border-t border-border/60">
                <td className="px-2 py-1 text-white">{w.name}</td>
                <td className="px-2 py-1 text-right"><Avail pct={w.availabilityPct} target={data.slaTargetPct} rated={w.rated} /></td>
                <td className="px-2 py-1 text-right text-muted-light">{dur(w.totalDowntimeSec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
