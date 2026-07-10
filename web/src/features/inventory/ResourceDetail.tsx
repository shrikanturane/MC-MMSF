'use client';

import { AreaTrend } from '@/components/charts';
import { ProviderBadge, StatusBadge } from '@/components/ui';
import { useResourceDetail } from '@/lib/hooks';
import { currency, pct } from '@/lib/format';
import type { TimePoint } from '@/lib/types';

export function ResourceDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, isLoading, isError } = useResourceDetail(id);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <aside className="relative h-full w-full max-w-xl overflow-y-auto border-l border-border bg-panel shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-panel/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-white">{data?.resource.name ?? 'Resource'}</div>
            <div className="truncate text-2xs text-muted">{data?.resource.externalId}</div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-light hover:text-white">
            ✕ Close
          </button>
        </header>

        <div className="space-y-4 p-5">
          {isLoading && <div className="h-40 animate-pulse rounded-xl bg-card/60" />}
          {isError && <div className="text-sm text-danger">Failed to load resource details.</div>}

          {data && (
            <>
              {/* Meta */}
              <div className="flex flex-wrap items-center gap-2">
                <ProviderBadge provider={data.resource.provider} />
                <StatusBadge status={data.resource.status} />
                <span className="pill bg-card text-muted-light">{data.resource.service}</span>
                <span className="pill bg-card text-muted-light">{data.resource.region}</span>
                <span className="pill bg-card text-muted-light capitalize">{data.resource.type}</span>
              </div>

              {/* Live health metrics */}
              {data.metrics.available ? (
                <div className="space-y-3">
                  <div className="text-2xs font-semibold uppercase tracking-wide text-muted">Live Health (Azure Monitor)</div>
                  <div className="grid grid-cols-2 gap-3">
                    <MetricTile
                      label="CPU"
                      value={data.metrics.latest?.cpuPct != null ? pct(data.metrics.latest.cpuPct) : '—'}
                      series={data.metrics.cpu}
                      color="#3b82f6"
                      unit="%"
                    />
                    <MetricTile
                      label="Network"
                      value={data.metrics.latest?.networkMbps != null ? `${data.metrics.latest.networkMbps} Mbps` : '—'}
                      series={data.metrics.networkMbps}
                      color="#a855f7"
                      unit=" Mbps"
                    />
                    <MetricTile
                      label="Disk I/O"
                      value={data.metrics.latest?.diskKBps != null ? `${data.metrics.latest.diskKBps} KB/s` : '—'}
                      series={data.metrics.diskKBps}
                      color="#f59e0b"
                      unit=" KB/s"
                    />
                    <MetricTile
                      label="Memory (available)"
                      value={data.metrics.latest?.memoryAvailGB != null ? `${data.metrics.latest.memoryAvailGB} GB` : 'agent needed'}
                      series={data.metrics.memoryAvailGB ?? undefined}
                      color="#22c55e"
                      unit=" GB"
                    />
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-border bg-card-hover/40 p-4 text-xs text-muted-light">
                  {data.metrics.note ?? 'No live metrics for this resource.'}
                </div>
              )}

              {data.metrics.note && data.metrics.available && (
                <div className="rounded-lg border border-warning/20 bg-warning/5 p-3 text-2xs text-muted-light">
                  ⓘ {data.metrics.note}
                </div>
              )}

              {/* Cost (when wired) */}
              <div className="grid grid-cols-2 gap-3">
                <div className="card card-pad">
                  <div className="text-2xs text-muted">Monthly Cost</div>
                  <div className="text-lg font-semibold text-white">
                    {data.resource.monthlyCost > 0 ? currency(data.resource.monthlyCost) : '— (cost phase)'}
                  </div>
                </div>
                <div className="card card-pad">
                  <div className="text-2xs text-muted">Source</div>
                  <div className="text-lg font-semibold capitalize text-white">{data.resource.source}</div>
                </div>
              </div>

              {/* Properties */}
              <div>
                <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted">Properties</div>
                <div className="card divide-y divide-border-soft">
                  {Object.entries(data.resource.properties ?? {}).map(([k, v]) => (
                    <div key={k} className="flex items-start justify-between gap-4 px-4 py-2 text-xs">
                      <span className="text-muted">{k}</span>
                      <span className="max-w-[60%] break-words text-right text-muted-light">{String(v)}</span>
                    </div>
                  ))}
                  {Object.keys(data.resource.properties ?? {}).length === 0 && (
                    <div className="px-4 py-3 text-xs text-muted">No properties.</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function MetricTile({
  label,
  value,
  series,
  color,
  unit,
}: {
  label: string;
  value: string;
  series?: TimePoint[];
  color: string;
  unit: string;
}) {
  return (
    <div className="card card-pad">
      <div className="flex items-center justify-between">
        <span className="text-2xs uppercase tracking-wide text-muted">{label}</span>
        <span className="text-sm font-semibold text-white">{value}</span>
      </div>
      <div className="mt-1">
        {series && series.length > 1 ? (
          <AreaTrend data={series} color={color} height={70} unit={unit} />
        ) : (
          <div className="flex h-[70px] items-center justify-center text-2xs text-muted">no series</div>
        )}
      </div>
    </div>
  );
}
