import { randomUUID } from 'node:crypto';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertReference } from '../compiler/store';
import type { ServiceContext } from '../context';
import type { PoolDb } from '../db/pool';
import type { Category, ItemKind } from '../enums';
import { resolvePrincipal } from '../services/auth';
import { addCollectionItem, createCollection, removeCollectionItem } from '../services/collections';
import { ensureSampleItems } from '../feed/samples';
import { getJob } from '../services/jobs';
import { getItem, startRelatedDiscovery } from '../services/items';
import type { AccountPrincipal } from '../principal';
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
import { attachAssertionSupport, insertEvidence, recordSourceRevision } from './evidence';
import { linkGraphReferenceIdentities } from './identity-links';
import { retractGraphEvidence } from './validity';

/**
 * Scoped Discover more READ context and proof validity (round-8 repairs
 * DISC-SCR-033/034/036 and their round-9 remnants DISC-SCR-045/046;
 * VAL-DISC-007/008/009).
 *
 * The approved grant-scoped graph producer is honest at PUBLICATION time: it
 * publishes only admitted results of the authorized exact discovery context
 * and pins a per-result proof. These tests hold the READ paths to the same
 * standard:
 *
 *  - DISC-SCR-033: a graph-on scoped response's related rail carries only the
 *    authorized context's admitted results — honestly empty when the walk
 *    admits nothing or the requested category filters everything — and is
 *    never padded with unrelated interest-pool cards (owner or grant-limited
 *    agent). Graph-off reads keep the unchanged legacy padding.
 *  - DISC-SCR-036: the cached scoped context is correlated to the origin's
 *    CURRENT membership in the discovery's EXACT origin collection: losing
 *    that membership denies the cached result/reason/rail even when a second
 *    granted membership keeps the origin itself visible, so item reads agree
 *    with job reads, while independently authorized contexts keep serving.
 *  - DISC-SCR-034: before a scoped result or its reason is served, its pinned
 *    proof is rechecked: the stored invalidation record, natural evidence or
 *    rights expiry (realized through the production admission helpers with
 *    controlled read clocks) and pinned revision drift all suppress the stale
 *    output, while independent valid reasons and the explicitly saved item
 *    survive.
 *  - DISC-SCR-045: the SAME proof revalidation gates grant-derived candidate
 *    VISIBILITY. A durable scoped recommendation is no longer a standing
 *    witness: after its only proof retracts or expires, an agent holding the
 *    retained candidate ID gets 404, while public items, explicit saves in
 *    granted collections, independently authorized contexts and first-party
 *    ownership keep serving.
 *  - DISC-SCR-046: invalid recommendation history is paged until a valid
 *    authorized reason serves or the history is actually exhausted — eight
 *    withdrawn newer scoped contexts cannot hide a ninth independently valid
 *    older taste reason, and the durable rows survive as provenance (no
 *    destructive cleanup).
 *
 * Everything runs the REAL enqueue + handler path on isolated databases with
 * the committed reviewed corpus and zero provider calls.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const graphOff = testConfig();

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
/** One of FIVE same-named "Vincent van Gogh" persons Qloo returned: no mapping ships. */
const UNMAPPED_VANGOGH_QLOO_ID = 'FF1DECE6-AB12-47A4-AE63-55ABFA4DA279';

const AIC_KEY = 'atlas:place:art-institute-of-chicago';
const RODIN_KEY = 'atlas:creator:auguste-rodin';
const SEURAT_KEY = 'atlas:creator:georges-seurat';

const SCOPED_REASON = 'Also work on display at Art Institute of Chicago';

