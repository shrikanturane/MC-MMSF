'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from '@/components/Sidebar';
import { Topbar } from '@/components/Topbar';
import { MobileDrawer, BottomBar } from '@/components/MobileNav';
import { DownAlertWatcher } from '@/components/DownAlertWatcher';
import { LoginView } from '@/features/auth/LoginView';
import { Enforce2FA } from '@/features/auth/Enforce2FA';
import { setToken, useAuthUser } from '@/lib/auth';
import { useApplyBrand } from '@/lib/branding';
import { accessAllows, PLATFORM_MODULES } from '@/lib/modules';

/** Match a pathname to the platform module that owns it (longest href wins; '/' only matches home). */
function moduleForPath(p: string) {
  return PLATFORM_MODULES
    .filter((m) => (m.href === '/' ? p === '/' : p === m.href || p.startsWith(m.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** Routes reachable WITHOUT a session (the user is locked out by definition). */
const PUBLIC_PATHS = ['/reset'];

/** Authenticated routes that render full-screen WITHOUT the app chrome (sidebar/topbar). */
const CHROMELESS_PATHS = ['/console'];

/** Gates the whole app behind authentication. No valid session → login screen. */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { data, isLoading, isError } = useAuthUser();
  const [exchanging, setExchanging] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useApplyBrand();
  // Close the mobile nav drawer whenever the route changes.
  useEffect(() => { setNavOpen(false); }, [pathname]);

  // SSO callback lands here as /?token=…  → store it, clean the URL, reload authenticated.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (t) {
      setExchanging(true);
      setToken(t);
      window.location.replace('/topology'); // SSO sign-in lands on the topology
    }
  }, []);

  if (exchanging) {
    return <div className="flex min-h-screen items-center justify-center bg-bg text-2xs text-muted">Signing you in…</div>;
  }

  // Public auth pages render without the gate or the app chrome.
  if (PUBLIC_PATHS.includes(pathname)) return <>{children}</>;

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-brand" />
          Loading…
        </div>
      </div>
    );
  }

  if (isError || !data) return <LoginView />;

  // Mandatory 2FA: roles that require it (operator/viewer) must enrol before using the app.
  if (data.twoFactorRequired && !data.twoFactorEnabled) return <Enforce2FA user={data} />;

  // The remote console (RDP/SSH) is full-screen — no sidebar/topbar chrome.
  if (CHROMELESS_PATHS.includes(pathname)) return <>{children}</>;

  // Group-based route guard: block direct navigation to a module the user's groups don't grant.
  const mod = moduleForPath(pathname);
  const blocked = mod && !accessAllows(data.access, 'modules', mod.key, data.role);

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      {/* Mobile-only: slide-in drawer (md:hidden) mirrors the sidebar. */}
      <MobileDrawer open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setNavOpen(true)} />
        <main className="flex-1 overflow-x-hidden px-3 py-4 pb-24 md:px-6 md:py-5 md:pb-5">
          {blocked ? (
            <div className="mx-auto mt-24 max-w-md rounded-xl border border-border bg-panel p-6 text-center">
              <div className="text-3xl">🔒</div>
              <div className="mt-2 text-sm font-semibold text-white">No access to this module</div>
              <div className="mt-1 text-2xs text-muted">Your group doesn&apos;t include &ldquo;{mod.label}&rdquo;. Choose a module from the sidebar, or contact your administrator.</div>
            </div>
          ) : children}
        </main>
      </div>
      {/* Mobile-only: app-style bottom tab bar (md:hidden). */}
      <BottomBar onMenu={() => setNavOpen(true)} />
      <DownAlertWatcher />
    </div>
  );
}
