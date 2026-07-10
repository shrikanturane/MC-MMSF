'use client';

import { useState, type ReactNode } from 'react';
import { Card, Modal } from '@/components/ui';
import { useNetworkDevices, useSnmpPoll } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import type { NetworkDevice } from '@/lib/types';

const KIND_ICON: Record<string, string> = { firewall: '🛡', router: '🌐', switch: '🔀', server: '🖥', other: '📟', host: '🖥' };
const kindIcon = (k: string) => KIND_ICON[k] ?? '📟';
const metricColor = (v: number) => (v >= 90 ? '#ef4444' : v >= 70 ? '#f59e0b' : '#22c55e');

const SNMP_BADGE: Record<string, { label: string; color: string }> = {
  ok: { label: '● SNMP ok', color: '#22c55e' },
  stale: { label: '◐ SNMP stale', color: '#f59e0b' },
  'no-response': { label: '○ no SNMP reply', color: '#ef4444' },
  off: { label: '— SNMP off', color: '#64748b' },
};

function fmtUptime(sec: number | null): string {
  if (!sec || sec < 0) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtBps(bps: number): string {
  if (!bps || bps < 0) return '0';
  const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  let v = bps, i = 0;
  while (v >= 1000 && i < u.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

/** Network Devices widget — firewalls / routers / switches via SNMP. */
const DEV_CHARTS: [string, string][] = [
  ['table', 'Interfaces · Table'],
  ['bandwidth', 'Bandwidth · Bars'],
  ['utilization', 'Utilization · Gauges'],
];

export function NetworkDevicesPanel({ bare = false, scope: scopeProp, chartType, onConfig }: { bare?: boolean; scope?: string; chartType?: string; onConfig?: (patch: { group?: string; chart?: string }) => void }) {
  const { data, isLoading } = useNetworkDevices();
  const [openId, setOpenId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  // When rendered as a board widget, scope/chart are PERSISTED to the saved panel config (via onConfig)
  // so they survive a refresh; standalone, they fall back to local state.
  const [scopeInternal, setScopeInternal] = useState('all');
  const [chartInternal, setChartInternal] = useState('table');
  const scope = scopeProp ?? scopeInternal;
  const chart = chartType ?? chartInternal;
  const setScope = (v: string) => (onConfig ? onConfig({ group: v }) : setScopeInternal(v));
  const setChart = (v: string) => (onConfig ? onConfig({ chart: v }) : setChartInternal(v));
  const all = data ?? [];
  const scopes = [...new Set(all.map((d) => d.group))].sort();
  const devices = scope === 'all' ? all : all.filter((d) => d.group === scope);

  const totals = {
    n: devices.length,
    up: devices.filter((d) => d.status === 'up').length,
    snmpOk: devices.filter((d) => d.snmpStatus === 'ok').length,
    connected: devices.reduce((s, d) => s + d.connectedCount, 0),
    linkDown: devices.reduce((s, d) => s + d.linkDown, 0),
  };

  const body = (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-3 py-2 text-2xs">
        {/* Stats — lightweight dot + value + label, left aligned */}
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
          <Stat color="#3b82f6" value={totals.n} label="devices" />
          <Stat color="#22c55e" value={totals.up} label="up" />
          <Stat color="#22c55e" value={totals.snmpOk} label="SNMP ok" />
          <Stat color="#a855f7" value={totals.connected} label="LAN" />
          {totals.linkDown > 0 && <Stat color="#ef4444" value={totals.linkDown} label="links down" />}
        </div>
        {/* Controls — tidy cluster, right aligned */}
        <div className="ml-auto flex items-center gap-1.5">
          <SelectControl icon="⊟" title="Filter by scope / group (shared with IP/Host Monitor & Guest Agents)" value={scope} onChange={setScope}>
            <option value="all">All scopes</option>
            {scopes.map((g) => <option key={g} value={g}>{g}</option>)}
          </SelectControl>
          <SelectControl icon="📊" title="Chart for the expanded device view" value={chart} onChange={setChart}>
            {DEV_CHARTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </SelectControl>
          <button onClick={() => setHelp(true)} className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-brand hover:bg-card-hover hover:text-white" title="How to enable SNMP on a device">⤓ SNMP</button>
        </div>
      </div>

      {isLoading ? (
        <div className="px-4 py-6 text-center text-2xs text-muted">Loading network devices…</div>
      ) : devices.length === 0 ? (
        <div className="px-4 py-8 text-center text-2xs text-muted">
          No network devices yet. In <b className="text-white">IP / Host Monitor → + Add</b>, set <b className="text-white">Device type</b> to Firewall / Router / Switch and enter the <b className="text-white">SNMP community</b> to pull bandwidth, uptime, link alerts and the connected-device MAC table.
        </div>
      ) : (
        <div className="divide-y divide-border-soft">
          {devices.map((d) => (
            <DeviceRow key={d.id} d={d} chart={chart} open={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} />
          ))}
        </div>
      )}
      {help && <EnableSnmpModal onClose={() => setHelp(false)} />}
    </>
  );

  // The board cell already scrolls; don't nest another overflow container (avoids a double scrollbar).
  if (bare) return <div className="flex flex-col">{body}</div>;
  return <Card title="Network Devices · Firewall / Router / Switch" bodyClassName="p-0">{body}</Card>;
}

/** Lightweight stat: colored dot + value + label (no heavy border — reads as a clean summary strip). */
function Stat({ color, value, label }: { color: string; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      <span className="font-semibold tabular-nums text-white">{value}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}

/** A compact select with an inline icon, styled as one tidy control. */
function SelectControl({ icon, title, value, onChange, children }: { icon: string; title: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="flex shrink-0 items-center gap-1 rounded-md border border-border bg-bg pl-1.5 text-muted focus-within:border-brand" title={title}>
      <span className="text-[10px] opacity-70">{icon}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="max-w-[9rem] cursor-pointer truncate rounded-md bg-transparent py-1 pr-1 text-2xs text-white focus:outline-none">
        {children}
      </select>
    </label>
  );
}

function DeviceRow({ d, chart = 'table', open, onToggle }: { d: NetworkDevice; chart?: string; open: boolean; onToggle: () => void }) {
  const poll = useSnmpPoll();
  const [msg, setMsg] = useState<string | null>(null);
  const badge = SNMP_BADGE[d.snmpStatus] ?? SNMP_BADGE.off;
  const doPoll = async () => {
    setMsg('Polling SNMP…');
    try { const r = await poll.mutateAsync(d.id); setMsg(r.message); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-card-hover">
        <button onClick={onToggle} className="flex min-w-0 items-center gap-2.5 text-left">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.status === 'up' ? '#22c55e' : d.status === 'down' ? '#ef4444' : '#64748b' }} />
          <span className="text-base">{kindIcon(d.deviceKind)}</span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-white">{d.name}</span>
              <span className="shrink-0 rounded px-1 text-[9px] font-semibold uppercase capitalize" style={{ background: `${badge.color}22`, color: badge.color }}>{d.deviceKind}</span>
            </span>
            <span className="block truncate font-mono text-2xs text-muted">{d.target}{d.deviceMac ? ` · ${d.deviceMac}` : ''}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-3 text-2xs">
          <span className="hidden md:inline" style={{ color: badge.color }}>{badge.label}</span>
          <Metric label="lat" value={d.latencyMs != null ? `${d.latencyMs}ms` : '—'} />
          <Metric label="jit" value={d.jitterMs != null ? `${d.jitterMs}ms` : '—'} />
          <Metric label="up" value={fmtUptime(d.uptimeSec)} />
          <span className="hidden items-center gap-1 sm:flex" title="busiest interface utilization">
            <div className="h-1.5 w-10 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full" style={{ width: `${Math.min(100, d.maxUtilPct)}%`, background: metricColor(d.maxUtilPct) }} /></div>
            <span className="w-8 text-right" style={{ color: metricColor(d.maxUtilPct) }}>{d.maxUtilPct}%</span>
          </span>
          {d.linkDown > 0 && <span className="rounded bg-danger/15 px-1 text-danger" title="interfaces down">{d.linkDown}▼</span>}
          <span className="rounded bg-purple/15 px-1 text-purple" title="devices connected on LAN">{d.connectedCount} 🖧</span>
          <button onClick={onToggle} className="text-muted hover:text-white">{open ? '▾' : '▸'}</button>
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border-soft bg-bg/30 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-2xs">
            <span className="text-muted">SNMP: <span style={{ color: badge.color }}>{d.snmpStatus}</span>{d.lastSnmpAt ? ` · polled ${timeAgo(d.lastSnmpAt)}` : ''}</span>
            <button onClick={doPoll} disabled={poll.isPending} className="rounded-md border border-brand/40 bg-brand/10 px-2 py-0.5 text-brand hover:bg-brand/20 disabled:opacity-50">{poll.isPending ? 'Polling…' : '↻ Poll SNMP now'}</button>
            {msg && <span className="text-muted-light">{msg}</span>}
          </div>

          {/* Top talkers (busiest ports/links) */}
          {d.topTalkers.length > 0 && (
            <Section title={`Top talkers · busiest links (${d.topTalkers.length})`}>
              {d.topTalkers.map((t) => (
                <div key={t.name} className="flex items-center gap-2 py-0.5">
                  <span className="w-28 truncate font-mono text-white" title={t.name}>{t.name}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full" style={{ width: `${Math.min(100, t.utilPct)}%`, background: metricColor(t.utilPct) }} /></div>
                  <span className="w-20 text-right text-muted-light">↓{fmtBps(t.inBps)}</span>
                  <span className="w-20 text-right text-muted-light">↑{fmtBps(t.outBps)}</span>
                </div>
              ))}
            </Section>
          )}

          {/* Interfaces — Bandwidth (bars) / Utilization (gauges) / Table per the chart selector */}
          {d.interfaces.length > 0 && chart === 'bandwidth' && (
            <Section title={`Interfaces · bandwidth (${d.ifUp}/${d.ifTotal} up)`}>
              {(() => { const mx = Math.max(...d.interfaces.map((i) => Math.max(i.inBps, i.outBps)), 1); return d.interfaces.map((i) => (
                <div key={i.index} className="py-0.5">
                  <div className="flex items-center justify-between"><span className="max-w-[140px] truncate font-mono text-white" title={i.name}>{i.name}</span><span className="text-muted-light">↓{fmtBps(i.inBps)} · ↑{fmtBps(i.outBps)}</span></div>
                  <div className="mt-0.5 flex gap-0.5"><div className="h-2 rounded-l bg-sky-400" style={{ width: `${(i.inBps / mx) * 50}%` }} /><div className="h-2 rounded-r bg-emerald-400" style={{ width: `${(i.outBps / mx) * 50}%` }} /></div>
                </div>
              )); })()}
              <div className="mt-1 text-[9px] text-muted"><span className="text-sky-400">▮</span> in · <span className="text-emerald-400">▮</span> out</div>
            </Section>
          )}
          {d.interfaces.length > 0 && chart === 'utilization' && (
            <Section title={`Interfaces · utilization (${d.ifUp}/${d.ifTotal} up)`}>
              <div className="flex flex-wrap gap-2">
                {d.interfaces.map((i) => (
                  <div key={i.index} className="flex w-20 flex-col items-center gap-0.5 rounded border border-border bg-card/40 p-1">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-border"><div className="h-full rounded-full" style={{ width: `${Math.min(100, i.utilPct)}%`, background: metricColor(i.utilPct) }} /></div>
                    <span className="text-[10px] font-semibold" style={{ color: metricColor(i.utilPct) }}>{i.utilPct}%</span>
                    <span className="w-full truncate text-center font-mono text-[9px] text-muted" title={i.name}>{i.name}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
          {d.interfaces.length > 0 && chart === 'table' && (
            <Section title={`Interfaces · bandwidth (${d.ifUp}/${d.ifTotal} up)`}>
              <table className="w-full">
                <thead><tr className="text-left text-muted"><th className="py-0.5">Port</th><th>Status</th><th>Speed</th><th>In</th><th>Out</th><th>Util</th><th>MAC</th></tr></thead>
                <tbody>
                  {d.interfaces.map((i) => (
                    <tr key={i.index} className="border-t border-border-soft">
                      <td className="max-w-[120px] truncate py-0.5 font-mono text-white" title={i.name}>{i.name}</td>
                      <td><span style={{ color: i.status === 'up' ? '#22c55e' : '#ef4444' }}>●</span></td>
                      <td className="text-muted-light">{i.speedMbps >= 1000 ? `${i.speedMbps / 1000}G` : i.speedMbps ? `${i.speedMbps}M` : '—'}</td>
                      <td className="text-muted-light">{fmtBps(i.inBps)}</td>
                      <td className="text-muted-light">{fmtBps(i.outBps)}</td>
                      <td style={{ color: metricColor(i.utilPct) }}>{i.utilPct}%</td>
                      <td className="font-mono text-muted">{i.mac ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {/* Connected devices on LAN (MAC table) */}
          {d.neighbors.length > 0 && (
            <Section title={`Connected devices on LAN (${d.neighbors.length}) · MAC ↔ IP ↔ port`}>
              <table className="w-full">
                <thead><tr className="text-left text-muted"><th className="py-0.5">MAC address</th><th>IP</th><th>Via port</th></tr></thead>
                <tbody>
                  {d.neighbors.map((n, idx) => (
                    <tr key={n.mac + idx} className="border-t border-border-soft">
                      <td className="py-0.5 font-mono text-white">{n.mac}</td>
                      <td className="font-mono text-muted-light">{n.ip ?? '—'}</td>
                      <td className="text-muted-light">{n.ifName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          )}

          {d.snmp && d.interfaces.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card/30 px-3 py-2 text-2xs text-muted">SNMP community is set but the device hasn't answered. Click <b className="text-white">↻ Poll SNMP now</b>; if it still fails, enable SNMP v2c on the device (<b className="text-white">⤓ Enable SNMP</b>) and allow UDP 161 from the MCMF server.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <span className="hidden lg:inline"><span className="text-muted">{label} </span><span className="font-medium text-white">{value}</span></span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/50 p-2.5">
      <div className="mb-1.5 text-2xs font-semibold text-white">{title}</div>
      <div className="max-h-56 overflow-auto text-2xs">{children}</div>
    </div>
  );
}

/** "Push SNMP" — copy-paste config to enable SNMP v2c on common devices. */
function EnableSnmpModal({ onClose }: { onClose: () => void }) {
  const snippets: [string, string][] = [
    ['Linux (net-snmp)', 'sudo apt install -y snmpd\n# /etc/snmp/snmpd.conf:\nrocommunity public 192.168.0.0/16\nagentAddress udp:161\nsudo systemctl restart snmpd'],
    ['MikroTik RouterOS', '/snmp set enabled=yes\n/snmp community set [find default=yes] name=public addresses=192.168.0.0/16'],
    ['pfSense / OPNsense', 'Services → SNMP → Enable.\nCommunity = public, Bind to LAN, allow the MCMF server IP.'],
    ['Cisco IOS', 'conf t\n snmp-server community public RO\n snmp-server host <MCMF_IP> version 2c public\nend\nwrite memory'],
  ];
  return (
    <Modal title="Enable SNMP on the device" subtitle="MCMF reads bandwidth, uptime, link status and the MAC table over SNMP v2c (read-only). Open UDP 161 from the MCMF server, then set the same community on the monitor." onClose={onClose}>
      <div className="space-y-3">
        {snippets.map(([name, code]) => (
          <div key={name}>
            <div className="mb-1 text-2xs font-semibold text-white">{name}</div>
            <pre className="overflow-auto rounded-lg border border-border bg-bg p-2 font-mono text-2xs leading-relaxed text-muted-light">{code}</pre>
          </div>
        ))}
        <div className="rounded-lg border border-border bg-card/50 px-3 py-2 text-2xs text-muted">SNMP v2c read-only is safe — MCMF only reads. Use a non-default community and restrict it to the MCMF server's IP. Then edit the device in IP/Host Monitor and set the same community.</div>
      </div>
    </Modal>
  );
}