/** A fake Qloo that RECORDS every call and fails closed on each one. */
function noCallQloo(): FakeQloo {
  return new FakeQloo({}, { live: true });
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

/** A read context whose clock runs ahead, so a near-future expiry/rights window has lapsed at read time. */
function aheadCtx(db: PoolDb, principal: AccountPrincipal, aheadMs: number): ServiceContext {
  return testContext(principal, { db, config: graphOn, now: () => new Date(Date.now() + aheadMs) });
}

/**
 * A fresh per-request AGENT read context whose clock runs ahead: the same
 * principal the REST/MCP layers resolve on every call, reading through a
 * lapsed expiry/rights window (DISC-SCR-045's expiry leg).
 */
async function aheadAgentCtx(db: PoolDb, credential: string, aheadMs: number): Promise<ServiceContext> {
  const principal = await resolvePrincipal(db, { authorization: `Bearer ${credential}` });
  expect(principal?.kind).toBe('agent');
  return testContext(principal!, { db, config: graphOn, now: () => new Date(Date.now() + aheadMs) });
}

interface ScopedReadLibrary {
  accountId: string;
  ownerCtx: ServiceContext;
  owner: AccountPrincipal;
  origin: string;
  col: { id: string };
  credential: string;
  seuratRef: string;
}

/** One fresh scoped library: owner, Rodin origin in one collection, granted agent. */
async function scopedReadLibrary(db: PoolDb): Promise<ScopedReadLibrary> {
  const owner = await insertAccount(db);
  const ctx = testContext(owner, { db, config: graphOn });
  const rodinRef = await qlooPersonReference(db, RODIN_QLOO_ID, 'Auguste Rodin');
  const seuratRef = await qlooPersonReference(db, SEURAT_QLOO_ID, 'Georges Seurat');
  const origin = await insertItem(
    { accountId: owner.accountId },
    { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
    db,
  );
  const col = await createCollection(ctx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
  await addCollectionItem(ctx, { id: col.id, item_id: origin, body: {} });
  await linkGraphReferenceIdentities(db);
  const agent = await insertAgentConnection(
    owner,
    { scopes: ['collections:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
    db,
  );
  return {
    accountId: owner.accountId,
    ownerCtx: ctx,
    owner,
    origin,
    col,
    credential: agent.credential,
    seuratRef,
  };
}

/**
 * The legacy interest-pool padding source: a completed taste seed carrying one
 * unrelated account-wide card (the pool `interestPoolRelatedIds` reads).
 */
async function seedInterestPoolCard(
  db: PoolDb,
  accountId: string,
  opts: { kind: ItemKind; category: Category; title: string },
): Promise<string> {
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

async function corpusAssertion(db: PoolDb, subjectKey: string, predicate: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id FROM graph_assertions a
       JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = $1
       JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = $2
      WHERE a.predicate = $3`,
    [subjectKey, AIC_KEY, predicate],
  );
  return rows[0]!.id;
}

async function soleEvidenceOf(db: PoolDb, assertionId: string): Promise<string> {
  const { rows } = await db.query<{ evidence_id: string }>(
    `SELECT s.evidence_id
       FROM graph_assertion_support s
       JOIN graph_evidence e ON e.id = s.evidence_id
      WHERE s.assertion_id = $1 AND s.role = 'supports' AND e.validity_state = 'valid'`,
    [assertionId],
  );
  return rows[0]!.evidence_id;
}

/** The ids a scoped parent published, in rank order. */
async function publishedItemIds(db: PoolDb, discoveryJobId: string): Promise<string[]> {
  const { rows } = await db.query<{ discovery_item_id: string }>(
    'SELECT discovery_item_id FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank',
    [discoveryJobId],
  );
  return rows.map((r) => r.discovery_item_id);
}

/** Run one real scoped Discover more enqueue through the graph pass. */
async function publishScoped(
  ctx: ServiceContext,
  db: PoolDb,
  origin: string,
  collectionId: string,
  category: 'play' | 'watch' | null,
) {
  const started = await startRelatedDiscovery(ctx, {
    id: origin,
    body: category ? { collection_id: collectionId, category } : { collection_id: collectionId },
  });
  const out = await runJob(started.job_id, { db, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
  return { started, out };
}

/**
 * One new reviewed evidence row from a fresh source family, admitted through
 * the production helpers — the only legitimate way to give a witness an
 * expiry or a lapsed rights window (content rows are immutable by design).
 */
async function freshEvidence(
  db: PoolDb,
  over: { expiresAt?: Date | null; rightsExpiresAt?: Date | null } = {},
): Promise<{ evidenceId: string; revision: number; familyKey: string }> {
  const family = `test:${randomUUID()}`;
  const recorded = await recordSourceRevision(db, {
    provider: 'artic_open_access',
    url: `https://www.artic.edu/artworks/${randomUUID().slice(0, 8)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
    documentHash: randomUUID(),
    rightsExpiresAt: over.rightsExpiresAt ?? null,
  });
  const inserted = await insertEvidence(db, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: over.expiresAt ?? null,
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, familyKey: family };
}

/**
 * Re-grounds one walked corpus assertion on fresh expiring evidence: the
 * corpus's original witness is withdrawn (the real retraction path) and the
 * new row attached (the production support path, which also versions the
 * assertion), so the pass grounds and pins exactly the new witness.
 */
async function regroundAssertion(
  db: PoolDb,
  assertionId: string,
  evidence: { evidenceId: string; familyKey: string },
): Promise<void> {
  const original = await soleEvidenceOf(db, assertionId);
  await retractGraphEvidence(db, { evidenceId: original, reason: 're-grounded on a rights-windowed witness' });
  await attachAssertionSupport(db, {
    assertionId,
    evidenceId: evidence.evidenceId,
    derivation: 'primary',
    sourceFamilyKey: evidence.familyKey,
  });
}

describe('scoped graph Discover more read context (DISC-SCR-033; VAL-DISC-009)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('scrdctx');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterAll(async () => {
    await dropIso();
  });

  /** One fresh library with a Rodin origin (mapped) and a van Gogh origin (unmapped), plus the legacy padding pool. */
  async function readContextLibrary() {
    const owner = await insertAccount(isoDb);
    const ownerCtx = testContext(owner, { db: isoDb, config: graphOn });
    const ownerOffCtx = testContext(owner, { db: isoDb, config: graphOff });
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    const seuratRef = await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
    const vanGoghRef = await qlooPersonReference(isoDb, UNMAPPED_VANGOGH_QLOO_ID, 'Vincent van Gogh');
    const rodinOrigin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Auguste Rodin', qloo: RODIN_QLOO_ID, referenceId: rodinRef },
      isoDb,
    );
    const vanGoghOrigin = await insertItem(
      { accountId: owner.accountId },
      { kind: 'artist', category: 'play', title: 'Vincent van Gogh', qloo: UNMAPPED_VANGOGH_QLOO_ID, referenceId: vanGoghRef },
      isoDb,
    );
    const colRodin = await createCollection(ownerCtx, { name: `Museum visits ${randomUUID().slice(0, 6)}` });
    const colVanGogh = await createCollection(ownerCtx, { name: `Gallery ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(ownerCtx, { id: colRodin.id, item_id: rodinOrigin, body: {} });
    await addCollectionItem(ownerCtx, { id: colVanGogh.id, item_id: vanGoghOrigin, body: {} });
    await linkGraphReferenceIdentities(isoDb);
    const agent = await insertAgentConnection(
      owner,
      {
        scopes: ['collections:read'],
        libraryAccess: 'selected_collections',
        collectionIds: [colRodin.id, colVanGogh.id],
      },
      isoDb,
    );
    // The legacy padding pool: one unrelated account-wide taste card that is
    // ALSO visible under the agent's grant (saved into the van Gogh collection).
    const seedCard = await seedInterestPoolCard(isoDb, owner.accountId, {
      kind: 'brand',
      category: 'wear',
      title: 'Unrelated taste brand',
    });
    await addCollectionItem(ownerCtx, { id: colVanGogh.id, item_id: seedCard, body: {} });
    return {
      owner,
      ownerCtx,
      ownerOffCtx,
      rodinOrigin,
      vanGoghOrigin,
      colRodin,
      colVanGogh,
      credential: agent.credential,
      seedCard,
      seuratRef,
    };
  }

  it('a graph-on scoped rail is honestly empty when the walk admits nothing or the category filters everything; graph-off keeps the legacy padding', async () => {
    const lib = await readContextLibrary();
    const actx = await freshAgentCtx(isoDb, lib.credential);

    // An unmapped origin: the graph pass admits nothing (partial, zero rows,
    // zero provider calls) — the honest empty outcome.
    const empty = await startRelatedDiscovery(lib.ownerCtx, {
      id: lib.vanGoghOrigin,
      body: { collection_id: lib.colVanGogh.id, category: 'watch' },
    });
    const qloo = noCallQloo();
    const emptyOut = await runJob(empty.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo }) });
    expect(emptyOut.state).toBe('partial');
    expect(qloo.calls).toEqual([]);

    // Owner read: honest empty rail — the unrelated interest-pool card never
    // pads a scoped response, and 'cached' never masks an empty context.
    const ownerEmpty = await getItem(lib.ownerCtx, { id: lib.vanGoghOrigin, query: {} });
    expect(ownerEmpty.related).toEqual([]);
    expect(ownerEmpty.related_state).toBe('none');
    expect(ownerEmpty.related_job_id).toBe(empty.job_id);

    // The grant-limited agent's read is equally honest (the seed card is
    // visible under its grant, yet never fills the scoped rail).
    const agentEmpty = await getItem(actx, { id: lib.vanGoghOrigin, query: {} });
    expect(agentEmpty.related).toEqual([]);
    expect(agentEmpty.related_state).toBe('none');

    // Graph-off contrast: the SAME stored context keeps the unchanged legacy
    // read behavior — the interest pool still fills the empty rail.
    const legacyEmpty = await getItem(lib.ownerOffCtx, { id: lib.vanGoghOrigin, query: {} });
    expect(legacyEmpty.related.map((r) => r.id)).toEqual([lib.seedCard]);
    expect(legacyEmpty.related_state).toBe('cached');

    // A category-filtered rail is equally honest: the reviewed path admits
    // only play candidates, so a 'watch' filter yields nothing — not padding.
    const filtered = await startRelatedDiscovery(lib.ownerCtx, {
      id: lib.rodinOrigin,
      body: { collection_id: lib.colRodin.id, category: 'watch' },
    });
    await runJob(filtered.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    const ownerFiltered = await getItem(lib.ownerCtx, { id: lib.rodinOrigin, query: {} });
    expect(ownerFiltered.related).toEqual([]);
    expect(ownerFiltered.related_state).toBe('none');
  });

  it('a graph-on scoped rail with admitted results carries exactly those results — the pool never fills the remaining slots', async () => {
    const lib = await readContextLibrary();
    const actx = await freshAgentCtx(isoDb, lib.credential);

    const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.rodinOrigin, lib.colRodin.id, 'play');
    expect(out.state).toBe('complete');
    const candidate = (await publishedItemIds(isoDb, started.discovery_job_id))[0]!;

    // The rail carries exactly the one admitted result: no interest-pool
    // padding fills the remaining five cached slots.
    const ownerPlay = await getItem(lib.ownerCtx, { id: lib.rodinOrigin, query: {} });
    expect(ownerPlay.related_state).toBe('cached');
    expect(ownerPlay.related.map((r) => r.id)).toEqual([candidate]);
    expect(ownerPlay.related.every((r) => r.id !== lib.seedCard)).toBe(true);

    // The agent's read agrees: only the authorized context's admitted result.
    const agentPlay = await getItem(actx, { id: lib.rodinOrigin, query: {} });
    expect(agentPlay.related_state).toBe('cached');
    expect(agentPlay.related.map((r) => r.id)).toEqual([candidate]);
  });
});

describe('exact origin-collection read authority across granted collections (DISC-SCR-036; VAL-DISC-007/009)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeEach(async () => {
    const created = await createIsolatedDatabase('scrdcoll');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterEach(async () => {
    await dropIso();
  });

  it("a second granted membership never keeps a lost context's cached results readable; item reads agree with job reads", async () => {
    // Origin in TWO granted collections A and B, both under the agent's grant.
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

    // Publish the scoped result under collection A.
    const underA = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colA.id, category: 'play' } });
    await runJob(underA.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    const candidate = (await publishedItemIds(isoDb, underA.discovery_job_id))[0]!;

    // Control: the agent reads the cached context through the grant.
    let actx = await freshAgentCtx(isoDb, agent.credential);
    expect((await getItem(actx, { id: origin, query: {} })).related.map((r) => r.id)).toEqual([candidate]);

    // The owner removes the origin from collection A ONLY: collection B, both
    // collection grants and the origin's own visibility all survive.
    await removeCollectionItem(ownerCtx, { id: colA.id, item_id: origin });

    // Job polling denies (the existing exact-context rule)...
    actx = await freshAgentCtx(isoDb, agent.credential);
    await expect(getJob(actx, { id: underA.job_id })).rejects.toMatchObject({ code: 'not_found' });
    // ...and the item reads now AGREE with it: the origin stays visible
    // through collection B, but A's cached result left its rail...
    const originRead = await getItem(actx, { id: origin, query: {} });
    expect(originRead.item.id).toBe(origin);
    expect(originRead.related).toEqual([]);
    // ...and the published candidate is no longer readable under the grant
    // (no independently authorized path exists for it yet).
    await expect(getItem(actx, { id: candidate, query: {} })).rejects.toMatchObject({ code: 'not_found' });

    // The owner keeps their own cached context (their own data).
    const ownerRead = await getItem(ownerCtx, { id: origin, query: {} });
    expect(ownerRead.related_state).toBe('cached');
    expect(ownerRead.related.map((r) => r.id)).toEqual([candidate]);

    // A fresh scoped discovery under the SURVIVING granted context B is
    // independently authorized: it publishes, restores the rail and makes the
    // candidate readable again through B's exact context.
    const underB = await startRelatedDiscovery(ownerCtx, { id: origin, body: { collection_id: colB.id, category: 'play' } });
    await runJob(underB.job_id, { db: isoDb, config: graphOn, providers: testProviders({ qloo: noCallQloo() }) });
    actx = await freshAgentCtx(isoDb, agent.credential);
    const after = await getItem(actx, { id: origin, query: {} });
    expect(after.related_state).toBe('cached');
    expect(after.related.map((r) => r.id)).toEqual([candidate]);
    expect((await getItem(actx, { id: candidate, query: {} })).item.id).toBe(candidate);
  });
});

describe('scoped proof validity on result and reason reads (DISC-SCR-034; VAL-DISC-007/008)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  // Retraction and expiry are permanent for their evidence rows, so every
  // case runs against its own freshly admitted corpus.
  beforeEach(async () => {
    const created = await createIsolatedDatabase('scrdval');
    isoDb = created.db;
    dropIso = created.drop;
    await admitGraphCorpus(isoDb, getCorpusManifestFile());
  });
  afterEach(async () => {
    await dropIso();
  });

  it('sole-source retraction withdraws the served result and reason; independent reasons and the explicit save survive', async () => {
    const lib = await scopedReadLibrary(isoDb);
    // The candidate item already exists, carrying an independent account-wide
    // taste recommendation (the owner's own earlier interest) and an explicit
    // save — both must survive the scoped withdrawal.
    const candidate = await insertItem(
      { accountId: lib.accountId },
      { kind: 'artist', category: 'play', title: 'Georges Seurat', qloo: SEURAT_QLOO_ID, referenceId: lib.seuratRef },
      isoDb,
    );
    const tasteRun = await isoDb.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
       VALUES ($1, 0, 'complete', 1) RETURNING id`,
      [lib.accountId],
    );
    await isoDb.query(
      `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                    external_ids, display_reason, origin, provider_query_ids)
       VALUES ($1, $2, 'play', 1, 'Georges Seurat', '{}'::jsonb, 'From your interests.', 'catalog', ARRAY[]::uuid[])`,
      [tasteRun.rows[0]!.id, candidate],
    );
    const savedCol = await createCollection(lib.ownerCtx, { name: `Saved ${randomUUID().slice(0, 6)}` });
    await addCollectionItem(lib.ownerCtx, { id: savedCol.id, item_id: candidate, body: {} });

    const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.origin, lib.col.id, 'play');
    expect(out.state).toBe('complete');

    // Control reads: the scoped result and its pinned reason serve.
    const before = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(before.related_state).toBe('cached');
    expect(before.related.map((r) => r.id)).toEqual([candidate]);
    const candidateBefore = await getItem(lib.ownerCtx, { id: candidate, query: {} });
    expect(candidateBefore.reason).toBe(SCOPED_REASON);

    // Control: withdrawing evidence of an assertion the proof never pinned
    // changes nothing — suppression is path-specific.
    const unrelated = await isoDb.query<{ id: string }>(
      `SELECT a.id FROM graph_assertions a
         JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = 'atlas:work:artic-28560'
         JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = 'atlas:attribute:post-impressionism-art'
        WHERE a.predicate = 'HAS_ATTRIBUTE'`,
    );
    const unrelatedRetraction = await retractGraphEvidence(isoDb, {
      evidenceId: await soleEvidenceOf(isoDb, unrelated.rows[0]!.id),
      reason: 'unrelated withdrawal',
    });
    expect(unrelatedRetraction.scopedProofsInvalidated).toBe(0);
    const stillBefore = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(stillBefore.related.map((r) => r.id)).toEqual([candidate]);

    // Withdraw the walked path's sole evidence.
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const retraction = await retractGraphEvidence(isoDb, {
      evidenceId: await soleEvidenceOf(isoDb, rodinAssociation),
      reason: 'withdrawn after publication',
    });
    expect(retraction.scopedProofsInvalidated).toBe(1);

    // The served rail withdraws the retracted result (honestly empty, 'none').
    const after = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(after.related).toEqual([]);
    expect(after.related_state).toBe('none');

    // The withdrawn scoped reason never serves; the candidate keeps its
    // independent taste reason and its explicit save.
    const candidateAfter = await getItem(lib.ownerCtx, { id: candidate, query: {} });
    expect(candidateAfter.reason).toBe('From your interests.');
    expect(candidateAfter.item.saved).toBe(true);

    // A grant-limited agent loses the withdrawn scoped reason too (taste
    // seeds carry no authority under the grant) — and, DISC-SCR-045, the
    // retained candidate ID stops being READABLE: the only grant-visible
    // context for the newly materialized candidate was the withdrawn scoped
    // proof, and its explicit save sits in an ungranted collection, which is
    // never an independent authorization. The ORIGIN itself stays readable
    // through its surviving granted membership.
    const actx = await freshAgentCtx(isoDb, lib.credential);
    await expect(getItem(actx, { id: candidate, query: {} })).rejects.toMatchObject({ code: 'not_found' });
    const agentOrigin = await getItem(actx, { id: lib.origin, query: {} });
    expect(agentOrigin.item.id).toBe(lib.origin);
    expect(agentOrigin.related).toEqual([]);

    // Controls: a PUBLIC item and an EXPLICIT save in the GRANTED collection
    // stay readable under the grant independent of the withdrawn proof. The
    // granted save restores the candidate card while its scoped reason stays
    // withdrawn (and taste still carries no authority under the grant).
    await ensureSampleItems(isoDb);
    const { rows: sampleRows } = await isoDb.query<{ id: string }>('SELECT id FROM discovery_items WHERE is_sample LIMIT 1');
    expect(sampleRows.length).toBeGreaterThan(0);
    expect((await getItem(actx, { id: sampleRows[0]!.id, query: {} })).item.id).toBe(sampleRows[0]!.id);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: candidate, body: {} });
    const grantedSave = await getItem(actx, { id: candidate, query: {} });
    expect(grantedSave.item.id).toBe(candidate);
    expect(grantedSave.reason).toBeNull();

    // The stored recommendation row is the durable record: nothing was
    // deleted, only its serving was withdrawn.
    expect(await publishedItemIds(isoDb, started.discovery_job_id)).toEqual([candidate]);
  });

  it('natural evidence expiry suppresses the served scoped result and reason without any retraction event', async () => {
    const lib = await scopedReadLibrary(isoDb);
    // Re-ground both walked assertions on reviewed evidence carrying a
    // near-future expiry window (one hour): the pass grounds and pins exactly
    // these rows, live at publication time.
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const seuratAssociation = await corpusAssertion(isoDb, SEURAT_KEY, 'DOCUMENTED_ASSOCIATION');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await regroundAssertion(isoDb, rodinAssociation, await freshEvidence(isoDb, { expiresAt }));
    await regroundAssertion(isoDb, seuratAssociation, await freshEvidence(isoDb, { expiresAt }));

    const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.origin, lib.col.id, 'play');
    expect(out.state).toBe('complete');
    const candidate = (await publishedItemIds(isoDb, started.discovery_job_id))[0]!;

    // Control: the result and reason serve while the window is open.
    expect((await getItem(lib.ownerCtx, { id: lib.origin, query: {} })).related.map((r) => r.id)).toEqual([candidate]);
    expect((await getItem(lib.ownerCtx, { id: candidate, query: {} })).reason).toBe(SCOPED_REASON);

    // No event flips the stored flag (it stays 'valid'): the read's
    // CURRENT-dependency recheck is what withdraws the output once the
    // window has lapsed at read time.
    const { rows: proofs } = await isoDb.query<{ validity_state: string }>(
      'SELECT validity_state FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(proofs[0]!.validity_state).toBe('valid');

    const expiredCtx = aheadCtx(isoDb, lib.owner, 2 * 60 * 60 * 1000);
    const railAfter = await getItem(expiredCtx, { id: lib.origin, query: {} });
    expect(railAfter.related).toEqual([]);
    expect(railAfter.related_state).toBe('none');
    expect((await getItem(expiredCtx, { id: candidate, query: {} })).reason).toBeNull();
  });

  it('natural rights expiry suppresses the served scoped result and reason', async () => {
    const lib = await scopedReadLibrary(isoDb);
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const seuratAssociation = await corpusAssertion(isoDb, SEURAT_KEY, 'DOCUMENTED_ASSOCIATION');
    const rightsExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await regroundAssertion(isoDb, rodinAssociation, await freshEvidence(isoDb, { rightsExpiresAt }));
    await regroundAssertion(isoDb, seuratAssociation, await freshEvidence(isoDb, { rightsExpiresAt }));

    const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.origin, lib.col.id, 'play');
    expect(out.state).toBe('complete');
    const candidate = (await publishedItemIds(isoDb, started.discovery_job_id))[0]!;
    expect((await getItem(lib.ownerCtx, { id: lib.origin, query: {} })).related.map((r) => r.id)).toEqual([candidate]);
    expect((await getItem(lib.ownerCtx, { id: candidate, query: {} })).reason).toBe(SCOPED_REASON);

    const lapsedCtx = aheadCtx(isoDb, lib.owner, 2 * 60 * 60 * 1000);
    const railAfter = await getItem(lapsedCtx, { id: lib.origin, query: {} });
    expect(railAfter.related).toEqual([]);
    expect(railAfter.related_state).toBe('none');
    expect((await getItem(lapsedCtx, { id: candidate, query: {} })).reason).toBeNull();
  });

  it('assertion revision drift past a pinned revision suppresses the served scoped result and reason', async () => {
    const lib = await scopedReadLibrary(isoDb);
    const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.origin, lib.col.id, 'play');
    expect(out.state).toBe('complete');
    const candidate = (await publishedItemIds(isoDb, started.discovery_job_id))[0]!;
    expect((await getItem(lib.ownerCtx, { id: lib.origin, query: {} })).related.map((r) => r.id)).toEqual([candidate]);
    expect((await getItem(lib.ownerCtx, { id: candidate, query: {} })).reason).toBe(SCOPED_REASON);

    // A newer assertion revision lands (the real support path versions the
    // assertion): the pinned revision no longer matches the current one, so
    // the served scoped output must not survive the drift.
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const { rows: pinned } = await isoDb.query<{ revision: number }>(
      'SELECT revision FROM graph_assertions WHERE id = $1',
      [rodinAssociation],
    );
    const support = await freshEvidence(isoDb);
    const attached = await attachAssertionSupport(isoDb, {
      assertionId: rodinAssociation,
      evidenceId: support.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: support.familyKey,
    });
    expect(attached.revisionBumped).toBe(true);
    expect(attached.assertionRevision).toBe(pinned[0]!.revision + 1);

    const railAfter = await getItem(lib.ownerCtx, { id: lib.origin, query: {} });
    expect(railAfter.related).toEqual([]);
    expect(railAfter.related_state).toBe('none');
    expect((await getItem(lib.ownerCtx, { id: candidate, query: {} })).reason).toBeNull();
  });

  it('natural evidence expiry also denies the retained candidate ID for a grant-limited agent; the owner and the open window keep serving (DISC-SCR-045)', async () => {
    const lib = await scopedReadLibrary(isoDb);
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const seuratAssociation = await corpusAssertion(isoDb, SEURAT_KEY, 'DOCUMENTED_ASSOCIATION');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await regroundAssertion(isoDb, rodinAssociation, await freshEvidence(isoDb, { expiresAt }));
    await regroundAssertion(isoDb, seuratAssociation, await freshEvidence(isoDb, { expiresAt }));

    const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.origin, lib.col.id, 'play');
    expect(out.state).toBe('complete');
    const candidate = (await publishedItemIds(isoDb, started.discovery_job_id))[0]!;

    // Control: while the window is open, the grant-limited agent reads the
    // published candidate through its valid scoped proof.
    const actx = await freshAgentCtx(isoDb, lib.credential);
    expect((await getItem(actx, { id: candidate, query: {} })).item.id).toBe(candidate);

    // The window lapses only at READ time: no stored state flips, yet the
    // read-time revalidation withdraws both the reason and the retained-ID
    // visibility of the newly materialized, unsaved candidate.
    const { rows: proofs } = await isoDb.query<{ validity_state: string }>(
      'SELECT validity_state FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [started.discovery_job_id],
    );
    expect(proofs[0]!.validity_state).toBe('valid');
    const expiredAgent = await aheadAgentCtx(isoDb, lib.credential, 2 * 60 * 60 * 1000);
    await expect(getItem(expiredAgent, { id: candidate, query: {} })).rejects.toMatchObject({ code: 'not_found' });

    // First-party ownership is untouched: the owner keeps the card (with the
    // scoped reason withdrawn) and the origin's honest rail.
    const expiredOwner = aheadCtx(isoDb, lib.owner, 2 * 60 * 60 * 1000);
    const ownerCandidate = await getItem(expiredOwner, { id: candidate, query: {} });
    expect(ownerCandidate.item.id).toBe(candidate);
    expect(ownerCandidate.reason).toBeNull();
    const expiredRail = await getItem(expiredOwner, { id: lib.origin, query: {} });
    expect(expiredRail.related).toEqual([]);
    expect(expiredRail.related_state).toBe('none');

    // An EXPLICIT granted save restores the agent's read under the expired
    // proof (the save is an independent authorization); the reason stays null.
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: candidate, body: {} });
    const grantedSave = await getItem(expiredAgent, { id: candidate, query: {} });
    expect(grantedSave.item.id).toBe(candidate);
    expect(grantedSave.reason).toBeNull();
  });

  it('eight withdrawn newer scoped contexts cannot hide a ninth independently valid older reason (DISC-SCR-046)', async () => {
    const lib = await scopedReadLibrary(isoDb);
    // The candidate already carries an INDEPENDENT taste recommendation
    // created an hour EARLIER than every scoped context below (the owner's
    // own prior interest — a plain taste row, no destructive setup).
    const candidate = await insertItem(
      { accountId: lib.accountId },
      { kind: 'artist', category: 'play', title: 'Georges Seurat', qloo: SEURAT_QLOO_ID, referenceId: lib.seuratRef },
      isoDb,
    );
    const tasteRun = await isoDb.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state, signal_count)
       VALUES ($1, 0, 'complete', 1) RETURNING id`,
      [lib.accountId],
    );
    await isoDb.query(
      `INSERT INTO recommendations (taste_seed_run_id, discovery_item_id, category, rank, title,
                                    external_ids, display_reason, origin, provider_query_ids, created_at)
       VALUES ($1, $2, 'play', 1, 'Georges Seurat', '{}'::jsonb, 'From your interests.', 'catalog',
               ARRAY[]::uuid[], now() - interval '1 hour')`,
      [tasteRun.rows[0]!.id, candidate],
    );

    // Eight NEWER scoped contexts publish the same canonical candidate, one
    // per granted-origin collection (ordinary supported discoveries).
    for (let i = 0; i < 8; i += 1) {
      const col = await createCollection(lib.ownerCtx, { name: `Museum ${i} ${randomUUID().slice(0, 6)}` });
      await addCollectionItem(lib.ownerCtx, { id: col.id, item_id: lib.origin, body: {} });
      const { started, out } = await publishScoped(lib.ownerCtx, isoDb, lib.origin, col.id, 'play');
      expect(out.state).toBe('complete');
      expect(await publishedItemIds(isoDb, started.discovery_job_id)).toEqual([candidate]);
    }

    // Their shared walked evidence is withdrawn together: all eight pinned
    // proofs stop serving at once.
    const rodinAssociation = await corpusAssertion(isoDb, RODIN_KEY, 'DOCUMENTED_ASSOCIATION');
    const retraction = await retractGraphEvidence(isoDb, {
      evidenceId: await soleEvidenceOf(isoDb, rodinAssociation),
      reason: 'withdrawn after publication',
    });
    expect(retraction.scopedProofsInvalidated).toBe(8);

    // The ninth, independently valid OLDER taste reason still serves: the
    // item read pages past every invalid context instead of treating a fixed
    // history-search budget as proof that no valid reason exists.
    const after = await getItem(lib.ownerCtx, { id: candidate, query: {} });
    expect(after.reason).toBe('From your interests.');
    expect(after.why_this?.text).toBe('From your interests.');
    expect(after.item.saved).toBe(false);

    // Provenance is preserved without destructive cleanup: all eight durable
    // scoped rows and the taste row remain — only serving was withdrawn.
    const { rows: history } = await isoDb.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recommendations WHERE discovery_item_id = $1',
      [candidate],
    );
    expect(Number(history[0]!.n)).toBe(9);
  });
});
