'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Portal-based modal. Renders into document.body so it escapes any ancestor with
 * `backdrop-filter` / `transform` (which would otherwise become the containing block
 * for position:fixed and clip the modal — the bug behind "popup not coming properly").
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setMounted(true);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  if (!mounted) return null;

  const content = (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        className={`relative flex w-full flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl transition-all ${expanded ? 'h-[95vh] max-h-[95vh] max-w-[96vw]' : `max-h-[88vh] ${wide ? 'max-w-2xl' : 'max-w-lg'}`}`}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div>
            <div className="text-sm font-semibold text-white">{title}</div>
            {subtitle && <div className="text-2xs text-muted">{subtitle}</div>}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setExpanded((v) => !v)} title={expanded ? 'Restore' : 'Expand'} className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-light hover:text-white">
              {expanded ? '🗗' : '⤢'}
            </button>
            <button onClick={onClose} title="Close (Esc)" className="rounded-lg border border-border bg-card px-2.5 py-1 text-xs text-muted-light hover:text-white">
              ✕
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
