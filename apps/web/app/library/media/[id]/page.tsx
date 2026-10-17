import type { Metadata } from 'next';
import { MediaDetailView } from '@/components/v2/MediaDetailView';

export const metadata: Metadata = { title: 'Library' };

export default async function MediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MediaDetailView key={id} id={id} />;
}
