'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Board } from '@/features/board/Board';
import { useManagementSummary, useSettings, useVms, useAlerts } from '@/lib/hooks';
import { useBranding } from '@/lib/branding';
import { useAuthUser } from '@/lib/auth';
import { accessAllows } from '@/lib/modules';
import { useClock, formatClock, formatLongDate, greeting, tzCity, tzOffset } from '@/lib/time';
import { money, number } from '@/lib/format';
import type { BoardPanel } from '@/lib/types';

const SEED: BoardPanel[] = [
  { i: 'res', kind: 'resources', title: 'Resources by Provider', x: 0, y: 0, w: 4, h: 6 },
  { i: 'cost', kind: 'cost', title: 'Cost by Service', x: 4, y: 0, w: 8, h: 6 },
  { i: 'kpis', kind: 'kpis', title: 'Monitoring KPIs', x: 0, y: 6, w: 12, h: 4 },
  { i: 'alerts', kind: 'alerts', title: 'Active Alerts', x: 0, y: 10, w: 6, h: 5 },
  { i: 'vms', kind: 'vms', title: 'Virtual Machines', x: 6, y: 10, w: 6, h: 5 },
];

export function CustomDashboardView() {
  const { data: settings } = useSettings();
  const { data: summary } = useManagementSummary();
  const { data: vms } = useVms();
  const { data: alerts } = useAlerts('active');
  const { layout } = useBranding();
  const { data: me } = useAuthUser();
  const now = useClock();
  // Default board + any pages the admin created in Settings → Workspace → Pages, gated by group access.
  const pages = [{ id: 'custom', label: 'My Board', icon: '🏠' }, ...(layout.customPages ?? []).filter((p) => accessAllows(me?.access, 'pages', p.id, me?.role))];
  const [pageId, setPageId] = useState('custom');
  const active = pages.find((p) => p.id === pageId) ?? pages[0];
  const boardKey = active.id === 'custom' ? 'custom' : `custom-${active.id}`;

  const tz = settings?.region.timezone;
  const firstName = (settings?.profile.userName ?? '').trim().split(/\s+/)[0] || 'there';
  const currency = summary?.currency ?? settings?.region.currency ?? 'USD';

  const runningVms = (vms ?? []).filter((v) => v.status === 'running').length;
  const activeAlerts = (alerts ?? []).filter((a) => a.status !== 'resolved').length;

  // Each KPI drills into the exact data behind it; the Topbar "← Back" returns here.
  const kpis = [
    { label: 'Total Assets', value: number(summary?.kpis.totalAssets ?? 0), accent: '#3b82f6', href: '/inventory' },
    { label: 'Running', value: number(summary?.kpis.runningResources ?? 0), accent: '#22c55e', href: '/vms' },
    { label: 'VMs Up', value: `${runningVms}/${vms?.length ?? 0}`, accent: '#06b6d4', href: '/vms' },
    { label: 'Active Alerts', value: number(activeAlerts), accent: activeAlerts > 0 ? '#ef4444' : '#22c55e', href: '/security#alerts' },
    { label: 'Compliance', value: `${Math.round(summary?.kpis.complianceScore ?? 0)}%`, accent: '#a855f7', href: '/governance' },
    { label: 'Monthly Cost', value: money(summary?.kpis.monthlyCost ?? 0, currency, true), accent: '#f59e0b', href: '/reports' },
  ];

  return (
    <div className="space-y-4">
      {/* Personalized hero with live, timezone-aware clock */}
      <div className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-brand/15 via-panel to-panel px-5 py-5">
        <div className="pointer-events-none absolute -right-10 -top-10 h-44 w-44 rounded-full bg-brand/10 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-lg font-semibold text-white">
              {greeting(now, tz)}, {firstName} 👋
            </div>
            <div className="mt-0.5 text-2xs text-muted">
              Here&apos;s your multi-cloud snapshot. {activeAlerts > 0 ? (
                <span className="text-danger">{activeAlerts} alert{activeAlerts > 1 ? 's' : ''} need attention.</span>
              ) : (
                <span className="text-success">All systems nominal.</span>
              )}
            </div>
            <div className="mt-2 text-2xs text-muted">{settings?.profile.userRole ?? 'Cloud Administrator'} · {settings?.profile.orgName ?? 'MCMF'}</div>
          </div>

          <div className="text-right">
            <div className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-white">
              {formatClock(now, tz)}
            </div>
            <div className="text-2xs text-muted-light">{formatLongDate(now, tz)}</div>
            <div className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-2 py-0.5 text-2xs text-muted">
              <span>📍</span>
              <span className="text-white">{tzCity(tz)}</span>
              <span>·</span>
              <span>{tzOffset(now, tz)}</span>
            </div>
          </div>
        </div>

        {/* KPI strip — live backend data */}
        <div className="relative mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {kpis.map((k) => (
            <Link key={k.label} href={k.href} title={`View ${k.label}`} className="group rounded-xl border border-border bg-card/60 px-3 py-2.5 transition hover:border-brand/50 hover:bg-card-hover">
              <div className="text-lg font-semibold tabular-nums text-white" style={{ color: k.accent }}>{k.value}</div>
              <div className="flex items-center gap-1 text-2xs text-muted">{k.label}<span className="opacity-0 transition group-hover:opacity-100">↗</span></div>
            </Link>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {pages.map((p) => (
              <button key={p.id} onClick={() => setPageId(p.id)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${pageId === p.id ? 'bg-brand text-white' : 'border border-border bg-card text-muted hover:text-white'}`}>
                {p.icon ?? '📋'} {p.label}
              </button>
            ))}
          </div>
          <Link href="/settings?section=workspace" className="text-2xs text-brand hover:underline">+ Manage pages (Settings → Workspace)</Link>
        </div>
        <div className="mt-2 text-2xs text-muted">Build your own view — add widgets, drag to reposition, resize from the corner, switch chart types. Saved automatically. Create more pages in Settings → Workspace → Pages.</div>
      </div>
      <Board key={boardKey} boardKey={boardKey} seed={active.id === 'custom' ? SEED : []} />
    </div>
  );
}
