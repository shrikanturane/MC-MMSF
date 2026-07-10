'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logout } from '@/lib/auth';
import { useBranding } from '@/lib/branding';
import { useNavModules } from '@/lib/nav';

const ROLE_LABELS: Record<string, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };

/** variant 'desktop' = sticky aside (md+ only); 'mobile' = full-height drawer panel. */
export function Sidebar({ variant = 'desktop', onNavigate }: { variant?: 'desktop' | 'mobile'; onNavigate?: () => void } = {}) {
  const pathname = usePathname();
  const { logo, orgName, tagline } = useBranding();
  const { items, noAccess, user } = useNavModules();

  const asideCls =
    variant === 'mobile'
      ? 'flex h-full w-72 max-w-[82vw] flex-col bg-panel'
      : 'sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-panel md:flex';

  return (
    <aside className={asideCls}>
      <div className="flex h-14 items-center gap-2 border-b border-border px-5">
        {logo ? (
          <img src={logo} alt="logo" className="h-7 w-7 rounded-md object-cover" />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand text-sm font-bold text-white">{orgName.slice(0, 1).toUpperCase()}</div>
        )}
        <div className="leading-tight">
          <div className="truncate text-sm font-semibold text-white">{orgName}</div>
          {tagline && <div className="truncate text-2xs text-muted">{tagline}</div>}
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        <div className="px-2 pb-2 text-2xs font-semibold uppercase tracking-wider text-muted">Platform</div>
        {items.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                active ? 'bg-brand/15 font-medium text-white ring-1 ring-brand/30' : 'text-muted-light hover:bg-card-hover hover:text-white'
              }`}
            >
              <span className="w-4 text-center text-xs opacity-80">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
        {noAccess && (
          <div className="mx-1 mt-2 rounded-lg border border-border bg-bg/40 px-3 py-3 text-2xs text-muted">
            No modules have been assigned to your group yet. Please contact your administrator.
          </div>
        )}
      </nav>

      <div className="border-t border-border p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand to-purple text-xs font-semibold text-white">
            {(user?.name ?? 'U').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-xs font-medium text-white">{user?.name ?? '—'}</div>
            <div className="truncate text-2xs text-muted">{ROLE_LABELS[user?.role ?? ''] ?? user?.role ?? ''}</div>
          </div>
          <button onClick={logout} title="Sign out" className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-light hover:text-white">⎋</button>
        </div>
      </div>
    </aside>
  );
}
