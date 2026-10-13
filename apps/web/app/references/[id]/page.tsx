import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ReferenceView } from '@/components/views/ReferenceView';

export const metadata: Metadata = { title: 'Reference' };

export default async function ReferencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ReferenceView key={id} referenceId={id} />
    </Suspense>
  );
}
