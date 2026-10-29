import { randomUUID } from 'node:crypto';
import { FakeQloo } from '@culture-atlas/providers/testing';
import type { QlooEntity } from '@culture-atlas/providers';
import { afterAll, describe, expect, it } from 'vitest';
import type { Scope } from '../enums';
import type { AgentPrincipal } from '../principal';
import { revokeAgentConnection, updateAgentConnection } from '../services/agent-connections';
import { narrowConnection } from '../services/agent-platform';
import { resolvePrincipal } from '../services/auth';
import { addCollectionItem, createCollection } from '../services/collections';
import { startRelatedDiscovery } from '../services/items';
import { accountCtx, ctxFor, insertItem, runJob, saveDirect } from '../test-support/library';
import { closeTestDb, getTestDb, insertAgentConnection, testProviders } from '../testing';
import { INTEREST_GRAPH_POLICY_VERSION } from './schema';
import { discoveryGrantAuthorityForJob, requireDiscoveryGrantAuthorityForJob } from './scoped-discovery';
import { createGraphRun, graphRunForOwner } from './store';

/**
 * Durable grant authority for the approved grant-scoped Discover more branch
 * (approved 2026-10-29): the existing selected-collection REST
 * POST /v1/items/{id}/discoveries / MCP discover_related operation pins the
 * account owner, initiating agent connection, enqueue-time authorization
 * version, granted collection and origin item as an immutable authority tied
 * to both the discovery job and the queue job. Retry, redelivery and dedupe
 * cannot adopt a later grant epoch, owner or resource; revoke, narrow and
 * remove/regrant advance or otherwise invalidate the recorded epoch without
 * touching independent account-owned graph work; the legacy whole-library
 * operation keeps its unchanged shape and persists no authority.
 *
 * The DISC-SCR-030/031 repairs: a shared public sample saved into the exact
 * owner/granted collection stays an eligible origin, with private authority
 * bound through the owner's save row (never through the shared item's
 * ownership, which is never mutated, and never through an implicit save);
 * and the initiating epoch is VALIDATED under the enqueue lock — a stale
 * authenticated principal is not silently adopted at a narrowed epoch —
 * while unchanged versionless legacy principals keep the live-permission
 * policy.
 */

const db = getTestDb();
afterAll(closeTestDb);

const e = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: [], properties: {}, tags: [] });

function qloo(prefix: string) {
  return new FakeQloo(
    {
      insights: (req) => {
        const kind = req.filterType.split(':').pop();
        return { entities: Array.from({ length: 4 }, (_, i) => e(`${prefix}-${kind}-${i}`, `${kind} ${prefix} ${i}`)), tags: [] };
      },
    },
    { live: true },
  );
}

interface AuthorityRow {
  id: string;
  owner_account_id: string;
  discovery_job_id: string;
  job_id: string;
  agent_connection_id: string | null;
  authorization_version: number | null;
  collection_granted_at: Date | null;
  origin_collection_id: string;
  origin_item_id: string;
  origin_saved_item_id: string;
  created_at: Date;
}

async function authorities(ownerAccountId?: string): Promise<AuthorityRow[]> {
  const { rows } = await db.query<AuthorityRow>(
    `SELECT id, owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
            collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id, created_at
       FROM discovery_grant_authorities ${ownerAccountId ? 'WHERE owner_account_id = $1' : ''}
      ORDER BY created_at, id`,
    ownerAccountId ? [ownerAccountId] : [],
  );
  return rows;
}

/** The owner's save row that grounds an origin's membership in a collection. */
async function ownerSaveOf(accountId: string, itemId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
    [accountId, itemId],
  );
  return rows[0]!.id;
}

/**
 * Fails honestly on timeout, so a race barrier test cannot pass by racing
 * past the park: the mutator's in-flight query MUST be observed as a lock
 * waiter first (same discipline as the publication-fence races).
 */
async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND datname = current_database()`,
      [pattern],
    );
    if (Number(rows[0]!.n) >= atLeast) return;
    if (Date.now() >= deadline)
      throw new Error(`expected at least ${atLeast} lock waiter(s) matching ${pattern} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** One fresh scoped library: owner account + member collection + granted agent. */
