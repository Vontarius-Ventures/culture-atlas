import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PlanView } from '@/components/views/PlanView';

export const metadata: Metadata = { title: 'Movie night' };

export default async function PlanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <PlanView key={id} planId={id} />
    </Suspense>
  );
}
