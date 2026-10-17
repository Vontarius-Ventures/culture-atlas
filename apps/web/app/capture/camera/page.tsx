import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CameraView } from '@/components/v2/CameraView';

export const metadata: Metadata = { title: 'Camera' };

export default function CameraPage() {
  return (
    <Suspense>
      <CameraView />
    </Suspense>
  );
}