async function scopedLibrary(input: { agentScopes?: Scope[]; libraryAccess?: 'all' | 'selected_collections' } = {}) {
  const { principal: owner, ctx } = await accountCtx();
  const prefix = randomUUID().slice(0, 6);
  const item = await insertItem({ accountId: owner.accountId }, { kind: 'film', title: `Scoped film ${prefix}`, qloo: `${prefix}-origin` });
  const col = await createCollection(ctx, { name: `Scoped ${prefix}` });
  await addCollectionItem(ctx, { id: col.id, item_id: item, body: {} });
  const libraryAccess = input.libraryAccess ?? 'selected_collections';
  const { principal: agent, credential } = await insertAgentConnection(owner, {
    scopes: input.agentScopes ?? (['collections:read', 'captures:read'] as Scope[]),
    libraryAccess,
    collectionIds: libraryAccess === 'all' ? [] : [col.id],
  });
  const actx = ctxFor(agent);
  const grants = await db.query<{ granted_at: Date }>(
    'SELECT granted_at FROM agent_connection_collections WHERE agent_connection_id = $1 AND collection_id = $2',
    [agent.connectionId, col.id],
  );
  return { owner, ctx, prefix, item, col, agent, credential, actx, grantedAt: grants.rows[0]?.granted_at ?? null };
}

/** An account-owned graph run: independent of any agent grant. */
async function accountOwnedRun(accountId: string) {
  return createGraphRun(db, { ownerAccountId: accountId, runKind: 'expansion', policyVersion: INTEREST_GRAPH_POLICY_VERSION });
}

describe('selected-collection enqueue pins the durable grant authority', () => {
  it('an agent scoped enqueue pins owner, connection, live version, grant epoch, collection, origin and both identities', async () => {
    const lib = await scopedLibrary();
    const started = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    // The REST/MCP response shape is unchanged.
    expect(Object.keys(started).sort()).toEqual(['discovery_job_id', 'job_id', 'reused']);
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a.owner_account_id).toBe(lib.owner.accountId);
    expect(a.agent_connection_id).toBe(lib.agent.connectionId);
    expect(a.authorization_version).toBe(1);
    expect(a.collection_granted_at).toEqual(lib.grantedAt);
    expect(a.origin_collection_id).toBe(lib.col.id);
    expect(a.origin_item_id).toBe(lib.item);
    expect(a.discovery_job_id).toBe(started.discovery_job_id);
    expect(a.job_id).toBe(started.job_id);
    // The pinned identities are real rows.
    const job = await db.query<{ type: string }>('SELECT type FROM jobs WHERE id = $1', [a.job_id]);
    expect(job.rows[0]!.type).toBe('discover_related');
    const dj = await db.query<{ origin_item_id: string; origin_collection_id: string; agent_connection_id: string | null }>(
      'SELECT origin_item_id, origin_collection_id, agent_connection_id FROM discovery_jobs WHERE id = $1',
      [a.discovery_job_id],
    );
    expect(dj.rows[0]).toEqual({ origin_item_id: lib.item, origin_collection_id: lib.col.id, agent_connection_id: lib.agent.connectionId });
  });

  it('an owner-initiated scoped enqueue records owner authority with no connection epoch', async () => {
    const lib = await scopedLibrary();
    const started = await startRelatedDiscovery(lib.ctx, { id: lib.item, body: { collection_id: lib.col.id } });
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_account_id: lib.owner.accountId,
      agent_connection_id: null,
      authorization_version: null,
      collection_granted_at: null,
      origin_collection_id: lib.col.id,
      origin_item_id: lib.item,
      discovery_job_id: started.discovery_job_id,
    });
  });

  it('a whole-library agent scoped enqueue pins the connection version with no per-collection grant timestamp', async () => {
    const lib = await scopedLibrary({ agentScopes: ['collections:read'], libraryAccess: 'all' });
    await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_connection_id: lib.agent.connectionId, authorization_version: 1, collection_granted_at: null });
  });

  it('legacy whole-library Discover more keeps its shape and persists no grant authority', async () => {
    const before = (await authorities()).length;
    const lib = await scopedLibrary();
    // Owner without a collection.
    const owner = await startRelatedDiscovery(lib.ctx, { id: lib.item, body: {} });
    expect(owner.reused).toBe(false);
    // Anonymous session (no collections exist for it).
    const anon = await accountCtx();
    const anonItem = await insertItem({ accountId: anon.principal.accountId }, { kind: 'film', qloo: `x-${randomUUID()}` });
    await startRelatedDiscovery(anon.ctx, { id: anonItem, body: {} });
    expect(await authorities()).toHaveLength(before);
  });
});

