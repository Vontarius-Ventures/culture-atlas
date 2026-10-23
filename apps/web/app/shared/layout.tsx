import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** Share redemption and viewer pages: never indexed, never leak a referrer (headers also set in next.config.ts). */
export const metadata: Metadata = {
  title: 'Shared collection',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function SharedLayout({ children }: { children: ReactNode }) {
  return children;
}
