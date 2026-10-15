import type { ReactNode } from 'react';
export const metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};
export default function IdentityLayout({ children }: { children: ReactNode }) {
  return children;
}
