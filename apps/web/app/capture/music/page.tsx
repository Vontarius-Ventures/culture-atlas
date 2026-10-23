import type { Metadata } from 'next';
import { MusicView } from '@/components/v2/MusicView';

export const metadata: Metadata = { title: 'Music' };

export default function MusicPage() {
  return <MusicView />;
}
