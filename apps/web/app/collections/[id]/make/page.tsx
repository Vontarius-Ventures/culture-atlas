import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlanFormView } from '@/components/views/PlanFormView';

export const metadata: Metadata = { title: 'Make a movie night' };

export default async function MakePlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <PlanFormView key={id} collectionId={id} />
    </Suspense>
  );
}
