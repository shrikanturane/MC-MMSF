import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from './providers';
import { AppShell } from '@/components/AppShell';

export const metadata: Metadata = {
  title: 'MCMF — Multi-Cloud Management',
  description: 'Unified multi-cloud management, monitoring, security and operations.',
  applicationName: 'MCMF',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg', apple: '/icon.svg', shortcut: '/icon.svg' },
  // Installed-app behaviour on iOS (Add to Home Screen → standalone, no Safari chrome).
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'MCMF' },
  formatDetection: { telephone: false },
};

// Mobile rendering: scale to the device, draw under the notch (viewport-fit cover), match the dark chrome.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#070a12',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-bg text-slate-200 antialiased">
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
