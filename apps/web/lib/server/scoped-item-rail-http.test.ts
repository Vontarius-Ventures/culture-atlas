import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  admitGraphCorpus,
  auth,
  collections,
  getCorpusManifestFile,
  items,
  linkGraphReferenceIdentities,
  setDbForTesting,
  setDomainConfigForTesting,
} from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import {
  createIsolatedDatabase,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
  testProviders,
} from '@culture-atlas/domain/testing';
import { setProvidersForTesting, type QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { upsertReference } from '../../../../packages/domain/src/compiler/store';
import { ensureSampleItems, sampleKey } from '../../../../packages/domain/src/feed/samples';
import { insertItem, runJob } from '../../../../packages/domain/src/test-support/library';

vi.mock('server-only', () => ({}));

/**
 * Route-level checks of the item read's compatible discovery-context
 * selection (round-9 repairs DISC-SCR-043/044): the REAL /v1/items/{id}
 * handler (apiRoute wrapper mirroring app/v1/items/[id]/route.ts) must serve
 * the authorized compatible collection and graph/legacy context — an
 * explicit collection read never serves another collection's or a legacy
 * whole-library discovery's results, and a saved public sample with an
 * explicit graph-on scoped operation serves that context's honest rail
 * instead of unrelated public example cards. Graph-off reads keep the
 * ordinary sample carousel and legacy padding.
 */

const { apiRoute } = await import('../../lib/server/http');

const getItemRoute = apiRoute(ROUTES.getItem, ({ ctx, params, query }) => items.getItem(ctx, { id: params.id, query }));

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const graphOff = testConfig();

const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

const iso = await createIsolatedDatabase('scrdweb');
const providers = testProviders();

/** Legacy whole-library provider results (the pre-graph Discover more path). */
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

beforeAll(async () => {
  await admitGraphCorpus(iso.db, getCorpusManifestFile());
  setDbForTesting(iso.db);
  setDomainConfigForTesting(graphOn);
  setProvidersForTesting(providers);
});
afterAll(async () => {
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  setProvidersForTesting(undefined);
  await iso.drop();
});

/** One account whose browser session cookie is a known token. */
async function browserOwner() {
  const principal = await insertAccount(iso.db);
  const token = randomUUID();
  await iso.db.query(`UPDATE sessions SET token_hash=$2 WHERE id=$1`, [principal.sessionId, auth.hashToken(token)]);
  return { principal, token };
}

let ip = 0;
/** GET /v1/items/{id} through the real route handler (owner cookie or agent bearer). */
function get(
  path: string,
  creds: { cookie?: string; bearer?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'x-forwarded-for': `203.0.113.${++ip % 250}` };
  if (creds.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${creds.cookie}`;
  if (creds.bearer) headers.authorization = creds.bearer;
  return (async () => {
    const id = /\/items\/([0-9a-f-]{36})/.exec(path)![1]!;
    const res = await getItemRoute(new NextRequest(`http://localhost:3300${path}`, { method: 'GET', headers }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  })();
}

interface Rail {
  related: { id: string; title: string; is_example: boolean }[];
  related_state: string;
  related_job_id: string | null;
}

describe('GET /v1/items/{id} serves one compatible discovery context (DISC-SCR-043)', () => {
  it('a fresh scoped request never reuses an older legacy whole-library discovery through the real route', async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
    const legacyOrigin = await insertItem(
      { accountId: owner.principal.accountId },
      { kind: 'film', category: 'watch', title: 'Legacy discovery film', qloo: `film-${randomUUID()}` },
      iso.db,
    );
    const col = await collections.createCollection(ownerCtx, { name: `Movie nights ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: legacyOrigin, body: {} });

    // The older whole-library Discover more completes with one provider result.
    const legacy = await items.startRelatedDiscovery(ownerCtx, { id: legacyOrigin, body: { category: 'watch' } });
    await runJob(legacy.job_id, { db: iso.db, config: graphOn, providers: testProviders({ qloo: legacyResultsQloo('lg2') }) });
    const legacyRail = await get(`/v1/items/${legacyOrigin}`, { cookie: owner.token });
    expect(legacyRail.status).toBe(200);
    expect((legacyRail.body as unknown as Rail).related_state).toBe('cached');
    expect(((legacyRail.body as unknown as Rail).related ?? []).length).toBeGreaterThan(0);

    // A fresh scoped request is enqueued (queued, not run): the real route
    // serves the pending scoped context honestly — the legacy results are an
    // incompatible context and never fill this rail.
    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: legacyOrigin, body: { collection_id: col.id } });
    const pending = (await get(`/v1/items/${legacyOrigin}`, { cookie: owner.token })).body as unknown as Rail;
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(scoped.job_id);
    const pendingScoped = (await get(`/v1/items/${legacyOrigin}?collection_id=${col.id}`, { cookie: owner.token }))
      .body as unknown as Rail;
    expect(pendingScoped.related).toEqual([]);
    expect(pendingScoped.related_state).toBe('pending');
    expect(pendingScoped.related_job_id).toBe(scoped.job_id);

    // The scoped pass honestly admits nothing for the unmapped origin: the
    // completed scoped rail stays empty — the legacy results never return.
    await runJob(scoped.job_id, { db: iso.db, config: graphOn, providers });
    const empty = (await get(`/v1/items/${legacyOrigin}`, { cookie: owner.token })).body as unknown as Rail;
    expect(empty.related).toEqual([]);
    expect(empty.related_state).toBe('none');
    expect(empty.related_job_id).toBe(scoped.job_id);
  });

  it("an explicit collection read never serves another collection's newer results through the real route", async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
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
      { accountId: owner.principal.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      iso.db,
    );
    const colA = await collections.createCollection(ownerCtx, { name: `Museum A ${randomUUID().slice(0, 6)}` });
    const colB = await collections.createCollection(ownerCtx, { name: `Museum B ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    await collections.addCollectionItem(ownerCtx, { id: colB.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(iso.db);
    const agent = await insertAgentConnection(
      owner.principal,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
      iso.db,
    );
    const bearer = `Bearer ${agent.credential}`;

    // A's watch-filtered scoped discovery honestly admits nothing; B's NEWER
    // play discovery publishes the reviewed Rodin→museum→Seurat path.
    const underA = await items.startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'watch' } });
    await runJob(underA.job_id, { db: iso.db, config: graphOn, providers });
    const underB = await items.startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colB.id, category: 'play' } });
    await runJob(underB.job_id, { db: iso.db, config: graphOn, providers });

    // The agent's A read serves A's honest empty rail — never B's newer results.
    const aRead = (await get(`/v1/items/${origin}?collection_id=${colA.id}`, { bearer })).body as unknown as Rail;
    expect(aRead.related).toEqual([]);
    expect(aRead.related_state).toBe('none');
    expect(aRead.related_job_id).toBe(underA.job_id);

    // The B read serves exactly B's admitted result.
    const bRead = (await get(`/v1/items/${origin}?collection_id=${colB.id}`, { bearer })).body as unknown as Rail;
    expect(bRead.related_state).toBe('cached');
    expect(bRead.related.map((r) => r.title)).toEqual(['Georges Seurat']);
    expect(bRead.related_job_id).toBe(underB.job_id);

    // The owner's explicit collection reads agree through their own session.
    const ownerA = (await get(`/v1/items/${origin}?collection_id=${colA.id}`, { cookie: owner.token })).body as unknown as Rail;
    expect(ownerA.related).toEqual([]);
    expect(ownerA.related_state).toBe('none');
  });
});

