'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Sub-tab state that survives a page refresh by persisting the active tab in a URL query param.
 * Each tab group uses its own `key` (e.g. 'db', 'inttab') so nested tab sets don't collide, and it
 * coexists with the page's main tab (which uses the hash / ?section=). Restored on mount; written
 * with replaceState so it doesn't spam browser history.
 */
export function useTabParam<T extends string>(key: string, def: T, valid: readonly T[]): [T, (v: T) => void] {
  const [tab, setTabState] = useState<T>(def);

  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get(key);
    if (v && (valid as readonly string[]).includes(v)) setTabState(v as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTab = useCallback(
    (v: T) => {
      setTabState(v);
      try {
        const u = new URL(window.location.href);
        u.searchParams.set(key, v);
        window.history.replaceState(null, '', u.toString());
      } catch {
        /* ignore */
      }
    },
    [key],
  );

  return [tab, setTab];
}
