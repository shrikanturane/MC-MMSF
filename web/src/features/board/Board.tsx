'use client';

import { Component, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { Modal } from '@/components/ui';
import { useBoardLayout, useSaveBoardLayout } from '@/lib/hooks';
import type { BoardPanel } from '@/lib/types';
import { useAuthUser } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { accessAllows, widgetAllowedInModule } from '@/lib/modules';
import { WidgetContent, WIDGET_CATALOG, TREND_METRIC_OPTIONS, chartOptions, defaultSize } from './widgets';

const Grid = WidthProvider(Responsive);

// One failing widget must never white-screen the whole board.
class WidgetBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[widget crash]', this.props.name, error); }
  render() {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-start gap-1 overflow-auto p-1 text-2xs text-danger">
          <span className="font-semibold">Widget error · {this.props.name}</span>
          <span className="text-muted-light">{this.state.error.message}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function Board({ boardKey, seed = [] }: { boardKey: string; seed?: BoardPanel[] }) {
  const layout = useBoardLayout(boardKey);
  const save = useSaveBoardLayout(boardKey);
  const [panels, setPanels] = useState<BoardPanel[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Current RGL breakpoint. The saved layout is ALWAYS the desktop (lg) layout; on mobile (sm) the grid
  // auto-stacks it read-only so a phone rearrange can't overwrite (and then bleed into) the desktop layout.
  const [bp, setBp] = useState<string>('lg');
  const isMobile = bp === 'sm';

  // Load ONCE from the server; thereafter the board owns local state (avoids
  // any save→refetch→reset re-render loop while dragging/resizing).
  useEffect(() => {
    if (loaded || !layout.data) return;
    const p = layout.data.panels ?? [];
    setPanels(p.length ? (p as BoardPanel[]) : seed);
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.data, loaded]);

  const persist = (next: BoardPanel[]) => {
    setPanels(next);
    save.mutate(next);
  };

  const onLayoutChange = (l: Layout[]) => {
    if (isMobile) return; // never let a mobile (auto-stacked) layout overwrite the saved desktop layout
    const map = new Map(l.map((x) => [x.i, x]));
    const next = panels.map((p) => {
      const g = map.get(p.i);
      return g ? { ...p, x: g.x, y: g.y, w: g.w, h: g.h } : p;
    });
    persist(next);
  };

  const remove = (i: string) => persist(panels.filter((p) => p.i !== i));
  const add = (panel: BoardPanel) => { persist([...panels, panel]); setShowAdd(false); };
  const updatePanel = (i: string, patch: Partial<BoardPanel>) => persist(panels.map((p) => (p.i === i ? { ...p, ...patch } : p)));

  const rglLayout = useMemo(() => panels.map((p) => ({ i: p.i, x: p.x, y: p.y, w: p.w, h: p.h, minW: 2, minH: 3 })), [panels]);
  // The board's "module" for per-module widget gating (all monitoring tabs / custom pages share one).
  const module = boardKey.startsWith('monitoring') ? 'monitoring' : boardKey.startsWith('custom') ? 'custom' : boardKey;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-2xs text-muted">{isMobile ? 'Mobile view — widgets stack automatically; arrange them on a desktop browser' : 'Drag the header to move · drag the corner to resize · auto-saved'}</div>
        <button onClick={() => setShowAdd(true)} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">+ Add Widget</button>
      </div>

      {loaded && panels.length === 0 ? (
        <div className="card card-pad py-12 text-center text-sm text-muted">Empty board — click <b className="text-white">+ Add Widget</b> to start.</div>
      ) : (
        <Grid
          className="layout"
          // Only the desktop (lg/md) layout is stored; the sm layout is DERIVED by RGL (not passed), so on a
          // phone every widget stacks full-width without ever mutating the saved desktop coordinates.
          layouts={{ lg: rglLayout, md: rglLayout }}
          breakpoints={{ lg: 1200, md: 900, sm: 0 }}
          cols={{ lg: 12, md: 12, sm: 1 }}
          rowHeight={34}
          margin={[14, 14]}
          draggableHandle=".drag-handle"
          draggableCancel=".widget-action"
          onBreakpointChange={(b) => setBp(b)}
          onDragStop={onLayoutChange}
          onResizeStop={onLayoutChange}
          isDraggable={!isMobile}
          isResizable={!isMobile}
          resizeHandles={['se', 'e', 's', 'sw']}
          isBounded
        >
          {panels.map((p) => {
            const charts = chartOptions(p.kind);
            return (
              <div key={p.i} className="flex flex-col overflow-hidden rounded-xl border border-border bg-card/80">
                <div className="drag-handle flex cursor-move items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                  {/* widget-action = excluded from the drag handle, so the title is selectable/copyable
                      (cursor-text + select-text) instead of starting a drag on mousedown. */}
                  <span className="widget-action max-w-full cursor-text select-text truncate text-2xs font-semibold text-slate-200" title="Select to copy">{p.title ?? WIDGET_CATALOG.find((w) => w.kind === p.kind)?.label ?? p.kind}</span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {charts && (
                      <select
                        value={p.cfg?.chart ?? charts[0]}
                        onChange={(e) => updatePanel(p.i, { cfg: { ...p.cfg, chart: e.target.value } })}
                        className="widget-action cursor-pointer rounded border border-border bg-card px-1 py-0.5 text-2xs text-muted-light focus:outline-none"
                        title="Change chart"
                      >
                        {charts.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                    <button onClick={() => remove(p.i)} className="widget-action text-2xs text-muted hover:text-danger" title="Remove">✕</button>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-3">
                  <WidgetBoundary name={p.title ?? p.kind}>
                    <WidgetContent panel={p} onConfig={(patch) => updatePanel(p.i, patch)} />
                  </WidgetBoundary>
                </div>
              </div>
            );
          })}
        </Grid>
      )}

      {showAdd && <AddWidgetModal onClose={() => setShowAdd(false)} onAdd={add} existing={panels} module={module} />}
    </div>
  );
}

function AddWidgetModal({ onClose, onAdd, existing, module }: { onClose: () => void; onAdd: (p: BoardPanel) => void; existing: BoardPanel[]; module: string }) {
  const { data: me } = useAuthUser();
  const { layout } = useBranding();
  // Widget is offered when the role may see it AND it's allowed in this module (Settings → Workspace).
  const catalog = WIDGET_CATALOG.filter((w) => accessAllows(me?.access, 'widgets', w.kind, me?.role) && widgetAllowedInModule(layout.widgetModules?.[w.kind], module));
  const [kind, setKind] = useState(catalog[0]?.kind ?? WIDGET_CATALOG[0].kind);
  const [metric, setMetric] = useState('cpu');
  const [q, setQ] = useState('');
  const spec = catalog.find((w) => w.kind === kind) ?? WIDGET_CATALOG.find((w) => w.kind === kind)!;
  const filtered = catalog.filter((w) => `${w.label} ${w.desc} ${w.kind}`.toLowerCase().includes(q.trim().toLowerCase()));
  const maxY = existing.reduce((m, p) => Math.max(m, p.y + p.h), 0);

  const submit = () => {
    const size = defaultSize(kind);
    const metricLabel = TREND_METRIC_OPTIONS.find(([v]) => v === metric)?.[1] ?? metric;
    onAdd({
      i: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
      kind,
      title: kind === 'trend' ? `${metricLabel} Trend` : spec.label,
      cfg: kind === 'trend' ? { metric } : {},
      x: 0,
      y: maxY,
      w: size.w,
      h: size.h,
    });
  };

  return (
    <Modal title="Add Widget" subtitle="Search a widget, click to select, then Add — drag & resize it on the board" onClose={onClose}>
      <div className="space-y-3">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search widgets…" className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        <div className="max-h-64 space-y-1 overflow-auto rounded-lg border border-border p-1">
          {filtered.length === 0 ? (
            <div className="px-2 py-6 text-center text-2xs text-muted">No widgets match “{q}”.</div>
          ) : (
            filtered.map((w) => (
              <button key={w.kind} onClick={() => setKind(w.kind)} className={`flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left transition ${kind === w.kind ? 'bg-brand/15 ring-1 ring-brand/40' : 'hover:bg-card-hover'}`}>
                <span className="text-xs font-medium text-white">{w.label}</span>
                <span className="text-2xs text-muted">{w.desc}</span>
              </button>
            ))
          )}
        </div>
        {kind === 'trend' && (
          <label className="block">
            <span className="mb-1.5 block text-2xs font-medium uppercase tracking-wide text-muted">Metric (telemetry)</span>
            <select value={metric} onChange={(e) => setMetric(e.target.value)} className="w-full rounded-lg border border-border bg-bg px-2 py-2 text-sm text-white focus:border-brand focus:outline-none">
              {TREND_METRIC_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-2xs text-muted">Selected: <b className="text-white">{spec.label}</b></span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-light hover:text-white">Cancel</button>
            <button onClick={submit} className="rounded-lg bg-brand px-4 py-1.5 text-xs font-medium text-white hover:bg-brand-soft">Add</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
