import type { Metadata } from 'next';
import { ShareCollectionView } from '@/components/views/ShareCollectionView';

export const metadata: Metadata = { title: 'Share collection', robots: { index: false, follow: false } };

export default async function ShareCollectionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ShareCollectionView key={id} collectionId={id} />;
}
