'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAlerts } from '@/lib/hooks';
import { timeAgo } from '@/lib/format';
import type { AlertItem } from '@/lib/types';

type Pop = { id: string; title: string; resource: string | null; at: string };

/** A down/offline event — VM powered off, firewall/router/switch/host unreachable, or agent offline. */
const isDown = (a: AlertItem) =>
  a.status !== 'resolved' &&
  (a.metric === 'reachability' || /^(monitor|event):/.test(a.source || '')) &&
  /\b(down|unreachable|offline|powered off)\b/i.test(a.title);

/**
 * App-wide watcher: polls active alerts and raises a red "DOWN" popup the moment a resource goes
 * down (VM / firewall / switch / router). Primes silently on first load so historical alerts don't
 * all pop at once; only newly-raised down alerts trigger a toast.
 */
export function DownAlertWatcher() {
  const { data } = useAlerts('active');
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const [pops, setPops] = useState<Pop[]>([]);

  useEffect(() => {
    if (!data) return;
    const down = data.filter(isDown);
    // On first load, surface only very-recent downs (last 60s); mark the rest as already-seen so we
    // don't pop a wall of history. After that, any newly-raised down alert pops.
    const fresh = primed.current
      ? down.filter((a) => !seen.current.has(a.id))
      : down.filter((a) => Date.now() - new Date(a.raisedAt).getTime() < 60_000);
    if (!primed.current) { down.forEach((a) => seen.current.add(a.id)); primed.current = true; }
    if (!fresh.length) return;
    fresh.forEach((a) => {
      seen.current.add(a.id);
      setTimeout(() => setPops((p) => p.filter((x) => x.id !== a.id)), 20_000); // auto-dismiss
    });
    setPops((p) => [...fresh.map((a) => ({ id: a.id, title: a.title, resource: a.resourceName, at: a.raisedAt })), ...p].slice(0, 5));
  }, [data]);

  const dismiss = (id: string) => setPops((p) => p.filter((x) => x.id !== id));
  if (!pops.length) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[300] flex w-80 flex-col gap-2">
      {pops.map((p) => (
        <div key={p.id} className="relative overflow-hidden rounded-xl border border-red-500/40 bg-[#1b0f0f] shadow-2xl shadow-red-900/40">
          <div className="absolute inset-x-0 top-0 h-1 bg-red-500" />
          <div className="flex items-start gap-3 p-3.5">
            <span className="relative mt-1 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold tracking-wide text-red-400">● DOWN</div>
              <div className="mt-0.5 break-words text-xs text-white">{p.title}</div>
              {p.resource && <div className="truncate text-2xs text-red-200/70">{p.resource}</div>}
              <div className="mt-1.5 flex items-center gap-3 text-2xs text-muted">
                <span>{timeAgo(p.at)}</span>
                <Link href="/activity" onClick={() => dismiss(p.id)} className="font-medium text-red-300 hover:underline">View in Activity →</Link>
              </div>
            </div>
            <button onClick={() => dismiss(p.id)} title="Dismiss" className="shrink-0 rounded p-0.5 text-muted hover:text-white">✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}
