import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type {
  AgentConnectionsListResponse,
  CreateAgentConnectionRequest,
  CreateAgentConnectionResponse,
} from '../schemas/agent-connections';

/**
 * Agent connections (account owner, browser only: requireAccountOwner).
 * Credential via auth.generateAgentCredential(); store hash + prefix only.
 * selected_collections grants are rows in agent_connection_collections and
 * must reference collections the owner owns. Revocation is immediate
 * (resolvePrincipal rejects revoked tokens on the next call).
 */

/** GET /v1/agent-connections. TODO(agent gateway owner): implement. */
export async function listAgentConnections(ctx: ServiceContext): Promise<AgentConnectionsListResponse> {
  void ctx;
  notImplemented('agentConnections.list');
}

/** POST /v1/agent-connections (201; credential shown once). TODO(agent gateway owner). */
export async function createAgentConnection(
  ctx: ServiceContext,
  body: CreateAgentConnectionRequest,
): Promise<CreateAgentConnectionResponse> {
  void ctx;
  void body;
  notImplemented('agentConnections.create');
}

/** DELETE /v1/agent-connections/{id} — revoke immediately. TODO(agent gateway owner). */
export async function revokeAgentConnection(ctx: ServiceContext, input: { id: string }): Promise<void> {
  void ctx;
  void input;
  notImplemented('agentConnections.revoke');
}
