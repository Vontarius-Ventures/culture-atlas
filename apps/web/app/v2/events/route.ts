import type { NextRequest } from 'next/server';
import { eventStream } from '@/lib/server/events';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return eventStream(request);
}