describe("GET /v1/items/{id} serves a saved public sample's scoped outcome (DISC-SCR-044)", () => {
  it('serves the honest empty scoped rail instead of unrelated example cards; graph-off keeps the carousel', async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
    await ensureSampleItems(iso.db);
    const { rows } = await iso.db.query<{ id: string }>(
      'SELECT id FROM discovery_items WHERE is_sample AND canonical_key = $1',
      [sampleKey('film-playtime')],
    );
    const sample = rows[0]!.id;
    const col = await collections.createCollection(ownerCtx, { name: `Saved samples ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });
    const agent = await insertAgentConnection(
      owner.principal,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
      iso.db,
    );

    // Control: before the scoped operation the ordinary example carousel is
    // the saved sample's rail.
    const before = (await get(`/v1/items/${sample}?collection_id=${col.id}`, { cookie: owner.token })).body as unknown as Rail;
    expect(before.related_state).toBe('cached');
    expect(before.related.length).toBeGreaterThan(0);
    expect(before.related.every((r) => r.is_example)).toBe(true);

    // The explicit graph-on scoped operation honestly admits nothing.
    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id } });
    await runJob(scoped.job_id, { db: iso.db, config: graphOn, providers });

    // The owner's and the granted agent's reads serve the honest empty scoped
    // outcome: no unrelated public example cards stand in.
    const ownerRead = (await get(`/v1/items/${sample}`, { cookie: owner.token })).body as unknown as Rail;
    expect(ownerRead.related).toEqual([]);
    expect(ownerRead.related_state).toBe('none');
    expect(ownerRead.related_job_id).toBe(scoped.job_id);
    const agentRead = (await get(`/v1/items/${sample}?collection_id=${col.id}`, { bearer: `Bearer ${agent.credential}` }))
      .body as unknown as Rail;
    expect(agentRead.related).toEqual([]);
    expect(agentRead.related_state).toBe('none');
    expect(agentRead.related_job_id).toBe(scoped.job_id);

    // Graph-off control: the same route keeps the ordinary example carousel
    // (the legacy sample read behavior is unchanged).
    try {
      setDomainConfigForTesting(graphOff);
      const offRead = (await get(`/v1/items/${sample}`, { cookie: owner.token })).body as unknown as Rail;
      expect(offRead.related_state).toBe('cached');
      expect(offRead.related.length).toBeGreaterThan(0);
      expect(offRead.related.every((r) => r.is_example)).toBe(true);
    } finally {
      setDomainConfigForTesting(graphOn);
    }
  });

  it('serves exactly the admitted scoped results of a saved sample through the real route', async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
    const rodinRef = await upsertReference(iso.db, {
      canonicalKey: `qloo:${RODIN_QLOO_ID}`,
      name: 'Auguste Rodin',
      type: 'creator',
      externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    // A public shared sample carrying the verified Rodin subject identity,
    // grounded by the owner's save into the granted collection.
    const sample = await insertItem(
      null,
      {
        kind: 'artist',
        category: 'play',
        title: 'Auguste Rodin',
        key: `sample:rodin-web-${randomUUID().slice(0, 6)}`,
        qloo: RODIN_QLOO_ID,
        referenceId: rodinRef,
      },
      iso.db,
    );
    const col = await collections.createCollection(ownerCtx, { name: `Sample museum ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });
    await linkGraphReferenceIdentities(iso.db);
    const agent = await insertAgentConnection(
      owner.principal,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
      iso.db,
    );

    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'play' } });
    await runJob(scoped.job_id, { db: iso.db, config: graphOn, providers });

    const read = (await get(`/v1/items/${sample}?collection_id=${col.id}`, { bearer: `Bearer ${agent.credential}` }))
      .body as unknown as Rail;
    expect(read.related_state).toBe('cached');
    expect(read.related.map((r) => r.title)).toEqual(['Georges Seurat']);
    expect(read.related.every((r) => !r.is_example)).toBe(true);
    expect(read.related_job_id).toBe(scoped.job_id);
  });
});