describe('retry, redelivery and dedupe cannot adopt a new grant epoch', () => {
  it('a dedupe reuse keeps the original grant epoch instead of adopting a later one', async () => {
    const lib = await scopedLibrary();
    const first = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    // Real owner narrowing advances the connection authorization version without touching the grant list.
    await narrowConnection(lib.ctx, lib.agent.connectionId, { scopes: ['collections:read'] });
    const version = (
      await db.query<{ authorization_version: number }>('SELECT authorization_version FROM agent_connections WHERE id = $1', [lib.agent.connectionId])
    ).rows[0]!.authorization_version;
    expect(version).toBe(2);
    const second = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    expect(second.reused).toBe(true);
    expect(second.job_id).toBe(first.job_id);
    expect(second.discovery_job_id).toBe(first.discovery_job_id);
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorization_version).toBe(1);
    expect(rows[0]!.collection_granted_at).toEqual(lib.grantedAt);
  });

  it('running the enqueued job to completion never rewrites the persisted authority', async () => {
    const lib = await scopedLibrary();
    const started = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    const before = (await authorities(lib.owner.accountId))[0]!;
    const out = await runJob(started.job_id, { providers: testProviders({ qloo: qloo(lib.prefix) }) });
    expect(out.state).toBe('complete');
    expect((await authorities(lib.owner.accountId))[0]).toEqual(before);
  });

  it('the database rejects any in-place rewrite of the persisted authority', async () => {
    const lib = await scopedLibrary();
    await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    const a = (await authorities(lib.owner.accountId))[0]!;
    await expect(db.query('UPDATE discovery_grant_authorities SET authorization_version = 99 WHERE id = $1', [a.id])).rejects.toThrow(/immutable/);
    await expect(
      db.query('UPDATE discovery_grant_authorities SET origin_item_id = $2 WHERE id = $1', [a.id, randomUUID()]),
    ).rejects.toThrow(/immutable/);
    await expect(db.query('UPDATE discovery_grant_authorities SET agent_connection_id = NULL WHERE id = $1', [a.id])).rejects.toThrow(/immutable/);
    expect((await authorities(lib.owner.accountId))[0]).toEqual(a);
  });

  it('two concurrent identical enqueues converge on one job and one authority', async () => {
    const lib = await scopedLibrary();
    const [r1, r2] = await Promise.all([
      startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } }),
      startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } }),
    ]);
    expect(r1.job_id).toBe(r2.job_id);
    expect(r1.discovery_job_id).toBe(r2.discovery_job_id);
    expect([r1.reused, r2.reused].filter(Boolean)).toHaveLength(1);
    expect(await authorities(lib.owner.accountId)).toHaveLength(1);
  });
});

