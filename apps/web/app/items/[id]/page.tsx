import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ItemView } from '@/components/views/ItemView';

export const metadata: Metadata = { title: 'Discovery' };

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <ItemView key={id} itemId={id} />
    </Suspense>
  );
}
