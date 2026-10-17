import type { NextRequest } from 'next/server';
import { sharedMediaRoute } from '@/lib/server/share-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v2/shared/media/{id} (AGENTS-AND-SHARING API table): the default
 * share-safe rendition, i.e. the playback stream for a video and the
 * normalized image for a photo. Same per-request and per-range checks as
 * /v2/shared/media/{id}/{variant}.
 */
export async function GET(request: NextRequest, segment: { params: Promise<{ id: string }> }) {
  const { id } = await segment.params;
  return sharedMediaRoute(request, id, 'playback');
}
