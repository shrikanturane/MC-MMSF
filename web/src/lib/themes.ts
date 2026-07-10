// Platform appearance themes. Each theme re-colors the whole UI chrome (background, panels,
// cards, borders, muted text, foreground) plus a default accent. Includes dark (night) and
// light (day) variants. Applied at runtime as CSS variables by lib/branding.ts.

export interface Theme {
  id: string;
  name: string;
  mode: 'dark' | 'light';
  accent: string; // default brand/accent (user can override with a custom color)
  vars: {
    bg: string; panel: string; card: string; cardHover: string;
    border: string; borderSoft: string; muted: string; mutedLight: string; text: string; fg: string;
  };
}

const WHITE = '#ffffff';

export const THEMES: Theme[] = [
  {
    id: 'midnight', name: 'Midnight', mode: 'dark', accent: '#3b82f6',
    vars: { bg: '#070a12', panel: '#0d1320', card: '#111827', cardHover: '#161f33', border: '#1e293b', borderSoft: '#1a2336', muted: '#64748b', mutedLight: '#94a3b8', text: '#e2e8f0', fg: WHITE },
  },
  {
    id: 'carbon', name: 'Carbon', mode: 'dark', accent: '#22c55e',
    vars: { bg: '#0a0a0a', panel: '#121212', card: '#1a1a1a', cardHover: '#242424', border: '#2a2a2a', borderSoft: '#222222', muted: '#737373', mutedLight: '#a3a3a3', text: '#ededed', fg: WHITE },
  },
  {
    id: 'slate', name: 'Slate', mode: 'dark', accent: '#38bdf8',
    vars: { bg: '#0f172a', panel: '#172033', card: '#1e293b', cardHover: '#273449', border: '#334155', borderSoft: '#2a3850', muted: '#64748b', mutedLight: '#94a3b8', text: '#e2e8f0', fg: WHITE },
  },
  {
    id: 'ocean', name: 'Deep Ocean', mode: 'dark', accent: '#06b6d4',
    vars: { bg: '#04141a', panel: '#072530', card: '#0a2e3a', cardHover: '#0f3a48', border: '#124b5c', borderSoft: '#0f3d4b', muted: '#5f8a96', mutedLight: '#9bc3cd', text: '#e0f2f7', fg: WHITE },
  },
  {
    id: 'forest', name: 'Forest', mode: 'dark', accent: '#34d399',
    vars: { bg: '#06120c', panel: '#0a1f15', card: '#0d281b', cardHover: '#123724', border: '#1c4a32', borderSoft: '#173d29', muted: '#5e8a72', mutedLight: '#9ec9b1', text: '#e3f4ea', fg: WHITE },
  },
  {
    id: 'plum', name: 'Plum', mode: 'dark', accent: '#c084fc',
    vars: { bg: '#100a18', panel: '#1a1228', card: '#221733', cardHover: '#2e2044', border: '#3a2a54', borderSoft: '#312349', muted: '#8a7aa3', mutedLight: '#c0b3d6', text: '#efe9f7', fg: WHITE },
  },
  {
    id: 'ember', name: 'Ember', mode: 'dark', accent: '#fb923c',
    vars: { bg: '#140a07', panel: '#20120c', card: '#2a1810', cardHover: '#3a2216', border: '#4d2e1c', borderSoft: '#402617', muted: '#9a7c68', mutedLight: '#cdb6a3', text: '#f6ece4', fg: WHITE },
  },
  // ── Day / light ──
  {
    id: 'daylight', name: 'Daylight', mode: 'light', accent: '#2563eb',
    vars: { bg: '#f3f5fa', panel: '#e8edf6', card: '#ffffff', cardHover: '#eef2f9', border: '#d4dbe7', borderSoft: '#e3e8f1', muted: '#5b6878', mutedLight: '#404c5c', text: '#0f172a', fg: '#0f172a' },
  },
  {
    id: 'paper', name: 'Paper', mode: 'light', accent: '#0ea5e9',
    vars: { bg: '#faf8f4', panel: '#f1ede5', card: '#ffffff', cardHover: '#f5f1ea', border: '#e2dccf', borderSoft: '#ece6da', muted: '#6b6256', mutedLight: '#4a4339', text: '#1c1917', fg: '#1c1917' },
  },
];

export const DEFAULT_THEME = 'midnight';
export const DEFAULT_LIGHT = 'daylight';
export const DEFAULT_DARK = 'midnight';
export const getTheme = (id?: string): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0];

// ── Text size (scales the whole UI via the root font-size; Tailwind text-* are rem-based) ──
export const FONT_SCALES: { id: string; name: string; scale: number }[] = [
  { id: 'sm', name: 'Compact', scale: 0.9 },
  { id: 'base', name: 'Default', scale: 1 },
  { id: 'lg', name: 'Large', scale: 1.1 },
  { id: 'xl', name: 'Extra large', scale: 1.2 },
];
export const getFontScale = (id?: string): number => FONT_SCALES.find((f) => f.id === id)?.scale ?? 1;

// ── Font family — curated, system-safe stacks (no web-font downloads; works fully offline) ──
export const FONT_FAMILIES: { id: string; name: string; stack: string }[] = [
  { id: 'system', name: 'System default', stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { id: 'grotesk', name: 'Grotesk (Segoe / Roboto)', stack: '"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  { id: 'humanist', name: 'Humanist (Verdana)', stack: 'Verdana, "Segoe UI", Geneva, Tahoma, sans-serif' },
  { id: 'rounded', name: 'Rounded (Trebuchet)', stack: '"Trebuchet MS", "Segoe UI", system-ui, sans-serif' },
  { id: 'serif', name: 'Serif (Georgia)', stack: 'Georgia, "Times New Roman", Cambria, serif' },
  { id: 'mono', name: 'Monospace', stack: '"SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Roboto Mono", monospace' },
];
export const getFontStack = (id?: string): string => FONT_FAMILIES.find((f) => f.id === id)?.stack ?? FONT_FAMILIES[0].stack;
