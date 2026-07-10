'use client';

import { StatCard } from '@/components/ui';
import { Board } from '@/features/board/Board';
import { useFinOpsOverview, useCarbonSummary, useRefreshCost } from '@/lib/hooks';
import { useTabParam } from '@/lib/useTabParam';
import { money, number } from '@/lib/format';
import type { BoardPanel } from '@/lib/types';

// Both tabs are customizable boards — every panel is a resizable widget (saved layout per tab).
const COST_SEED: BoardPanel[] = [
  { i: 'trend', kind: 'fin-trend', title: 'Spend Trend & Forecast', x: 0, y: 0, w: 6, h: 6 },
  { i: 'breakdowns', kind: 'fin-breakdowns', title: 'Cost Breakdowns', x: 6, y: 0, w: 6, h: 11 },
  { i: 'savings', kind: 'fin-savings', title: 'Savings & Anomalies', x: 0, y: 6, w: 6, h: 8 },
  { i: 'drivers', kind: 'fin-drivers', title: 'Top Cost Drivers', x: 0, y: 14, w: 12, h: 7 },
  { i: 'budgets', kind: 'fin-budgets', title: 'Budgets', x: 0, y: 21, w: 12, h: 5 },
];
const CARBON_SEED: BoardPanel[] = [
  { i: 'equiv', kind: 'carbon-equivalents', title: 'Real-world Equivalents', x: 0, y: 0, w: 12, h: 4 },
  { i: 'trend', kind: 'carbon-trend', title: 'Emissions Trend', x: 0, y: 4, w: 6, h: 5 },
  { i: 'breakdowns', kind: 'carbon-breakdowns', title: 'Emissions Breakdowns', x: 6, y: 4, w: 6, h: 8 },
  { i: 'grid', kind: 'carbon-grid', title: 'Grid Intensity & Clean Energy', x: 0, y: 9, w: 6, h: 9 },
  { i: 'rec', kind: 'carbon-recommendations', title: 'Decarbonisation Opportunities', x: 6, y: 12, w: 6, h: 7 },
];

export function FinOpsView() {
  const [tab, setTab] = useTabParam<'cost' | 'carbon'>('fintab', 'cost', ['cost', 'carbon']);
  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-lg font-semibold text-white">FinOps &amp; Sustainability</h1>
        <p className="text-2xs text-muted">Cloud cost management and estimated carbon footprint. Every panel is a resizable widget — drag, resize, add/remove. Saved automatically.</p>
      </div>
      <div className="flex w-fit gap-1 rounded-lg border border-border bg-card p-1">
        {([['cost', '💰 Cost (FinOps)'], ['carbon', '🌱 Carbon (Green)']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-4 py-1.5 text-sm transition ${tab === k ? 'bg-brand text-white' : 'text-muted-light hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'cost' ? (
        <>
          <div className="flex items-center justify-end">
            <RefreshCostButton />
          </div>
          <CostKpis />
          <CloudBillingStatus />
          <Board key="finops-cost" boardKey="finops-cost" seed={COST_SEED} />
        </>
      ) : (
        <>
          <CarbonKpis />
          <Board key="finops-carbon" boardKey="finops-carbon" seed={CARBON_SEED} />
        </>
      )}
    </div>
  );
}

// Manual cost refresh — the noisy "cloud cost data" status banner was removed at the user's
// request; cost distribution now lives entirely in the widgets below (fin-breakdowns byProvider).
// Per-cloud cost setup guidance stays in Help → Cloud Setup, and the AWS connection Test now
// reports billing/Cost-Explorer state directly.
function RefreshCostButton() {
  const refresh = useRefreshCost();
  return (
    <button
      onClick={() => refresh.mutate()}
      disabled={refresh.isPending}
      title="Cost auto-refreshes every 6 hours; cloud billing itself lags (AWS ~24h, others daily). Setup steps are in Help → Cloud Setup."
      className="rounded-md border border-border bg-card px-3 py-1 text-2xs font-medium text-muted-light hover:text-white disabled:opacity-50"
    >
      {refresh.isPending ? 'Refreshing…' : '↻ Refresh cost'}
    </button>
  );
}

// Per-cloud billing status — makes it explicit whether each cloud's cost is flowing,
// genuinely $0 (free-tier / idle), or needs setup. Answers "why is X cost not coming?".
function CloudBillingStatus() {
  const { data } = useFinOpsOverview();
  const rows = data?.costStatus ?? [];
  if (!rows.length) return null;
  const STYLE: Record<string, { dot: string; label: string; cls: string }> = {
    ok: { dot: '#10b981', label: 'flowing', cls: 'border-emerald-600/30 bg-emerald-600/5' },
    zero: { dot: '#3b82f6', label: '$0 this period', cls: 'border-blue-600/30 bg-blue-600/5' },
    setup: { dot: '#f59e0b', label: 'needs setup', cls: 'border-amber-600/30 bg-amber-600/5' },
  };
  const PROV: Record<string, string> = { aws: 'AWS', azure: 'Azure', gcp: 'GCP' };
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {rows.map((c, i) => {
        const s = STYLE[c.state] ?? STYLE.setup!;
        return (
          <div key={i} className={`rounded-lg border p-3 ${s.cls}`}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium text-white">
                <span className="h-2 w-2 rounded-full" style={{ background: s.dot }} />
                {PROV[c.provider] ?? c.provider.toUpperCase()}
              </span>
              <span className="tabular-nums text-sm font-semibold text-white">
                {c.monthlyCost > 0 ? money(c.monthlyCost, c.currency, true) : `${c.currency} 0`}
                <span className="ml-1 text-2xs font-normal" style={{ color: s.dot }}>· {s.label}</span>
              </span>
            </div>
            {c.state !== 'ok' && c.note && <div className="mt-1 text-2xs leading-snug text-muted">{c.note}</div>}
            {c.refreshedAt && <div className="mt-1 text-[10px] text-muted">checked {new Date(c.refreshedAt).toLocaleString()}</div>}
          </div>
        );
      })}
    </div>
  );
}

