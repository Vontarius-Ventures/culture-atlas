import type { NextRequest } from 'next/server';
import { acknowledgeDeviceCommandRoute } from '@/lib/server/device-commands-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, segment: { params: Promise<{ id: string }> }) {
  return acknowledgeDeviceCommandRoute(request, (await segment.params).id);
}
