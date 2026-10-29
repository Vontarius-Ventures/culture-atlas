import { randomUUID } from 'node:crypto';
import type { QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import { ensureSampleItems, sampleKey } from '../feed/samples';
import { resolvePrincipal } from '../services/auth';
import { addCollectionItem, createCollection } from '../services/collections';
import { getItem, startRelatedDiscovery } from '../services/items';
import { insertItem, runJob } from '../test-support/library';
import {
  createIsolatedDatabase,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
  testProviders,
} from '../testing';
import { admitGraphCorpus } from './corpus';
import { getCorpusManifestFile } from './corpus-manifest';
import { linkGraphReferenceIdentities } from './identity-links';

/**
 * Compatible discovery-context selection on item reads (round-9 repairs
 * DISC-SCR-043/044, the remaining legs of DISC-SCR-033).
 *
 * The round-8 read repair suppressed interest-pool padding for a scoped
 * context but still chose the active and completed parents independently
 * across the origin's whole job history, and the public-sample branch never
 * selected its explicit scoped job at all. These tests hold the fixed reader
 * to the approved exact-context rule:
 *
 *  - DISC-SCR-043: the authorized compatible collection and graph/legacy
 *    context is selected BEFORE the active/completed parent choice. A read
 *    for collection A never serves B's or a legacy whole-library discovery's
 *    results, and a fresh scoped request (pending or honestly empty) never
 *    reuses an older incompatible context's cached results. The legacy rail
 *    keeps its own compatible path.
 *  - DISC-SCR-044: a saved public sample with an explicit graph-on scoped
 *    operation serves that context's admitted results or its honest empty
 *    outcome — never unrelated public example cards standing in for the
 *    scoped rail. The ordinary example carousel remains for graph-off reads
 *    and samples without a scoped operation.
 *
 * Everything runs the REAL enqueue + handler path on isolated databases with
 * the committed reviewed corpus and zero live provider calls.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const graphOff = testConfig();

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';

/** A fake Qloo that RECORDS every call and fails closed on each one. */
function noCallQloo(): FakeQloo {
  return new FakeQloo({}, { live: true });
}

const qlooEntity = (id: string, name: string): QlooEntity => ({ entity_id: id, name, types: [], properties: {}, tags: [] });

/** Legacy whole-library provider results (the pre-graph Discover more path). */
function legacyResultsQloo(prefix: string): FakeQloo {
  return new FakeQloo(
    {
      insights: (req) => ({
        entities: [qlooEntity(`${prefix}-${req.filterType.split(':').pop()}`, `Provider pick ${prefix}`)],
        tags: [],
      }),
    },
    { live: true },
  );
}

async function qlooPersonReference(db: PoolDb, qlooId: string, name: string): Promise<string> {
  return upsertReference(db, {
    canonicalKey: `qloo:${qlooId}`,
    name,
    type: 'creator',
    externalIds: { qloo: qlooId, qloo_types: ['urn:entity:person'] },
  });
}

/** The fresh per-request agent principal the REST/MCP layers resolve on every call. */
async function freshAgentCtx(db: PoolDb, credential: string): Promise<ServiceContext> {
  const principal = await resolvePrincipal(db, { authorization: `Bearer ${credential}` });
  expect(principal?.kind).toBe('agent');
  return testContext(principal!, { db, config: graphOn });
}

async function shippedSampleId(db: PoolDb, slug: string): Promise<string> {
  await ensureSampleItems(db);
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM discovery_items WHERE is_sample AND canonical_key = $1',
    [sampleKey(slug)],
  );
  return rows[0]!.id;
}

/** The ids one scoped parent published, in rank order. */
async function publishedItemIds(db: PoolDb, discoveryJobId: string): Promise<string[]> {
  const { rows } = await db.query<{ discovery_item_id: string }>(
    'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
    [discoveryJobId],
  );
  return rows.map((r) => r.discovery_item_id);
}