describe('revoke, narrow and remove/regrant transitions', () => {
  it('revocation fails new scoped enqueues closed and changes neither persisted authority nor account-owned work', async () => {
    const lib = await scopedLibrary();
    await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id } });
    const run = await accountOwnedRun(lib.owner.accountId);
    const before = (await authorities(lib.owner.accountId))[0]!;
    await revokeAgentConnection(lib.ctx, { id: lib.agent.connectionId });
    // The persisted authority and account-owned graph work are untouched.
    expect((await authorities(lib.owner.accountId))[0]).toEqual(before);
    expect(await graphRunForOwner(db, { runId: run.id, ownerAccountId: lib.owner.accountId })).toEqual(run);
    // A fresh-key scoped enqueue fails closed on the live connection state.
    await expect(
      startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } }),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    expect(await authorities(lib.owner.accountId)).toHaveLength(1);
    const jobs = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM discovery_jobs WHERE owner_account_id = $1', [lib.owner.accountId]);
    expect(jobs.rows[0]!.n).toBe(1);
  });

  it('narrowing the collection grant away fails new enqueues non-disclosing and touches nothing persisted', async () => {
    const lib = await scopedLibrary();
    await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id } });
    const run = await accountOwnedRun(lib.owner.accountId);
    const before = (await authorities(lib.owner.accountId))[0]!;
    // Real owner grant replacement removing the scoped collection. The payload
    // is route-valid for the public v1 schema (collection_ids min(1)): the
    // replacement retains a second owned collection instead of an empty list.
    const keep = await createCollection(lib.ctx, { name: `Kept ${lib.prefix}` });
    await updateAgentConnection(lib.ctx, { id: lib.agent.connectionId, body: { collection_ids: [keep.id] } });
    // The next request's fresh principal sees no grant...
    const narrowed: AgentPrincipal = { ...lib.agent, allowedCollectionIds: [] };
    await expect(
      startRelatedDiscovery(ctxFor(narrowed), { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // ...and even a stale principal is caught by the enqueue-time grant epoch read.
    await expect(
      startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'play' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await authorities(lib.owner.accountId))[0]).toEqual(before);
    expect(await graphRunForOwner(db, { runId: run.id, ownerAccountId: lib.owner.accountId })).toEqual(run);
  });

  it('remove/regrant advances the recorded epoch for fresh work while older authority stays pinned', async () => {
    const lib = await scopedLibrary();
    const j1 = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    const j2 = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'play' } });
    const run = await accountOwnedRun(lib.owner.accountId);
    // The owner removes the collection grant and grants it again (the real v1
    // replace path). Both payloads are route-valid for the public v1 schema
    // (collection_ids min(1)): the replacement retains a second collection.
    const keep = await createCollection(lib.ctx, { name: `Kept ${lib.prefix}` });
    await updateAgentConnection(lib.ctx, { id: lib.agent.connectionId, body: { collection_ids: [keep.id] } });
    await updateAgentConnection(lib.ctx, { id: lib.agent.connectionId, body: { collection_ids: [keep.id, lib.col.id] } });
    const newGrant = (
      await db.query<{ granted_at: Date }>(
        'SELECT granted_at FROM agent_connection_collections WHERE agent_connection_id = $1 AND collection_id = $2',
        [lib.agent.connectionId, lib.col.id],
      )
    ).rows[0]!.granted_at;
    expect(newGrant > lib.grantedAt!).toBe(true);
    // Fresh scoped work records the new grant epoch; older rows keep theirs.
    const regranted: AgentPrincipal = { ...lib.agent, allowedCollectionIds: [lib.col.id] };
    const j3 = await startRelatedDiscovery(ctxFor(regranted), { id: lib.item, body: { collection_id: lib.col.id, category: 'eat' } });
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(3);
    const byJob = new Map(rows.map((r) => [r.discovery_job_id, r]));
    expect(byJob.get(j1.discovery_job_id)!.collection_granted_at).toEqual(lib.grantedAt);
    expect(byJob.get(j2.discovery_job_id)!.collection_granted_at).toEqual(lib.grantedAt);
    expect(byJob.get(j3.discovery_job_id)!.collection_granted_at).toEqual(newGrant);
    // The v1 replace does not bump the version; the grant timestamp carries the epoch.
    expect(byJob.get(j3.discovery_job_id)!.authorization_version).toBe(1);
    expect(await graphRunForOwner(db, { runId: run.id, ownerAccountId: lib.owner.accountId })).toEqual(run);
  });
});

