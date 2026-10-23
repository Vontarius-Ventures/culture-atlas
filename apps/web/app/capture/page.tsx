import type { Metadata } from 'next';
import { SourceView } from '@/components/v2/SourceView';

export const metadata: Metadata = { title: 'Capture' };

export default function CapturePage() {
  return <SourceView />;
}
