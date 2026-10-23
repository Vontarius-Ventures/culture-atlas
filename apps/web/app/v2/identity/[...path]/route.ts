import { identityRoute } from '../../../../lib/server/identity-http';
import type { NextRequest } from 'next/server';

type Segment = { params: Promise<{ path: string[] }> };
async function handle(request: NextRequest, segment: Segment) {
  return identityRoute(request, (await segment.params).path.join('/'));
}
export const GET = handle;
export const POST = handle;
