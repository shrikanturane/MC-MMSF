'use client';

import { useEffect } from 'react';
import { useSettings } from './hooks';
import { getTheme, getFontScale, getFontStack } from './themes';

export interface AppearanceOpts {
  fontScale?: string;
  fontFamily?: string;
  reduceMotion?: boolean;
  highContrast?: boolean;
  solidSurfaces?: boolean;
}

function hexTriplet(hex?: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function darken(hex?: string, f = 0.78): string | null {
  const t = hexTriplet(hex);
  if (!t) return null;
  const [r, g, b] = t.split(' ').map(Number);
  return `${Math.round(r * f)} ${Math.round(g * f)} ${Math.round(b * f)}`;
}

/** Apply a theme (background, surfaces, borders) + accent + optional background image + text/font/a11y options. */
export function applyAppearance(themeId?: string, accent?: string, bgImage?: string, opts?: AppearanceOpts) {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  const root = el.style;
  const set = (name: string, hex?: string) => { const t = hexTriplet(hex); if (t) root.setProperty(name, t); };
  const theme = getTheme(themeId);
  // Background image: layer a theme-tinted overlay over the photo so cards stay readable.
  if (bgImage) {
    const t = hexTriplet(theme.vars.bg) ?? '0 0 0';
    root.setProperty('--bg-image', `linear-gradient(rgb(${t} / 0.82), rgb(${t} / 0.88)), url("${bgImage}")`);
  } else {
    root.setProperty('--bg-image', 'none');
  }
  set('--bg-rgb', theme.vars.bg);
  set('--panel-rgb', theme.vars.panel);
  set('--card-rgb', theme.vars.card);
  set('--card-hover-rgb', theme.vars.cardHover);
  set('--border-rgb', theme.vars.border);
  set('--border-soft-rgb', theme.vars.borderSoft);
  set('--muted-rgb', theme.vars.muted);
  set('--muted-light-rgb', theme.vars.mutedLight);
  set('--text-rgb', theme.vars.text);
  set('--fg-rgb', theme.vars.fg);
  document.documentElement.style.colorScheme = theme.mode;
  // Accent: the user's custom color overrides the theme's default accent.
  const brand = accent || theme.accent;
  set('--brand-rgb', brand);
  const soft = darken(brand);
  if (soft) root.setProperty('--brand-soft-rgb', soft);

  // ── Text size: scale the root font-size; Tailwind's rem-based text-* sizes follow. ──
  root.setProperty('--font-scale', String(getFontScale(opts?.fontScale)));
  // ── Font family: applied to html/body via globals.css. ──
  root.setProperty('--app-font', getFontStack(opts?.fontFamily));
  // ── High contrast: strengthen borders + muted text using the theme's own brighter tones. ──
  if (opts?.highContrast) {
    set('--border-rgb', theme.vars.muted);
    set('--border-soft-rgb', theme.vars.muted);
    set('--muted-rgb', theme.vars.mutedLight);
  }
  // ── Advanced toggles surfaced as data-attributes (CSS reacts in globals.css). ──
  el.setAttribute('data-motion', opts?.reduceMotion ? 'reduced' : 'full');
  el.setAttribute('data-surfaces', opts?.solidSurfaces ? 'solid' : 'default');
  el.setAttribute('data-contrast', opts?.highContrast ? 'high' : 'normal');
}

/** Applies the saved appearance theme + accent + text/font/a11y options across the app on load and on change. */
export function useApplyBrand() {
  const { data } = useSettings();
  const b = data?.branding;
  const themeId = b?.theme;
  const accent = b?.primaryColor;
  const bgImage = b?.bgImage;
  const fontScale = b?.fontScale;
  const fontFamily = b?.fontFamily;
  const reduceMotion = b?.reduceMotion;
  const highContrast = b?.highContrast;
  const solidSurfaces = b?.solidSurfaces;
  useEffect(() => {
    applyAppearance(themeId, accent, bgImage, { fontScale, fontFamily, reduceMotion, highContrast, solidSurfaces });
  }, [themeId, accent, bgImage, fontScale, fontFamily, reduceMotion, highContrast, solidSurfaces]);
}

/** Logo (data URL), org name and color for the current org. */
export function useBranding() {
  const { data } = useSettings();
  return {
    logo: data?.branding?.logo || '',
    orgName: data?.branding?.orgName || 'MCMF',
    tagline: data?.branding?.tagline ?? 'Multi-Cloud Platform',
    primaryColor: data?.branding?.primaryColor || '#3b82f6',
    modules: (data?.modules ?? {}) as Record<string, boolean>,
    layout: (data?.layout ?? {}) as import('./modules').LayoutConfig,
  };
}
