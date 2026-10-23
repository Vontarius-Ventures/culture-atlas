import type { Metadata } from 'next';
import { DeviceDetailView } from '@/components/v2/DevicesView';

export const metadata: Metadata = { title: 'Device' };

export default async function DevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DeviceDetailView key={id} id={id} />;
}