describe('compatible discovery context selection on item reads (DISC-SCR-043)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scrdrl');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  it('a fresh scoped request never reuses an older legacy whole-library discovery: pending is pending and empty stays empty', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const legacyOrigin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'film', category: 'watch', title: 'Legacy discovery film', qloo: `film-${randomUUID()}` },
      isoDb,
    );
    const col = await createCollection(ownerCtx, { name: `Movie nights ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: legacyOrigin, body: {} });

    // The owner's older whole-library Discover more completes with provider
    // results (the only discovery context so far).
    const legacy = await startRelatedDiscovery(ownerCtx, { id: legacyOrigin, body: { category: 'watch' } });
    const legacyOut = await runJob(legacy.job_id, {
      db: isoDb,
      config: graphOn,
      providers: testProviders({ qloo: legacyResultsQloo('lg1') }),
    });
    expect(legacyOut.state).toBe('complete');
    const legacyRead = await getItem(ownerCtx, { id: legacyOrigin, query: {} });
    expect(legacyRead.related_state).toBe('cached');
    expect(legacyRead.related.length).toBeGreaterThan(0);
    expect(legacyRead.related.every((r) => !r.is_example)).toBe(true);

    // A fresh scoped request for the same origin is enqueued (queued, not run).
    const scoped = await startRelatedDiscovery(ownerCtx, { id: legacyOrigin, body: { collection_id: col.id } });

    // The pending scoped context is served honestly: the request's own
    // pending state, an EMPTY rail and the scoped job id — the older legacy
    // results are an incompatible context and never fill this rail.
    const ownerPending = await getItem(ownerCtx, { id: legacyOrigin, query: {} });
    expect(ownerPending.related).toEqual([]);
    expect(ownerPending.related_state).toBe('pending');
    expect(ownerPending.related_job_id).toBe(scoped.job_id);

    // The explicit collection read agrees: only that collection's context.
    const ownerPendingScoped = await getItem(ownerCtx, { id: legacyOrigin, query: { collection_id: col.id } });
    expect(ownerPendingScoped.related).toEqual([]);
    expect(ownerPendingScoped.related_state).toBe('pending');
    expect(ownerPendingScoped.related_job_id).toBe(scoped.job_id);

    // The unmapped origin's scoped graph pass honestly admits nothing: the
    // completed scoped rail stays empty — the legacy results never return.
    const qloo = noCallQloo();
    const out = await runJob(scoped.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    const ownerEmpty = await getItem(ownerCtx, { id: legacyOrigin, query: {} });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    expect(ownerEmpty.related_job_id).toBe(scoped.job_id);
    const ownerEmptyScoped = await getItem(ownerCtx, { id: legacyOrigin, query: { collection_id: col.id } });
    expect(ownerEmptyScoped.related).toEqual([]);
    expect(ownerEmptyScoped.related_state).toBe('none');
    expect(ownerEmptyScoped.related_job_id).toBe(scoped.job_id);
  });

  it("a collection-A read never serves B's newer results: A's honest empty rail stays empty", async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      isoDb,
    );
    const colA = await createCollection(ownerCtx, { name: `Museum A ${randomUUID().slice(0, 6)}` });
    const colB = await createCollection(ownerCtx, { name: `Museum B ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    await addCollectionItem(ownerCtx, { id: colB.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(isoDb);
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
      isoDb,
    );

    // A's watch-filtered scoped discovery honestly admits nothing.
    const underA = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'watch' } });
    await runJob(underA.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    expect(await publishedItemIds(isoDb, underA.discovery_job_id)).toEqual([]);

    // B's NEWER play discovery publishes the reviewed Rodin→museum→Seurat path.
    const underB = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colB.id, category: 'play' } });
    await runJob(underB.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    const candidate = (await publishedItemIds(isoDb, underB.discovery_job_id))[0]!;
    expect(candidate).toBeTruthy();

    // The agent's A read serves A's honest empty rail — never B's newer
    // completed results.
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const aRead = await getItem(actx, { id: origin, query: { collection_id: colA.id } });
    expect(aRead.related).toEqual([]);
    expect(aRead.related_state).toBe('none');
    expect(aRead.related_job_id).toBe(underA.job_id);

    // The B read serves exactly B's admitted result.
    const bRead = await getItem(actx, { id: origin, query: { collection_id: colB.id } });
    expect(bRead.related_state).toBe('cached');
    expect(bRead.related.map((r) => r.id)).toEqual([candidate]);
    expect(bRead.related_job_id).toBe(underB.job_id);

    // The owner's reads agree with the agent's exact-context rails.
    const ownerA = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(ownerA.related).toEqual([]);
    expect(ownerA.related_state).toBe('none');
    expect(ownerA.related_job_id).toBe(underA.job_id);
    const ownerB = await getItem(ownerCtx, { id: origin, query: { collection_id: colB.id } });
    expect(ownerB.related.map((r) => r.id)).toEqual([candidate]);

    // A collection-less read follows the origin's newest context (B) — it
    // still never mixes A's or legacy results into one rail.
    const ownerNewest = await getItem(ownerCtx, { id: origin, query: {} });
    expect(ownerNewest.related.map((r) => r.id)).toEqual([candidate]);
    expect(ownerNewest.related_job_id).toBe(underB.job_id);
    const agentNewest = await getItem(actx, { id: origin, query: {} });
    expect(agentNewest.related.map((r) => r.id)).toEqual([candidate]);
  });
});

