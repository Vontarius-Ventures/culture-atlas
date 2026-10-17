import type { NextRequest } from 'next/server';
import { agentMediaRoute } from '@/lib/server/agent-media-http';

/** Preview/playback links returned by agent get_media (live grant checked per request). */
export const runtime = 'nodejs';
export const GET = (request: NextRequest) => agentMediaRoute(request);
