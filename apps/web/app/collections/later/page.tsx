import type { Metadata } from 'next';
import { SavedForLaterView } from '@/components/views/CollectionsView';

export const metadata: Metadata = { title: 'Saved for later' };

export default function SavedForLaterPage() {
  return <SavedForLaterView />;
}
