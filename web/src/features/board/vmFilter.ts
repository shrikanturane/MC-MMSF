'use client';

import { useSyncExternalStore } from 'react';

// A tiny cross-widget store so one VM filter drives every Monitoring widget (KPIs, trends,
// services). Persisted to sessionStorage so it survives tab switches within the session.
const KEY = 'mcmf.vmFilter';
let vm = 'all';
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  const saved = window.sessionStorage.getItem(KEY);
  if (saved) vm = saved;
}

export function setVmFilter(next: string) {
  vm = next || 'all';
  if (typeof window !== 'undefined') window.sessionStorage.setItem(KEY, vm);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** [selectedVmId ('all' = fleet), setter] — shared across all widgets on the page. */
export function useVmFilter(): [string, (v: string) => void] {
  const v = useSyncExternalStore(subscribe, () => vm, () => 'all');
  return [v, setVmFilter];
}
