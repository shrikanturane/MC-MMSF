'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Board } from '@/features/board/Board';
import { useVmFilter } from '@/features/board/vmFilter';
import { useTelemetry } from '@/lib/hooks';
import type { BoardPanel } from '@/lib/types';

// Each tab is its own customizable board (independent saved layout per boardKey),
// so the long single-scroll monitoring page becomes a few focused screens.
type MonTab = 'overview' | 'trends' | 'telemetry' | 'netdevices' | 'health';
const TABS: { id: MonTab; label: string; icon: string; boardKey: string; seed: BoardPanel[] }[] = [
  {
    id: 'overview',
    label: 'Overview',
    icon: '📊',
    boardKey: 'monitoring-overview',
    seed: [
      { i: 'kpis', kind: 'kpis', title: 'Monitoring KPIs', x: 0, y: 0, w: 12, h: 7 },
      { i: 'fleet', kind: 'fleet-type', title: 'Fleet by Type', x: 0, y: 7, w: 6, h: 7 },
      { i: 'cpu', kind: 'trend', title: 'CPU Trend', cfg: { metric: 'cpu' }, x: 6, y: 7, w: 6, h: 7 },
      { i: 'mem', kind: 'trend', title: 'Memory Trend', cfg: { metric: 'memory' }, x: 0, y: 14, w: 6, h: 6 },
    ],
  },
  {
    id: 'trends',
    label: 'Trends',
    icon: '📈',
    boardKey: 'monitoring-trends',
    seed: [
      { i: 'cpu', kind: 'trend', title: 'CPU Trend', cfg: { metric: 'cpu' }, x: 0, y: 0, w: 6, h: 5 },
      { i: 'mem', kind: 'trend', title: 'Memory Trend', cfg: { metric: 'memory' }, x: 6, y: 0, w: 6, h: 5 },
      { i: 'disk', kind: 'trend', title: 'Disk Trend', cfg: { metric: 'disk' }, x: 0, y: 5, w: 6, h: 5 },
      { i: 'net', kind: 'trend', title: 'Network Trend', cfg: { metric: 'network' }, x: 6, y: 5, w: 6, h: 5 },
      { i: 'lat', kind: 'trend', title: 'Latency Trend', cfg: { metric: 'latency' }, x: 0, y: 10, w: 6, h: 5 },
      { i: 'jit', kind: 'trend', title: 'Jitter Trend', cfg: { metric: 'jitter' }, x: 6, y: 10, w: 6, h: 5 },
      { i: 'err', kind: 'trend', title: 'Error-Rate Trend', cfg: { metric: 'error' }, x: 0, y: 15, w: 6, h: 5 },
    ],
  },
  {
    id: 'telemetry',
    label: 'Telemetry & Hosts',
    icon: '📡',
    boardKey: 'monitoring-telemetry',
    seed: [
      { i: 'tel', kind: 'telemetry', title: 'Per-VM Telemetry', x: 0, y: 0, w: 6, h: 9 },
      { i: 'ipmon', kind: 'ipmon', title: 'IP / Host Monitor', x: 6, y: 0, w: 6, h: 9 },
      { i: 'vmdetail', kind: 'vmdetail', title: 'Selected VM Detail', x: 0, y: 9, w: 6, h: 8 },
      { i: 'svc', kind: 'services', title: 'Running Services', x: 6, y: 9, w: 6, h: 8 },
    ],
  },
  {
    id: 'netdevices',
    label: 'Network Devices',
    icon: '🔀',
    boardKey: 'monitoring-netdevices',
    seed: [
      { i: 'netdev', kind: 'netdevices', title: 'Network Devices', x: 0, y: 0, w: 12, h: 9 },
      { i: 'ipmon', kind: 'ipmon', title: 'IP / Host Monitor', x: 0, y: 9, w: 12, h: 8 },
    ],
  },
  {
    id: 'health',
    label: 'Service Health',
    icon: '🩺',
    boardKey: 'monitoring-health',
    seed: [
      { i: 'health', kind: 'health', title: 'Service Health Map', x: 0, y: 0, w: 12, h: 8 },
    ],
  },
];

export function MonitoringView() {
  const [tab, setTab] = useState<MonTab>('overview');

  // Deep-linkable + reload-stable tab via URL hash.
  useEffect(() => {
    const h = window.location.hash.replace('#', '') as MonTab;
    if (TABS.some((t) => t.id === h)) setTab(h);
  }, []);
  const go = (id: MonTab) => {
    setTab(id);
    window.history.replaceState(null, '', `#${id}`);
  };

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-white">Monitoring &amp; Telemetry</div>
          <div className="text-2xs text-muted">Each tab is its own customizable board — drag to move, resize from the corner, add/remove widgets. Saved automatically.</div>
        </div>
        <div className="flex items-center gap-2">
          <MonitoringVmFilter />
          <Link href="/custom" className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-brand hover:text-white">My Dashboard →</Link>
        </div>
      </div>

      {/* Tab bar — splits the long board into focused, one-screenful sections */}
      <div className="flex flex-wrap gap-1.5 border-b border-border pb-2">
        {TABS.map((t) => {
          const on = t.id === active.id;
          return (
            <button
              key={t.id}
              onClick={() => go(t.id)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition ${
                on ? 'border-brand/40 bg-brand/10 text-white' : 'border-border bg-card text-muted hover:text-white'
              }`}
            >
              <span>{t.icon}</span>
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Only the active tab's board mounts — keeps the page short and the grid measured correctly */}
      <Board key={active.boardKey} boardKey={active.boardKey} seed={active.seed} />
    </div>
  );
}

/** Shared VM filter — drives every widget on every Monitoring tab (KPIs, trends, services). */
function MonitoringVmFilter() {
  const [vmId, setVmId] = useVmFilter();
  const tel = useTelemetry();
  const vms = tel.data ?? [];
  return (
    <label className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-2xs">
      <span className="text-muted">🖥 VM</span>
      <select value={vmId} onChange={(e) => setVmId(e.target.value)} className="max-w-[200px] rounded-md border border-border bg-bg px-2 py-0.5 text-2xs text-white focus:border-brand focus:outline-none">
        <option value="all">All VMs · fleet</option>
        {vms.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      {vmId !== 'all' && <button onClick={() => setVmId('all')} className="text-muted hover:text-white" title="Clear filter">✕</button>}
    </label>
  );
}
