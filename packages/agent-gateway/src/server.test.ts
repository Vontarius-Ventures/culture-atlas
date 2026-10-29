import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import {
  SCOPES,
  admitGraphCorpus,
  agentConnections,
  agentPlatform,
  collections,
  getCorpusManifestFile,
  items,
  linkGraphReferenceIdentities,
  retractGraphEvidence,
} from '@culture-atlas/domain';
import {
  closeTestDb,
  createIsolatedDatabase,
  getTestDb,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
  testProviders,
} from '@culture-atlas/domain/testing';
import { upsertReference } from '../../domain/src/compiler/store';
import { GraphWorkDeadlineExpiredError } from '../../domain/src/interest-graph/budgets';
import { ensureSampleItems, sampleKey } from '../../domain/src/feed/samples';
import { gatedReadDb, insertItem, runClaimedAttempt, runJob } from '../../domain/src/test-support/library';
import { connectMcp, ConnectionRefusedError } from '../../../apps/demo-agent/src/client';
import { SPEC_TOOL_NAMES } from './tools';
import { errorDetailText } from './server';
import { MCP_URL, buildLibrary, connect, mcpClient, mcpFetch, rawMcp } from './test-helpers';

const db = getTestDb();
const errBody = async (r: Response) => (await r.json()) as { code: string };
afterAll(closeTestDb);

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
};

describe('MCP transport and bearer auth', () => {
  it('lists exactly the spec tools with JSON input schemas', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib, { scopes: [...SCOPES], library_access: 'all' });
    const client = await mcpClient(credential);
    try {
      expect((await client.listTools()).sort()).toEqual([...SPEC_TOOL_NAMES].sort());
    } finally {
      await client.close();
    }
  });

  it('lists only the tools a narrower connection can call', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib);
    const client = await mcpClient(credential);
    try {
      const names = await client.listTools();
      expect(names).toEqual(expect.arrayContaining(['get_item', 'list_captures', 'get_discoveries', 'list_plans', 'get_plan']));
      for (const hidden of ['begin_upload', 'request_capture', 'update_preferences', 'create_collection', 'record_preference'])
        expect(names).not.toContain(hidden);
    } finally {
      await client.close();
    }
  });

  it('records v1 mutations in the owner’s agent activity with readable targets', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib, { scopes: [...SCOPES], library_access: 'all' });
    const client = await mcpClient(credential);
    try {
      const created = await client.callTool<{ id: string }>('create_collection', { name: 'Dinner party' });
      expect(created.ok).toBe(true);
      const id = created.ok ? created.data.id : '';
      expect((await client.callTool('add_collection_item', { collection_id: id, item_id: lib.film })).ok).toBe(true);
      const recent = await client.callTool<{ items: { title: string | null; recommendation_item_ids: string[] }[] }>('list_captures', {});
      expect(recent.ok && recent.data.items[0]?.title).toBe('Café table');
    } finally {
      await client.close();
    }
    const activity = await agentPlatform.getActivity(lib.ownerCtx);
    const actions = activity.items.map((i) => [i.action, i.target_label]);
    expect(actions).toEqual(expect.arrayContaining([['collections.create', 'Dinner party'], ['collections.add_item', 'Dinner party']]));
  });

  it('puts invalid fields and missing scopes into the error text models read', () => {
    expect(errorDetailText({ issues: [{ path: 'target_id', message: 'Required' }, { path: '', message: 'Unrecognized key: "item_id"' }] }))
      .toBe('target_id: Required; Unrecognized key: "item_id"');
    expect(errorDetailText({ missing_scopes: ['collections:write'] })).toBe('needs collections:write');
    expect(errorDetailText(undefined, ['taste:write'])).toBe('needs taste:write');
  });

  it('refuses missing, unknown, revoked and expired tokens at the HTTP layer with REST codes', async () => {
    const none = await rawMcp(null, INIT);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect(await none.json()).toMatchObject({ code: 'unauthenticated', retryable: false });

    const unknown = await rawMcp('cat_deadbeef_notarealtoken0000000000', INIT);
    expect(unknown.status).toBe(401);
    expect((await errBody(unknown)).code).toBe('unauthenticated');

    const lib = await buildLibrary();
    const c = await connect(lib);
    expect((await rawMcp(c.credential, INIT)).status).toBe(200);
    await agentConnections.revokeAgentConnection(lib.ownerCtx, { id: c.id });
    const revoked = await rawMcp(c.credential, INIT);
    expect(revoked.status).toBe(401);
    expect((await errBody(revoked)).code).toBe('token_revoked');

    const e = await connect(lib);
    await db.query(`UPDATE agent_connections SET expires_at = now() - interval '1 minute' WHERE id = $1`, [e.id]);
    const expired = await rawMcp(e.credential, INIT);
    expect(expired.status).toBe(401);
    expect((await errBody(expired)).code).toBe('token_expired');
  });

  it('refuses the sensor-bridge token entirely and allows only POST', async () => {
    const account = await insertAccount();
    const { credential, principal } = await insertAgentConnection(account, { scopes: ['captures:write'], libraryAccess: 'none' });
    await db.query(`UPDATE agent_connections SET purpose = 'sensor_bridge' WHERE id = $1`, [principal.connectionId]);
    const res = await rawMcp(credential, INIT);
    expect(res.status).toBe(403);
    expect((await errBody(res)).code).toBe('scope_denied');

    const lib = await buildLibrary();
    const c = await connect(lib);
    const { mcpFetch, MCP_URL } = await import('./test-helpers');
    const get = await mcpFetch()(MCP_URL, { method: 'GET', headers: { authorization: `Bearer ${c.credential}` } });
    expect(get.status).toBe(405);
  });
});

