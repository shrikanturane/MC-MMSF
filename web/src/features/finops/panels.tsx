'use client';

import { useState, type ReactNode } from 'react';
import { Card, LoadingState, Modal, ProgressBar } from '@/components/ui';
import { useAuthUser } from '@/lib/auth';
import { useFinOpsOverview, useCarbonSummary, useCreateBudget, useUpdateBudget, useDeleteBudget } from '@/lib/hooks';
import { money, number } from '@/lib/format';
import type { Breakdown, CarbonBreakdown, BudgetStatus } from '@/lib/types';
import { CostDrillDown } from './CostDrillDown';

const PALETTE = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b', '#14b8a6', '#a855f7'];
const SCOPE_LABELS: Record<string, string> = { all: 'All spend', provider: 'Provider', environment: 'Environment', account: 'Account', service: 'Service' };
const STATUS_COLOR: Record<string, string> = { ok: '#10b981', warning: '#f59e0b', over: '#ef4444' };

function Frame({ bare, title, action, bodyClassName, children }: { bare?: boolean; title: string; action?: ReactNode; bodyClassName?: string; children: ReactNode }) {
  if (bare) {
    return (
      <div className="flex h-full flex-col">
        {action && <div className="mb-2 flex flex-wrap items-center justify-end gap-2">{action}</div>}
        <div className={`min-h-0 flex-1 ${bodyClassName ?? ''}`}>{children}</div>
      </div>
    );
  }
  return <Card title={title} action={action} bodyClassName={bodyClassName}>{children}</Card>;
}

function BreakBars({ rows, fmt, max }: { rows: { key: string; value: number; pct: number }[]; fmt: (n: number) => string; max?: number }) {
  const top = rows.slice(0, max ?? rows.length);
  if (!top.length) return <div className="text-2xs text-muted">No data.</div>;
  return (
    <div className="grid gap-2.5">
      {top.map((r, i) => (
        <div key={r.key}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="truncate text-muted-light" title={r.key}>{r.key}</span>
            <span className="tabular-nums font-medium text-white">{fmt(r.value)} <span className="text-2xs text-muted">· {r.pct}%</span></span>
          </div>
          <ProgressBar value={r.pct} color={PALETTE[i % PALETTE.length]} />
        </div>
      ))}
    </div>
  );
}

