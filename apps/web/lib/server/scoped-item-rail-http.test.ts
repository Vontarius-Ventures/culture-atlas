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
  retractGraphEvidence,
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

/**
 * Route-level retained-candidate visibility (round-9 repair DISC-SCR-045):
 * the REAL /v1/items/{id} handler serves a grant-derived scoped candidate
 * only while its pinned proof currently serves. After the sole evidence
 * retracts, the retained candidate ID answers 404 for the granted agent —
 * the durable recommendation row alone is no witness — while public items,
 * an EXPLICIT save in the granted collection and the first-party owner keep
 * reading. This describe runs on its OWN isolated database (retraction is
 * permanent for its evidence rows, and the file's shared corpus serves the
 * other describes) by swapping the route handler's testing DB for its tests.
 */
describe('GET /v1/items/{id} candidate visibility survives only while the scoped proof serves (DISC-SCR-045)', () => {
  let vis: Awaited<ReturnType<typeof createIsolatedDatabase>>;

  beforeAll(async () => {
    vis = await createIsolatedDatabase('scrdvisweb');
    await admitGraphCorpus(vis.db, getCorpusManifestFile());
    setDbForTesting(vis.db);
  });
  afterAll(async () => {
    // Restore the file's shared database before the module-level afterAll
    // clears the testing handles.
    setDbForTesting(iso.db);
    await vis.drop();
  });

  /** One account whose browser session cookie is a known token, on this describe's DB. */
  async function visOwner() {
    const principal = await insertAccount(vis.db);
    const token = randomUUID();
    await vis.db.query(`UPDATE sessions SET token_hash=$2 WHERE id=$1`, [principal.sessionId, auth.hashToken(token)]);
    return { principal, token };
  }

  it('denies the retained candidate ID after sole-source retraction, keeping public items, granted saves and the owner', async () => {
    const owner = await visOwner();
    const ownerCtx = testContext(owner.principal, { db: vis.db, config: graphOn });
    const rodinRef = await upsertReference(vis.db, {
      canonicalKey: `qloo:${RODIN_QLOO_ID}`,
      name: 'Auguste Rodin',
      type: 'creator',
      externalIds: { qloo: RODIN_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    const seuratRef = await upsertReference(vis.db, {
      canonicalKey: `qloo:${SEURAT_QLOO_ID}`,
      name: 'Georges Seurat',
      type: 'creator',
      externalIds: { qloo: SEURAT_QLOO_ID, qloo_types: ['urn:entity:person'] },
    });
    const origin = await insertItem(
      { accountId: owner.principal.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      vis.db,
    );
    const col = await collections.createCollection(ownerCtx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(vis.db);
    const agent = await insertAgentConnection(
      owner.principal,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
      vis.db,
    );
    const bearer = `Bearer ${agent.credential}`;

    // The scoped operation publishes one admitted candidate with a pinned proof.
    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'play' } });
    await runJob(scoped.job_id, { db: vis.db, config: graphOn, providers });
    const rail = (await get(`/v1/items/${origin}?collection_id=${col.id}`, { bearer })).body as unknown as Rail;
    expect(rail.related_state).toBe('cached');
    expect(rail.related.map((r) => r.title)).toEqual(['Georges Seurat']);
    const candidateId = rail.related[0]!.id;

    // Control: the real route serves the published candidate to the agent.
    const control = await get(`/v1/items/${candidateId}?collection_id=${col.id}`, { bearer });
    expect(control.status).toBe(200);
    const { rows: candidateRows } = await vis.db.query<{ reference_id: string | null }>(
      'SELECT reference_id FROM discovery_items WHERE id = $1',
      [candidateId],
    );
    expect(candidateRows[0]!.reference_id).toBe(seuratRef);

    // Withdraw the walked path's sole evidence (the real retraction path).
    const rodinAssociation = await vis.db.query<{ id: string }>(
      `SELECT a.id FROM graph_assertions a
         JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = 'atlas:creator:auguste-rodin'
         JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = 'atlas:place:art-institute-of-chicago'
        WHERE a.predicate = 'DOCUMENTED_ASSOCIATION'`,
    );
    const soleEvidence = await vis.db.query<{ evidence_id: string }>(
      `SELECT s.evidence_id
         FROM graph_assertion_support s
         JOIN graph_evidence e ON e.id = s.evidence_id
        WHERE s.assertion_id = $1 AND s.role = 'supports' AND e.validity_state = 'valid'`,
      [rodinAssociation.rows[0]!.id],
    );
    const retraction = await retractGraphEvidence(vis.db, {
      evidenceId: soleEvidence.rows[0]!.evidence_id,
      reason: 'withdrawn after publication',
    });
    expect(retraction.scopedProofsInvalidated).toBe(1);

    // DISC-SCR-045: the retained candidate ID answers 404 through the real
    // route — the only grant-visible context was the withdrawn scoped proof,
    // and the candidate has no independent granted context.
    const denied = await get(`/v1/items/${candidateId}?collection_id=${col.id}`, { bearer });
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ code: 'not_found' });

    // The origin rail is honest while the origin stays readable.
    const originAfter = (await get(`/v1/items/${origin}?collection_id=${col.id}`, { bearer })).body as unknown as Rail;
    expect(originAfter.related).toEqual([]);
    expect(originAfter.related_state).toBe('none');

    // Public item control: a shipped public sample stays readable under the grant.
    await ensureSampleItems(vis.db);
    const { rows: sampleRows } = await vis.db.query<{ id: string }>('SELECT id FROM discovery_items WHERE is_sample LIMIT 1');
    expect(sampleRows.length).toBeGreaterThan(0);
    expect((await get(`/v1/items/${sampleRows[0]!.id}?collection_id=${col.id}`, { bearer })).status).toBe(200);

    // Granted-save control: an EXPLICIT save in the granted collection
    // restores the candidate read — an authorization independent of the
    // withdrawn proof. Its scoped reason stays withdrawn (the taste row below
    // pins the same candidate so the owner keeps a reason; agents never see
    // taste-seed authority under the grant).
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: candidateId, body: {} });
    const restored = (await get(`/v1/items/${candidateId}?collection_id=${col.id}`, { bearer })).body as {
      reason: string | null;
    };
    expect(restored.reason).toBeNull();

    // Owner control: first-party ownership keeps the card through the real
    // route, with the withdrawn scoped reason gone and the independent taste
    // reason serving (DISC-SCR-046's survival case through the route).
    const tasteRun = await vis.db.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
       VALUES ($1, 0, 'complete', 1) RETURNING id`,
      [owner.principal.accountId],
    );
    await vis.db.query(
      `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                    external_ids, display_reason, origin, provider_query_ids, created_at)
       VALUES ($1, $2, 'play', 1, 'Georges Seurat', '{}'::jsonb, 'From your interests.', 'catalog',
               ARRAY[]::uuid[], now() - interval '2 hours')`,
      [tasteRun.rows[0]!.id, candidateId],
    );
    const ownerRead = (await get(`/v1/items/${candidateId}`, { cookie: owner.token })).body as {
      reason: string | null;
      item: { id: string };
    };
    expect(ownerRead.item.id).toBe(candidateId);
    expect(ownerRead.reason).toBe('From your interests.');

    // Provenance control: the durable scoped row survives — only its serving
    // was withdrawn.
    const { rows: recs } = await vis.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
      [scoped.discovery_job_id],
    );
    expect(Number(recs[0]!.n)).toBe(1);
  });
});

/**
 * Route-level checks of the round-10 execution-class and failed-context
 * repairs (DISC-SCR-047/048): the REAL /v1/items/{id} handler must separate
 * the graph and legacy execution classes of one collection before choosing
 * the active/completed parents — a fresh graph-on request never borrows an
 * older same-collection graph-off provider completion, a saved sample never
 * mistakes one for explicit graph work — and a scoped context whose only
 * parent failed or was cancelled keeps its honest empty rail instead of
 * unrelated account/other-collection cards. Graph-off reads keep the legacy
 * pairing and padding on their own compatible path.
 */
describe('GET /v1/items/{id} separates execution class and keeps failed scoped contexts isolated (DISC-SCR-047/048)', () => {
  /**
   * The legacy interest-pool padding source: a completed taste seed carrying
   * one unrelated account-wide card, also saved into a second granted
   * collection so an A+B agent can independently see it.
   */
  async function seedPoolCard(db: typeof iso.db, accountId: string): Promise<string> {
    const item = await insertItem(
      { accountId },
      { kind: 'brand', category: 'wear', title: 'Unrelated taste brand' },
      db,
    );
    const run = await db.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
       VALUES ($1, 0, 'complete', 1) RETURNING id`,
      [accountId],
    );
    const pq = randomUUID();
    await db.query(
      `INSERT INTO provider_queries (id, taste_seed_run_id, provider, operation, sanitized_request, results, status)
       VALUES ($1, $2, 'qloo', 'insights', '{}'::jsonb, NULL, 'ok')`,
      [pq, run.rows[0]!.id],
    );
    await db.query(
      `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                    external_ids, display_reason, origin, provider_query_ids)
       VALUES ($1, $2, 'wear', 1, 'Unrelated taste brand', '{}'::jsonb, 'From your interests.', 'qloo', ARRAY[$3::uuid])`,
      [run.rows[0]!.id, item, pq],
    );
    return item;
  }

  /** Re-anchor one scoped discovery's immutable work window into the past through the row's own closed path (fixture setup, not production retry). */
  async function expireWorkWindow(db: typeof iso.db, discoveryJobId: string): Promise<void> {
    await db.query(
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
  }

  it('a fresh graph-on scoped request never borrows an older same-collection graph-off provider completion (DISC-SCR-047)', async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
    const origin = await insertItem(
      { accountId: owner.principal.accountId },
      { kind: 'film', category: 'watch', title: 'Rollout discovery film', qloo: `film-${randomUUID()}` },
      iso.db,
    );
    const col = await collections.createCollection(ownerCtx, { name: `Movie nights ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: origin, body: {} });

    // The graph-off era: the selected-collection Discover more ran the LEGACY
    // provider branch (same origin_collection_id and scoped marker as a
    // graph job) and completed with one provider card.
    const legacy = await items.startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'watch' } });
    await runJob(legacy.job_id, { db: iso.db, config: graphOff, providers: testProviders({ qloo: legacyResultsQloo('xwr') }) });
    const { rows: legacyRows } = await iso.db.query<{ discovery_item_id: string }>(
      'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1',
      [legacy.discovery_job_id],
    );
    expect(legacyRows.length).toBeGreaterThan(0);

    // Rollout: a genuinely fresh scoped request is enqueued. The real route
    // serves its pending context honestly — the older provider completion is
    // a different execution class and never fills this rail.
    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'play' } });
    const pending = (await get(`/v1/items/${origin}`, { cookie: owner.token })).body as unknown as Rail;
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(scoped.job_id);
    const pendingScoped = (await get(`/v1/items/${origin}?collection_id=${col.id}`, { cookie: owner.token }))
      .body as unknown as Rail;
    expect(pendingScoped.related).toEqual([]);
    expect(pendingScoped.related_state).toBe('pending');
    expect(pendingScoped.related_job_id).toBe(scoped.job_id);

    // Graph-off control through the same route: the legacy pairing survives
    // — pending fresh work with the older provider card as the cached rail.
    try {
      setDomainConfigForTesting(graphOff);
      const offPending = (await get(`/v1/items/${origin}?collection_id=${col.id}`, { cookie: owner.token }))
        .body as unknown as Rail;
      expect(offPending.related_state).toBe('pending');
      expect(offPending.related_job_id).toBe(scoped.job_id);
      expect(offPending.related.map((r) => r.id)).toEqual(legacyRows.map((r) => r.discovery_item_id));
    } finally {
      setDomainConfigForTesting(graphOn);
    }

    // The fresh graph pass honestly admits nothing (unmapped origin): the
    // completed scoped rail stays empty — the provider card never returns.
    await runJob(scoped.job_id, { db: iso.db, config: graphOn, providers });
    const empty = (await get(`/v1/items/${origin}`, { cookie: owner.token })).body as unknown as Rail;
    expect(empty.related).toEqual([]);
    expect(empty.related_state).toBe('none');
    expect(empty.related_job_id).toBe(scoped.job_id);
  });

  it('a saved sample keeps its carousel when the only scoped job ran the graph-off provider branch; a fresh graph-on operation takes the rail (DISC-SCR-047)', async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
    await ensureSampleItems(iso.db);
    // A public shared sample with a provider-resolvable identity.
    const sample = await insertItem(
      null,
      {
        kind: 'artist',
        category: 'play',
        title: 'Sample sculptor',
        key: `sample:sculptor-web-${randomUUID().slice(0, 6)}`,
        qloo: `artist-${randomUUID()}`,
      },
      iso.db,
    );
    const col = await collections.createCollection(ownerCtx, { name: `Sample shelf ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });

    // Control: before any discovery the ordinary example carousel serves.
    const before = (await get(`/v1/items/${sample}`, { cookie: owner.token })).body as unknown as Rail;
    expect(before.related_state).toBe('cached');
    expect(before.related.length).toBeGreaterThan(0);
    expect(before.related.every((r) => r.is_example)).toBe(true);

    // The graph-off era: the selected-collection operation runs the LEGACY
    // provider branch and publishes one provider card for this sample.
    const legacy = await items.startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'play' } });
    await runJob(legacy.job_id, { db: iso.db, config: graphOff, providers: testProviders({ qloo: legacyResultsQloo('xws') }) });
    const { rows: legacyRows } = await iso.db.query<{ discovery_item_id: string }>(
      'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1',
      [legacy.discovery_job_id],
    );
    expect(legacyRows.length).toBeGreaterThan(0);

    // The graph-on sample read keeps the ordinary example carousel: the old
    // provider job is NOT explicit graph work and never takes the sample rail.
    const carousel = (await get(`/v1/items/${sample}`, { cookie: owner.token })).body as unknown as Rail;
    expect(carousel.related_state).toBe('cached');
    expect(carousel.related.length).toBeGreaterThan(0);
    expect(carousel.related.every((r) => r.is_example)).toBe(true);

    // A fresh explicit graph-on scoped operation takes the sample rail
    // honestly: pending, then its own completed empty outcome.
    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'watch' } });
    const pending = (await get(`/v1/items/${sample}`, { cookie: owner.token })).body as unknown as Rail;
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(scoped.job_id);
    await runJob(scoped.job_id, { db: iso.db, config: graphOn, providers });
    const empty = (await get(`/v1/items/${sample}`, { cookie: owner.token })).body as unknown as Rail;
    expect(empty.related).toEqual([]);
    expect(empty.related_state).toBe('none');
    expect(empty.related_job_id).toBe(scoped.job_id);
  });

  it('a scoped context whose only parent failed at its immutable deadline serves honest empty — never the account pool or another granted collection save (DISC-SCR-048)', async () => {
    const owner = await browserOwner();
    const ownerCtx = testContext(owner.principal, { db: iso.db, config: graphOn });
    const origin = await insertItem(
      { accountId: owner.principal.accountId },
      { kind: 'film', category: 'watch', title: 'Failed window film', qloo: `film-${randomUUID()}` },
      iso.db,
    );
    const colA = await collections.createCollection(ownerCtx, { name: `Museum A ${randomUUID().slice(0, 6)}` });
    const colB = await collections.createCollection(ownerCtx, { name: `Museum B ${randomUUID().slice(0, 6)}` });
    await collections.addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    const seedCard = await seedPoolCard(iso.db, owner.principal.accountId);
    await collections.addCollectionItem(ownerCtx, { id: colB.id, item_id: seedCard, body: {} });
    const agent = await insertAgentConnection(
      owner.principal,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
      iso.db,
    );

    // The origin's first graph-on scoped discovery is delayed past its
    // immutable work window and fails nonretryably BEFORE any results: the
    // durable 'graph' stage records the executed class, nothing is published
    // and no provider call runs.
    const scoped = await items.startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id } });
    await expireWorkWindow(iso.db, scoped.discovery_job_id);
    const noQloo = testProviders({ qloo: new FakeQloo({}, { live: true }) });
    await expect(runJob(scoped.job_id, { db: iso.db, config: graphOn, providers: noQloo })).rejects.toThrow();

    // The owner's read of the failed exact context is honest through the
    // real route: the unrelated interest-pool card never fills the rail.
    const ownerEmpty = (await get(`/v1/items/${origin}?collection_id=${colA.id}`, { cookie: owner.token }))
      .body as unknown as Rail;
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');

    // The A+B-granted agent reading the failed A context sees the same
    // honest empty — its B-saved seed card is independently visible, yet
    // never stands in for the scoped outcome.
    const agentRead = (await get(`/v1/items/${origin}?collection_id=${colA.id}`, { bearer: `Bearer ${agent.credential}` }))
      .body as unknown as Rail;
    expect(agentRead.related).toEqual([]);
    expect(agentRead.related_state).toBe('none');

    // Graph-off control through the same route: the legacy fallback fills
    // the empty rail there (the compatible path is unchanged).
    try {
      setDomainConfigForTesting(graphOff);
      const offRead = (await get(`/v1/items/${origin}?collection_id=${colA.id}`, { cookie: owner.token }))
        .body as unknown as Rail;
      expect(offRead.related.map((r) => r.id)).toEqual([seedCard]);
      expect(offRead.related_state).toBe('cached');
    } finally {
      setDomainConfigForTesting(graphOn);
    }
  });
});
