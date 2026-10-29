import { randomUUID } from 'node:crypto';
import type { QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import type { Category, ItemKind } from '../enums';
import { ensureSampleItems, sampleKey } from '../feed/samples';
import { GraphWorkDeadlineExpiredError } from './budgets';
import { cancelJob } from '../jobs/queue';
import { resolvePrincipal } from '../services/auth';
import { addCollectionItem, createCollection } from '../services/collections';
import { getItem, startRelatedDiscovery } from '../services/items';
import { insertItem, runClaimedAttempt, runJob } from '../test-support/library';
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
 *  - DISC-SCR-047 (round 10): the compatible context is the PAIR of the
 *    origin collection and the actual EXECUTION CLASS of its work. The
 *    class is durable evidence of which producer branch ran — the `graph`
 *    job stage proves the scoped graph pass executed, other stage rows
 *    prove the legacy provider path executed, and work with no stage rows
 *    has not started (it claims no provenance and follows today's graph-on
 *    eligibility). The scoped_authority_required marker is NOT the class:
 *    graph-off selected-collection jobs carry it too. A fresh graph-on
 *    request never borrows an older same-collection provider completion,
 *    and a graph-on sample read never mistakes one for explicit graph work.
 *  - DISC-SCR-048 (round 10): a scoped context whose only parent failed,
 *    was cancelled or expired before results keeps its scoped isolation —
 *    the owner and an A+B-granted agent see an honest empty rail, never
 *    unrelated account taste cards or the other granted collection's saved
 *    card. Graph-off reads keep the legacy interest-pool fallback on their
 *    own compatible path.
 *  - DISC-SCR-049 (round 11): job_stages is CUMULATIVE across attempts, so
 *    historical graph-stage existence proves only that a graph attempt
 *    OCCURRED, never that it produced the current results. A real
 *    graph-on attempt that persists its stage then crashes before
 *    publication can be redelivered after lease expiry with graph disabled:
 *    the graph-off reclaim runs the LEGACY provider branch and publishes
 *    provider results on the SAME discovery parent. Graph-on scoped reads
 *    never borrow those proofless results (fresh selected-collection
 *    pending rails, owner/agent reads and saved-sample carousels alike):
 *    mixed graph/legacy history classifies as graph ONLY when the current
 *    results themselves are proven graph-produced (their pinned scoped
 *    proofs — which any legacy republication deletes with the rows it
 *    replaces). Graph-only pending/failed no-padding, the valid graph-only
 *    cache and graph-off legacy behavior all stay preserved.
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

describe('execution class and failed-context isolation on item reads (DISC-SCR-047/048)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scrdxec');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  /**
   * The legacy interest-pool padding source: a completed taste seed carrying
   * one unrelated account-wide card (the pool `interestPoolRelatedIds`
   * reads), also saved into a second granted collection so an A+B agent can
   * independently see it (the ordinary pool/grant arrangement of the
   * read-context tests).
   */
  async function seedPoolCard(db: PoolDb, accountId: string, opts: { kind: ItemKind; category: Category; title: string }): Promise<string> {
    const item = await insertItem({ accountId }, { kind: opts.kind, category: opts.category, title: opts.title }, db);
    const run = await db.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
       VALUES ($1, 0, 'complete', 1) RETURNING id`,
      [accountId],
    );
    const seedRunId = run.rows[0]!.id;
    const pq = randomUUID();
    await db.query(
      `INSERT INTO provider_queries (id, taste_seed_run_id, provider, operation, sanitized_request, results, status)
       VALUES ($1, $2, 'qloo', 'insights', '{}'::jsonb, NULL, 'ok')`,
      [pq, seedRunId],
    );
    await db.query(
      `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                    external_ids, display_reason, origin, provider_query_ids)
       VALUES ($1, $2, $3, 1, $4, '{}'::jsonb, 'From your interests.', 'qloo', ARRAY[$5::uuid])`,
      [seedRunId, item, opts.category, opts.title, pq],
    );
    return item;
  }

  /**
   * Re-anchor one scoped discovery's immutable work window into the past
   * through the row's own closed path (DELETE + fresh INSERT, exactly the
   * enqueue transaction's dedupe-race cleanup — the migration-360 trigger
   * rejects in-place rewrites). Test-fixture setup for a delayed execution,
   * not production retry semantics.
   */
  async function expireWorkWindow(db: PoolDb, discoveryJobId: string): Promise<void> {
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
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'film', category: 'watch', title: 'Rollout discovery film', qloo: `film-${randomUUID()}` },
      isoDb,
    );
    const col = await createCollection(ownerCtx, { name: `Movie nights ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: origin, body: {} });

    // The graph-off era: this selected-collection Discover more ran the
    // LEGACY provider branch — the same origin_collection_id and scoped
    // marker a graph job would carry — and completed with a provider card.
    const legacy = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'watch' } });
    const legacyOut = await runJob(legacy.job_id, { db: isoDb, config: graphOff, providers: testProviders({ qloo: legacyResultsQloo('xcl') }) });
    expect(legacyOut.state).toBe('complete');
    const legacyIds = await publishedItemIds(isoDb, legacy.discovery_job_id);
    expect(legacyIds.length).toBeGreaterThan(0);

    // Graph-off reads keep the provider card on its own compatible legacy path.
    const offCached = await getItem(ownerOffCtx, { id: origin, query: { collection_id: col.id } });
    expect(offCached.related_state).toBe('cached');
    expect(offCached.related.map((r) => r.id)).toEqual(legacyIds);

    // Rollout: graph discovery is enabled and a GENUINELY FRESH request for
    // the same origin/A is enqueued (a different category is new work). Its
    // pending rail is honest — the old provider completion is a different
    // execution class and never fills it.
    const scoped = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'play' } });
    const pending = await getItem(ownerCtx, { id: origin, query: {} });
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(scoped.job_id);
    const pendingScoped = await getItem(ownerCtx, { id: origin, query: { collection_id: col.id } });
    expect(pendingScoped.related).toEqual([]);
    expect(pendingScoped.related_state).toBe('pending');
    expect(pendingScoped.related_job_id).toBe(scoped.job_id);

    // Graph-off control: the same stored state keeps the legacy pairing —
    // pending fresh work with the older provider card as the cached rail.
    const offPending = await getItem(ownerOffCtx, { id: origin, query: { collection_id: col.id } });
    expect(offPending.related_state).toBe('pending');
    expect(offPending.related_job_id).toBe(scoped.job_id);
    expect(offPending.related.map((r) => r.id)).toEqual(legacyIds);

    // The fresh graph pass runs and honestly admits nothing (unmapped
    // origin): its completed rail stays empty — the provider cards never
    // return on the graph class's rail.
    const qloo = noCallQloo();
    const out = await runJob(scoped.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(out.state).toBe('partial');
    expect(qloo.calls).toEqual([]);
    const ownerEmpty = await getItem(ownerCtx, { id: origin, query: {} });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    expect(ownerEmpty.related_job_id).toBe(scoped.job_id);
  });

  it('a graph-on sample read never mistakes an older graph-off selected-collection provider job for explicit graph work (DISC-SCR-047)', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    await ensureSampleItems(isoDb);
    // A public shared sample with a provider-resolvable identity.
    const sample = await insertItem(
      null,
      {
        kind: 'artist',
        category: 'play',
        title: 'Sample sculptor',
        key: `sample:sculptor-${randomUUID().slice(0, 6)}`,
        qloo: `artist-${randomUUID()}`,
      },
      isoDb,
    );
    const col = await createCollection(ownerCtx, { name: `Sample shelf ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });

    // Control: before any discovery the ordinary example carousel serves.
    const before = await getItem(ownerCtx, { id: sample, query: {} });
    expect(before.related_state).toBe('cached');
    expect(before.related.length).toBeGreaterThan(0);
    expect(before.related.every((r) => r.is_example)).toBe(true);

    // The graph-off era: the selected-collection operation runs the LEGACY
    // provider branch and publishes one provider card for this sample.
    const legacy = await startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'play' } });
    await runJob(legacy.job_id, { db: isoDb, config: graphOff, providers: testProviders({ qloo: legacyResultsQloo('xcs') }) });
    const legacyIds = await publishedItemIds(isoDb, legacy.discovery_job_id);
    expect(legacyIds.length).toBeGreaterThan(0);

    // The graph-on sample read keeps the ordinary example carousel: the old
    // provider job is NOT explicit graph work and never takes the sample rail.
    const carousel = await getItem(ownerCtx, { id: sample, query: {} });
    expect(carousel.related_state).toBe('cached');
    expect(carousel.related.length).toBeGreaterThan(0);
    expect(carousel.related.every((r) => r.is_example)).toBe(true);

    // Graph-off control: the carousel is unchanged there too.
    const offRead = await getItem(ownerOffCtx, { id: sample, query: {} });
    expect(offRead.related_state).toBe('cached');
    expect(offRead.related.length).toBeGreaterThan(0);
    expect(offRead.related.every((r) => r.is_example)).toBe(true);

    // A fresh explicit graph-on scoped operation takes the sample rail
    // honestly: pending, then its own completed empty outcome — never the
    // provider card, never the carousel.
    const scoped = await startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'watch' } });
    const pending = await getItem(ownerCtx, { id: sample, query: {} });
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(scoped.job_id);
    const qloo = noCallQloo();
    await runJob(scoped.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(qloo.calls).toEqual([]);
    const empty = await getItem(ownerCtx, { id: sample, query: {} });
    expect(empty.related).toEqual([]);
    expect(empty.related_state).toBe('none');
    expect(empty.related_job_id).toBe(scoped.job_id);
  });

  it('a scoped context whose newer graph parent failed at its immutable deadline stays isolated: no same-collection provider card, no interest pool, no other granted collection save (DISC-SCR-047/048)', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'film', category: 'watch', title: 'Failed window film', qloo: `film-${randomUUID()}` },
      isoDb,
    );
    const colA = await createCollection(ownerCtx, { name: `Museum A ${randomUUID().slice(0, 6)}` });
    const colB = await createCollection(ownerCtx, { name: `Museum B ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    const seedCard = await seedPoolCard(isoDb, owner.accountId, { kind: 'brand', category: 'wear', title: 'Unrelated taste brand' });
    await addCollectionItem(ownerCtx, { id: colB.id, item_id: seedCard, body: {} });
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
      isoDb,
    );

    // The graph-off era's provider completion in the SAME collection A.
    const legacy = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'watch' } });
    await runJob(legacy.job_id, { db: isoDb, config: graphOff, providers: testProviders({ qloo: legacyResultsQloo('xcf') }) });
    const legacyIds = await publishedItemIds(isoDb, legacy.discovery_job_id);
    expect(legacyIds.length).toBeGreaterThan(0);

    // The origin's first graph-on scoped discovery is delayed past its
    // immutable 45-second work window and fails nonretryably BEFORE any
    // results (the real deadline outcome): the durable 'graph' stage records
    // the executed class, and nothing is published.
    const scoped = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'play' } });
    await expireWorkWindow(isoDb, scoped.discovery_job_id);
    const qloo = noCallQloo();
    await expect(
      runJob(scoped.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) }),
    ).rejects.toThrow(GraphWorkDeadlineExpiredError);
    expect(qloo.calls).toEqual([]);
    const { rows: stages } = await isoDb.query<{ stage: string; status: string }>(
      'SELECT stage, status FROM job_stages WHERE job_id = $1',
      [scoped.job_id],
    );
    expect(stages).toEqual([{ stage: 'graph', status: 'failed' }]);
    const { rows: recs } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_job_id = $1',
      [scoped.discovery_job_id],
    );
    expect(Number(recs[0]!.n)).toBe(0);

    // The owner's reads of the failed exact context are honest: the same-
    // collection provider completion and the unrelated interest pool never
    // fill the scoped rail.
    const ownerEmpty = await getItem(ownerCtx, { id: origin, query: {} });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    const ownerScoped = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(ownerScoped.related).toEqual([]);
    expect(ownerScoped.related_state).toBe('none');

    // The A+B-granted agent reading the failed A context sees the same
    // honest empty — its B-saved seed card is independently visible, yet
    // never stands in for the scoped outcome.
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const agentRead = await getItem(actx, { id: origin, query: { collection_id: colA.id } });
    expect(agentRead.related).toEqual([]);
    expect(agentRead.related_state).toBe('none');

    // Graph-off control: the same stored state keeps the legacy rail — the
    // provider card and the interest-pool padding (the compatible path).
    const offRead = await getItem(ownerOffCtx, { id: origin, query: { collection_id: colA.id } });
    expect(offRead.related.map((r) => r.id)).toEqual(expect.arrayContaining([...legacyIds, seedCard]));
  });

  it('a scoped context whose only parent was cancelled before any stage stays isolated: honest empty, never the account pool or another granted collection save (DISC-SCR-048)', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'film', category: 'watch', title: 'Cancelled window film', qloo: `film-${randomUUID()}` },
      isoDb,
    );
    const colA = await createCollection(ownerCtx, { name: `Museum A ${randomUUID().slice(0, 6)}` });
    const colB = await createCollection(ownerCtx, { name: `Museum B ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    const seedCard = await seedPoolCard(isoDb, owner.accountId, { kind: 'brand', category: 'wear', title: 'Unrelated taste brand' });
    await addCollectionItem(ownerCtx, { id: colB.id, item_id: seedCard, body: {} });
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id, colB.id] },
      isoDb,
    );

    // The origin's first scoped discovery is CANCELLED while still queued,
    // before any stage ran: no execution provenance exists at all.
    const scoped = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id } });
    expect(await cancelJob(isoDb, scoped.job_id)).toBe('cancelled');
    const { rows: stages } = await isoDb.query<{ stage: string }>(
      'SELECT stage FROM job_stages WHERE job_id = $1',
      [scoped.job_id],
    );
    expect(stages).toEqual([]);

    // Graph-on reads of the cancelled exact context stay isolated: honest
    // empty — the unrelated interest-pool card (and the B-saved seed card
    // for the A+B agent) never fills the scoped rail.
    const ownerEmpty = await getItem(ownerCtx, { id: origin, query: {} });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    const ownerScoped = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(ownerScoped.related).toEqual([]);
    expect(ownerScoped.related_state).toBe('none');
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const agentRead = await getItem(actx, { id: origin, query: { collection_id: colA.id } });
    expect(agentRead.related).toEqual([]);
    expect(agentRead.related_state).toBe('none');

    // Graph-off control: the same context keeps the legacy fallback — the
    // interest pool fills the empty rail there.
    const offRead = await getItem(ownerOffCtx, { id: origin, query: { collection_id: colA.id } });
    expect(offRead.related.map((r) => r.id)).toEqual([seedCard]);
    expect(offRead.related_state).toBe('cached');
  });

  it('one graph context keeps its own older results as the cached rail while newer same-class work runs (compatible cache control)', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      isoDb,
    );
    const col = await createCollection(ownerCtx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: origin, body: {} });
    await linkGraphReferenceIdentities(isoDb);

    // The first scoped graph pass publishes the reviewed Rodin→museum→Seurat path.
    const first = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'play' } });
    await runJob(first.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    const candidate = (await publishedItemIds(isoDb, first.discovery_job_id))[0]!;
    expect(candidate).toBeTruthy();

    // A NEWER scoped request in the SAME collection/class is enqueued: while
    // it runs, its rail stays pending with the context's own cached result —
    // same-class older work is the compatible cache, never a fallback.
    const second = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: col.id, category: 'watch' } });
    const pending = await getItem(ownerCtx, { id: origin, query: {} });
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(second.job_id);
    expect(pending.related.map((r) => r.id)).toEqual([candidate]);

    // The newer watch-filtered pass honestly admits nothing: the completed
    // rail reports that context's own outcome.
    await runJob(second.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    const empty = await getItem(ownerCtx, { id: origin, query: {} });
    expect(empty.related).toEqual([]);
    expect(empty.related_state).toBe('none');
    expect(empty.related_job_id).toBe(second.job_id);
  });
});

describe('mixed graph/legacy attempt history never lends provider results to graph-on reads (DISC-SCR-049)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scrdmix');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const stageRows = (jobId: string) =>
    isoDb
      .query<{ stage: string; status: string; attempt: number }>(
        'SELECT stage, status, attempt FROM job_stages WHERE job_id = $1 ORDER BY stage',
        [jobId],
      )
      .then(({ rows }) => rows);
  const proofCount = (discoveryJobId: string) =>
    isoDb
      .query<{ n: number }>('SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1', [
        discoveryJobId,
      ])
      .then(({ rows }) => Number(rows[0]!.n));

  it('a graph-on attempt that persisted its stage then crashed, redelivered graph-off with provider results, is never borrowed by a fresh graph-on read', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
    const origin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      isoDb,
    );
    const colA = await createCollection(ownerCtx, { name: `Museum A ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id] },
      isoDb,
    );
    await linkGraphReferenceIdentities(isoDb);

    // Attempt 1 (graph ON): the real claim runs the scoped graph branch; the
    // pass persists its durable 'graph' stage evidence and is interrupted
    // exactly at its publication barrier — the crashed-worker shape (no
    // terminal queue write, nothing published, zero provider calls).
    const scoped = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'play' } });
    const graphQloo = noCallQloo();
    const first = await runClaimedAttempt(scoped.job_id, {
      db: isoDb,
      config: graphOn,
      providers: testProviders({ qloo: graphQloo }),
      interruptPublication: true,
      leaseMs: 300,
    });
    expect(first).toMatchObject({ state: 'running', attempt: 1, interrupted: true });
    expect(graphQloo.calls).toEqual([]);
    expect(await stageRows(scoped.job_id)).toEqual([{ stage: 'graph', status: 'failed', attempt: 1 }]);
    expect(await publishedItemIds(isoDb, scoped.discovery_job_id)).toEqual([]);

    // The lease really lapses by the clock, then the job is REDELIVERED with
    // graph disabled: the real reclaim (attempt 2) picks the LEGACY provider
    // branch from today's flags and publishes provider results on the SAME
    // discovery parent — the exact mixed graph/legacy attempt history.
    await sleep(450);
    const providerQloo = legacyResultsQloo('mix');
    const second = await runClaimedAttempt(scoped.job_id, {
      db: isoDb,
      config: graphOff,
      providers: testProviders({ qloo: providerQloo }),
    });
    expect(second).toMatchObject({ state: 'complete', attempt: 2, interrupted: false });
    expect(providerQloo.calls.length).toBeGreaterThan(0);
    const providerIds = await publishedItemIds(isoDb, scoped.discovery_job_id);
    expect(providerIds.length).toBeGreaterThan(0);
    expect(await stageRows(scoped.job_id)).toEqual([
      { stage: 'graph', status: 'failed', attempt: 1 },
      { stage: 'insights:play', status: 'complete', attempt: 2 },
      { stage: 'resolve', status: 'complete', attempt: 2 },
    ]);
    // The published rows are proofless provider results (no scoped proofs).
    expect(await proofCount(scoped.discovery_job_id)).toBe(0);

    // Graph-off reads keep the legacy rail on their own compatible path.
    const offCached = await getItem(ownerOffCtx, { id: origin, query: { collection_id: colA.id } });
    expect(offCached.related_state).toBe('cached');
    expect(offCached.related.map((r) => r.id)).toEqual(providerIds);

    // Graph re-enabled + a genuinely fresh scoped request: its pending rail
    // is honest — the mixed history's provider card NEVER fills it (a
    // historical 'graph' stage row alone does not classify the job).
    const fresh = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'watch' } });
    const pending = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(fresh.job_id);
    const pendingNoCollection = await getItem(ownerCtx, { id: origin, query: {} });
    expect(pendingNoCollection.related).toEqual([]);
    expect(pendingNoCollection.related_state).toBe('pending');
    expect(pendingNoCollection.related_job_id).toBe(fresh.job_id);

    // The A-granted agent's graph-on read agrees: the provider card never
    // reaches the pending scoped rail under the grant either.
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const agentPending = await getItem(actx, { id: origin, query: { collection_id: colA.id } });
    expect(agentPending.related).toEqual([]);
    expect(agentPending.related_state).toBe('pending');
    expect(agentPending.related_job_id).toBe(fresh.job_id);

    // Graph-off control after re-enable: pending fresh work still carries
    // the older provider card as its cached rail (legacy pairing preserved).
    const offPending = await getItem(ownerOffCtx, { id: origin, query: { collection_id: colA.id } });
    expect(offPending.related_state).toBe('pending');
    expect(offPending.related_job_id).toBe(fresh.job_id);
    expect(offPending.related.map((r) => r.id)).toEqual(providerIds);

    // The fresh pass completes honestly empty (watch filter, zero provider
    // calls) and the completed graph-on rail still never borrows the card.
    const freshQloo = noCallQloo();
    const freshOut = await runJob(fresh.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: freshQloo }) });
    expect(freshOut.state).toBe('partial');
    expect(freshQloo.calls).toEqual([]);
    const ownerEmpty = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    expect(ownerEmpty.related_job_id).toBe(fresh.job_id);
    const agentEmpty = await getItem(actx, { id: origin, query: { collection_id: colA.id } });
    expect(agentEmpty.related).toEqual([]);
    expect(agentEmpty.related_state).toBe('none');
    expect(agentEmpty.related_job_id).toBe(fresh.job_id);
  });

  it('a saved sample keeps its carousel when its scoped job is mixed history: the provider card never takes the sample rail, real graph work still does', async () => {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    await ensureSampleItems(isoDb);
    // A public shared sample with a provider-resolvable identity.
    const sample = await insertItem(
      null,
      {
        kind: 'artist',
        category: 'play',
        title: 'Sample sculptor',
        key: `sample:sculptor-mixed-${randomUUID().slice(0, 6)}`,
        qloo: `artist-${randomUUID()}`,
      },
      isoDb,
    );
    const col = await createCollection(ownerCtx, { name: `Sample shelf ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: col.id, item_id: sample, body: {} });

    // Control: before any discovery the ordinary example carousel serves.
    const before = await getItem(ownerCtx, { id: sample, query: {} });
    expect(before.related_state).toBe('cached');
    expect(before.related.length).toBeGreaterThan(0);
    expect(before.related.every((r) => r.is_example)).toBe(true);

    // The scoped job's graph-on attempt persists its stage then crashes at
    // the publication barrier; the graph-off reclaim publishes one provider
    // card on the same sample's discovery parent.
    const scoped = await startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'play' } });
    const graphQloo = noCallQloo();
    await runClaimedAttempt(scoped.job_id, {
      db: isoDb,
      config: graphOn,
      providers: testProviders({ qloo: graphQloo }),
      interruptPublication: true,
      leaseMs: 300,
    });
    expect(graphQloo.calls).toEqual([]);
    await sleep(450);
    const providerQloo = legacyResultsQloo('smx');
    await runClaimedAttempt(scoped.job_id, {
      db: isoDb,
      config: graphOff,
      providers: testProviders({ qloo: providerQloo }),
    });
    const providerIds = await publishedItemIds(isoDb, scoped.discovery_job_id);
    expect(providerIds.length).toBeGreaterThan(0);
    expect(await proofCount(scoped.discovery_job_id)).toBe(0);

    // The graph-on sample read keeps the ordinary example carousel: the
    // mixed history job is not explicit graph work and never takes the
    // sample rail. (Graph-off reads keep the carousel unchanged too.)
    const carousel = await getItem(ownerCtx, { id: sample, query: {} });
    expect(carousel.related_state).toBe('cached');
    expect(carousel.related.length).toBeGreaterThan(0);
    expect(carousel.related.every((r) => r.is_example)).toBe(true);
    const offCarousel = await getItem(ownerOffCtx, { id: sample, query: {} });
    expect(offCarousel.related_state).toBe('cached');
    expect(offCarousel.related.length).toBeGreaterThan(0);
    expect(offCarousel.related.every((r) => r.is_example)).toBe(true);

    // A fresh explicit graph-on scoped operation still takes the sample rail
    // honestly (pending, then its own completed empty outcome) — excluding
    // the ambiguous mixed job never excludes genuine graph work.
    const fresh = await startRelatedDiscovery(ownerCtx, { id: sample, body: { collection_id: col.id, category: 'watch' } });
    const pending = await getItem(ownerCtx, { id: sample, query: {} });
    expect(pending.related).toEqual([]);
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(fresh.job_id);
    const freshQloo = noCallQloo();
    await runJob(fresh.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: freshQloo }) });
    expect(freshQloo.calls).toEqual([]);
    const empty = await getItem(ownerCtx, { id: sample, query: {} });
    expect(empty.related).toEqual([]);
    expect(empty.related_state).toBe('none');
    expect(empty.related_job_id).toBe(fresh.job_id);
  });

  it('mixed history whose current results are proven graph-produced (their pinned proofs survived) still serves as the graph rail: the legacy attempt never published', async () => {
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
    await addCollectionItem(ownerCtx, { id: colA.id, item_id: origin, body: {} });
    const agent = await insertAgentConnection(
      owner,
      { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [colA.id] },
      isoDb,
    );
    await linkGraphReferenceIdentities(isoDb);

    // Attempt 1 (graph OFF): the legacy provider branch completes its stages
    // (the fake provider answers) but is interrupted at its publication
    // barrier — the crashed-worker shape again, no provider rows published.
    const scoped = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'play' } });
    const providerQloo = legacyResultsQloo('prv');
    const first = await runClaimedAttempt(scoped.job_id, {
      db: isoDb,
      config: graphOff,
      providers: testProviders({ qloo: providerQloo }),
      interruptPublication: true,
      leaseMs: 300,
    });
    expect(first).toMatchObject({ state: 'running', attempt: 1, interrupted: true });
    expect(providerQloo.calls.length).toBeGreaterThan(0);
    expect(await publishedItemIds(isoDb, scoped.discovery_job_id)).toEqual([]);

    // Attempt 2 (graph ON, real reclaim): the scoped graph pass publishes
    // the reviewed Rodin→museum→Seurat path with its pinned proofs. The
    // current results ARE graph-produced, so the mixed history's class is
    // PROVEN graph — not excluded.
    await sleep(450);
    const graphQloo = noCallQloo();
    const second = await runClaimedAttempt(scoped.job_id, {
      db: isoDb,
      config: graphOn,
      providers: testProviders({ qloo: graphQloo }),
    });
    expect(second).toMatchObject({ state: 'complete', attempt: 2, interrupted: false });
    expect(graphQloo.calls).toEqual([]);
    const candidate = (await publishedItemIds(isoDb, scoped.discovery_job_id))[0]!;
    expect(candidate).toBeTruthy();
    expect(await proofCount(scoped.discovery_job_id)).toBeGreaterThan(0);
    expect(await stageRows(scoped.job_id)).toEqual([
      { stage: 'graph', status: 'complete', attempt: 2 },
      { stage: 'insights:play', status: 'complete', attempt: 1 },
      { stage: 'resolve', status: 'complete', attempt: 1 },
    ]);

    // The owner's and the A-granted agent's graph-on reads serve the proven
    // graph result as the context's cached rail — valid graph results are
    // never lost to the conservative mixed-history rule.
    const ownerCached = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(ownerCached.related_state).toBe('cached');
    expect(ownerCached.related.map((r) => r.id)).toEqual([candidate]);
    const actx = await freshAgentCtx(isoDb, agent.credential);
    const agentCached = await getItem(actx, { id: origin, query: { collection_id: colA.id } });
    expect(agentCached.related_state).toBe('cached');
    expect(agentCached.related.map((r) => r.id)).toEqual([candidate]);

    // A newer same-context graph request keeps the proven result as its
    // cached rail while it runs (compatible cache control preserved).
    const fresh = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'watch' } });
    const pending = await getItem(ownerCtx, { id: origin, query: { collection_id: colA.id } });
    expect(pending.related_state).toBe('pending');
    expect(pending.related_job_id).toBe(fresh.job_id);
    expect(pending.related.map((r) => r.id)).toEqual([candidate]);
  });
});
