import type { ReactNode } from 'react';
import {
  PROVIDER_COLORS,
  PROVIDER_LABELS,
  SEVERITY_COLORS,
  STATUS_COLORS,
  type Provider,
  type Severity,
} from '@/lib/format';

export function Card({
  title,
  action,
  children,
  className = '',
  bodyClassName = 'card-pad',
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`card flex flex-col ${className}`}>
      {(title || action) && (
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="panel-title">{title}</div>
          {action}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent = '#3b82f6',
  delta,
  href,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: string;
  delta?: { value: string; up: boolean };
  /** Drill-down: makes the whole card a link to the exact data behind this number. */
  href?: string;
  onClick?: () => void;
}) {
  const interactive = !!href || !!onClick;
  const inner = (
    <>
      <div
        className="absolute inset-x-0 top-0 h-0.5"
        style={{ background: `linear-gradient(90deg, ${accent}, transparent)` }}
      />
      <div className="flex items-center justify-between">
        <div className="text-2xs font-medium uppercase tracking-wide text-muted">{label}</div>
        {interactive && <span className="text-2xs text-muted opacity-0 transition group-hover:opacity-100" style={{ color: accent }}>↗</span>}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="stat-value">{value}</div>
        {delta && (
          <span
            className={`pill ${delta.up ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'}`}
          >
            {delta.up ? '▲' : '▼'} {delta.value}
          </span>
        )}
      </div>
      {sub && <div className="mt-1 text-2xs text-muted">{sub}</div>}
    </>
  );
  const cls = 'card card-pad relative overflow-hidden';
  if (href) {
    return (
      <a href={href} className={`${cls} group block cursor-pointer transition hover:border-brand/50 hover:bg-card-hover/40`} title={`View ${label}`}>
        {inner}
      </a>
    );
  }
  if (onClick) {
    return (
      <button onClick={onClick} className={`${cls} group block w-full cursor-pointer text-left transition hover:border-brand/50 hover:bg-card-hover/40`} title={`View ${label}`}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

export function Badge({
  children,
  color,
  tone = 'soft',
}: {
  children: ReactNode;
  color: string;
  tone?: 'soft' | 'solid' | 'dot';
}) {
  if (tone === 'dot') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-light">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        {children}
      </span>
    );
  }
  return (
    <span
      className="pill"
      style={
        tone === 'solid'
          ? { background: color, color: '#fff' }
          : { background: `${color}1a`, color }
      }
    >
      {children}
    </span>
  );
}

export function ProviderBadge({ provider }: { provider: Provider }) {
  return (
    <Badge color={PROVIDER_COLORS[provider]} tone="soft">
      {PROVIDER_LABELS[provider]}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge color={SEVERITY_COLORS[severity]} tone="soft">
      {severity}
    </Badge>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? '#64748b';
  return <Badge color={color} tone="dot">{status}</Badge>;
}

export function ProgressBar({
  value,
  color = '#3b82f6',
  height = 6,
}: {
  value: number;
  color?: string;
  height?: number;
}) {
  return (
    <div className="w-full overflow-hidden rounded-full bg-border" style={{ height }}>
      <div
        className="h-full rounded-full transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }}
      />
    </div>
  );
}

export function PageGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-12 gap-4">{children}</div>;
}

export { Modal } from './Modal';

export function ErrorState({ message }: { message?: string }) {
  return (
    <div className="card card-pad text-sm text-danger">
      Failed to load data{message ? `: ${message}` : ''}. Is the API running on{' '}
      <code className="text-muted-light">:4000</code>?
    </div>
  );
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid gap-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-xl bg-card/60" />
      ))}
    </div>
  );
}
