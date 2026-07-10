import type { MetadataRoute } from 'next';

// PWA manifest — makes MCMF installable ("Add to Home Screen") and launchable as a standalone
// app (no browser chrome). Served by Next at /manifest.webmanifest.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'MCMF — Multi-Cloud Management',
    short_name: 'MCMF',
    description: 'Unified multi-cloud management, monitoring, security and operations.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#070a12',
    theme_color: '#070a12',
    categories: ['business', 'productivity', 'utilities'],
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
