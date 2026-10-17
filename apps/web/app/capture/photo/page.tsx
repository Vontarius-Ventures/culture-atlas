import type { Metadata } from 'next';
import { CaptureView } from '@/components/views/CaptureView';

export const metadata: Metadata = { title: 'Discover from a photo' };

/** The v1 photo → discoveries flow (anonymous-friendly), kept reachable beside the v2 chooser. */
export default function CapturePhotoPage() {
  return <CaptureView />;
}
