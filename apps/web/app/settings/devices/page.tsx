import type { Metadata } from 'next';
import { DevicesView } from '@/components/v2/DevicesView';

export const metadata: Metadata = { title: 'Devices' };

export default function DevicesPage() {
  return <DevicesView />;
}
