'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { useNavModules } from '@/lib/nav';

const isActive = (pathname: string, href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));

/** Slide-in navigation drawer for phones (md:hidden). Reuses the real Sidebar so nav never drifts. */
export function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <div className={`fixed inset-0 z-40 md:hidden ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open} role="dialog" aria-modal="true">
      <div onClick={onClose} className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`} />
      <div className={`absolute left-0 top-0 h-full shadow-2xl transition-transform duration-300 ease-out ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <Sidebar variant="mobile" onNavigate={onClose} />
      </div>
    </div>
  );
}

/** App-style bottom tab bar for phones (md:hidden): the first accessible modules + a Menu button. */
export function BottomBar({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const { items } = useNavModules();
  const primary = items.filter((i) => !i.locked).slice(0, 4);
  return (
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-border bg-panel/95 backdrop-blur md:hidden">
      {primary.map((i) => {
        const on = isActive(pathname, i.href);
        return (
          <Link key={i.href} href={i.href} className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-2xs transition ${on ? 'text-brand' : 'text-muted hover:text-white'}`}>
            <span className="text-lg leading-none">{i.icon}</span>
            <span className="max-w-full truncate px-0.5">{i.label.split(/\s|&/)[0]}</span>
          </Link>
        );
      })}
      <button onClick={onMenu} className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-2xs text-muted transition hover:text-white" aria-label="Open menu">
        <span className="text-lg leading-none">☰</span>
        <span>Menu</span>
      </button>
    </nav>
  );
}
