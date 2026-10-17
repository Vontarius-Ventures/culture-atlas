import type { Metadata } from 'next';
import { LibraryView } from '@/components/v2/LibraryView';

export const metadata: Metadata = { title: 'Library' };

export default function LibraryPage() {
  return <LibraryView />;
}