describe('shared public sample origins stay eligible through the owner-bound save', () => {
  it('a public sample saved into the granted collection enqueues under owner-bound save authority', async () => {
    const lib = await scopedLibrary();
    // A reviewed public sample: a shared, ownerless discovery item (is_sample).
    const sample = await insertItem(null, { kind: 'film', title: `Sample film ${lib.prefix}` });
    await addCollectionItem(lib.ctx, { id: lib.col.id, item_id: sample, body: {} });
    const savedItemId = await ownerSaveOf(lib.owner.accountId, sample);
    const started = await startRelatedDiscovery(lib.actx, { id: sample, body: { collection_id: lib.col.id, category: 'watch' } });
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_account_id: lib.owner.accountId,
      agent_connection_id: lib.agent.connectionId,
      origin_collection_id: lib.col.id,
      origin_item_id: sample,
      origin_saved_item_id: savedItemId,
      discovery_job_id: started.discovery_job_id,
      job_id: started.job_id,
    });
    // The shared sample itself is never mutated: still ownerless, still a
    // sample, and exactly the one save the owner made (no implicit save).
    const item = await db.query<{ owner_account_id: string | null; is_sample: boolean }>(
      'SELECT owner_account_id, is_sample FROM discovery_items WHERE id = $1',
      [sample],
    );
    expect(item.rows[0]).toEqual({ owner_account_id: null, is_sample: true });
    const saves = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [lib.owner.accountId, sample],
    );
    expect(saves.rows[0]!.n).toBe(1);
  });

  it('an owner-initiated sample enqueue records the same owner-bound authority without a connection epoch', async () => {
    const lib = await scopedLibrary();
    const sample = await insertItem(null, { kind: 'film', title: `Sample film ${lib.prefix}` });
    await addCollectionItem(lib.ctx, { id: lib.col.id, item_id: sample, body: {} });
    const savedItemId = await ownerSaveOf(lib.owner.accountId, sample);
    const started = await startRelatedDiscovery(lib.ctx, { id: sample, body: { collection_id: lib.col.id } });
    const rows = await authorities(lib.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agent_connection_id: null,
      authorization_version: null,
      collection_granted_at: null,
      origin_item_id: sample,
      origin_saved_item_id: savedItemId,
      discovery_job_id: started.discovery_job_id,
    });
  });

  it('a sample origin runs the enqueued job graph-off without touching the shared item', async () => {
    const lib = await scopedLibrary();
    const sample = await insertItem(null, { kind: 'film', title: `Sample film ${lib.prefix}` });
    await addCollectionItem(lib.ctx, { id: lib.col.id, item_id: sample, body: {} });
    const started = await startRelatedDiscovery(lib.actx, { id: sample, body: { collection_id: lib.col.id, category: 'watch' } });
    const out = await runJob(started.job_id, { providers: testProviders({ qloo: qloo(lib.prefix) }) });
    expect(['complete', 'partial']).toContain(out.state);
    const item = await db.query<{ owner_account_id: string | null; is_sample: boolean }>(
      'SELECT owner_account_id, is_sample FROM discovery_items WHERE id = $1',
      [sample],
    );
    expect(item.rows[0]).toEqual({ owner_account_id: null, is_sample: true });
  });

  it('a foreign private item is never admitted as a scoped origin: not_found, nothing persisted', async () => {
    const foreign = await accountCtx();
    const foreignItem = await insertItem({ accountId: foreign.principal.accountId }, { kind: 'film', qloo: `x-${randomUUID()}` });
    const lib = await scopedLibrary();
    // Corrupted state no product path can create (visibility blocks it): the
    // owner's collection somehow holds a membership of a foreign private item.
    await saveDirect(lib.owner.accountId, foreignItem, [lib.col.id]);
    const before = (await authorities()).length;
    await expect(
      startRelatedDiscovery(lib.actx, { id: foreignItem, body: { collection_id: lib.col.id, category: 'watch' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await authorities()).toHaveLength(before);
  });
});

describe('the initiating epoch is validated under the enqueue lock', () => {
  it('a stale authenticated principal is not adopted at a narrowed epoch: rejects without jobs, quota or authority rows', async () => {
    const lib = await scopedLibrary();
    // The request was authenticated while the connection held version 1 with
    // collections:read + captures:read: the per-request principal resolution
    // pins the live version at authentication time.
    const authenticated = await resolvePrincipal(db, { authorization: `Bearer ${lib.credential}` });
    expect(authenticated).toMatchObject({ kind: 'agent', authorizationVersion: 1 });
    // The real owner narrow lands before the request reaches the enqueue
    // lock: the collection grant stays, collections:read is gone (version 2).
    await narrowConnection(lib.ctx, lib.agent.connectionId, { scopes: ['captures:read'] });
    await expect(
      startRelatedDiscovery(ctxFor(authenticated!), { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } }),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    // Stale authenticated requests reject WITHOUT jobs, quota or authority rows.
    expect(await authorities(lib.owner.accountId)).toHaveLength(0);
    const djs = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM discovery_jobs WHERE owner_account_id = $1',
      [lib.owner.accountId],
    );
    expect(djs.rows[0]!.n).toBe(0);
    const jobs = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM jobs WHERE owner_account_id = $1', [
      lib.owner.accountId,
    ]);
    expect(jobs.rows[0]!.n).toBe(0);
    const quota = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM usage_counters WHERE bucket = $1 AND metric = $2',
      [`account:${lib.owner.accountId}`, 'analyses'],
    );
    expect(quota.rows[0]!.n).toBe(0);
  });

  it('an unchanged versionless legacy principal retains the live-permission policy', async () => {
    const lib = await scopedLibrary();
    // v1 in-process callers carry no authorization version: their authority is
    // the LIVE permission state, revalidated under the enqueue lock.
    expect(lib.agent.authorizationVersion).toBeUndefined();
    const first = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    expect(first.reused).toBe(false);
    expect((await authorities(lib.owner.accountId))[0]).toMatchObject({
      agent_connection_id: lib.agent.connectionId,
      authorization_version: 1,
    });
    // The live scope later narrows away collections:read: a versionless
    // principal's cached scopes are never trusted, the live permission fails.
    await narrowConnection(lib.ctx, lib.agent.connectionId, { scopes: ['captures:read'] });
    const cachedStillReadable: AgentPrincipal = { ...lib.agent, scopes: ['collections:read', 'captures:read'] };
    await expect(
      startRelatedDiscovery(ctxFor(cachedStillReadable), { id: lib.item, body: { collection_id: lib.col.id, category: 'play' } }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    expect(await authorities(lib.owner.accountId)).toHaveLength(1);
    expect((await authorities(lib.owner.accountId))[0]!.authorization_version).toBe(1);
  });

  it('the enqueue-before-narrowing barrier: a committed enqueue pins its epoch; dedupe reuse and fresh work never adopt the newer one', async () => {
    const lib = await scopedLibrary();
    // The request that will go stale after the enqueue commits below.
    const stale = await resolvePrincipal(db, { authorization: `Bearer ${lib.credential}` });
    expect(stale).toMatchObject({ kind: 'agent', authorizationVersion: 1 });
    // The enqueue commits FIRST, pinning its epoch.
    const first = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    // The real owner narrow lands AFTER that commit (version 2, collections:read preserved).
    await narrowConnection(lib.ctx, lib.agent.connectionId, { scopes: ['collections:read'] });
    expect((await authorities(lib.owner.accountId))).toHaveLength(1);
    expect((await authorities(lib.owner.accountId))[0]!.authorization_version).toBe(1);
    // A request re-authenticated at version 2 dedupe-reuses the v1-authority
    // job: reuse adopts nothing, and the pinned epoch never moves.
    const fresh = await resolvePrincipal(db, { authorization: `Bearer ${lib.credential}` });
    expect(fresh).toMatchObject({ kind: 'agent', authorizationVersion: 2 });
    const second = await startRelatedDiscovery(ctxFor(fresh!), { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    expect(second.reused).toBe(true);
    expect(second.job_id).toBe(first.job_id);
    expect(second.discovery_job_id).toBe(first.discovery_job_id);
    expect((await authorities(lib.owner.accountId))[0]!.authorization_version).toBe(1);
    // The stale version-1 principal is rejected on a fresh key too: a
    // narrowed/stale initiating principal is never silently adopted at the
    // new enqueue epoch.
    await expect(
      startRelatedDiscovery(ctxFor(stale!), { id: lib.item, body: { collection_id: lib.col.id, category: 'play' } }),
    ).rejects.toMatchObject({ code: 'token_revoked' });
    expect(await authorities(lib.owner.accountId)).toHaveLength(1);
    expect((await authorities(lib.owner.accountId))[0]!.authorization_version).toBe(1);
  });

  it('the real enqueue lock serializes the owner narrow with the enqueue: both orders converge safely', async () => {
    const lib = await scopedLibrary();
    // A versioned request principal, authenticated at the live version 1.
    const authenticated = await resolvePrincipal(db, { authorization: `Bearer ${lib.credential}` });
    // The in-flight enqueue's connection row lock, held exactly as the enqueue
    // transaction holds it (FOR UPDATE through its commit).
    const holder = await db.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM agent_connections WHERE id = $1 AND owner_account_id = $2 FOR UPDATE', [
        lib.agent.connectionId,
        lib.owner.accountId,
      ]);
      // Both the real owner narrow and the real enqueue queue behind the lock.
      const narrow = narrowConnection(lib.ctx, lib.agent.connectionId, { scopes: ['captures:read'] });
      await waitForLockWaiters('%agent_connections%', 1);
      const enqueue = startRelatedDiscovery(ctxFor(authenticated!), {
        id: lib.item,
        body: { collection_id: lib.col.id, category: 'watch' },
      });
      await waitForLockWaiters('%agent_connections%', 2);
      // Release the holder: the two real waiters now race for the lock in
      // EITHER order, and both orders must converge on a safe state.
      await holder.query('ROLLBACK');
      const [, enqueued] = await Promise.allSettled([narrow, enqueue]);
      // The narrow always lands (version 2).
      const conn = await db.query<{ v: number }>('SELECT authorization_version AS v FROM agent_connections WHERE id = $1', [
        lib.agent.connectionId,
      ]);
      expect(conn.rows[0]!.v).toBe(2);
      const rows = await authorities(lib.owner.accountId);
      if (rows.length > 0) {
        // The enqueue won the lock: its authority pinned the pre-narrow
        // epoch, and the later narrow can never rewrite it.
        expect(rows).toHaveLength(1);
        expect(rows[0]!.authorization_version).toBe(1);
        expect(enqueued.status).toBe('fulfilled');
      } else {
        // The narrow won the lock: the stale version-1 request rejected
        // closed, with no job, quota or authority rows.
        expect(enqueued.status).toBe('rejected');
      }
    } finally {
      holder.release();
    }
  });
});

