'use client';

import { type ReactNode } from 'react';
import { Card, LoadingState, ErrorState } from '@/components/ui';
import { useSiemStream, useAuditTrail } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';

const LEVEL_COLORS: Record<string, string> = { info: '#3b82f6', warning: '#f59e0b', error: '#ef4444', critical: '#ef4444' };

function Frame({ bare, title, action, children }: { bare?: boolean; title: string; action?: ReactNode; children: ReactNode }) {
  if (bare) {
    return (
      <div className="flex h-full flex-col">
        {action && <div className="mb-2 flex flex-wrap items-center justify-end gap-2">{action}</div>}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    );
  }
  return <Card title={title} action={action} bodyClassName="p-0">{children}</Card>;
}

/** SIEM event stream (display widget). Full drill-down lives on the Activity console. */
export function SiemStreamPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading, isError } = useSiemStream();
  const events = data ?? [];
  return (
    <Frame bare={bare} title="SIEM Event Stream" action={<span className="text-2xs text-muted">{events.length} events</span>}>
      {isLoading ? (
        <div className="p-4"><LoadingState rows={6} /></div>
      ) : isError ? (
        <div className="p-4"><ErrorState /></div>
      ) : events.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No SIEM events yet — agents and monitors feed this stream.</div>
      ) : (
        <div className="divide-y divide-border-soft font-mono">
          {events.map((e) => (
            <div key={e.id} className="flex items-start gap-2 px-4 py-2 text-2xs">
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL_COLORS[e.level] ?? '#64748b' }} />
              <span className="shrink-0 text-muted" title={new Date(e.ts).toLocaleString()}>{timeAgo(e.ts)}</span>
              <span className="shrink-0 uppercase text-muted-light">{e.category}</span>
              {e.host && <span className="shrink-0 text-brand">{e.host}</span>}
              <span className="min-w-0 flex-1 break-words text-white">{e.message}</span>
              <span className="shrink-0 text-muted">{e.source}</span>
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}

/** Security audit trail (display widget). Full drill-down lives on the Activity console. */
export function AuditTrailPanel({ bare = false }: { bare?: boolean }) {
  const { data, isLoading, isError } = useAuditTrail();
  const rows = data ?? [];
  return (
    <Frame bare={bare} title="Security Audit Trail" action={<span className="text-2xs text-muted">{rows.length} entries</span>}>
      {isLoading ? (
        <div className="p-4"><LoadingState rows={6} /></div>
      ) : isError ? (
        <div className="p-4"><ErrorState /></div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted">No audit entries yet.</div>
      ) : (
        <div className="divide-y divide-border-soft">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-2 text-2xs">
              <span className="shrink-0 text-muted" title={new Date(r.ts).toLocaleString()}>{timeAgo(r.ts)}</span>
              <span className="shrink-0 rounded bg-border/40 px-1.5 text-muted-light">{r.action}</span>
              <span className="min-w-0 flex-1 text-white">{r.actorEmail || '—'}{r.targetEmail ? ` → ${r.targetEmail}` : ''}{r.detail ? ` · ${r.detail}` : ''}</span>
              {r.ip && <span className="shrink-0 text-muted">{r.ip}</span>}
            </div>
          ))}
        </div>
      )}
    </Frame>
  );
}
