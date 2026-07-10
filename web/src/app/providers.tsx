'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Every page auto-refreshes in the background (even when the tab is unfocused) so VM
            // up/down and other live state stay current without a manual reload.
            refetchInterval: 15000,
            refetchIntervalInBackground: true,
            refetchOnWindowFocus: true,
            staleTime: 5000,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
