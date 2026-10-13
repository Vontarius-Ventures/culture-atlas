import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CaptureResultView } from '@/components/views/CaptureResultView';

export const metadata: Metadata = { title: 'Your photo' };

export default async function CaptureResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <CaptureResultView key={id} captureId={id} />
    </Suspense>
  );
}
