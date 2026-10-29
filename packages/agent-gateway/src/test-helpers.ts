import { randomUUID } from 'node:crypto';
import { agentConnections, collections, type AgentPrincipal, type DomainConfig, type PoolDb, type Scope, type ServiceContext } from '@culture-atlas/domain';
import { getTestDb, insertAccount, testConfig, testContext, testProviders } from '@culture-atlas/domain/testing';
import type { ProviderRegistry } from '@culture-atlas/providers';
// Test-only factories shared with the domain's own library tests.
import { insertCaptureWithAnalysis, insertItem, insertReference, saveDirect } from '../../domain/src/test-support/library';
import { connectMcp, type ToolCaller } from '../../../apps/demo-agent/src/client';
import { createMcpHandler } from './server';

/**
 * Fixtures for gateway tests: an account with a granted collection, an
 * ungranted collection and an unfiled save, plus helpers that speak to the
 * real MCP handler in-process (no network).
 */

export const MCP_URL = 'http://localhost:3000/mcp';

/** In-process MCP transport over the real handler (no network). */
export function mcpFetch(providers: ProviderRegistry = testProviders(), opts: { db?: PoolDb; config?: DomainConfig } = {}) {
  const handler = createMcpHandler({ db: opts.db ?? getTestDb(), config: opts.config ?? testConfig(), providers });
  return (input: string | URL, init?: RequestInit) => handler(new Request(input, init));
}

export async function mcpClient(token: string, providers?: ProviderRegistry): Promise<ToolCaller> {
  return connectMcp({ url: MCP_URL, token, fetch: mcpFetch(providers) });
}

/** One raw JSON-RPC POST (for HTTP-level assertions). */
export async function rawMcp(token: string | null, body: unknown, providers?: ProviderRegistry): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  return mcpFetch(providers)(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

export interface Library {
  owner: Awaited<ReturnType<typeof insertAccount>>;
  ownerCtx: ServiceContext;
  granted: { id: string; revision: number };
  other: { id: string };
  captureItem: string;
  artist: string;
  film: string;
  otherItem: string;
  unfiledItem: string;
  reference: string;
}

/** Account with "Tokyo evenings" (capture+artist+film), "Private" (one film) and an unfiled save. */
export async function buildLibrary(opts: { demoOwner?: boolean } = {}): Promise<Library> {
  const owner = await insertAccount(undefined, { isDemoOwner: opts.demoOwner ?? false });
  const ownerCtx = testContext(owner);
  const o = { accountId: owner.accountId };
  const reference = await insertReference({ name: 'Kissaten coffee culture', type: 'tradition', qloo: `ref-${randomUUID()}` });
  const cap = await insertCaptureWithAnalysis(o, { anchorIds: [reference], title: 'Café table' });
  const artist = await insertItem(o, { kind: 'artist', title: 'Haruomi Hosono', qloo: `artist-${randomUUID()}` });
  const film = await insertItem(o, { kind: 'film', title: 'Tampopo', year: 1985, qloo: `film-${randomUUID()}` });
  const otherItem = await insertItem(o, { kind: 'film', title: 'Private film', qloo: `film-${randomUUID()}` });
  const unfiledItem = await insertItem(o, { kind: 'artist', title: 'Unfiled artist', qloo: `artist-${randomUUID()}` });
  const granted = await collections.createCollection(ownerCtx, { name: 'Tokyo evenings' });
  for (const id of [cap.itemId, artist, film]) await collections.addCollectionItem(ownerCtx, { id: granted.id, item_id: id, body: {} });
  const other = await collections.createCollection(ownerCtx, { name: 'Private' });
  await collections.addCollectionItem(ownerCtx, { id: other.id, item_id: otherItem, body: {} });
  await saveDirect(owner.accountId, unfiledItem);
  const fresh = await collections.getCollection(ownerCtx, { id: granted.id, query: {} });
  return {
    owner,
    ownerCtx,
    granted: { id: granted.id, revision: fresh.collection.revision },
    other: { id: other.id },
    captureItem: cap.itemId,
    artist,
    film,
    otherItem,
    unfiledItem,
    reference,
  };
}

/** Create a connection through the real service (credential shown once). */
export async function connect(
  lib: Library,
  opts: { scopes?: Scope[]; library_access?: 'none' | 'selected_collections' | 'all'; collection_ids?: string[]; client_name?: string } = {},
): Promise<{ id: string; credential: string; principal: AgentPrincipal }> {
  const libraryAccess = opts.library_access ?? 'selected_collections';
  const res = await agentConnections.createAgentConnection(lib.ownerCtx, {
    client_name: opts.client_name ?? 'demo agent',
    scopes: opts.scopes ?? ['collections:read', 'taste:read', 'plans:read', 'plans:write', 'captures:read'],
    library_access: libraryAccess,
    collection_ids: libraryAccess === 'selected_collections' ? (opts.collection_ids ?? [lib.granted.id]) : [],
    expires_in_days: 30,
  });
  return {
    id: res.connection.id,
    credential: res.credential,
    principal: {
      kind: 'agent',
      accountId: lib.owner.accountId,
      connectionId: res.connection.id,
      clientName: res.connection.client_name,
      purpose: 'agent',
      scopes: res.connection.scopes,
      libraryAccess,
      allowedCollectionIds: res.connection.collection_ids,
      sensorConnectionId: null,
      expiresAt: new Date(res.connection.expires_at),
    },
  };
}

export { testProviders };
