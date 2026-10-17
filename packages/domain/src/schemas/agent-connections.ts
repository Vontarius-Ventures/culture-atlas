import { z } from 'zod';
import { LibraryAccess, READ_ONLY_SCOPES, Scope } from '../enums';
import { Timestamp, Uuid } from './common';

/** POST /v1/agent-connections — account owner only; credential is shown once. */
export const CreateAgentConnectionRequest = z
  .strictObject({
    client_name: z.string().trim().min(1).max(80),
    scopes: z.array(Scope).min(1).default([...READ_ONLY_SCOPES]),
    library_access: LibraryAccess,
    collection_ids: z.array(Uuid).max(100).default([]),
    expires_in_days: z.number().int().min(1).max(90).default(30),
  })
  .refine(
    (v) =>
      v.library_access === 'selected_collections'
        ? v.collection_ids.length > 0
        : v.collection_ids.length === 0,
    { message: 'collection_ids are required for selected_collections and only allowed there', path: ['collection_ids'] },
  );
export type CreateAgentConnectionRequest = z.infer<typeof CreateAgentConnectionRequest>;

/** Plain-language summary of readable/writable data (authz/connection-access.ts). */
export const ConnectionAccessSummary = z.object({
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  limits: z.array(z.string()),
});

export const AgentConnectionDto = z.object({
  id: Uuid,
  client_name: z.string(),
  scopes: z.array(Scope),
  library_access: LibraryAccess,
  collection_ids: z.array(Uuid),
  installation_ids: z.array(Uuid).optional(),
  authorization_version: z.number().int().positive().optional(),
  credential_prefix: z.string(),
  created_at: Timestamp,
  expires_at: Timestamp,
  revoked_at: Timestamp.nullable(),
  last_used_at: Timestamp.nullable(),
  /** 'active' | 'expired' | 'revoked' — derived from expires_at / revoked_at. */
  status: z.enum(['active', 'expired', 'revoked']),
  access_summary: ConnectionAccessSummary,
});

/**
 * PATCH /v1/agent-connections/{id} (extension) — rename or change the
 * collection grant of a selected_collections connection. Removing a
 * collection takes effect on the agent's very next call. Scopes and library
 * mode cannot be widened here; create a new connection instead.
 */
export const UpdateAgentConnectionRequest = z
  .strictObject({
    client_name: z.string().trim().min(1).max(80).optional(),
    collection_ids: z.array(Uuid).min(1).max(100).optional(),
  })
  .refine((v) => v.client_name !== undefined || v.collection_ids !== undefined, { message: 'Nothing to update' });
export type UpdateAgentConnectionRequest = z.infer<typeof UpdateAgentConnectionRequest>;
export type AgentConnectionDto = z.infer<typeof AgentConnectionDto>;

export const CreateAgentConnectionResponse = z.object({
  connection: AgentConnectionDto,
  /** Bearer credential, shown once. Format: "cat_<prefix>_<secret>". */
  credential: z.string(),
  /** Remote MCP endpoint for compatible clients (bearer auth). */
  mcp_url: z.string(),
});
export type CreateAgentConnectionResponse = z.infer<typeof CreateAgentConnectionResponse>;

/** GET /v1/agent-connections (extension: settings list). */
export const AgentConnectionsListResponse = z.object({ connections: z.array(AgentConnectionDto) });
export type AgentConnectionsListResponse = z.infer<typeof AgentConnectionsListResponse>;
