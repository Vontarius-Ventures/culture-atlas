import type { Metadata } from 'next';
import { CollectionDetailView } from '@/components/views/CollectionDetailView';

export const metadata: Metadata = { title: 'Collection' };

export default async function CollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CollectionDetailView key={id} collectionId={id} />;
}
