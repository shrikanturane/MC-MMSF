'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ProgressBar } from '@/components/ui';
import { money } from '@/lib/format';
import type { CostResourceRow } from '@/lib/types';

const PALETTE = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b', '#14b8a6', '#a855f7'];

/** Dimensions you can group/drill by. Order = the default drill path. */
const DIMENSIONS = [
  { key: 'provider', label: 'Provider' },
  { key: 'service', label: 'Service' },
  { key: 'environment', label: 'Environment' },
  { key: 'region', label: 'Region' },
  { key: 'type', label: 'Type' },
  { key: 'account', label: 'Account' },
] as const;
type DimKey = (typeof DIMENSIONS)[number]['key'];
const DIM_LABEL: Record<string, string> = Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.label]));

interface Filter {
  dim: DimKey;
  value: string;
}

/**
 * Interactive cost drill-down: group the resource set by any dimension, click a bar to
 * drill deeper (adds a filter + advances to the next dimension), and see the underlying
 * resources at every level. Breadcrumb chips pop back up. Fully client-side over the
 * per-resource cost rows from /finops/overview.
 */
export function CostDrillDown({
  resources,
  currency,
  compact = false,
}: {
  resources: CostResourceRow[];
  currency: string;
  compact?: boolean;
}) {
  const [path, setPath] = useState<Filter[]>([]);
  const [groupDim, setGroupDim] = useState<DimKey>('provider');
  const [showResources, setShowResources] = useState(false);

  const fmt = (n: number) => money(n, currency, true);

  // Resources matching the current drill path.
  const filtered = useMemo(
    () => resources.filter((r) => path.every((p) => String((r as any)[p.dim]) === p.value)),
    [resources, path],
  );

  const scopeTotal = useMemo(() => filtered.reduce((s, r) => s + r.cost, 0), [filtered]);

  // Group the filtered set by the current dimension.
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of filtered) {
      const k = String((r as any)[groupDim] || 'unknown');
      m.set(k, (m.get(k) ?? 0) + r.cost);
    }
    return [...m.entries()]
      .map(([key, value]) => ({ key, value: Math.round(value * 100) / 100, pct: scopeTotal > 0 ? Math.round((value / scopeTotal) * 1000) / 10 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [filtered, groupDim, scopeTotal]);

  // Dimensions already pinned in the path (can't drill into them again).
  const usedDims = useMemo(() => new Set(path.map((p) => p.dim)), [path]);
  const nextDim = DIMENSIONS.find((d) => d.key !== groupDim && !usedDims.has(d.key))?.key;

  const drill = (key: string) => {
    const nextPath = [...path, { dim: groupDim, value: key }];
    setPath(nextPath);
    if (nextDim) setGroupDim(nextDim);
    else setShowResources(true); // no dimensions left → reveal resources for this leaf
  };

  const popTo = (i: number) => {
    // i = -1 → back to root; else keep the first i+1 filters.
    const nextPath = i < 0 ? [] : path.slice(0, i + 1);
    setPath(nextPath);
    const used = new Set(nextPath.map((p) => p.dim));
    setGroupDim((DIMENSIONS.find((d) => !used.has(d.key))?.key ?? 'provider'));
    setShowResources(false);
  };

  const canDrill = !!nextDim || groups.length > 1;

  return (
    <div className="grid gap-2.5">
      {/* Breadcrumb + group-by control */}
      <div className="flex flex-wrap items-center gap-1.5 text-2xs">
        <button onClick={() => popTo(-1)} className={`rounded px-1.5 py-0.5 ${path.length ? 'text-brand hover:underline' : 'text-muted'}`}>All spend</button>
        {path.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted">›</span>
            <button onClick={() => popTo(i)} className="rounded bg-card px-1.5 py-0.5 text-muted-light hover:text-white" title={`Back to ${DIM_LABEL[p.dim]}`}>
              {DIM_LABEL[p.dim]}: <span className="font-medium text-white">{p.value}</span> ✕
            </button>
          </span>
        ))}
        <span className="flex-1" />
        <span className="text-muted">group by</span>
        <select
          value={groupDim}
          onChange={(e) => { setGroupDim(e.target.value as DimKey); setShowResources(false); }}
          className="rounded border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-light"
        >
          {DIMENSIONS.filter((d) => !usedDims.has(d.key)).map((d) => (
            <option key={d.key} value={d.key}>{d.label}</option>
          ))}
        </select>
      </div>

      {/* Scope total */}
      <div className="flex items-baseline justify-between border-b border-border/60 pb-1.5">
        <span className="text-2xs uppercase tracking-wide text-muted">{path.length ? 'Scope' : 'Total'} — {DIM_LABEL[groupDim]}</span>
        <span className="text-sm font-semibold tabular-nums text-white">{fmt(scopeTotal)} <span className="text-2xs font-normal text-muted">· {filtered.length} resource(s)</span></span>
      </div>

      {/* Grouped bars — click to drill */}
      {groups.length === 0 ? (
        <div className="text-2xs text-muted">No cost in this scope.</div>
      ) : (
        <div className="grid gap-2">
          {groups.slice(0, compact ? 6 : 20).map((g, i) => (
            <button
              key={g.key}
              onClick={() => canDrill && drill(g.key)}
              disabled={!canDrill}
              className={`group/bar text-left ${canDrill ? 'cursor-pointer' : 'cursor-default'}`}
              title={canDrill ? `Drill into ${DIM_LABEL[groupDim]}: ${g.key}` : g.key}
            >
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="truncate text-muted-light group-hover/bar:text-white" title={g.key}>
                  {g.key}{canDrill && <span className="ml-1 opacity-0 transition group-hover/bar:opacity-100">↘</span>}
                </span>
                <span className="tabular-nums font-medium text-white">{fmt(g.value)} <span className="text-2xs text-muted">· {g.pct}%</span></span>
              </div>
              <ProgressBar value={g.pct} color={PALETTE[i % PALETTE.length]} />
            </button>
          ))}
        </div>
      )}

      {/* Resource leaf — the actual resources behind the current scope */}
      <div className="border-t border-border/60 pt-1.5">
        <button onClick={() => setShowResources((v) => !v)} className="flex w-full items-center justify-between text-2xs text-muted hover:text-white">
          <span>{showResources ? '▾' : '▸'} Resources in scope ({filtered.length})</span>
          <span className="text-muted">click to {showResources ? 'hide' : 'view individual resources'}</span>
        </button>
        {showResources && (
          <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border/60">
            <table className="w-full text-left text-2xs">
              <thead className="sticky top-0 bg-panel text-muted">
                <tr>
                  <th className="px-2 py-1">Resource</th>
                  <th className="px-2 py-1">Provider</th>
                  <th className="px-2 py-1">Service</th>
                  <th className="px-2 py-1">Region</th>
                  <th className="px-2 py-1 text-right">Monthly</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 100).map((r, i) => (
                  <tr key={i} className="border-t border-border/40">
                    <td className="px-2 py-1 font-medium text-white">{r.name}</td>
                    <td className="px-2 py-1 uppercase text-muted-light">{r.provider}</td>
                    <td className="px-2 py-1 text-muted-light">{r.service}</td>
                    <td className="px-2 py-1 text-muted-light">{r.region}</td>
                    <td className="px-2 py-1 text-right tabular-nums font-semibold text-white">{money(r.cost, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 100 && <div className="px-2 py-1 text-center text-2xs text-muted">+{filtered.length - 100} more…</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Small helper: wrap the drill-down with an optional heading, for embedding in cards. */
export function CostDrillDownSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-2xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}
