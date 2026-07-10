'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useOsInventory } from '@/lib/hooks';
import { CategoryPie, CategoryBar } from '@/components/charts';
import type { OsHost } from '@/lib/types';

const FAMILY_ICON: Record<string, string> = { windows: '🪟', linux: '🐧', macos: '🍎', bsd: '😈', other: '🖥', unknown: '❔' };

type FlatHost = OsHost & { family: string; familyLabel: string; version: string; support?: string };

/** OS Inventory console — dashboard (KPIs + charts) + sortable VM grid + per-host drill-down. */
export function OsInventoryWidget() {
  const { data, isLoading } = useOsInventory();
  const [view, setView] = useState<'dashboard' | 'grid'>('dashboard');
  const [q, setQ] = useState('');
  const [famFilter, setFamFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'up' | 'down' | 'eol' | 'noagent' | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: keyof FlatHost | 'ip' | 'agent' | 'ports'; dir: 1 | -1 }>({ key: 'name', dir: 1 });

  const families = data?.families ?? [];
  const hosts: FlatHost[] = useMemo(
    () => families.flatMap((f) => f.versions.flatMap((v) => v.hosts.map((h) => ({ ...h, family: f.family, familyLabel: f.label, version: v.version, support: v.support })))),
    [families],
  );

  if (isLoading) return <div className="p-4 text-2xs text-muted">Loading OS inventory…</div>;
  if (!hosts.length) return <div className="p-4 text-2xs text-muted">No VMs discovered yet. Connect a cloud (Settings → Connections) or deploy a guest agent.</div>;

  const selHost = hosts.find((h) => h.id === sel);
  if (selHost) return <HostDetail host={selHost} onBack={() => setSel(null)} />;

  // KPIs
  const total = hosts.length;
  const online = hosts.filter((h) => h.up).length;
  const eol = hosts.filter((h) => h.support === 'eol').length;
  const noAgent = hosts.filter((h) => !h.hasAgent).length;
  const naVer = hosts.filter((h) => /n\/a/i.test(h.version)).length;

  // chart data
  const famDist = families.map((f) => ({ label: f.label, value: f.total }));
  const verDist = families.flatMap((f) => f.versions.map((v) => ({ label: v.version.replace(' (version n/a)', ' (n/a)').replace(' (distro n/a)', ' (n/a)'), value: v.total }))).sort((a, b) => b.value - a.value).slice(0, 8);
  const provMap = new Map<string, number>();
  for (const h of hosts) { const p = (h.provider || 'on-prem').toUpperCase(); provMap.set(p, (provMap.get(p) || 0) + 1); }
  const provDist = [...provMap.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);

  // grid filter + sort
  const filtered = hosts.filter((h) => {
    if (famFilter && h.family !== famFilter) return false;
    if (statusFilter === 'up' && !h.up) return false;
    if (statusFilter === 'down' && h.up) return false;
    if (statusFilter === 'eol' && h.support !== 'eol') return false;
    if (statusFilter === 'noagent' && h.hasAgent) return false;
    if (q && !`${h.name} ${h.version} ${h.provider ?? ''} ${(h.ips || []).join(' ')}`.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });
  const sortVal = (h: FlatHost): string | number => {
    switch (sort.key) {
      case 'ip': return h.ips[0] ?? '';
      case 'agent': return h.hasAgent ? 1 : 0;
      case 'ports': return h.ports.length;
      case 'up': return h.up ? 1 : 0;
      default: return (h[sort.key as keyof FlatHost] as any) ?? '';
    }
  };
  const sorted = [...filtered].sort((a, b) => { const x = sortVal(a), y = sortVal(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  const setSortKey = (k: typeof sort.key) => setSort((s) => ({ key: k, dir: s.key === k ? (s.dir === 1 ? -1 : 1) : 1 }));

  const tab = (on: boolean) => `rounded-md px-2.5 py-1 text-2xs font-medium transition ${on ? 'bg-brand text-white' : 'text-muted hover:text-white'}`;
  const activeFilter = famFilter || statusFilter;

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="inline-flex rounded-lg border border-border bg-bg p-0.5">
          <button onClick={() => setView('dashboard')} className={tab(view === 'dashboard')}>📊 Dashboard</button>
          <button onClick={() => setView('grid')} className={tab(view === 'grid')}>▦ Inventory</button>
        </div>
        <div className="flex items-center gap-2">
          {activeFilter && <button onClick={() => { setFamFilter(null); setStatusFilter(null); }} className="rounded-md border border-brand/40 bg-brand/10 px-2 py-1 text-2xs text-brand">clear filter ✕</button>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search VMs…" className="w-40 rounded-lg border border-border bg-bg px-2.5 py-1 text-2xs text-white placeholder:text-muted focus:border-brand focus:outline-none" />
        </div>
      </div>

      {/* KPI strip (clickable filters) */}
      <div className="grid grid-cols-3 gap-px border-b border-border bg-border sm:grid-cols-6">
        <Kpi label="Total VMs" value={total} onClick={() => { setFamFilter(null); setStatusFilter(null); setView('grid'); }} active={!activeFilter} />
        <Kpi label="Online" value={online} tone="success" onClick={() => { setStatusFilter('up'); setFamFilter(null); setView('grid'); }} active={statusFilter === 'up'} />
        <Kpi label="Offline" value={total - online} tone="danger" onClick={() => { setStatusFilter('down'); setFamFilter(null); setView('grid'); }} active={statusFilter === 'down'} />
        <Kpi label="EOL" value={eol} tone="danger" onClick={() => { setStatusFilter('eol'); setFamFilter(null); setView('grid'); }} active={statusFilter === 'eol'} />
        <Kpi label="No agent" value={noAgent} tone="warning" onClick={() => { setStatusFilter('noagent'); setFamFilter(null); setView('grid'); }} active={statusFilter === 'noagent'} />
        <Kpi label="With agent" value={total - noAgent} tone="brand" onClick={() => { setStatusFilter('noagent'); setFamFilter(null); setView('grid'); }} active={false} />
      </div>

      <div className="flex-1 overflow-auto p-3">
        {view === 'dashboard' ? (
          <div className="space-y-3">
            <div className="grid gap-3 lg:grid-cols-3">
              <Panel title="OS distribution">
                <CategoryPie data={famDist} height={170} donut />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {families.map((f) => (
                    <button key={f.family} onClick={() => { setFamFilter(f.family); setStatusFilter(null); setView('grid'); }} className="rounded-md border border-border bg-bg px-1.5 py-0.5 text-2xs text-muted-light hover:border-brand/40 hover:text-white">
                      {FAMILY_ICON[f.family] ?? '🖥'} {f.label} {f.total}
                    </button>
                  ))}
                </div>
              </Panel>
              <Panel title="Top OS versions"><CategoryBar data={verDist} height={210} /></Panel>
              <Panel title="VMs by provider"><CategoryBar data={provDist} height={210} /></Panel>
            </div>
            <Panel title="Attention">
              <div className="grid gap-2 sm:grid-cols-3 text-2xs">
                <Attn n={eol} label="End-of-life OS" tone="danger" hint="Unsupported — plan upgrades." onClick={() => { setStatusFilter('eol'); setView('grid'); }} />
                <Attn n={noAgent} label="No guest agent" tone="warning" hint="No ports/connections/apps visibility." onClick={() => { setStatusFilter('noagent'); setView('grid'); }} />
                <Attn n={naVer} label="Version unknown" tone="muted" hint="Cloud APIs report only the OS family — install the agent (or it's a non-agent cloud VM) for the exact build." onClick={() => { setStatusFilter('noagent'); setView('grid'); }} />
              </div>
            </Panel>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-2xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  {([['name', 'Host'], ['familyLabel', 'OS'], ['version', 'Version'], ['provider', 'Provider'], ['up', 'Status'], ['ip', 'IP'], ['agent', 'Agent'], ['ports', 'Ports']] as [typeof sort.key, string][]).map(([k, lbl]) => (
                    <th key={k} onClick={() => setSortKey(k)} className="cursor-pointer select-none py-1.5 pr-3 font-medium hover:text-white">{lbl}{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((h) => (
                  <tr key={h.id} onClick={() => setSel(h.id)} className="cursor-pointer border-b border-border-soft hover:bg-card-hover">
                    <td className="py-1.5 pr-3"><span className="flex items-center gap-1.5"><span className={`h-1.5 w-1.5 rounded-full ${h.up ? 'bg-success' : 'bg-danger'}`} /><span className="text-white">{h.name}</span></span></td>
                    <td className="py-1.5 pr-3 text-muted-light">{FAMILY_ICON[h.family] ?? ''} {h.familyLabel}</td>
                    <td className="py-1.5 pr-3"><span className="text-muted-light">{h.version}</span>{h.support === 'eol' && <span className="ml-1 rounded bg-danger/15 px-1 text-2xs text-danger">EOL</span>}</td>
                    <td className="py-1.5 pr-3 uppercase text-muted">{h.provider ?? '—'}</td>
                    <td className="py-1.5 pr-3"><span className={h.up ? 'text-success' : 'text-danger'}>{h.status ?? (h.up ? 'up' : 'down')}</span></td>
                    <td className="py-1.5 pr-3 font-mono text-muted">{h.ips[0] ?? '—'}</td>
                    <td className="py-1.5 pr-3">{h.hasAgent ? <span className="text-success">✓</span> : <span className="text-muted">—</span>}</td>
                    <td className="py-1.5 pr-3 text-muted">{h.hasAgent ? `${h.ports.length} / ${h.connections.length}c` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!sorted.length && <div className="py-6 text-center text-2xs text-muted">No VMs match the filter.</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, tone = 'default', onClick, active }: { label: string; value: number; tone?: 'default' | 'success' | 'danger' | 'warning' | 'brand'; onClick: () => void; active: boolean }) {
  const color = { default: 'text-white', success: 'text-success', danger: 'text-danger', warning: 'text-warning', brand: 'text-brand' }[tone];
  return (
    <button onClick={onClick} className={`flex flex-col items-start bg-panel px-3 py-2 text-left transition hover:bg-card ${active ? 'ring-1 ring-inset ring-brand' : ''}`}>
      <span className={`text-lg font-semibold leading-none ${color}`}>{value}</span>
      <span className="mt-0.5 text-2xs uppercase tracking-wide text-muted">{label}</span>
    </button>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card/60 p-3">
      <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}

function Attn({ n, label, tone, hint, onClick }: { n: number; label: string; tone: 'danger' | 'warning' | 'muted'; hint: string; onClick: () => void }) {
  const color = { danger: 'text-danger', warning: 'text-warning', muted: 'text-muted-light' }[tone];
  return (
    <button onClick={onClick} className="rounded-lg border border-border bg-bg p-2.5 text-left transition hover:border-brand/40">
      <div className={`text-lg font-semibold leading-none ${color}`}>{n}</div>
      <div className="mt-0.5 font-medium text-white">{label}</div>
      <div className="mt-0.5 text-muted">{hint}</div>
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (<div className="mb-3"><div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted">{title}</div>{children}</div>);
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded border border-dashed border-border px-2 py-1.5 text-2xs text-muted">{children}</div>;
}

function HostDetail({ host, onBack }: { host: FlatHost; onBack: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button onClick={onBack} className="flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 text-2xs text-muted-light transition hover:border-brand/40 hover:text-white">← Back</button>
        <span className={`h-2.5 w-2.5 rounded-full ${host.up ? 'bg-success' : 'bg-danger'}`} />
        <span className="truncate text-sm font-semibold text-white">{host.name}</span>
        {host.provider && <span className="rounded bg-bg px-1.5 py-0.5 text-2xs uppercase text-muted">{host.provider}</span>}
        {host.support === 'eol' && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-2xs text-danger">EOL</span>}
      </div>
      <div className="flex-1 overflow-auto p-3">
        <div className="mb-3 grid grid-cols-2 gap-2 text-2xs sm:grid-cols-4">
          <Meta label="OS" value={`${host.familyLabel} · ${host.version}`} />
          <Meta label="Status" value={host.status ?? (host.up ? 'running' : 'down')} />
          <Meta label="IP" value={host.ips.join(', ') || '—'} mono />
          <Meta label="Guest agent" value={host.hasAgent ? 'installed' : 'not installed'} />
        </div>

        {!host.hasAgent && (
          <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-2xs text-warning">
            No guest agent on this VM — install it (Help → Guest Agent) to see the exact OS version, open ports, active connections and installed apps.
          </div>
        )}

        <Section title={`Open ports (${host.ports.length})`}>
          {host.ports.length
            ? <div className="flex flex-wrap gap-1">{host.ports.map((p, i) => <span key={i} className="rounded bg-bg px-1.5 py-0.5 font-mono text-2xs text-brand">{p.port}{p.proc ? ` ${p.proc}` : ''}</span>)}</div>
            : <Empty>No listening ports reported.</Empty>}
        </Section>

        <Section title={`Active connections → remote IP (${host.connections.length})`}>
          {host.connections.length
            ? <div className="space-y-1">{host.connections.map((c, i) => (
                <div key={i} className="flex items-center gap-2 rounded bg-bg px-2 py-1 font-mono text-2xs">
                  <span className="text-muted-light">:{c.lport}</span><span className="text-muted">→</span>
                  <span className="truncate text-white">{c.raddr}:{c.rport}</span>{c.proc && <span className="ml-auto truncate text-muted">{c.proc}</span>}
                </div>
              ))}</div>
            : <Empty>No active connections reported.</Empty>}
        </Section>

        <Section title={`Applications (${host.apps.length})${host.appsSource === 'running' ? ' · running' : ' · installed'}`}>
          {host.apps.length
            ? <div className="flex flex-wrap gap-1">{host.apps.map((a, i) => <span key={i} className="rounded bg-bg px-1.5 py-0.5 text-2xs text-muted-light">{a}</span>)}</div>
            : <Empty>No applications reported.</Empty>}
        </Section>
      </div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-bg px-2 py-1.5">
      <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div className={`truncate text-white ${mono ? 'font-mono' : ''}`} title={value}>{value}</div>
    </div>
  );
}
