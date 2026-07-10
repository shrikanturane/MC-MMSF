'use client';

import { useState } from 'react';
import { Board } from '@/features/board/Board';
import { useAuthUser } from '@/lib/auth';
import { useNetworkOverview, useNetworkScan, useNetworkMonitoring } from '@/lib/hooks';
import { number } from '@/lib/format';
import type { BoardPanel } from '@/lib/types';

// Every network panel is now a resizable widget. Two tabs, each its own saved board.
const ANALYSIS_SEED: BoardPanel[] = [
  { i: 'risks', kind: 'firewall-risks', title: 'Risky Firewall / NSG Rules', x: 0, y: 0, w: 12, h: 9 },
  { i: 'exposure', kind: 'public-exposure', title: 'Public Exposure', x: 0, y: 9, w: 7, h: 8 },
  { i: 'inv', kind: 'net-inventory', title: 'Network Inventory', x: 7, y: 9, w: 5, h: 8 },
  { i: 'seg', kind: 'net-segments', title: 'Network Segments', x: 0, y: 17, w: 12, h: 5 },
];
const MONITORING_SEED: BoardPanel[] = [
  { i: 'link', kind: 'link-health', title: 'Link Latency & Health', x: 0, y: 0, w: 12, h: 8 },
  { i: 'tp', kind: 'net-throughput', title: 'Per-VM Network Throughput', x: 0, y: 8, w: 12, h: 8 },
];

export function NetworkView() {
  const { data: me } = useAuthUser();
  const scan = useNetworkScan();
  const [tab, setTab] = useState<'analysis' | 'monitoring'>('analysis');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-xl border border-border bg-panel px-4 py-3">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
          {(['analysis', 'monitoring'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1.5 text-xs capitalize ${tab === t ? 'bg-brand text-white' : 'text-muted-light hover:text-white'}`}>
              {t === 'analysis' ? 'Analysis & Exposure' : 'Monitoring'}
            </button>
          ))}
        </div>
        {tab === 'analysis' && me?.role !== 'viewer' && (
          <button onClick={() => scan.mutate()} disabled={scan.isPending} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">
            {scan.isPending ? 'Scanning…' : 'Scan firewall rules'}
          </button>
        )}
      </div>

      {tab === 'analysis' && (
        <>
          <AnalysisKpis />
          <Board key="network-analysis" boardKey="network-analysis" seed={ANALYSIS_SEED} />
        </>
      )}
      {tab === 'monitoring' && (
        <>
          <MonitoringKpis />
          <Board key="network-monitoring" boardKey="network-monitoring" seed={MONITORING_SEED} />
        </>
      )}
    </div>
  );
}

function AnalysisKpis() {
  const net = useNetworkOverview();
  const s = net.data?.summary;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Kpi label="Publicly Exposed" value={number(s?.exposed ?? 0)} color={(s?.exposed ?? 0) > 0 ? '#f59e0b' : '#22c55e'} />
      <Kpi label="Risky Rules" value={number(s?.risks ?? 0)} color={(s?.risks ?? 0) > 0 ? '#ef4444' : '#22c55e'} />
      <Kpi label="Critical + High" value={number((s?.bySeverity.critical ?? 0) + (s?.bySeverity.high ?? 0))} color="#ef4444" />
      <Kpi label="Network Resources" value={number(s?.networkResources ?? 0)} color="#3b82f6" />
    </div>
  );
}

function MonitoringKpis() {
  const mon = useNetworkMonitoring();
  const c = mon.data?.connectivity;
  const d = mon.data;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      <Kpi label="Links Up" value={`${c?.up ?? 0}/${c?.total ?? 0}`} color="#22c55e" />
      <Kpi label="Links Down" value={number(c?.down ?? 0)} color={(c?.down ?? 0) > 0 ? '#ef4444' : '#22c55e'} />
      <Kpi label="Uptime" value={`${c?.uptimePct ?? 0}%`} color="#3b82f6" />
      <Kpi label="Avg Latency" value={d?.fleetAvgLatency != null ? `${d.fleetAvgLatency} ms` : '—'} color="#a855f7" />
      <Kpi label="Fleet Net I/O" value={`${d?.totalMbps ?? 0} Mbps`} color="#06b6d4" />
    </div>
  );
}

function Kpi({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 px-4 py-3">
      <div className="text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-2xs text-muted">{label}</div>
    </div>
  );
}
