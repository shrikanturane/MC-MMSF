import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // App chrome — driven by CSS vars so the whole platform re-themes from Appearance settings.
        bg: 'rgb(var(--bg-rgb) / <alpha-value>)',
        panel: 'rgb(var(--panel-rgb) / <alpha-value>)',
        card: 'rgb(var(--card-rgb) / <alpha-value>)',
        'card-hover': 'rgb(var(--card-hover-rgb) / <alpha-value>)',
        border: 'rgb(var(--border-rgb) / <alpha-value>)',
        'border-soft': 'rgb(var(--border-soft-rgb) / <alpha-value>)',
        muted: 'rgb(var(--muted-rgb) / <alpha-value>)',
        'muted-light': 'rgb(var(--muted-light-rgb) / <alpha-value>)',
        // Primary foreground — themeable so light (day) mode flips text to dark. Accent/semantic
        // buttons keep white text via a rule in globals.css.
        white: 'rgb(var(--fg-rgb) / <alpha-value>)',
        // Accents (live brand color via CSS var — set at runtime from Branding settings)
        brand: 'rgb(var(--brand-rgb) / <alpha-value>)',
        'brand-soft': 'rgb(var(--brand-soft-rgb) / <alpha-value>)',
        success: '#22c55e',
        warning: '#f59e0b',
        danger: '#ef4444',
        info: '#06b6d4',
        purple: '#a855f7',
        // Provider brand colors
        aws: '#ff9900',
        azure: '#0078d4',
        gcp: '#ea4335',
        private: '#a855f7',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': '0.6875rem',
      },
    },
  },
  plugins: [],
};

export default config;
