import type { NextRequest } from 'next/server';
import { agentConnections, agentPlatform } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';
import { listArmingAgentsRoute, refuseInstallationMutation } from '@/lib/server/arming-agents-http';

const ownerGet = agentRoute(ROUTES.listConnectionsV2, async ({ ctx }) => ({
  ...(await agentConnections.listAgentConnections(ctx)),
  schema_version: '2.1' as const,
  request_id: ctx.requestId,
}));

/** Owner Settings list, or an installation-safe name list for the arming sheet. */
export function GET(request: NextRequest, segment: { params: Promise<Record<string, string>> }) {
  if (request.headers.get('authorization')?.startsWith('Bearer cna_')) {
    return listArmingAgentsRoute(request);
  }
  return ownerGet(request, segment);
}

const ownerPost = agentRoute(ROUTES.createConnectionV2, ({ ctx, body }) =>
  agentPlatform.createConnection(ctx, body),
);

export function POST(request: NextRequest, segment: { params: Promise<Record<string, string>> }) {
  if (request.headers.get('authorization')?.startsWith('Bearer cna_')) {
    return refuseInstallationMutation(request);
  }
  return ownerPost(request, segment);
}
