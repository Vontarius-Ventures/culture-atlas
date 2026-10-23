import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import './globals.css';
// Capture platform v2 surfaces; loaded after the v1 base so its overrides win.
import '@/components/v2/v2.css';
// Spec amendment 2.2 screens 14-18 (taste onboarding, While we look, ready notice).
import '@/components/onboarding/onboarding.css';

export const metadata: Metadata = {
  title: { default: 'culture atlas', template: '%s · culture atlas' },
  description: 'Capture something you like. Discover more you will like.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f8f6f1',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
