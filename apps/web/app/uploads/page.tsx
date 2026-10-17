import type { Metadata } from 'next';
import { UploadsView } from '@/components/v2/UploadsView';

export const metadata: Metadata = { title: 'Uploads' };

export default function UploadsPage() {
  return <UploadsView />;
}
