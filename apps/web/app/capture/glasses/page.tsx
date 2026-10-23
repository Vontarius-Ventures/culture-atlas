import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GlassesView } from '@/components/v2/GlassesView';

export const metadata: Metadata = { title: 'Meta glasses', referrer: 'no-referrer' };

export default function CaptureGlassesPage() {
  return (
    <Suspense>
      <GlassesView back={{ href: '/capture', label: 'Capture' }} />
    </Suspense>
  );
}