describe('authorization matrix and legacy compatibility', () => {
  it('the existing permission matrix gates the authority: denied scoped enqueues persist nothing', async () => {
    const before = (await authorities()).length;
    // No collections:read scope.
    const noScope = await scopedLibrary({ agentScopes: [] });
    await expect(startRelatedDiscovery(noScope.actx, { id: noScope.item, body: { collection_id: noScope.col.id } })).rejects.toMatchObject({
      code: 'scope_denied',
    });
    // A foreign collection is indistinguishable from a missing one.
    const a = await scopedLibrary();
    const b = await scopedLibrary();
    await expect(startRelatedDiscovery(a.actx, { id: a.item, body: { collection_id: b.col.id, category: 'watch' } })).rejects.toMatchObject({
      code: 'not_found',
    });
    // Grant-limited agents must pass their collection (existing invalid_input shape).
    await expect(startRelatedDiscovery(a.actx, { id: a.item, body: {} })).rejects.toMatchObject({ code: 'invalid_input' });
    // An origin outside the granted collection.
    const outside = await insertItem({ accountId: a.owner.accountId }, { kind: 'film', qloo: `x-${randomUUID()}` });
    await expect(startRelatedDiscovery(a.actx, { id: outside, body: { collection_id: a.col.id, category: 'play' } })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await authorities()).toHaveLength(before);
  });

  it('database constraints bind the authority to its owner and one authority per discovery', async () => {
    const lib = await scopedLibrary();
    const started = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    const savedItemId = await ownerSaveOf(lib.owner.accountId, lib.item);
    // A legacy (non-collection) discovery carries no authority; its real rows anchor the constraint checks.
    const legacy = await startRelatedDiscovery(lib.ctx, { id: lib.item, body: { category: 'eat' } });
    const other = await accountCtx();
    // A different owner cannot adopt the discovery's authority.
    await expect(
      db.query(
        `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, origin_collection_id, origin_item_id, origin_saved_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [other.principal.accountId, legacy.discovery_job_id, legacy.job_id, lib.col.id, lib.item, savedItemId],
      ),
    ).rejects.toThrow(/violates foreign key/);
    // Exactly one authority per discovery job.
    await expect(
      db.query(
        `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, origin_collection_id, origin_item_id, origin_saved_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [lib.owner.accountId, started.discovery_job_id, started.job_id, lib.col.id, lib.item, savedItemId],
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/);
    // An initiating connection is recorded together with its authorization version.
    await expect(
      db.query(
        `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, agent_connection_id, origin_collection_id, origin_item_id, origin_saved_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [lib.owner.accountId, legacy.discovery_job_id, legacy.job_id, lib.agent.connectionId, lib.col.id, lib.item, savedItemId],
      ),
    ).rejects.toThrow(/check constraint/);
    // An owner-only authority cannot claim a grant timestamp.
    await expect(
      db.query(
        `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [lib.owner.accountId, legacy.discovery_job_id, legacy.job_id, new Date(), lib.col.id, lib.item, savedItemId],
      ),
    ).rejects.toThrow(/check constraint/);
    // The pinned origin item must be exactly the pinned save's own item: a
    // private authority cannot pair one owner's save with another item.
    const otherOwned = await insertItem({ accountId: lib.owner.accountId }, { kind: 'film', qloo: `x-${randomUUID()}` });
    await expect(
      db.query(
        `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, origin_collection_id, origin_item_id, origin_saved_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [lib.owner.accountId, legacy.discovery_job_id, legacy.job_id, lib.col.id, otherOwned, savedItemId],
      ),
    ).rejects.toThrow(/violates foreign key/);
    // The pinned save must be the owner's own save row, never a foreign one.
    const foreignSave = await saveDirect(other.principal.accountId, otherOwned);
    await expect(
      db.query(
        `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, origin_collection_id, origin_item_id, origin_saved_item_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [lib.owner.accountId, legacy.discovery_job_id, legacy.job_id, lib.col.id, otherOwned, foreignSave],
      ),
    ).rejects.toThrow(/violates foreign key/);
    expect(started.reused).toBe(false);
  });

  it('the typed reader resolves only real discover_related jobs for their owner', async () => {
    const lib = await scopedLibrary();
    const started = await startRelatedDiscovery(lib.actx, { id: lib.item, body: { collection_id: lib.col.id, category: 'watch' } });
    const resolved = await requireDiscoveryGrantAuthorityForJob(db, {
      ownerAccountId: lib.owner.accountId,
      discoveryJobId: started.discovery_job_id,
    });
    expect(resolved.job_type).toBe('discover_related');
    expect(resolved.job_state).toBe('queued');
    expect(resolved.authorization_version).toBe(1);
    expect(resolved.origin_collection_id).toBe(lib.col.id);
    expect(resolved.agent_connection_id).toBe(lib.agent.connectionId);
    // Foreign owners resolve nothing (non-disclosing).
    const other = await accountCtx();
    await expect(
      requireDiscoveryGrantAuthorityForJob(db, { ownerAccountId: other.principal.accountId, discoveryJobId: started.discovery_job_id }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // A legacy discovery not produced by the scoped operation has no authority.
    const legacy = await startRelatedDiscovery(lib.ctx, { id: lib.item, body: { category: 'eat' } });
    expect(await discoveryGrantAuthorityForJob(db, { ownerAccountId: lib.owner.accountId, discoveryJobId: legacy.discovery_job_id })).toBeNull();
    // An authority pointing at a non-discover_related job is not a supported scoped graph job.
    const foreignJob = await db.query<{ id: string }>(
      `INSERT INTO jobs (owner_account_id, type, payload, budget)
       VALUES ($1, 'project_interest_graph', $2::jsonb, '{}'::jsonb) RETURNING id`,
      [lib.owner.accountId, JSON.stringify({ account_id: lib.owner.accountId })],
    );
    const dj = await db.query<{ id: string }>(
      'INSERT INTO discovery_jobs (owner_account_id, origin_item_id) VALUES ($1, $2) RETURNING id',
      [lib.owner.accountId, lib.item],
    );
    await db.query(
      `INSERT INTO discovery_grant_authorities (owner_account_id, discovery_job_id, job_id, origin_collection_id, origin_item_id, origin_saved_item_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [lib.owner.accountId, dj.rows[0]!.id, foreignJob.rows[0]!.id, lib.col.id, lib.item, await ownerSaveOf(lib.owner.accountId, lib.item)],
    );
    expect(
      await discoveryGrantAuthorityForJob(db, { ownerAccountId: lib.owner.accountId, discoveryJobId: dj.rows[0]!.id }),
    ).toMatchObject({ job_type: 'project_interest_graph' });
    await expect(
      requireDiscoveryGrantAuthorityForJob(db, { ownerAccountId: lib.owner.accountId, discoveryJobId: dj.rows[0]!.id }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