describe('selected-collection grant over MCP', () => {
  it('sees only granted collections and items; unfiled saves, other collections and global taste stay private', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib);
    const client = await mcpClient(credential);
    try {
      const list = await client.callTool<{ collections: { id: string }[]; unfiled: unknown }>('list_collections', {});
      expect(list.ok && list.data.collections.map((c) => c.id)).toEqual([lib.granted.id]);
      expect(list.ok && list.data.unfiled).toBeNull();

      const granted = await client.callTool<{ items: { item: { id: string } }[] }>('get_collection', { collection_id: lib.granted.id });
      expect(granted.ok && granted.data.items.map((m) => m.item.id).sort()).toEqual([lib.captureItem, lib.artist, lib.film].sort());

      const other = await client.callTool('get_collection', { collection_id: lib.other.id });
      expect(other).toMatchObject({ ok: false, error: { code: 'not_found' } });

      const globalTaste = await client.callTool('get_taste', {});
      expect(globalTaste).toMatchObject({ ok: false, error: { code: 'scope_denied' } });
      const scoped = await client.callTool<{ scope: string; interests: { item_id: string | null }[] }>('get_taste', { collection_id: lib.granted.id });
      expect(scoped.ok && scoped.data.scope).toBe('collection');
      const tasteItems = scoped.ok ? scoped.data.interests.map((i) => i.item_id) : [];
      expect(tasteItems).not.toContain(lib.unfiledItem);
      expect(tasteItems).not.toContain(lib.otherItem);
      expect(await client.callTool('get_taste', { collection_id: lib.other.id })).toMatchObject({ ok: false, error: { code: 'not_found' } });

      // Related discovery from an unfiled or ungranted item is indistinguishable from a missing item.
      for (const item of [lib.unfiledItem, lib.otherItem]) {
        expect(await client.callTool('discover_related', { item_id: item, collection_id: lib.granted.id })).toMatchObject({
          ok: false,
          error: { code: 'not_found' },
        });
      }
      expect(await client.callTool('discover_related', { item_id: lib.otherItem, collection_id: lib.other.id })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    } finally {
      await client.close();
    }
  });

  it('new collections are not auto-granted; destructive/global actions need whole-library access', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib, {
      scopes: ['collections:read', 'collections:write', 'taste:read', 'taste:write', 'captures:read', 'captures:write'],
    });
    const later = await collections.createCollection(lib.ownerCtx, { name: 'Made later' });
    const client = await mcpClient(credential);
    try {
      const list = await client.callTool<{ collections: { id: string }[] }>('list_collections', {});
      expect(list.ok && list.data.collections.map((c) => c.id)).not.toContain(later.id);
      expect(await client.callTool('get_collection', { collection_id: later.id })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect(await client.callTool('create_collection', { name: 'Agent made' })).toMatchObject({ ok: false, error: { code: 'scope_denied' } });
      expect(await client.callTool('record_preference', { action: 'remove', target_id: lib.artist })).toMatchObject({
        ok: false,
        error: { code: 'scope_denied' },
      });
      expect(await client.callTool('record_preference', { action: 'hide', target_id: lib.artist })).toMatchObject({
        ok: false,
        error: { code: 'scope_denied' },
      });
      // Membership removal inside a granted collection is allowed with collections:write.
      const removed = await client.callTool('remove_collection_item', { collection_id: lib.granted.id, item_id: lib.film });
      expect(removed.ok).toBe(true);
      // Adding an item from outside the grant is refused as not found.
      expect(await client.callTool('add_collection_item', { collection_id: lib.granted.id, item_id: lib.unfiledItem })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      });
    } finally {
      await client.close();
    }
  });

  it('whole-library agents can create a collection that their grant then covers', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib, { library_access: 'all', scopes: ['collections:read', 'collections:write'] });
    const client = await mcpClient(credential);
    try {
      const made = await client.callTool<{ id: string }>('create_collection', { name: 'Agent picks' });
      expect(made.ok).toBe(true);
      const id = made.ok ? made.data.id : '';
      expect((await client.callTool('get_collection', { collection_id: id })).ok).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('discover_related works for a saved public sample origin under the same grant, without mutating the sample', async () => {
    const lib = await buildLibrary();
    // A reviewed public sample (ownerless shared item) saved into the granted
    // collection: the legitimate selected-collection origin of DISC-SCR-030.
    const sample = await insertItem(null, { kind: 'film', title: 'In the Mood for Love' });
    await collections.addCollectionItem(lib.ownerCtx, { id: lib.granted.id, item_id: sample, body: {} });
    const { credential } = await connect(lib);
    const client = await mcpClient(credential);
    try {
      const started = await client.callTool<{ job_id: string; discovery_job_id: string }>('discover_related', {
        item_id: sample,
        collection_id: lib.granted.id,
        category: 'watch',
      });
      expect(started.ok).toBe(true);
      const ids = started.ok ? started.data : { job_id: '', discovery_job_id: '' };
      expect(ids.job_id).not.toBe('');
      // The enqueued job runs the unchanged legacy path (graph-off) instead of
      // failing closed on the scoped enqueue.
      await runJob(ids.job_id);
      const job = await client.callTool<{ state: string }>('get_job', { job_id: ids.job_id });
      expect(['complete', 'partial']).toContain(job.ok ? job.data.state : '');
      // The durable authority pins the owner's save of the shared sample.
      const auth = await db.query<{ origin_saved_item_id: string }>(
        'SELECT origin_saved_item_id FROM discovery_grant_authorities WHERE discovery_job_id = $1',
        [ids.discovery_job_id],
      );
      const save = await db.query<{ id: string }>(
        'SELECT id FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
        [lib.owner.accountId, sample],
      );
      expect(auth.rows[0]!.origin_saved_item_id).toBe(save.rows[0]!.id);
      // The shared sample itself stays ownerless, and exactly one save of it
      // exists (no implicit second save, no ownership mutation).
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
    } finally {
      await client.close();
    }
  });

  it('revoking a collection grant or the connection takes effect on the next call', async () => {
    const lib = await buildLibrary();
    const c = await connect(lib, { collection_ids: [lib.granted.id, lib.other.id] });
    const client = await mcpClient(c.credential);
    try {
      expect((await client.callTool('get_collection', { collection_id: lib.other.id })).ok).toBe(true);
      await agentConnections.updateAgentConnection(lib.ownerCtx, { id: c.id, body: { collection_ids: [lib.granted.id] } });
      expect(await client.callTool('get_collection', { collection_id: lib.other.id })).toMatchObject({ ok: false, error: { code: 'not_found' } });
      expect((await client.callTool('get_collection', { collection_id: lib.granted.id })).ok).toBe(true);

      await agentConnections.revokeAgentConnection(lib.ownerCtx, { id: c.id });
      await expect(client.callTool('list_collections', {})).rejects.toSatisfy(
        (err: unknown) => err instanceof ConnectionRefusedError && err.code === 'token_revoked' && err.status === 401,
      );
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('validates tool input with the REST schema and treats argument text as data', async () => {
    const lib = await buildLibrary();
    const { credential } = await connect(lib);
    const client = await mcpClient(credential);
    try {
      expect(await client.callTool('get_collection', { collection_id: 'not-a-uuid' })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await client.callTool('get_collection', { collection_id: lib.granted.id, extra: 1 })).toMatchObject({
        ok: false,
        error: { code: 'invalid_input' },
      });
      expect(await client.callTool('analyze_capture', { url: 'http://169.254.169.254/latest' })).toMatchObject({ ok: false });
      expect(await client.callTool('no_such_tool', {})).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    } finally {
      await client.close();
    }
  });
});

describe('agent tool-call traces', () => {
  it('records each call with redacted arguments and no credentials', async () => {
    const lib = await buildLibrary();
    const c = await connect(lib);
    const client = await mcpClient(c.credential);
    try {
      await client.callTool('get_collection', { collection_id: lib.granted.id });
      await client.callTool('get_collection', { collection_id: lib.other.id });
    } finally {
      await client.close();
    }
    const { rows } = await db.query<{ name: string; data: Record<string, unknown>; owner_account_id: string; job_id: string | null }>(
      `SELECT name, data, owner_account_id, job_id FROM trace_events WHERE agent_connection_id = $1 AND kind = 'agent_tool_call' ORDER BY created_at`,
      [c.id],
    );
    expect(rows.map((r) => [r.name, r.data.outcome])).toEqual([
      ['get_collection', 'ok'],
      ['get_collection', 'error'],
    ]);
    expect(rows[1]!.data).toMatchObject({ error_code: 'not_found', refs: [] });
    expect(rows[0]!.data.refs).toContain(lib.granted.id);
    expect(rows.every((r) => r.owner_account_id === lib.owner.accountId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(c.credential);
  });
});

describe('scoped Discover more graph branch over MCP (VAL-DISC-008)', () => {
  it('the discover_related tool reaches the reviewed corpus path under the same grant with zero provider calls', async () => {
    const iso = await createIsolatedDatabase('scpmcp');
    try {
      await admitGraphCorpus(iso.db, getCorpusManifestFile());
      const graphOn = testConfig({
        INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
        INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
      });
      const owner = await insertAccount(iso.db);
      const ctx = testContext(owner, { db: iso.db, config: graphOn });
      const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
      const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
      const rodinRef = await upsertReference(iso.db, {
        canonicalKey: `qloo:${RODIN_QLOO_ID}`,
        name: 'Auguste Rodin',
        type: 'creator',
        externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      const seuratRef = await upsertReference(iso.db, {
        canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
        name: 'Georges Seurat',
        type: 'creator',
        externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      const origin = await insertItem(
        { accountId: owner.accountId },
        { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
        iso.db,
      );
      const col = await collections.createCollection(ctx, { name: 'Museum visits' });
      await collections.addCollectionItem(ctx, { id: col.id, item_id: origin, body: {} });
      await linkGraphReferenceIdentities(iso.db);
      const { credential } = await insertAgentConnection(
        owner,
        { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
        iso.db,
      );
      const qloo = new FakeQloo({}, { live: true });
      const providers = testProviders({ qloo });
      const client = await connectMcp({
        url: MCP_URL,
        token: credential,
        fetch: mcpFetch(providers, { db: iso.db, config: graphOn }),
      });
      try {
        // The MCP entrypoint enqueues the same pinned-authority scoped
        // discovery under its collections:read grant.
        const started = await client.callTool<{ job_id: string; discovery_job_id: string }>('discover_related', {
          item_id: origin,
          collection_id: col.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const { job_id, discovery_job_id } = started.ok ? started.data : { job_id: '', discovery_job_id: '' };
        expect(job_id).not.toBe('');

        // The real handler runs the graph-backed pass: zero live provider calls.
        const out = await runJob(job_id, { db: iso.db, config: graphOn, providers });
        expect(out.state).toBe('complete');
        expect(qloo.calls).toEqual([]);

        // Polling the job through MCP reads the scoped result.
        const job = await client.callTool<{ state: string; result: { type: string; id: string } | null }>('get_job', { job_id });
        expect(job.ok && job.data.state).toBe('complete');
        expect(job.ok && job.data.result).toEqual({ type: 'discovery_job', id: discovery_job_id });

        // get_item shows the admitted result attached to the scoped parent.
        const item = await client.callTool<{ related: { id: string; title: string; is_example: boolean }[]; related_state: string }>('get_item', {
          item_id: origin,
          collection_id: col.id,
        });
        expect(item.ok && item.data.related_state).toBe('cached');
        expect(item.ok && item.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        const candidate = item.ok ? item.data.related[0]! : { id: '', title: '', is_example: false };
        expect(candidate.is_example).toBe(false);

        // The result is pinned to the scoped discovery parent, with its
        // per-result proof; no account-wide graph state was written.
        const { rows: recs } = await iso.db.query<{ origin: string }>(
          'SELECT origin FROM recommendations WHERE discovery_job_id = $1',
          [discovery_job_id],
        );
        expect(recs).toEqual([{ origin: 'catalog' }]);
        const { rows: proofs } = await iso.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
          [discovery_job_id],
        );
        expect(proofs[0]!.n).toBe(1);
        const candidateRef = await iso.db.query<{ reference_id: string | null }>(
          'SELECT reference_id FROM discovery_items WHERE id = $1',
          [candidate.id],
        );
        expect(candidateRef.rows[0]!.reference_id).toBe(seuratRef);
      } finally {
        await client.close();
      }
    } finally {
      await iso.drop();
    }
  });
});

describe('scoped Discover more revocation and narrowing over MCP (VAL-DISC-007, VAL-DISC-009)', () => {
  /** One fresh scoped library: isolated corpus database, owner, granted agent, anchored origin. */
  async function scopedMcpLibrary() {
    const iso = await createIsolatedDatabase('scrdmcp');
    await admitGraphCorpus(iso.db, getCorpusManifestFile());
    const graphOn = testConfig({
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
    });
    const owner = await insertAccount(iso.db);
    const ownerCtx = testContext(owner, { db: iso.db, config: graphOn });
    const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
    const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
    const rodinRef = await upsertReference(iso.db, {
      canonicalKey: `qloo:${RODIN_QLOO_ID}`,
      name: 'Auguste Rodin',
      type: 'creator',
      externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    const seuratRef = await upsertReference(iso.db, {
      canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
      name: 'Georges Seurat',
      type: 'creator',
      externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      iso.db,
    );
    const col = await collections.createCollection(ownerCtx, { name: 'Museum visits' });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(iso.db);
    const { credential, principal } = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
      iso.db,
    );
    const providers = testProviders({ qloo: new FakeQloo({}, { live: true }) });
    return { iso, graphOn, ownerCtx, origin, col, credential, connectionId: principal.connectionId, providers, seuratRef };
  }

  it('revocation before the run fails the MCP-enqueued scoped job closed; the credential stops authenticating', async () => {
    const s = await scopedMcpLibrary();
    try {
      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      let jobId = '';
      let discoveryJobId = '';
      try {
        const started = await client.callTool<{ job_id: string; discovery_job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.col.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        jobId = started.ok ? started.data.job_id : '';
        discoveryJobId = started.ok ? started.data.discovery_job_id : '';
        expect(jobId).not.toBe('');
      } finally {
        await client.close();
      }
      // The owner revokes through the real REST service before any redelivery.
      await agentConnections.revokeAgentConnection(s.ownerCtx, { id: s.connectionId });
      // The delayed work rejects at the publication fence: nothing publishes.
      await expect(runJob(jobId, { db: s.iso.db, config: s.graphOn, providers: s.providers })).rejects.toMatchObject({
        code: 'token_revoked',
      });
      const { rows: recs } = await s.iso.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
        [discoveryJobId],
      );
      expect(Number(recs[0]!.n)).toBe(0);
      // And the MCP endpoint itself refuses the revoked credential at the
      // HTTP layer with the REST code.
      const refused = await mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn })(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${s.credential}` },
        body: JSON.stringify(INIT),
      });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: 'token_revoked', retryable: false });
    } finally {
      await s.iso.drop();
    }
  });

  it('after publication, a narrowed grant denies the previously published reads through the same transport; the owner keeps them', async () => {
    const s = await scopedMcpLibrary();
    try {
      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        const started = await client.callTool<{ job_id: string; discovery_job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.col.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const { job_id, discovery_job_id } = started.ok ? started.data : { job_id: '', discovery_job_id: '' };
        expect(job_id).not.toBe('');
        await runJob(job_id, { db: s.iso.db, config: s.graphOn, providers: s.providers });

        // Control: the same transport reads the published result.
        const job = await client.callTool<{ state: string }>('get_job', { job_id });
        expect(job.ok && job.data.state).toBe('complete');
        const item = await client.callTool<{ related: { id: string; title: string }[]; related_state: string }>('get_item', {
          item_id: s.origin,
          collection_id: s.col.id,
        });
        expect(item.ok && item.data.related_state).toBe('cached');
        expect(item.ok && item.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        const candidateId = item.ok ? item.data.related[0]!.id : '';
        const { rows: candidate } = await s.iso.db.query<{ reference_id: string | null }>(
          'SELECT reference_id FROM discovery_items WHERE id = $1',
          [candidateId],
        );
        expect(candidate[0]!.reference_id).toBe(s.seuratRef);

        // The owner v1-narrows the grant (the credential stays valid): the
        // previously published reads now deny through the same transport.
        await agentConnections.updateAgentConnection(s.ownerCtx, { id: s.connectionId, body: { collection_ids: [] } });
        const jobAfter = await client.callTool('get_job', { job_id });
        expect(jobAfter.ok).toBe(false);
        expect(!jobAfter.ok && jobAfter.error.code).toBe('not_found');
        const itemAfter = await client.callTool('get_item', {
          item_id: s.origin,
          collection_id: s.col.id,
        });
        expect(itemAfter.ok).toBe(false);
        expect(!itemAfter.ok && itemAfter.error.code).toBe('not_found');

        // The validly published results survive for the owner.
        const { rows: recs } = await s.iso.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
          [discovery_job_id],
        );
        expect(Number(recs[0]!.n)).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });

  it("a surviving second granted membership never keeps a lost collection context readable over MCP; the surviving context restores it (DISC-SCR-036)", async () => {
    const iso = await createIsolatedDatabase('scollmcp');
    try {
      await admitGraphCorpus(iso.db, getCorpusManifestFile());
      const graphOn = testConfig({
        INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
        INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
      });
      const owner = await insertAccount(iso.db);
      const ownerCtx = testContext(owner, { db: iso.db, config: graphOn });
      const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
      const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
      const rodinRef = await upsertReference(iso.db, {
        canonicalKey: `qloo:${RODIN_QLOO_ID}`,
        name: 'Auguste Rodin',
        type: 'creator',
        externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      await upsertReference(iso.db, {
        canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
        name: 'Georges Seurat',
        type: 'creator',
        externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      const origin = await insertItem(
        { accountId: owner.accountId },
        { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
        iso.db,
      );
      // The origin is a member of TWO granted collections: losing its
      // membership in A must not keep A's cached context readable through B.
      const colA = await collections.createCollection(ownerCtx, { name: 'Museum visits' });
      const colB = await collections.createCollection(ownerCtx, { name: 'More museums' });
      await collections.addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
      await collections.addCollectionItem(ownerCtx, { id: colB.id, item_id: origin, body: {} });
      await linkGraphReferenceIdentities(iso.db);
      const { credential } = await insertAgentConnection(
        owner,
        { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
        iso.db,
      );
      const providers = testProviders({ qloo: new FakeQloo({}, { live: true }) });
      const client = await connectMcp({
        url: MCP_URL,
        token: credential,
        fetch: mcpFetch(providers, { db: iso.db, config: graphOn }),
      });
      try {
        const started = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: origin,
          collection_id: colA.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        await runJob(jobId, { db: iso.db, config: graphOn, providers });

        // Control: the agent reads the published scoped context.
        const control = await client.callTool<{ related: { id: string; title: string }[]; related_state: string }>(
          'get_item',
          { item_id: origin, collection_id: colA.id },
        );
        expect(control.ok && control.data.related_state).toBe('cached');
        expect(control.ok && control.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        const candidateId = control.ok ? control.data.related[0]!.id : '';

        // The owner removes the origin from collection A only.
        await collections.removeCollectionItem(ownerCtx, { id: colA.id, item_id: origin });

        // Job polling denies (the existing exact-context rule)...
        const jobAfter = await client.callTool('get_job', { job_id: jobId });
        expect(jobAfter.ok).toBe(false);
        expect(!jobAfter.ok && jobAfter.error.code).toBe('not_found');
        // ...and the item reads agree with it: the origin stays readable
        // through collection B, but A's cached result left its rail...
        const originAfter = await client.callTool<{ related: { id: string }[]; related_state: string }>('get_item', {
          item_id: origin,
          collection_id: colB.id,
        });
        expect(originAfter.ok).toBe(true);
        expect(originAfter.ok && originAfter.data.related).toEqual([]);
        // ...and the published candidate is no longer readable under the grant.
        const candidateAfter = await client.callTool('get_item', { item_id: candidateId, collection_id: colB.id });
        expect(candidateAfter.ok).toBe(false);
        expect(!candidateAfter.ok && candidateAfter.error.code).toBe('not_found');

        // A fresh scoped discovery under the SURVIVING granted context B is
        // independently authorized: it restores the rail and the candidate.
        const again = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: origin,
          collection_id: colB.id,
          category: 'play',
        });
        expect(again.ok).toBe(true);
        const jobIdB = again.ok ? again.data.job_id : '';
        await runJob(jobIdB, { db: iso.db, config: graphOn, providers });
        const restored = await client.callTool<{ related: { id: string }[]; related_state: string }>('get_item', {
          item_id: origin,
          collection_id: colB.id,
        });
        expect(restored.ok && restored.data.related_state).toBe('cached');
        expect(restored.ok && restored.data.related.map((r) => r.id)).toEqual([candidateId]);
        const candidateRestored = await client.callTool('get_item', { item_id: candidateId, collection_id: colB.id });
        expect(candidateRestored.ok).toBe(true);
      } finally {
        await client.close();
      }
    } finally {
      await iso.drop();
    }
  });
});

describe('scoped Discover more rail context selection over MCP (DISC-SCR-043/044; VAL-DISC-009)', () => {
  const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
  const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

  /** One fresh scoped corpus library: owner, granted agent (A and B), Rodin origin in both. */
  async function railMcpLibrary() {
    const iso = await createIsolatedDatabase('scrdrlmcp');
    await admitGraphCorpus(iso.db, getCorpusManifestFile());
    const graphOn = testConfig({
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
    });
    const graphOff = testConfig();
    const owner = await insertAccount(iso.db);
    const ownerCtx = testContext(owner, { db: iso.db, config: graphOn });
    const rodinRef = await upsertReference(iso.db, {
      canonicalKey: `qloo:${RODIN_QLOO_ID}`,
      name: 'Auguste Rodin',
      type: 'creator',
      externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    await upsertReference(iso.db, {
      canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
      name: 'Georges Seurat',
      type: 'creator',
      externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      iso.db,
    );
    const colA = await collections.createCollection(ownerCtx, { name: 'Museum A' });
    const colB = await collections.createCollection(ownerCtx, { name: 'Museum B' });
    await collections.addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    await collections.addCollectionItem(ownerCtx, { id: colB.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(iso.db);
    const { credential } = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
      iso.db,
    );
    const providers = testProviders({ qloo: new FakeQloo({}, { live: true }) });
    return { iso, graphOn, graphOff, owner, ownerCtx, origin, colA, colB, credential, providers, rodinRef };
  }

  it("get_item never serves another granted collection's newer results: A's honest empty rail stays empty (DISC-SCR-043)", async () => {
    const s = await railMcpLibrary();
    try {
      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        // A's watch-filtered scoped discovery honestly admits nothing.
        const underA = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.colA.id,
          category: 'watch',
        });
        expect(underA.ok).toBe(true);
        const jobIdA = underA.ok ? underA.data.job_id : '';
        await runJob(jobIdA, { db: s.iso.db, config: s.graphOn, providers: s.providers });

        // B's NEWER scoped discovery is enqueued: its pending context is honest.
        const underB = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.colB.id,
          category: 'play',
        });
        expect(underB.ok).toBe(true);
        const jobIdB = underB.ok ? underB.data.job_id : '';
        const pending = await client.callTool<{
          related: unknown[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: s.origin, collection_id: s.colB.id });
        expect(pending.ok && pending.data.related).toEqual([]);
        expect(pending.ok && pending.data.related_state).toBe('pending');
        expect(pending.ok && pending.data.related_job_id).toBe(jobIdB);
        await runJob(jobIdB, { db: s.iso.db, config: s.graphOn, providers: s.providers });

        // A's read serves A's honest empty rail — never B's newer results.
        const aRead = await client.callTool<{
          related: { id: string; title: string }[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: s.origin, collection_id: s.colA.id });
        expect(aRead.ok && aRead.data.related).toEqual([]);
        expect(aRead.ok && aRead.data.related_state).toBe('none');
        expect(aRead.ok && aRead.data.related_job_id).toBe(jobIdA);

        // B's read serves exactly B's admitted result.
        const bRead = await client.callTool<{
          related: { id: string; title: string }[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: s.origin, collection_id: s.colB.id });
        expect(bRead.ok && bRead.data.related_state).toBe('cached');
        expect(bRead.ok && bRead.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        expect(bRead.ok && bRead.data.related_job_id).toBe(jobIdB);
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });

  it('a saved public sample serves its scoped outcome over MCP: honest empty, never the example carousel (DISC-SCR-044)', async () => {
    const s = await railMcpLibrary();
    try {
      await ensureSampleItems(s.iso.db);
      const { rows } = await s.iso.db.query<{ id: string }>(
        'SELECT id FROM discovery_items WHERE is_sample AND canonical_key = $1',
        [sampleKey('film-playtime')],
      );
      const sample = rows[0]!.id;
      await collections.addCollectionItem(s.ownerCtx, { id: s.colA.id, item_id: sample, body: {} });

      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        // Control: before the scoped operation, the ordinary example carousel serves.
        const before = await client.callTool<{ related: { is_example: boolean }[]; related_state: string }>('get_item', {
          item_id: sample,
          collection_id: s.colA.id,
        });
        expect(before.ok && before.data.related_state).toBe('cached');
        expect(before.ok && before.data.related.length).toBeGreaterThan(0);
        expect(before.ok && before.data.related.every((r) => r.is_example)).toBe(true);

        // The explicit graph-on scoped operation runs and honestly admits
        // nothing (the shipped sample carries no graph identities).
        const started = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: sample,
          collection_id: s.colA.id,
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        await runJob(jobId, { db: s.iso.db, config: s.graphOn, providers: s.providers });

        // get_item serves the honest empty scoped outcome: no unrelated
        // public example cards stand in for the scoped rail.
        const after = await client.callTool<{
          related: { is_example: boolean }[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: sample, collection_id: s.colA.id });
        expect(after.ok && after.data.related).toEqual([]);
        expect(after.ok && after.data.related_state).toBe('none');
        expect(after.ok && after.data.related_job_id).toBe(jobId);
      } finally {
        await client.close();
      }

      // Graph-off control through the same transport: the ordinary example
      // carousel is unchanged.
      const offClient = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOff }),
      });
      try {
        const off = await offClient.callTool<{ related: { is_example: boolean }[]; related_state: string }>('get_item', {
          item_id: sample,
          collection_id: s.colA.id,
        });
        expect(off.ok && off.data.related_state).toBe('cached');
        expect(off.ok && off.data.related.length).toBeGreaterThan(0);
        expect(off.ok && off.data.related.every((r) => r.is_example)).toBe(true);
      } finally {
        await offClient.close();
      }
    } finally {
      await s.iso.drop();
    }
  });

  it('a saved sample with admitted scoped results serves exactly those results over MCP (DISC-SCR-044)', async () => {
    const s = await railMcpLibrary();
    try {
      // A public shared sample carrying the verified Rodin subject identity,
      // grounded by the owner's save into the granted collection A.
      const sample = await insertItem(
        null,
        {
          kind: 'artist',
          category: 'play',
          title: 'Auguste Rodin',
          key: `sample:rodin-mcp-${randomUUID().slice(0, 6)}`,
          qloo: RODIN_QLOO_ID,
          referenceId: s.rodinRef,
        },
        s.iso.db,
      );
      await collections.addCollectionItem(s.ownerCtx, { id: s.colA.id, item_id: sample, body: {} });
      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        const started = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: sample,
          collection_id: s.colA.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        await runJob(jobId, { db: s.iso.db, config: s.graphOn, providers: s.providers });
        const read = await client.callTool<{
          related: { id: string; title: string; is_example: boolean }[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: sample, collection_id: s.colA.id });
        expect(read.ok && read.data.related_state).toBe('cached');
        expect(read.ok && read.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        expect(read.ok && read.data.related.every((r) => !r.is_example)).toBe(true);
        expect(read.ok && read.data.related_job_id).toBe(jobId);
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });

  it('get_item never borrows an older same-collection graph-off provider completion over MCP (DISC-SCR-047)', async () => {
    const s = await railMcpLibrary();
    try {
      // The graph-off era: the selected-collection Discover more ran the
      // LEGACY provider branch (same origin_collection_id and scoped marker
      // as a graph job) and completed with one provider card.
      const legacy = await items.startRelatedDiscovery(s.ownerCtx, {
        id: s.origin,
        body: { collection_id: s.colA.id, category: 'watch' },
      });
      const legacyQloo = new FakeQloo(
        {
          insights: (req) => ({
            entities: [
              {
                entity_id: `xmcp-${req.filterType.split(':').pop()}`,
                name: 'Provider pick xmcp',
                types: [],
                properties: {},
                tags: [],
              },
            ],
            tags: [],
          }),
        },
        { live: true },
      );
      await runJob(legacy.job_id, { db: s.iso.db, config: s.graphOff, providers: testProviders({ qloo: legacyQloo }) });
      const { rows: legacyRows } = await s.iso.db.query<{ discovery_item_id: string }>(
        'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1',
        [legacy.discovery_job_id],
      );
      expect(legacyRows.length).toBeGreaterThan(0);

      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        // Rollout: a genuinely fresh scoped request for the same origin/A is
        // enqueued over MCP. Its pending rail is honest — the old provider
        // completion is a different execution class and never fills it.
        const fresh = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.colA.id,
          category: 'play',
        });
        expect(fresh.ok).toBe(true);
        const jobId = fresh.ok ? fresh.data.job_id : '';
        const pending = await client.callTool<{
          related: { id: string }[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: s.origin, collection_id: s.colA.id });
        expect(pending.ok && pending.data.related).toEqual([]);
        expect(pending.ok && pending.data.related_state).toBe('pending');
        expect(pending.ok && pending.data.related_job_id).toBe(jobId);

        // The fresh graph pass admits the reviewed Rodin→museum→Seurat path:
        // its completed rail serves exactly that result — the provider card
        // never returns on the graph class's rail.
        await runJob(jobId, { db: s.iso.db, config: s.graphOn, providers: s.providers });
        const done = await client.callTool<{
          related: { id: string; title: string }[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: s.origin, collection_id: s.colA.id });
        expect(done.ok && done.data.related_state).toBe('cached');
        expect(done.ok && done.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        expect(done.ok && done.data.related_job_id).toBe(jobId);
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });

  it('a scoped context whose only parent failed at its immutable deadline serves honest empty over MCP: the other granted collection’s saved card never stands in (DISC-SCR-048)', async () => {
    const s = await railMcpLibrary();
    try {
      // The legacy interest-pool padding source: a completed taste seed with
      // one unrelated account-wide card, saved into the agent's SECOND
      // granted collection B.
      const seedCard = await insertItem(
        { accountId: s.owner.accountId },
        { kind: 'brand', category: 'wear', title: 'Unrelated taste brand' },
        s.iso.db,
      );
      const run = await s.iso.db.query<{ id: string }>(
        `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
         VALUES ($1, 0, 'complete', 1) RETURNING id`,
        [s.owner.accountId],
      );
      const pq = randomUUID();
      await s.iso.db.query(
        `INSERT INTO provider_queries (id, taste_seed_run_id, provider, operation, sanitized_request, results, status)
         VALUES ($1, $2, 'qloo', 'insights', '{}'::jsonb, NULL, 'ok')`,
        [pq, run.rows[0]!.id],
      );
      await s.iso.db.query(
        `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                      external_ids, display_reason, origin, provider_query_ids)
         VALUES ($1, $2, 'wear', 1, 'Unrelated taste brand', '{}'::jsonb, 'From your interests.', 'qloo', ARRAY[$3::uuid])`,
        [run.rows[0]!.id, seedCard, pq],
      );
      await collections.addCollectionItem(s.ownerCtx, { id: s.colB.id, item_id: seedCard, body: {} });

      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        // The origin's first graph-on scoped discovery is delayed past its
        // immutable work window and fails nonretryably BEFORE any results:
        // the durable 'graph' stage records the executed class and nothing
        // is published (re-anchored through the authority row's own closed
        // path — fixture setup, not production retry semantics).
        const started = await client.callTool<{ job_id: string; discovery_job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.colA.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        const discoveryJobId = started.ok ? started.data.discovery_job_id : '';
        await s.iso.db.query(
          `WITH old AS (DELETE FROM discovery_grant_authorities WHERE discovery_job_id = $1 RETURNING *)
           INSERT INTO discovery_grant_authorities
             (owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
              collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id, work_deadline_at)
           SELECT owner_account_id, discovery_job_id, job_id, agent_connection_id, authorization_version,
                  collection_granted_at, origin_collection_id, origin_item_id, origin_saved_item_id,
                  now() - interval '1 minute'
             FROM old`,
          [discoveryJobId],
        );
        await expect(runJob(jobId, { db: s.iso.db, config: s.graphOn, providers: s.providers })).rejects.toThrow(
          GraphWorkDeadlineExpiredError,
        );

        // The A+B-granted agent reading the failed A context over MCP sees
        // the honest empty rail: its B-saved seed card is independently
        // visible, yet never fills the scoped response.
        const read = await client.callTool<{ related: { id: string }[]; related_state: string }>('get_item', {
          item_id: s.origin,
          collection_id: s.colA.id,
        });
        expect(read.ok && read.data.related).toEqual([]);
        expect(read.ok && read.data.related_state).toBe('none');
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });
});

describe('scoped proof validity on retained candidate reads over MCP (DISC-SCR-045; VAL-DISC-007/008)', () => {
  const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
  const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

  it('sole-source retraction denies the retained candidate ID; public items, granted saves and the owner survive', async () => {
    const iso = await createIsolatedDatabase('scrdvismcp');
    try {
      await admitGraphCorpus(iso.db, getCorpusManifestFile());
      const graphOn = testConfig({
        INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
        INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
      });
      const owner = await insertAccount(iso.db);
      const ownerCtx = testContext(owner, { db: iso.db, config: graphOn });
      const rodinRef = await upsertReference(iso.db, {
        canonicalKey: `qloo:${RODIN_QLOO_ID}`,
        name: 'Auguste Rodin',
        type: 'creator',
        externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      await upsertReference(iso.db, {
        canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
        name: 'Georges Seurat',
        type: 'creator',
        externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      const origin = await insertItem(
        { accountId: owner.accountId },
        { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
        iso.db,
      );
      const col = await collections.createCollection(ownerCtx, { name: 'Museum visits' });
      await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: origin, body: {} });
      await linkGraphReferenceIdentities(iso.db);
      const { credential } = await insertAgentConnection(
        owner,
        { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
        iso.db,
      );
      const providers = testProviders({ qloo: new FakeQloo({}, { live: true }) });
      const client = await connectMcp({
        url: MCP_URL,
        token: credential,
        fetch: mcpFetch(providers, { db: iso.db, config: graphOn }),
      });
      try {
        // The scoped operation publishes one admitted result with a pinned proof.
        const started = await client.callTool<{ job_id: string; discovery_job_id: string }>('discover_related', {
          item_id: origin,
          collection_id: col.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        const discoveryJobId = started.ok ? started.data.discovery_job_id : '';
        await runJob(jobId, { db: iso.db, config: graphOn, providers });

        // Control: the same transport reads the published candidate.
        const control = await client.callTool<{ related: { id: string; title: string }[]; related_state: string }>(
          'get_item',
          { item_id: origin, collection_id: col.id },
        );
        expect(control.ok && control.data.related_state).toBe('cached');
        expect(control.ok && control.data.related.map((r) => r.title)).toEqual(['Georges Seurat']);
        const candidateId = control.ok ? control.data.related[0]!.id : '';
        const candidateRead = await client.callTool('get_item', { item_id: candidateId, collection_id: col.id });
        expect(candidateRead.ok).toBe(true);

        // Withdraw the walked path's sole evidence (the real retraction path):
        // the pinned proof stops serving.
        const rodinAssociation = await iso.db.query<{ id: string }>(
          `SELECT a.id FROM graph_assertions a
             JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = 'atlas:creator:auguste-rodin'
             JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = 'atlas:place:art-institute-of-chicago'
            WHERE a.predicate = 'DOCUMENTED_ASSOCIATION'`,
        );
        const soleEvidence = await iso.db.query<{ evidence_id: string }>(
          `SELECT s.evidence_id
             FROM graph_assertion_support s
             JOIN graph_evidence e ON e.id = s.evidence_id
            WHERE s.assertion_id = $1 AND s.role = 'supports' AND e.validity_state = 'valid'`,
          [rodinAssociation.rows[0]!.id],
        );
        const retraction = await retractGraphEvidence(iso.db, {
          evidenceId: soleEvidence.rows[0]!.evidence_id,
          reason: 'withdrawn after publication',
        });
        expect(retraction.scopedProofsInvalidated).toBe(1);

        // DISC-SCR-045: the retained candidate ID DENIES through the real MCP
        // transport — the durable recommendation alone is no witness once its
        // only scoped proof is withdrawn, and no independent granted context
        // exists for the newly materialized candidate.
        const denied = await client.callTool('get_item', { item_id: candidateId, collection_id: col.id });
        expect(denied.ok).toBe(false);
        expect(!denied.ok && denied.error.code).toBe('not_found');

        // The origin rail is honest ('none'), while the origin itself stays
        // readable through its granted membership.
        const originAfter = await client.callTool<{ related: unknown[]; related_state: string }>('get_item', {
          item_id: origin,
          collection_id: col.id,
        });
        expect(originAfter.ok && originAfter.data.related).toEqual([]);
        expect(originAfter.ok && originAfter.data.related_state).toBe('none');

        // Public item control: a shipped public sample stays readable.
        await ensureSampleItems(iso.db);
        const { rows: sampleRows } = await iso.db.query<{ id: string }>(
          'SELECT id FROM discovery_items WHERE is_sample LIMIT 1',
        );
        expect(sampleRows.length).toBeGreaterThan(0);
        const sampleRead = await client.callTool('get_item', { item_id: sampleRows[0]!.id, collection_id: col.id });
        expect(sampleRead.ok).toBe(true);

        // Granted-save control: an EXPLICIT save in the granted collection is
        // an independent authorization — the candidate reads again, with the
        // withdrawn scoped reason staying withdrawn.
        await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: candidateId, body: {} });
        const restored = await client.callTool<{ reason: string | null }>('get_item', {
          item_id: candidateId,
          collection_id: col.id,
        });
        expect(restored.ok).toBe(true);
        expect(restored.ok && restored.data.reason).toBeNull();

        // Owner control: first-party ownership keeps the card (reason
        // withdrawn) — the owner is never grant-limited.
        const ownerRead = await items.getItem(ownerCtx, { id: candidateId, query: {} });
        expect(ownerRead.item.id).toBe(candidateId);
        expect(ownerRead.reason).toBeNull();

        // Provenance control: the durable recommendation row survives the
        // withdrawal — only its serving was denied.
        const { rows: recs } = await iso.db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
          [discoveryJobId],
        );
        expect(Number(recs[0]!.n)).toBe(1);
      } finally {
        await client.close();
      }
    } finally {
      await iso.drop();
    }
  });
});

describe('scoped Discover more mixed attempt history over MCP (DISC-SCR-049)', () => {
  const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
  const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const noCallQloo = () => new FakeQloo({}, { live: true });

  /** Legacy provider results (the graph-off Discover more path). */
  function legacyResultsQloo(prefix: string): FakeQloo {
    const entity = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: [], properties: {}, tags: [] });
    return new FakeQloo(
      {
        insights: (req) => ({
          entities: [entity(`${prefix}-${req.filterType.split(':').pop()}`, `Provider pick ${prefix}`)],
          tags: [],
        }),
      },
      { live: true },
    );
  }

  /** One fresh scoped corpus library for the mixed-attempt history matrix. */
  async function mixedMcpLibrary() {
    const iso = await createIsolatedDatabase('scrdmixmcp');
    await admitGraphCorpus(iso.db, getCorpusManifestFile());
    const graphOn = testConfig({
      INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
      INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
    });
    const graphOff = testConfig();
    const owner = await insertAccount(iso.db);
    const ownerCtx = testContext(owner, { db: iso.db, config: graphOn });
    const rodinRef = await upsertReference(iso.db, {
      canonicalKey: `qloo:${RODIN_QLOO_ID}`,
      name: 'Auguste Rodin',
      type: 'creator',
      externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    await upsertReference(iso.db, {
      canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
      name: 'Georges Seurat',
      type: 'creator',
      externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      iso.db,
    );
    const colA = await collections.createCollection(ownerCtx, { name: 'Museum A' });
    await collections.addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(iso.db);
    const { credential } = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id] },
      iso.db,
    );
    const providers = testProviders({ qloo: new FakeQloo({}, { live: true }) });
    return { iso, graphOn, graphOff, owner, ownerCtx, origin, colA, credential, providers };
  }

  /**
   * The real mixed-attempt history of DISC-SCR-049 on one scoped job: the
   * graph-on claim runs the scoped graph branch, persists its durable
   * 'graph' stage evidence and is interrupted exactly at its publication
   * barrier (the crashed-worker shape — no terminal write, nothing
   * published, zero provider calls); the lease then lapses and the real
   * graph-off reclaim runs the LEGACY provider branch, publishing provider
   * results on the SAME discovery parent. Returns the provider card ids.
   */
  async function mixedAttemptHistory(
    db: Awaited<ReturnType<typeof createIsolatedDatabase>>['db'],
    graphOn: ReturnType<typeof testConfig>,
    graphOff: ReturnType<typeof testConfig>,
    jobId: string,
  ): Promise<string[]> {
    const graphQloo = noCallQloo();
    const first = await runClaimedAttempt(jobId, {
      db,
      config: graphOn,
      providers: testProviders({ qloo: graphQloo }),
      interruptPublication: true,
      leaseMs: 300,
    });
    expect(first).toMatchObject({ state: 'running', attempt: 1, interrupted: true });
    expect(graphQloo.calls).toEqual([]);
    await sleep(450);
    const providerQloo = legacyResultsQloo('mcpmix');
    const second = await runClaimedAttempt(jobId, {
      db,
      config: graphOff,
      providers: testProviders({ qloo: providerQloo }),
    });
    expect(second).toMatchObject({ state: 'complete', attempt: 2, interrupted: false });
    const { rows: dj } = await db.query<{ id: string }>('SELECT id FROM discovery_jobs WHERE job_id = $1', [jobId]);
    const discoveryJobId = dj[0]!.id;
    const { rows } = await db.query<{ discovery_item_id: string }>(
      'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
      [discoveryJobId],
    );
    expect(rows.length).toBeGreaterThan(0);
    return rows.map((r) => r.discovery_item_id);
  }

  it('get_item never serves the mixed history provider card under a fresh graph-on scoped request; the graph-off client keeps the legacy pairing', async () => {
    const s = await mixedMcpLibrary();
    try {
      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        // The scoped operation is enqueued through the real MCP tool.
        const started = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.colA.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';

        const providerIds = await mixedAttemptHistory(s.iso.db, s.graphOn, s.graphOff, jobId);

        // Graph re-enabled + a genuinely fresh scoped request: the agent's
        // pending read stays honest through the real transport — the mixed
        // history provider card never fills the rail.
        const fresh = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: s.origin,
          collection_id: s.colA.id,
          category: 'watch',
        });
        expect(fresh.ok).toBe(true);
        const freshJobId = fresh.ok ? fresh.data.job_id : '';
        const pending = await client.callTool<{
          related: unknown[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: s.origin, collection_id: s.colA.id });
        expect(pending.ok && pending.data.related).toEqual([]);
        expect(pending.ok && pending.data.related_state).toBe('pending');
        expect(pending.ok && pending.data.related_job_id).toBe(freshJobId);

        // Graph-off control over the same transport: the legacy pairing keeps
        // the older provider card as the pending rail's cached results.
        const offClient = await connectMcp({
          url: MCP_URL,
          token: s.credential,
          fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOff }),
        });
        try {
          const offPending = await offClient.callTool<{
            related: { id: string }[];
            related_state: string;
            related_job_id: string | null;
          }>('get_item', { item_id: s.origin, collection_id: s.colA.id });
          expect(offPending.ok && offPending.data.related_state).toBe('pending');
          expect(offPending.ok && offPending.data.related_job_id).toBe(freshJobId);
          expect(offPending.ok && offPending.data.related.map((r) => r.id)).toEqual(providerIds);
        } finally {
          await offClient.close();
        }
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });

  it('a saved sample read over MCP keeps its carousel when the scoped job is mixed history; fresh graph work still takes the rail', async () => {
    const s = await mixedMcpLibrary();
    try {
      // The shipped example cards the carousel serves, plus a public shared
      // sample origin with a provider-resolvable identity (the mixed
      // history's graph-off redelivery must actually publish through the
      // fake provider, so the origin needs a resolvable qloo id).
      await ensureSampleItems(s.iso.db);
      const sample = await insertItem(
        null,
        {
          kind: 'artist',
          category: 'play',
          title: 'Sample sculptor',
          key: `sample:sculptor-mcp-mixed-${randomUUID().slice(0, 6)}`,
          qloo: `artist-${randomUUID()}`,
        },
        s.iso.db,
      );
      await collections.addCollectionItem(s.ownerCtx, { id: s.colA.id, item_id: sample, body: {} });

      const client = await connectMcp({
        url: MCP_URL,
        token: s.credential,
        fetch: mcpFetch(s.providers, { db: s.iso.db, config: s.graphOn }),
      });
      try {
        // Control: before any discovery the ordinary example carousel serves.
        const before = await client.callTool<{ related: { is_example: boolean }[]; related_state: string }>('get_item', {
          item_id: sample,
        });
        expect(before.ok && before.data.related_state).toBe('cached');
        expect(before.ok && before.data.related.length).toBeGreaterThan(0);
        expect(before.ok && before.data.related.every((r) => r.is_example)).toBe(true);

        // The scoped sample operation's graph-on attempt persists its stage
        // then crashes at the publication barrier; the graph-off reclaim
        // publishes one provider card on the same discovery parent.
        const started = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: sample,
          collection_id: s.colA.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        await mixedAttemptHistory(s.iso.db, s.graphOn, s.graphOff, jobId);

        // The graph-on sample read keeps the ordinary example carousel: the
        // mixed history job is never mistaken for explicit graph work.
        const carousel = await client.callTool<{ related: { is_example: boolean }[]; related_state: string }>('get_item', {
          item_id: sample,
        });
        expect(carousel.ok && carousel.data.related_state).toBe('cached');
        expect(carousel.ok && carousel.data.related.length).toBeGreaterThan(0);
        expect(carousel.ok && carousel.data.related.every((r) => r.is_example)).toBe(true);

        // A fresh explicit graph-on scoped operation still takes the sample
        // rail honestly: pending, then its own completed empty outcome.
        const fresh = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: sample,
          collection_id: s.colA.id,
          category: 'watch',
        });
        expect(fresh.ok).toBe(true);
        const freshJobId = fresh.ok ? fresh.data.job_id : '';
        const pending = await client.callTool<{
          related: unknown[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: sample });
        expect(pending.ok && pending.data.related).toEqual([]);
        expect(pending.ok && pending.data.related_state).toBe('pending');
        expect(pending.ok && pending.data.related_job_id).toBe(freshJobId);
        await runJob(freshJobId, { db: s.iso.db, config: s.graphOn, providers: s.providers });
        const empty = await client.callTool<{
          related: unknown[];
          related_state: string;
          related_job_id: string | null;
        }>('get_item', { item_id: sample });
        expect(empty.ok && empty.data.related).toEqual([]);
        expect(empty.ok && empty.data.related_state).toBe('none');
        expect(empty.ok && empty.data.related_job_id).toBe(freshJobId);
      } finally {
        await client.close();
      }
    } finally {
      await s.iso.drop();
    }
  });
});

describe('scoped Discover more concurrent result substitution over MCP (DISC-SCR-050)', () => {
  const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
  const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const noCallQloo = () => new FakeQloo({}, { live: true });

  /** Legacy provider results (the graph-off Discover more path). */
  function legacyResultsQloo(prefix: string): FakeQloo {
    const entity = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: [], properties: {}, tags: [] });
    return new FakeQloo(
      {
        insights: (req) => ({
          entities: [entity(`${prefix}-${req.filterType.split(':').pop()}`, `Provider pick ${prefix}`)],
          tags: [],
        }),
      },
      { live: true },
    );
  }

  it('get_item never serves a graph-off redelivery committed between classification and row loading; the graph-off client keeps the legacy pairing', async () => {
    const iso = await createIsolatedDatabase('scrdrowmcp');
    try {
      await admitGraphCorpus(iso.db, getCorpusManifestFile());
      const graphOn = testConfig({
        INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
        INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
      });
      const graphOff = testConfig();
      const owner = await insertAccount(iso.db);
      const ownerCtx = testContext(owner, { db: iso.db, config: graphOn });
      const rodinRef = await upsertReference(iso.db, {
        canonicalKey: `qloo:${RODIN_QLOO_ID}`,
        name: 'Auguste Rodin',
        type: 'creator',
        externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      await upsertReference(iso.db, {
        canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
        name: 'Georges Seurat',
        type: 'creator',
        externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
      });
      const origin = await insertItem(
        { accountId: owner.accountId },
        { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
        iso.db,
      );
      const colA = await collections.createCollection(ownerCtx, { name: 'Museum A' });
      await collections.addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
      await linkGraphReferenceIdentities(iso.db);
      const { credential } = await insertAgentConnection(
        owner,
        { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id] },
        iso.db,
      );
      const providers = testProviders({ qloo: noCallQloo() });

      const client = await connectMcp({
        url: MCP_URL,
        token: credential,
        fetch: mcpFetch(providers, { db: iso.db, config: graphOn }),
      });
      try {
        // The scoped operation is enqueued through the real MCP tool, then
        // the graph-on claim COMMITS its publication (results, proofs,
        // terminal parent status) and dies before terminal queue completion:
        // the queue row keeps 'running' with its lease.
        const started = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: origin,
          collection_id: colA.id,
          category: 'play',
        });
        expect(started.ok).toBe(true);
        const jobId = started.ok ? started.data.job_id : '';
        const graphQloo = noCallQloo();
        const first = await runClaimedAttempt(jobId, {
          db: iso.db,
          config: graphOn,
          providers: testProviders({ qloo: graphQloo }),
          crashAfterPublication: true,
          leaseMs: 300,
        });
        expect(first).toMatchObject({ state: 'running', attempt: 1, interrupted: true, published: true });
        expect(graphQloo.calls).toEqual([]);
        const { rows: dj } = await iso.db.query<{ id: string }>('SELECT id FROM discovery_jobs WHERE job_id = $1', [jobId]);
        const discoveryJobId = dj[0]!.id;
        const { rows: graphRows } = await iso.db.query<{ discovery_item_id: string }>(
          'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
          [discoveryJobId],
        );
        const candidate = graphRows[0]!.discovery_item_id;
        expect(candidate).toBeTruthy();

        // The lease lapses; a fresh graph-on scoped request makes the
        // context's newest work pending with the crashed parent as its
        // compatible cache (its valid proof-bearing row still serves).
        await sleep(450);
        const fresh = await client.callTool<{ job_id: string }>('discover_related', {
          item_id: origin,
          collection_id: colA.id,
          category: 'watch',
        });
        expect(fresh.ok).toBe(true);
        const freshJobId = fresh.ok ? fresh.data.job_id : '';
        const before = await client.callTool<{ related: { id: string }[]; related_state: string; related_job_id: string | null }>(
          'get_item',
          { item_id: origin, collection_id: colA.id },
        );
        expect(before.ok && before.data.related_state).toBe('pending');
        expect(before.ok && before.data.related_job_id).toBe(freshJobId);
        expect(before.ok && before.data.related.map((r) => r.id)).toEqual([candidate]);

        // The agent's get_item through the REAL transport parks BETWEEN its
        // classification and its row loading (the gated db holds only the
        // read's own statements); the graph-off redelivery commits its
        // provider replacement on the same parent in that window.
        let classifiedOnce!: () => void;
        const classifiedSignal = new Promise<void>((resolve) => {
          classifiedOnce = resolve;
        });
        let releaseRows!: () => void;
        const rowsHeld = new Promise<void>((resolve) => {
          releaseRows = resolve;
        });
        const gated = gatedReadDb(iso.db, {
          onClassified: () => classifiedOnce(),
          beforeRowsLoad: () => rowsHeld,
        });
        let providerIds: string[] = [];
        const gatedClient = await connectMcp({
          url: MCP_URL,
          token: credential,
          fetch: mcpFetch(providers, { db: gated, config: graphOn }),
        });
        try {
          const pending = gatedClient.callTool<{ related: unknown[]; related_state: string; related_job_id: string | null }>(
            'get_item',
            { item_id: origin, collection_id: colA.id },
          );
          await classifiedSignal;
          const providerQloo = legacyResultsQloo('rowmcp');
          const second = await runClaimedAttempt(jobId, {
            db: iso.db,
            config: graphOff,
            providers: testProviders({ qloo: providerQloo }),
          });
          expect(second).toMatchObject({ state: 'complete', attempt: 2, interrupted: false });
          const { rows: providerRows } = await iso.db.query<{ discovery_item_id: string }>(
            'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
            [discoveryJobId],
          );
          providerIds = providerRows.map((r) => r.discovery_item_id);
          expect(providerIds.length).toBeGreaterThan(0);
          releaseRows();

          // The parked read must not serve the replacement: the fresh
          // request's pending rail stays honest and empty under the grant.
          const rail = await pending;
          expect(rail.ok && rail.data.related).toEqual([]);
          expect(rail.ok && rail.data.related_state).toBe('pending');
          expect(rail.ok && rail.data.related_job_id).toBe(freshJobId);
        } finally {
          await gatedClient.close();
        }

        // Graph-off control through the same transport: the legacy pairing
        // survives — the replacement provider card is the pending rail's
        // cached result there.
        const offClient = await connectMcp({
          url: MCP_URL,
          token: credential,
          fetch: mcpFetch(providers, { db: iso.db, config: graphOff }),
        });
        try {
          const offPending = await offClient.callTool<{
            related: { id: string }[];
            related_state: string;
            related_job_id: string | null;
          }>('get_item', { item_id: origin, collection_id: colA.id });
          expect(offPending.ok && offPending.data.related_state).toBe('pending');
          expect(offPending.ok && offPending.data.related_job_id).toBe(freshJobId);
          expect(offPending.ok && offPending.data.related.map((r) => r.id)).toEqual(providerIds);
        } finally {
          await offClient.close();
        }
      } finally {
        await client.close();
      }
    } finally {
      await iso.drop();
    }
  });
});