function CostKpis() {
  const { data } = useFinOpsOverview();
  const cur = data?.currency ?? 'USD';
  // When the fleet genuinely bills in >1 currency, a single summed total is meaningless —
  // show per-currency subtotals instead of hiding mixed currencies under one label.
  const mixed = data?.currencyMixed && (data?.byCurrency?.length ?? 0) > 1;
  const spendSub = mixed
    ? `mixed currencies — ${data!.byCurrency!.map((b) => money(b.amount, b.currency, true)).join(' + ')}`
    : data?.realBilling ? 'live billing API' : 'estimated from inventory';
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Monthly Spend" value={mixed ? money(data!.byCurrency![0]!.amount, data!.byCurrency![0]!.currency, true) : money(data?.totalMonthly ?? 0, cur, true)} accent="#3b82f6" sub={spendSub} delta={!mixed && data ? { value: `${Math.abs(data.deltaVsPrevPct)}% MoM`, up: data.deltaVsPrevPct > 0 } : undefined} />
      <StatCard label="Annual Run-Rate" value={mixed ? '— mixed' : money(data?.annualRunRate ?? 0, cur, true)} accent="#8b5cf6" sub={`${number(data?.resourceCount ?? 0)} resources`} />
      <StatCard label="Potential Savings" value={money(data?.potentialSavings ?? 0, cur, true)} accent="#10b981" sub={`${data?.savings.length ?? 0} opportunities / mo`} />
      <StatCard label="Avg Cost / Resource" value={mixed ? '— mixed' : money(data?.unitCost ?? 0, cur, true)} accent="#f59e0b" sub="unit economics" />
    </div>
  );
}

function CarbonKpis() {
  const { data } = useCarbonSummary();
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="Monthly Emissions" value={`${number(data?.totalKgMonth ?? 0)} kg`} accent="#10b981" sub={`${data?.tonnesMonth ?? 0} tCO₂e / month`} />
      <StatCard label="Annualised" value={`${data?.tonnesYear ?? 0} t`} accent="#059669" sub="tCO₂e / year (run-rate)" />
      <StatCard label="Energy" value={`${number(data?.totalKWhMonth ?? 0)} kWh`} accent="#0ea5e9" sub={`${data?.annualMWh ?? 0} MWh / year`} />
      <StatCard label="Carbon Intensity" value={`${data?.weightedIntensity ?? 0}`} accent="#f59e0b" sub="gCO₂e / kWh (weighted)" />
    </div>
  );
}
