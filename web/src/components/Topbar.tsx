'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useSettings } from '@/lib/hooks';
import { logout, useAuthUser } from '@/lib/auth';
import { formatClock, tzCity, useClock } from '@/lib/time';

const ROLE_LABELS: Record<string, string> = { admin: 'Administrator', operator: 'Operator', viewer: 'Viewer' };

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Multicloud Management', sub: 'Unified view across all cloud providers' },
  '/topology': { title: 'Virtual Network Topology', sub: 'App → cloud → VPC/VNet → VMs, with IPs, ports & VPN' },
  '/custom': { title: 'My Dashboard', sub: 'Your customizable widgets and charts' },
  '/vms': { title: 'Virtual Machines', sub: 'Power control and remote access across clouds' },
  '/monitoring': { title: 'Multicloud Monitoring', sub: 'Real-time performance across your fleet' },
  '/security': { title: 'Multicloud Security', sub: 'Posture, threats and compliance' },
  '/governance': { title: 'Policy & Environment Governance', sub: 'Environment-tier guardrails across clouds' },
  '/network': { title: 'Network Analysis', sub: 'Exposure, inventory and firewall-rule review' },
  '/inventory': { title: 'Cloud Inventory', sub: 'All discovered resources' },
  '/command-center': { title: 'Command Center', sub: 'Live operations and automation' },
  '/reports': { title: 'Custom Reports', sub: 'Build, run, download and schedule reports' },
  '/activity': { title: 'Activity & Event Tracking', sub: 'Searchable cross-cloud event timeline' },
  '/approvals': { title: 'Approvals', sub: 'Review and authorize sensitive actions — process control is in Settings' },
  '/connections': { title: 'Cloud Connections', sub: 'Connect real clouds and discover live resources' },
  '/replication': { title: 'Replication & DR Orchestration', sub: 'Primary/secondary/tertiary VM replication for multi-cloud HA' },
  '/help': { title: 'Help & Integration Guide', sub: 'How to connect each cloud provider' },
  '/settings': { title: 'Settings', sub: 'Account, connections and preferences' },
};

const PROVIDER_CHIPS = [
  { key: 'aws', label: 'AWS' },
  { key: 'azure', label: 'Azure' },
  { key: 'gcp', label: 'GCP' },
  { key: 'private', label: 'Private' },
];

export function Topbar({ onMenu }: { onMenu?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const meta =
    TITLES[pathname] ??
    TITLES[Object.keys(TITLES).find((k) => k !== '/' && pathname.startsWith(k)) ?? '/'];
  const isHome = pathname === '/' || pathname === '/custom';

  return (
    <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-bg/80 px-3 backdrop-blur md:px-6">
      <div className="flex min-w-0 items-center gap-2 md:gap-3">
        {/* Mobile: open the navigation drawer (md:hidden — sidebar takes over at md+). */}
        <button onClick={onMenu} aria-label="Open menu" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-base text-muted-light transition hover:border-brand/40 hover:text-white md:hidden">
          ☰
        </button>
        {/* Back to the screen you came from (e.g. after drilling into a KPI). */}
        {!isHome && (
          <button onClick={() => router.back()} className="hidden items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-light transition hover:border-brand/40 hover:text-white sm:flex" title="Go back">
            <span className="text-sm leading-none">←</span> Back
          </button>
        )}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-white">{meta.title}</h1>
          <p className="truncate text-2xs text-muted">{meta.sub}</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden items-center gap-1.5 lg:flex">
          {PROVIDER_CHIPS.map((p) => (
            <Link
              key={p.key}
              href={`/inventory?provider=${p.key}`}
              className="rounded-md border border-border bg-card px-2 py-1 text-2xs text-muted-light transition hover:border-brand/40 hover:text-white"
            >
              {p.label}
            </Link>
          ))}
        </div>
        <TopbarClock />
        <Link
          href="/settings?section=connections"
          className="shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white hover:bg-brand-soft md:px-3"
          title="Add a cloud connection"
        >
          +<span className="hidden sm:inline"> Add Cloud</span>
        </Link>
        <ProfileMenu />
      </div>
    </header>
  );
}

function ProfileMenu() {
  const { data: user } = useAuthUser();
  const [open, setOpen] = useState(false);
  const initials = (user?.name ?? 'U').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-brand to-purple text-xs font-semibold text-white">
        {initials}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-2 w-56 rounded-xl border border-border bg-panel p-1.5 shadow-xl">
            <div className="border-b border-border-soft px-3 py-2">
              <div className="truncate text-xs font-medium text-white">{user?.name ?? '—'}</div>
              <div className="truncate text-2xs text-muted">{user?.email}</div>
              <div className="mt-0.5 text-2xs text-brand">{ROLE_LABELS[user?.role ?? ''] ?? user?.role}</div>
            </div>
            <Link href="/settings?section=profile" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-xs text-muted-light hover:bg-card-hover hover:text-white">👤 My Profile</Link>
            <Link href="/settings?section=security" onClick={() => setOpen(false)} className="block rounded-lg px-3 py-2 text-xs text-muted-light hover:bg-card-hover hover:text-white">🔒 Password &amp; 2FA</Link>
            <button onClick={logout} className="block w-full rounded-lg px-3 py-2 text-left text-xs text-danger hover:bg-card-hover">⎋ Sign out</button>
          </div>
        </>
      )}
    </div>
  );
}

function TopbarClock() {
  const { data: settings } = useSettings();
  const now = useClock();
  const tz = settings?.region.timezone;
  return (
    <div className="hidden items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-2xs md:flex" title={tz}>
      <span>🕐</span>
      <span className="font-mono tabular-nums text-white">{formatClock(now, tz, false)}</span>
      <span className="text-muted">{tzCity(tz)}</span>
    </div>
  );
}
