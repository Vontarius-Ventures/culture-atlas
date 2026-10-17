import { createMcpHandler } from '@culture-atlas/agent-gateway';
import { agentCaptureContext } from '@/lib/server/agent-media-http';

/**
 * Remote MCP endpoint (bearer agent connections). Implemented in
 * packages/agent-gateway. Media tools receive the same live-authorized
 * capture context as agent REST media (gap G6).
 */
let handler: ((request: Request) => Promise<Response>) | undefined;
const handle = (request: Request) => {
  handler ??= createMcpHandler({ captureContext: agentCaptureContext });
  return handler(request);
};

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
