'use client';

import { useEffect, useState } from 'react';

/** Validate an IANA timezone; fall back to the browser's zone if unusable. */
export function safeTz(tz?: string): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!tz) return fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return fallback;
  }
}

/** The browser's detected timezone (for the "use my timezone" button). */
export function browserTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Full IANA timezone list when the runtime supports it, else a curated fallback. */
export function allTimezones(): string[] {
  const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof anyIntl.supportedValuesOf === 'function') {
    try {
      return anyIntl.supportedValuesOf('timeZone');
    } catch {
      /* fall through */
    }
  }
  return CURATED_TIMEZONES;
}

export const CURATED_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Pacific/Auckland',
];

/** Re-renders every `intervalMs` so callers get a live ticking clock. */
export function useClock(intervalMs = 1000): Date {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function formatClock(date: Date, tz?: string, withSeconds = true): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz),
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: true,
  }).format(date);
}

export function formatLongDate(date: Date, tz?: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz),
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** Hour 0–23 in the given timezone (for greetings / day-night logic). */
export function hourInTz(date: Date, tz?: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: safeTz(tz), hour: 'numeric', hour12: false }).format(date);
  return parseInt(h, 10) % 24;
}

export function greeting(date: Date, tz?: string): string {
  const h = hourInTz(date, tz);
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

/** "Asia/Kolkata" → "Kolkata"; "America/New_York" → "New York". */
export function tzCity(tz?: string): string {
  const z = safeTz(tz);
  const parts = z.split('/');
  return (parts[parts.length - 1] || z).replace(/_/g, ' ');
}

/** "Asia/Kolkata" → "Asia". */
/** Short GMT offset like "GMT+5:30" for the given zone at the given instant. */
export function tzOffset(date: Date, tz?: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: safeTz(tz), timeZoneName: 'shortOffset' })
      .formatToParts(date)
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

/** A friendly label for a timezone, e.g. "Kolkata · GMT+5:30". */
export function tzLabel(tz: string, at = new Date()): string {
  const off = tzOffset(at, tz);
  return `${tzCity(tz)}${off ? ` · ${off}` : ''}`;
}
