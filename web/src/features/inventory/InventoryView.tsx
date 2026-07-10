'use client';

import { useState } from 'react';
import { Card, ErrorState, LoadingState, ProgressBar, ProviderBadge, StatusBadge } from '@/components/ui';
import { useResourceTypes, useResources } from '@/lib/hooks';
import { PROVIDER_LABELS, currency, number, pct } from '@/lib/format';
import { ResourceDetail } from './ResourceDetail';
import { VmsTable } from '@/features/vms/VmsTable';

const PROVIDERS = [
  { key: 'all', label: 'All' },
  { key: 'aws', label: 'AWS' },
  { key: 'azure', label: 'Azure' },
  { key: 'gcp', label: 'GCP' },
  { key: 'private', label: 'Private' },
  { key: 'docker', label: 'Docker' },
  { key: 'linux', label: 'Linux' },
  { key: 'windows', label: 'Windows' },
];

const TYPE_ICONS: Record<string, string> = {
  compute: '🖥',
  storage: '💾',
  network: '🌐',
  database: '🗄',
  container: '📦',
  serverless: 'λ',
  security: '🛡',
  analytics: '📊',
};

export function InventoryView({ initialProvider = 'all' }: { initialProvider?: string }) {
  const [provider, setProvider] = useState(
    PROVIDERS.some((x) => x.key === initialProvider) ? initialProvider : 'all',
  );
  const [type, setType] = useState('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [view, setView] = useState<'resources' | 'vms'>('resources');
  const types = useResourceTypes();
  const resources = useResources({ provider, type, q });

  return (
    <>
    <div className="mb-4 flex items-center gap-1 rounded-lg border border-border bg-card p-0.5">
      {(['resources', 'vms'] as const).map((v) => (
        <button key={v} onClick={() => setView(v)} className={`rounded-md px-3 py-1.5 text-xs ${view === v ? 'bg-brand text-white' : 'text-muted-light hover:text-white'}`}>
          {v === 'resources' ? 'All Resources' : 'Virtual Machines'}
        </button>
      ))}
    </div>
    {view === 'vms' && <VmsTable />}
    {view === 'resources' && (
    <div className="grid grid-cols-12 gap-4">
      {/* Resource type sidebar */}
      <aside className="col-span-12 lg:col-span-3">
        <Card title="Resource Types" bodyClassName="p-2">
          <button
            onClick={() => setType('all')}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm ${
              type === 'all' ? 'bg-brand/15 text-white ring-1 ring-brand/30' : 'text-muted-light hover:bg-card-hover'
            }`}
          >
            <span className="flex items-center gap-2"><span>▦</span> All Resources</span>
            <span className="text-2xs text-muted">{number(types.data?.total ?? 0)}</span>
          </button>
          {types.data?.types.map((t) => (
            <button
              key={t.type}
              onClick={() => setType(t.type)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm capitalize ${
                type === t.type ? 'bg-brand/15 text-white ring-1 ring-brand/30' : 'text-muted-light hover:bg-card-hover'
              }`}
            >
              <span className="flex items-center gap-2">
                <span className="w-4 text-center text-xs">{TYPE_ICONS[t.type] ?? '•'}</span>
                {t.type}
              </span>
              <span className="text-2xs text-muted">{number(t.count)}</span>
            </button>
          ))}
        </Card>
      </aside>

      {/* Resource table */}
      <div className="col-span-12 lg:col-span-9">
        <Card
          title={
            <div className="flex items-center gap-1">
              {PROVIDERS.map((p) => (
                <button
                  key={p.key}
                  onClick={() => setProvider(p.key)}
                  className={`rounded-md px-2.5 py-1 text-xs ${
                    provider === p.key ? 'bg-brand text-white' : 'text-muted-light hover:bg-card-hover'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          }
          action={
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search resources…"
              className="w-48 rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-white placeholder:text-muted focus:border-brand focus:outline-none"
            />
          }
          bodyClassName="p-0"
        >
          {resources.isLoading ? (
            <div className="p-4"><LoadingState rows={6} /></div>
          ) : resources.isError ? (
            <div className="p-4"><ErrorState /></div>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex items-center justify-between border-b border-border px-4 py-2 text-2xs text-muted">
                <span>{number(resources.data?.length ?? 0)} resources</span>
                <span>{provider === 'all' ? 'All providers' : PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS]}</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-2xs uppercase tracking-wide text-muted">
                    <th className="px-4 py-2.5 font-medium">Resource</th>
                    <th className="px-4 py-2.5 font-medium">Provider</th>
                    <th className="px-4 py-2.5 font-medium">Region</th>
                    <th className="px-4 py-2.5 font-medium">CPU</th>
                    <th className="px-4 py-2.5 font-medium">Memory</th>
                    <th className="px-4 py-2.5 font-medium">Disk</th>
                    <th className="px-4 py-2.5 font-medium">Cost</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {resources.data?.slice(0, 80).map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedId(r.id)}
                      className="cursor-pointer border-b border-border-soft last:border-0 hover:bg-card-hover"
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-white">{r.name}</div>
                        <div className="text-2xs text-muted">{r.service} · <span className="capitalize">{r.type}</span></div>
                      </td>
                      <td className="px-4 py-2.5"><ProviderBadge provider={r.provider} /></td>
                      <td className="px-4 py-2.5 text-muted-light">{r.region}</td>
                      <td className="px-4 py-2.5">
                        <MetricCell value={r.cpuPct} />
                      </td>
                      <td className="px-4 py-2.5">
                        <MetricCell value={r.memoryPct} sub={r.memUsedMB != null ? formatSize(r.memUsedMB) : undefined} />
                      </td>
                      <td className="px-4 py-2.5">
                        <DiskCell diskPct={r.diskPct} diskUsedMB={r.diskUsedMB} />
                      </td>
                      <td className="px-4 py-2.5 font-medium text-white">{currency(r.monthlyCost)}</td>
                      <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
    )}
    {selectedId && <ResourceDetail id={selectedId} onClose={() => setSelectedId(null)} />}
    </>
  );
}

function MetricCell({ value, sub }: { value: number; sub?: string }) {
  const color = value > 85 ? '#ef4444' : value > 65 ? '#f59e0b' : '#22c55e';
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="w-14"><ProgressBar value={value} color={color} height={5} /></div>
        <span className="w-8 text-2xs text-muted-light">{pct(value)}</span>
      </div>
      {sub && <div className="mt-0.5 text-2xs text-muted">{sub}</div>}
    </div>
  );
}

/** Containers report disk as an absolute size (writable layer); VMs as a % (agent). */
function DiskCell({ diskPct, diskUsedMB }: { diskPct: number; diskUsedMB: number | null }) {
  if (diskUsedMB != null) return <span className="text-2xs font-medium text-white">{formatSize(diskUsedMB)}</span>;
  if (diskPct > 0) return <MetricCell value={diskPct} />;
  return <span className="text-2xs text-muted">—</span>;
}

function formatSize(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${Math.round(mb * 1024)} KB`;
}
