'use client';

import { useState, type ReactNode } from 'react';
import { Card, LoadingState, ProviderBadge } from '@/components/ui';
import { useAuthUser } from '@/lib/auth';
import { useNetworkOverview, useNetworkScan, useNetworkMonitoring, useRemediateRule } from '@/lib/hooks';
import { PROVIDER_COLORS, SEVERITY_COLORS, number } from '@/lib/format';

const ENV_COLORS: Record<string, string> = { production: '#ef4444', staging: '#f59e0b', development: '#3b82f6', test: '#a855f7', unknown: '#64748b' };

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

// ───────────────────────── Risky Firewall / NSG Rules ─────────────────────────
export function FirewallRisksPanel({ bare = false }: { bare?: boolean }) {
  const { data: me } = useAuthUser();
  const net = useNetworkOverview();
  const scan = useNetworkScan();
  const remediate = useRemediateRule();
  const canRemediate = me?.role !== 'viewer';
  const [filter, setFilter] = useState<'all' | 'critical-high' | 'public'>('all');
  const [msg, setMsg] = useState<string | null>(null);

  if (net.isLoading) return <LoadingState rows={3} />;
  const d = net.data;
  const risks = d?.risks ?? [];
  const isPublic = (r: (typeof risks)[number]) => /0\.0\.0\.0|::\/0|internet|\bany\b|\*|0-65535/i.test(`${r.source} ${r.detail}`);
  const shown = risks.filter((r) => (filter === 'all' ? true : filter === 'critical-high' ? (r.severity === 'critical' || r.severity === 'high') : isPublic(r)));
  const filterLabel = filter === 'critical-high' ? 'critical + high' : filter === 'public' ? 'publicly exposed' : '';

  const doRemediate = async (id: string) => {
    setMsg(null);
    try { setMsg((await remediate.mutateAsync(id)).detail); } catch (e) { setMsg((e as Error).message); }
  };

  const FilterChip = ({ id, label }: { id: typeof filter; label: string }) => (
    <button onClick={() => setFilter(id)} className={`rounded-md border px-2 py-0.5 text-2xs transition ${filter === id ? 'border-brand bg-brand/15 text-white' : 'border-border bg-card text-muted hover:text-white'}`}>{label}</button>
  );

  return (
    <Frame
      bare={bare}
      title={`Risky Firewall / NSG Rules (${shown.length}${filter !== 'all' ? ` of ${risks.length}` : ''})`}
      bodyClassName="p-0"
      action={
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip id="all" label="All" />
          <FilterChip id="critical-high" label="Critical+High" />
          <FilterChip id="public" label="Public" />
          {me?.role !== 'viewer' && <button onClick={() => scan.mutate()} disabled={scan.isPending} className="rounded-md bg-brand px-2.5 py-0.5 text-2xs font-medium text-white hover:bg-brand-soft disabled:opacity-50">{scan.isPending ? 'Scanning…' : 'Scan'}</button>}
        </div>
      }
    >
      {msg && <div className="border-b border-border bg-brand/10 px-4 py-2 text-2xs text-brand">{msg}</div>}
      {risks.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted">No risky rules. Click <b className="text-white">Scan</b> to fetch live NSG / security-group / firewall rules and flag public exposure on sensitive ports.</div>
      ) : shown.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted">No {filterLabel} rules. <button onClick={() => setFilter('all')} className="text-brand hover:underline">Show all</button></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Resource</th>
                <th className="px-4 py-2.5 font-medium">Provider</th>
                <th className="px-4 py-2.5 font-medium">Exposure</th>
                <th className="px-4 py-2.5 font-medium">Source</th>
                {canRemediate && <th className="px-4 py-2.5 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-border-soft last:border-0 hover:bg-card-hover">
                  <td className="px-4 py-2.5"><span className="rounded px-1.5 py-0.5 text-2xs font-medium capitalize" style={{ background: `${SEVERITY_COLORS[r.severity]}22`, color: SEVERITY_COLORS[r.severity] }}>{r.severity}</span></td>
                  <td className="px-4 py-2.5"><div className="text-white">{r.resourceName}</div><div className="text-2xs text-muted">{r.ruleName}</div></td>
                  <td className="px-4 py-2.5"><ProviderBadge provider={r.provider} /></td>
                  <td className="px-4 py-2.5 text-2xs text-muted-light">{r.detail}<div className="mt-0.5 text-2xs text-muted">Fix: in {r.provider.toUpperCase()} edit rule <span className="text-white">“{r.ruleName}”</span> — restrict source from <span className="font-mono text-danger">{r.source}</span> to your admin CIDR (or deny), then re-scan.{canRemediate ? ' Or click Remediate →' : ''}</div></td>
                  <td className="px-4 py-2.5 font-mono text-2xs text-danger">{r.source}</td>
                  {canRemediate && (
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => doRemediate(r.id)} disabled={remediate.isPending} className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-brand hover:text-white disabled:opacity-50" title="Deny / revoke / disable this rule (goes through approval)">Remediate</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Frame>
  );
}

// ───────────────────────── Public Exposure ─────────────────────────
export function PublicExposurePanel({ bare = false }: { bare?: boolean }) {
  const net = useNetworkOverview();
  const ex = net.data?.exposure ?? [];
  return (
    <Frame bare={bare} title={`Public Exposure (${ex.length})`} bodyClassName="p-0">
      {ex.length === 0 ? (
        <div className="px-4 py-8 text-center text-2xs text-success">No resources have a public IP. 🎉</div>
      ) : (
        <div className="max-h-80 divide-y divide-border-soft overflow-auto">
          {ex.map((e, i) => (
            <div key={i} className="flex items-center justify-between px-4 py-2.5">
              <div>
                <div className="text-2xs font-medium text-white">{e.name}</div>
                <div className="flex items-center gap-2 text-2xs text-muted">
                  <ProviderBadge provider={e.provider} />
                  <span className="rounded px-1 capitalize" style={{ color: ENV_COLORS[e.environment] }}>{e.environment}</span>
                  <span>· {e.region}</span>
                </div>
              </div>
              <span className="font-mono text-2xs text-warning">{e.publicIp}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

// ───────────────────────── Network Inventory ─────────────────────────
export function NetworkInventoryPanel({ bare = false }: { bare?: boolean }) {
  const net = useNetworkOverview();
  const inv = net.data?.inventory ?? [];
  return (
    <Frame bare={bare} title="Network Inventory" bodyClassName="p-0">
      <div className="max-h-80 divide-y divide-border-soft overflow-auto">
        {inv.map((k, i) => (
          <div key={i} className="flex items-center justify-between px-4 py-2">
            <span className="flex items-center gap-2 text-2xs text-muted-light"><ProviderBadge provider={k.provider} /> {k.kind}</span>
            <span className="text-2xs font-medium text-white">{number(k.count)}</span>
          </div>
        ))}
        {inv.length === 0 && <div className="px-4 py-6 text-center text-2xs text-muted">No network resources discovered.</div>}
      </div>
    </Frame>
  );
}

// ───────────────────────── Network Segments ─────────────────────────
export function NetworkSegmentsPanel({ bare = false }: { bare?: boolean }) {
  const net = useNetworkOverview();
  const segs = net.data?.segments ?? [];
  return (
    <Frame bare={bare} title="Network Segments" bodyClassName="p-0">
      <div className="grid grid-cols-2 gap-px bg-border-soft sm:grid-cols-3 lg:grid-cols-4">
        {segs.map((seg, i) => (
          <div key={i} className="bg-card px-4 py-3">
            <div className="flex items-center gap-2"><ProviderBadge provider={seg.provider} /><span className="truncate text-2xs font-medium text-white">{seg.group}</span></div>
            <div className="mt-1 text-lg font-semibold text-white">{number(seg.count)}</div>
            <div className="text-2xs text-muted">network resources</div>
          </div>
        ))}
        {segs.length === 0 && <div className="bg-card px-4 py-6 text-center text-2xs text-muted">No segments.</div>}
      </div>
    </Frame>
  );
}

// ───────────────────────── Link Latency & Health ─────────────────────────
export function LinkHealthPanel({ bare = false }: { bare?: boolean }) {
  const mon = useNetworkMonitoring();
  if (mon.isLoading) return <LoadingState rows={3} />;
  const lat = mon.data?.latencies ?? [];
  return (
    <Frame bare={bare} title="Link Latency & Health" bodyClassName="p-0">
      {lat.length === 0 ? (
        <div className="px-4 py-8 text-center text-2xs text-muted">No monitors yet. Add IP/host monitors on the Monitoring page.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
                <th className="px-4 py-2 font-medium">Link</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Latency</th>
                <th className="px-4 py-2 font-medium">Avg</th>
                <th className="px-4 py-2 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {lat.map((l) => (
                <tr key={l.id} className="border-b border-border-soft last:border-0 hover:bg-card-hover">
                  <td className="px-4 py-2"><div className="text-2xs text-white">{l.name}</div><div className="font-mono text-2xs text-muted">{l.target}</div></td>
                  <td className="px-4 py-2 text-2xs uppercase text-muted-light">{l.type}</td>
                  <td className="px-4 py-2"><span className="inline-flex items-center gap-1.5 text-2xs capitalize"><span className="h-2 w-2 rounded-full" style={{ background: l.status === 'up' ? '#22c55e' : l.status === 'down' ? '#ef4444' : '#64748b' }} />{l.status}</span></td>
                  <td className="px-4 py-2 text-2xs text-white">{l.lastLatencyMs != null ? `${l.lastLatencyMs} ms` : '—'}</td>
                  <td className="px-4 py-2 text-2xs text-muted-light">{l.avgLatencyMs != null ? `${l.avgLatencyMs} ms` : '—'}</td>
                  <td className="px-4 py-2"><LatencySpark history={l.history} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Frame>
  );
}

// ───────────────────────── Per-VM Network Throughput ─────────────────────────
export function NetworkThroughputPanel({ bare = false }: { bare?: boolean }) {
  const mon = useNetworkMonitoring();
  const tp = mon.data?.throughput ?? [];
  const maxMbps = Math.max(1, ...tp.map((t) => t.networkMbps));
  return (
    <Frame bare={bare} title="Per-VM Network Throughput" bodyClassName="p-0">
      {tp.length === 0 ? (
        <div className="px-4 py-8 text-center text-2xs text-muted">No compute instances with network metrics.</div>
      ) : (
        <div className="max-h-96 divide-y divide-border-soft overflow-auto">
          {tp.map((t, i) => (
            <div key={i} className="px-4 py-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="flex items-center gap-2 text-2xs text-white"><ProviderBadge provider={t.provider} /> {t.name}</span>
                <span className="text-2xs font-medium text-white">{t.networkMbps} Mbps</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-card">
                <div className="h-1.5 rounded-full" style={{ width: `${Math.max(2, (t.networkMbps / maxMbps) * 100)}%`, background: PROVIDER_COLORS[t.provider] }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

function LatencySpark({ history }: { history: { up: boolean; ms: number | null }[] }) {
  if (!history.length) return <span className="text-2xs text-muted">—</span>;
  const vals = history.map((h) => h.ms ?? 0);
  const max = Math.max(1, ...vals);
  return (
    <div className="flex h-6 items-end gap-0.5">
      {history.map((h, i) => (
        <div key={i} className="w-1 rounded-sm" style={{ height: `${Math.max(10, ((h.ms ?? 0) / max) * 100)}%`, background: h.up ? '#22c55e' : '#ef4444' }} title={h.ms != null ? `${h.ms} ms` : 'down'} />
      ))}
    </div>
  );
}
