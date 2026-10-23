import type { NextRequest } from 'next/server';
import { sharedMediaRoute } from '@/lib/server/share-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, segment: { params: Promise<{ id: string; variant: string }> }) {
  const { id, variant } = await segment.params;
  return sharedMediaRoute(request, id, variant);
}