function MiniTrend({ points, color, fmt }: { points: { label: string; value: number; forecast?: boolean }[]; color: string; fmt: (n: number) => string }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <div className="flex items-end gap-1.5" style={{ height: 110 }}>
      {points.map((p, i) => (
        <div key={i} className="group flex flex-1 flex-col items-center justify-end" title={`${p.label}: ${fmt(p.value)}`}>
          <div className="w-full rounded-t transition-all" style={{
            height: `${Math.max(4, (p.value / max) * 96)}%`,
            background: p.forecast ? `repeating-linear-gradient(45deg, ${color}, ${color} 4px, transparent 4px, transparent 8px)` : color,
            opacity: p.forecast ? 0.85 : 1, border: p.forecast ? `1px dashed ${color}` : 'none',
          }} />
          <span className="mt-1 text-[9px] text-muted">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 mt-3 text-2xs font-semibold uppercase tracking-wide text-muted first:mt-0">{children}</div>;
}

// ════════════════════════════ COST widgets ════════════════════════════
export function CostTrendPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useFinOpsOverview();
  if (isLoading || !data) return <LoadingState rows={3} />;
  const m = (n: number) => money(n, data.currency, true);
  return (
    <Frame bare={bare} title="Spend Trend & Forecast">
      <MiniTrend color="#3b82f6" fmt={m} points={data.forecast.map((f) => ({ label: f.month, value: f.value, forecast: f.kind === 'forecast' }))} />
      <div className="mt-2 flex items-center gap-4 text-2xs text-muted">
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm bg-[#3b82f6]" /> actual</span>
        <span className="flex items-center gap-1"><span className="inline-block h-2 w-3 rounded-sm border border-dashed border-[#3b82f6]" /> forecast (linear regression)</span>
      </div>
    </Frame>
  );
}

export function CostBreakdownsPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useFinOpsOverview();
  if (isLoading || !data) return <LoadingState rows={3} />;
  // Interactive drill-down: group by any dimension, click to drill provider → service →
  // region → type → env → account → resource. Falls back to flat bars for older API
  // responses that don't yet return per-resource rows.
  return (
    <Frame bare={bare} title="Cost Distribution (drill-down)">
      {data.resources?.length ? (
        <CostDrillDown resources={data.resources} currency={data.currency} />
      ) : (
        <>
          <SubTitle>By provider</SubTitle><BreakBars rows={data.byProvider} fmt={(n) => money(n, data.currency, true)} />
          <SubTitle>Top services</SubTitle><BreakBars rows={data.byService} fmt={(n) => money(n, data.currency, true)} max={8} />
        </>
      )}
    </Frame>
  );
}

export function CostDriversPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useFinOpsOverview();
  if (isLoading || !data) return <LoadingState rows={3} />;
  const cur = data.currency;
  return (
    <Frame bare={bare} title="Top Cost Drivers" bodyClassName="p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
              <th className="px-2 py-2">Resource</th><th className="px-2 py-2">Provider</th><th className="px-2 py-2">Service</th>
              <th className="px-2 py-2">Region</th><th className="px-2 py-2">Env</th><th className="px-2 py-2 text-right">CPU</th><th className="px-2 py-2 text-right">Monthly</th>
            </tr>
          </thead>
          <tbody>
            {data.topDrivers.map((r, i) => (
              <tr key={i} className="border-b border-border/50">
                <td className="px-2 py-2 font-medium text-white">{r.name}</td>
                <td className="px-2 py-2 uppercase text-muted-light">{r.provider}</td>
                <td className="px-2 py-2 text-muted-light">{r.service}</td>
                <td className="px-2 py-2 text-muted-light">{r.region}</td>
                <td className="px-2 py-2 text-muted-light">{r.environment}</td>
                <td className="px-2 py-2 text-right tabular-nums text-muted-light">{r.cpuPct}%</td>
                <td className="px-2 py-2 text-right tabular-nums font-semibold text-white">{money(r.monthlyCost, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  );
}

export function CostOptimizationPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useFinOpsOverview();
  if (isLoading || !data) return <LoadingState rows={3} />;
  const cur = data.currency;
  return (
    <Frame bare={bare} title="Savings & Anomalies">
      <SubTitle>Savings opportunities · {money(data.potentialSavings, cur, true)}/mo</SubTitle>
      {data.savings.length === 0 ? <div className="text-2xs text-muted">No waste detected — fleet looks efficient.</div> : (
        <div className="grid gap-2">
          {data.savings.map((s) => (
            <div key={s.id} className="rounded-lg border border-border bg-card/50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-white">{s.title}</span>
                <span className="pill bg-success/10 text-success whitespace-nowrap">save {money(s.monthlySaving, cur, true)}</span>
              </div>
              <div className="mt-1 text-2xs text-muted"><span className="uppercase">{s.provider}</span> · {s.resourceName} — {s.detail}</div>
            </div>
          ))}
        </div>
      )}
      <SubTitle>Spend anomalies</SubTitle>
      {data.anomalies.length === 0 ? <div className="text-2xs text-muted">No cost outliers detected.</div> : (
        <div className="grid gap-2">
          {data.anomalies.map((a, i) => (
            <div key={i} className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
              <div><div className="text-sm font-medium text-white">{a.label}</div><div className="text-2xs text-muted">{a.note}</div></div>
              <span className="pill bg-amber-500/10 text-amber-400">z {a.z}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

export function BudgetsPanel({ bare = false }: { bare?: boolean }) {
  const { data: me } = useAuthUser();
  const isAdmin = me?.role === 'admin';
  const { data } = useFinOpsOverview();
  const budgets = data?.budgets ?? [];
  const currency = data?.currency ?? 'USD';
  const [editing, setEditing] = useState<BudgetStatus | null>(null);
  const [adding, setAdding] = useState(false);
  const del = useDeleteBudget();
  return (
    <Frame bare={bare} title="Budgets" action={isAdmin ? <button onClick={() => setAdding(true)} className="rounded-lg border border-border bg-card px-3 py-1 text-xs text-muted-light hover:text-white">+ Add Budget</button> : undefined}>
      {budgets.length === 0 ? (
        <div className="text-2xs text-muted">No budgets set. {isAdmin && 'Add one to track spend against a ceiling and get burn alerts.'}</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {budgets.map((b) => (
            <div key={b.id} className="rounded-lg border border-border bg-card/50 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-white">{b.name}</div>
                  <div className="text-2xs text-muted">{SCOPE_LABELS[b.scope] ?? b.scope}{b.scopeValue ? `: ${b.scopeValue}` : ''} · {b.period}</div>
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <button onClick={() => setEditing(b)} className="rounded border border-border bg-card px-1.5 text-2xs text-muted-light hover:text-white" title="Edit">✎</button>
                    <button onClick={() => confirm(`Delete budget "${b.name}"?`) && del.mutate(b.id)} className="rounded border border-border bg-card px-1.5 text-2xs text-muted-light hover:text-danger" title="Delete">✕</button>
                  </div>
                )}
              </div>
              <div className="mt-2"><ProgressBar value={b.usedPct} color={STATUS_COLOR[b.status]} height={8} /></div>
              <div className="mt-1.5 flex items-center justify-between text-2xs">
                <span className="text-muted-light">{money(b.actual, currency, true)} of {money(b.amount, currency, true)}</span>
                <span style={{ color: STATUS_COLOR[b.status] }} className="font-semibold">{b.usedPct}% {b.status === 'over' ? '· OVER' : b.status === 'warning' ? '· near limit' : ''}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {(adding || editing) && <BudgetModal budget={editing} currency={currency} onClose={() => { setAdding(false); setEditing(null); }} />}
    </Frame>
  );
}

function BudgetModal({ budget, currency, onClose }: { budget: BudgetStatus | null; currency: string; onClose: () => void }) {
  const create = useCreateBudget();
  const update = useUpdateBudget();
  const [name, setName] = useState(budget?.name ?? '');
  const [amount, setAmount] = useState(String(budget?.amount ?? ''));
  const [scope, setScope] = useState(budget?.scope ?? 'all');
  const [scopeValue, setScopeValue] = useState(budget?.scopeValue ?? '');
  const busy = create.isPending || update.isPending;
  const err = (create.error || update.error) as Error | null;
  const submit = () => {
    const body = { name, amount: Number(amount), scope, scopeValue: scope === 'all' ? '' : scopeValue };
    const onDone = { onSuccess: onClose };
    if (budget) update.mutate({ id: budget.id, ...body }, onDone);
    else create.mutate(body, onDone);
  };
  return (
    <Modal title={budget ? 'Edit Budget' : 'Add Budget'} subtitle="Actual spend is computed live from inventory / billing." onClose={onClose}>
      <div className="grid gap-3">
        <label className="grid gap-1 text-xs text-muted-light">Name
          <input value={name} onChange={(e) => setName(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-white" placeholder="e.g. Production monthly cap" />
        </label>
        <label className="grid gap-1 text-xs text-muted-light">Monthly amount ({currency})
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" min="1" className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-white" placeholder="10000" />
        </label>
        <label className="grid gap-1 text-xs text-muted-light">Scope
          <select value={scope} onChange={(e) => setScope(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-white">
            {Object.entries(SCOPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {scope !== 'all' && (
          <label className="grid gap-1 text-xs text-muted-light">{SCOPE_LABELS[scope]} value
            {scope === 'provider' ? (
              <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-white">
                <option value="">Select…</option>{['aws', 'azure', 'gcp', 'private', 'docker', 'vmware', 'nutanix', 'proxmox', 'kvm'].map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
              </select>
            ) : scope === 'environment' ? (
              <select value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-white">
                <option value="">Select…</option>{['production', 'staging', 'development', 'test', 'unknown'].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            ) : (
              <input value={scopeValue} onChange={(e) => setScopeValue(e.target.value)} className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-white" placeholder={scope === 'service' ? 'e.g. EC2' : 'account name'} />
            )}
          </label>
        )}
        {err && <div className="text-2xs text-danger">{err.message}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-light hover:text-white">Cancel</button>
          <button onClick={submit} disabled={busy || !name || !amount} className="rounded-lg bg-brand px-4 py-2 text-xs font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : budget ? 'Save' : 'Create'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ════════════════════════════ CARBON widgets ════════════════════════════
function carbonFmt(kg: number) { return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${Math.round(kg)} kg`; }
const cb = (rows: CarbonBreakdown[]): Breakdown[] => rows.map((r) => ({ key: r.key, value: r.kg, pct: r.pct }));

export function CarbonEquivalentsPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useCarbonSummary();
  if (isLoading || !data) return <LoadingState rows={2} />;
  return (
    <Frame bare={bare} title="Real-world Equivalents (annual)">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { icon: '🌳', v: number(data.equivalents.treeSeedlings), l: 'tree seedlings grown 10 yrs' },
          { icon: '🚗', v: number(data.equivalents.passengerCars), l: 'cars driven for a year' },
          { icon: '🏠', v: number(data.equivalents.homesPowered), l: 'homes’ electricity / year' },
          { icon: '✈️', v: number(data.equivalents.flightsLondonNY), l: 'London→NY economy seats' },
        ].map((e) => (
          <div key={e.l} className="rounded-lg border border-border bg-card/50 p-3 text-center">
            <div className="text-2xl">{e.icon}</div>
            <div className="mt-1 text-lg font-semibold text-white tabular-nums">{e.v}</div>
            <div className="text-[10px] leading-tight text-muted">{e.l}</div>
          </div>
        ))}
      </div>
    </Frame>
  );
}

export function CarbonTrendPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useCarbonSummary();
  if (isLoading || !data) return <LoadingState rows={2} />;
  return (
    <Frame bare={bare} title="Emissions Trend (7 mo)">
      <MiniTrend color="#10b981" fmt={carbonFmt} points={data.trend.map((t) => ({ label: t.month, value: t.kg }))} />
    </Frame>
  );
}

export function CarbonBreakdownsPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useCarbonSummary();
  if (isLoading || !data) return <LoadingState rows={3} />;
  return (
    <Frame bare={bare} title="Emissions Breakdowns">
      <SubTitle>By provider</SubTitle><BreakBars rows={cb(data.byProvider)} fmt={carbonFmt} />
      <SubTitle>By region</SubTitle><BreakBars rows={cb(data.byRegion)} fmt={carbonFmt} max={8} />
      <SubTitle>By environment</SubTitle><BreakBars rows={cb(data.byEnvironment)} fmt={carbonFmt} />
    </Frame>
  );
}

export function CarbonGridPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useCarbonSummary();
  if (isLoading || !data) return <LoadingState rows={3} />;
  return (
    <Frame bare={bare} title="Grid Intensity & Clean Energy">
      <SubTitle>Grid intensity leaderboard (dirtiest first)</SubTitle>
      <div className="grid gap-2">
        {data.intensityBoard.map((r, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-border bg-card/50 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: r.gco2 > 500 ? '#ef4444' : r.gco2 > 300 ? '#f59e0b' : '#10b981' }} />
              <span className="text-sm text-white">{r.region}</span>
              <span className="text-2xs text-muted">· {r.workloads} workload(s)</span>
            </div>
            <span className="tabular-nums text-xs font-medium" style={{ color: r.gco2 > 500 ? '#ef4444' : r.gco2 > 300 ? '#f59e0b' : '#10b981' }}>{r.gco2} gCO₂e/kWh</span>
          </div>
        ))}
      </div>
      <SubTitle>Provider clean-energy coverage</SubTitle>
      <div className="grid gap-3">
        {data.renewable.map((r) => (
          <div key={r.key}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="text-muted-light">{r.provider} <span className="text-2xs text-muted">· PUE {r.pue}</span></span>
              <span className="font-medium text-white">{r.renewablePct}% renewable-matched</span>
            </div>
            <ProgressBar value={r.renewablePct} color="#10b981" />
          </div>
        ))}
      </div>
    </Frame>
  );
}

export function CarbonRecommendationsPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading } = useCarbonSummary();
  if (isLoading || !data) return <LoadingState rows={2} />;
  return (
    <Frame bare={bare} title="Decarbonisation Opportunities">
      {data.recommendations.length === 0 ? <div className="text-2xs text-muted">No material reduction opportunities detected.</div> : (
        <div className="grid gap-2">
          {data.recommendations.map((r, i) => (
            <div key={i} className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-white">{r.title}</span>
                <span className="pill bg-success/10 text-success whitespace-nowrap">−{carbonFmt(r.savingKgMonth)}/mo</span>
              </div>
              <div className="mt-1 text-2xs text-muted">{r.detail}</div>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}
