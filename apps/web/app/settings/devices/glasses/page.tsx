import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GlassesView } from '@/components/v2/GlassesView';

export const metadata: Metadata = { title: 'Meta glasses', referrer: 'no-referrer' };

export default function DevicesGlassesPage() {
  return (
    <Suspense>
      <GlassesView back={{ href: '/settings/devices', label: 'Settings' }} />
    </Suspense>
  );
}
