import { afterAll, describe, expect, it } from 'vitest';
import { FakeQloo } from '@culture-atlas/providers/testing';
import {
  SCOPES,
  admitGraphCorpus,
  agentConnections,
  agentPlatform,
  collections,
  getCorpusManifestFile,
  linkGraphReferenceIdentities,
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
import { insertItem, runJob } from '../../domain/src/test-support/library';
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

