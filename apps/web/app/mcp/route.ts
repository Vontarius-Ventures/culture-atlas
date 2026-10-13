import { handleMcpRequest } from '@culture-atlas/agent-gateway';

/** Remote MCP endpoint (bearer agent connections). Implemented in packages/agent-gateway. */
export const POST = (request: Request) => handleMcpRequest(request);
export const GET = (request: Request) => handleMcpRequest(request);
export const DELETE = (request: Request) => handleMcpRequest(request);
