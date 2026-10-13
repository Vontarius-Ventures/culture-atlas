import type { Metadata } from 'next';
import { CaptureView } from '@/components/views/CaptureView';

export const metadata: Metadata = { title: 'Capture' };

export default function CapturePage() {
  return <CaptureView />;
}