describe('saved public sample scoped result reads (DISC-SCR-044)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scrdsmp');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  it('a saved sample whose scoped graph discovery admitted nothing serves its honest empty outcome, not unrelated example cards', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    const sample = await shippedSampleId(isoDb, 'film-playtime');
    const col = await createCollection(ownerCtx, { name: `Saved samples ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
      isoDb,
    );

    // Control: before any scoped operation the ordinary example carousel is
    // the sample's rail (graph-on read, saved sample, no discovery yet).
    const before = await getItem(ownerCtx, { id: sample, query: {} });
    expect(before.related_state).toBe('cached');
    expect(before.related.length).toBeGreaterThan(0);
    expect(before.related.every((r) => r.is_example)).toBe(true);

    // An explicit graph-on scoped operation for this saved sample is
    // enqueued (queued, not run): its pending context replaces the carousel.
    const started = await startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id } });
    const pending = await getItem(ownerCtx, { id: sample, query: {} });
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(started.job_id);
    const pendingScoped = await getItem(ownerCtx, { id: sample, query: { collection_id: col.id } });
    expect(pendingScoped.related).toEqual([]);
    expect(pendingScoped.related_state).toBe('pending');
    expect(pendingScoped.related_job_id).toBe(started.job_id);

    // The shipped sample carries no graph identities: the pass publishes
    // nothing, zero provider calls.
    const qloo = noCallQloo();
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    expect(await publishedItemIds(isoDb, started.discovery_job_id)).toEqual([]);

    // The completed scoped rail is the honest empty outcome for the owner
    // AND the granted agent: no unrelated public example cards stand in.
    const ownerEmpty = await getItem(ownerCtx, { id: sample, query: {} });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    expect(ownerEmpty.related_job_id).toBe(started.job_id);
    const ownerEmptyScoped = await getItem(ownerCtx, { id: sample, query: { collection_id: col.id } });
    expect(ownerEmptyScoped.related).toEqual([]);
    expect(ownerEmptyScoped.related_state).toBe('none');
    expect(ownerEmptyScoped.related_job_id).toBe(started.job_id);
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const agentEmpty = await getItem(actx, { id: sample, query: { collection_id: col.id } });
    expect(agentEmpty.related).toEqual([]);
    expect(agentEmpty.related_state).toBe('none');
    expect(agentEmpty.related_job_id).toBe(started.job_id);

    // Graph-off control: the same saved sample keeps the ordinary example
    // carousel (the legacy sample read behavior is unchanged).
    const offRead = await getItem(ownerOffCtx, { id: sample, query: {} });
    expect(offRead.related_state).toBe('cached');
    expect(offRead.related.length).toBeGreaterThan(0);
    expect(offRead.related.every((r) => r.is_example)).toBe(true);

    // An untouched shipped sample (no scoped operation at all) keeps the
    // carousel on graph-on reads too.
    const untouched = await shippedSampleId(isoDb, 'artist-nina-simone');
    const untouchedRead = await getItem(ownerCtx, { id: untouched, query: {} });
    expect(untouchedRead.related_state).toBe('cached');
    expect(untouchedRead.related.every((r) => r.is_example)).toBe(true);
  });

  it('a saved sample with admitted scoped results serves exactly those results', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    // A public shared sample carrying the verified Rodin subject identity:
    // ownerless (is_sample), grounded by the owner's save into the granted
    // collection.
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
    const sample = await insertItem(
      null,
      {
        kind: 'artist',
        category: 'play',
        title: 'Auguste Rodin',
        key: `sample:rodin-${randomUUID().slice(0, 6)}`,
        qloo: RODIN_QLOO_ID,
        referenceId: rodinRef,
      },
      isoDb,
    );
    const col = await createCollection(ownerCtx, { name: `Sample museum ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });
    await linkGraphReferenceIdentities(isoDb);
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
      isoDb,
    );

    const started = await startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'play' } });
    const out = await runJob(started.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    expect(out.state).toBe('complete');
    const candidate = (await publishedItemIds(isoDb, started.discovery_job_id))[0]!;

    // The scoped rail carries the admitted result for the owner and the
    // granted agent — the example carousel never stands in or pads it.
    const ownerRead = await getItem(ownerCtx, { id: sample, query: { collection_id: col.id } });
    expect(ownerRead.related_state).toBe('cached');
    expect(ownerRead.related.map((r) => r.id)).toEqual([candidate]);
    expect(ownerRead.related.every((r) => !r.is_example)).toBe(true);
    expect(ownerRead.related_job_id).toBe(started.job_id);
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const agentRead = await getItem(actx, { id: sample, query: { collection_id: col.id } });
    expect(agentRead.related_state).toBe('cached');
    expect(agentRead.related.map((r) => r.id)).toEqual([candidate]);
    expect(agentRead.related_job_id).toBe(started.job_id);

    // The collection-less read follows the sample's explicit scoped context.
    const newest = await getItem(ownerCtx, { id: sample, query: {} });
    expect(newest.related.map((r) => r.id)).toEqual([candidate]);
    expect(newest.related_job_id).toBe(started.job_id);
  });
});
