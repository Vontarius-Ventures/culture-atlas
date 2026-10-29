import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertRecommendation as compilerInsertRecommendation, upsertDiscoveryItem as compilerUpsertItem, upsertReference } from '../compiler/store';
import { recordProviderQuery } from '../compiler/provider-queries';
import { upsertDiscoveryItem as composerUpsertItem } from '../composer/store';
import type { ServiceContext } from '../context';
import type { Db, PoolDb } from '../db/pool';
import { AppError } from '../errors';
import { activateAnalysis, submitCorrection } from '../services/analyses';
import { deleteCapture } from '../services/captures';
import { addCollectionItem, createCollection } from '../services/collections';
import { getItem, startRelatedDiscovery } from '../services/items';
import { runJob } from '../test-support/library';
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
import { discoveryGrantAuthorityForJob, type ScopedDiscoveryGrantAuthority } from './scoped-discovery';
import { runScopedGraphDiscovery } from './scoped-discovery-graph';

/**
 * The origin-root and live photo-lineage discipline of the approved
 * grant-scoped Discover more graph branch (round-8 repairs DISC-SCR-032 and
 * DISC-SCR-037; VAL-DISC-008/009).
 *
 * DISC-SCR-032 — historical merged contributor anchors are not the origin's
 * current identity. `discovery_items.resolved_anchor_ids` is a contributor
 * union the real compiler writes onto RECOMMENDED items from the source
 * photo's contributing references (compiler/analyze.ts's insights picks),
 * merged across analyses by the compiler's owner-keyed upsert. A scoped
 * walk must never root from it: a film recommended from a Rodin photo is not
 * Rodin, and an ungranted capture/collection's contributor must never leak
 * into another context's walk. Roots are ONLY the origin's own cultural
 * reference and — for a capture origin — its ACTIVE analysis's authorized
 * qualified references.
 *
 * DISC-SCR-037 — the capture/analysis/reference authority behind those photo
 * roots is locked and retained through the publication commit, ordered with
 * the REAL writers (activateAnalysis's pointer move, submitCorrection and
 * deleteCapture, which both take the capture row lock first) in both commit
 * orders: activation/deletion first rejects or honestly re-walks the new
 * lineage; publisher first holds the walked lineage through the commit and
 * the mutation lands after, with redelivery converging on it.
 *
 * Everything runs against the real committed pilot corpus on an isolated
 * database, with the real production writers building every fixture.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});

/** Verified live Qloo entity ids (see the manifest provenance). */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
/** One of FIVE same-named "Vincent van Gogh" persons Qloo returned: no mapping ships. */
const UNMAPPED_VANGOGH_QLOO_ID = 'FF1DECE6-AB12-47A4-AE63-55ABFA4DA279';

const RODIN_KEY = 'atlas:creator:auguste-rodin';
const SEURAT_KEY = 'atlas:creator:georges-seurat';

let isoDb: PoolDb;
let dropIso: () => Promise<void>;
let rodinRef: string;
let seuratRef: string;
let unmappedRef: string;

beforeAll(async () => {
  const created = await createIsolatedDatabase('scrdphoto');
  isoDb = created.db;
  dropIso = created.drop;
  await admitGraphCorpus(isoDb, getCorpusManifestFile());
  const qlooPersonReference = async (qlooId: string, name: string) =>
    upsertReference(isoDb, {
      canonicalKey: `qloo:${qlooId}`,
      name,
      type: 'creator',
      externalIds: { qloo: qlooId, qloo_types: ['urn:entity:person'] },
    });
  rodinRef = await qlooPersonReference(RODIN_QLOO_ID, 'Auguste Rodin');
  seuratRef = await qlooPersonReference(SEURAT_QLOO_ID, 'Georges Seurat');
  unmappedRef = await qlooPersonReference(UNMAPPED_VANGOGH_QLOO_ID, 'Vincent van Gogh');
  await linkGraphReferenceIdentities(isoDb);
});
afterAll(async () => {
  await dropIso();
});

/** A fake Qloo that RECORDS every call and fails closed on each one. */
function noCallQloo(): FakeQloo {
  return new FakeQloo({}, { live: true });
}

interface ScopedPhotoLibrary {
  accountId: string;
  ownerCtx: ServiceContext;
  col: { id: string };
  actx: ServiceContext;
}

/** One fresh account + granted collection + selected-collection agent. */
async function scopedPhotoLibrary(): Promise<ScopedPhotoLibrary> {
  const owner = await insertAccount(isoDb);
  const ctx = testContext(owner, { db: isoDb, config: graphOn });
  const col = await createCollection(ctx, { name: `Photo roots ${randomUUID().slice(0, 6)}` });
  const { principal: agent } = await insertAgentConnection(
    owner,
    { scopes: ['collections:read', 'captures:read'], libraryAccess: 'selected_collections', collectionIds: [col.id] },
    isoDb,
  );
  return {
    accountId: owner.accountId,
    ownerCtx: ctx,
    col,
    actx: testContext(agent, { db: isoDb, config: graphOn }),
  };
}

interface CaptureReferenceInput {
  referenceId: string;
  relation?: 'depicted' | 'resembles' | 'user_selected';
  resolution?: 'resolved' | 'user_confirmed' | 'rejected' | 'unmatched' | 'ambiguous';
  textOnly?: boolean;
  isAnchor?: boolean;
}

/** A capture with one analysis, its capture_references and its own item, through real rows. */
async function captureWithReferences(
  accountId: string,
  refs: readonly CaptureReferenceInput[],
  opts: { version?: number; activate?: boolean; title?: string } = {},
): Promise<{ captureId: string; analysisId: string; itemId: string }> {
  const version = opts.version ?? 1;
  const { rows: capRows } = await isoDb.query<{ id: string }>(
    `INSERT INTO captures (owner_account_id, source, image_sha256, private_object_key, status)
     VALUES ($1, 'upload', $2, $3, 'ready') RETURNING id`,
    [accountId, randomUUID().replace(/-/g, ''), `captures/test/${randomUUID()}.jpg`],
  );
  const captureId = capRows[0]!.id;
  const { rows: anRows } = await isoDb.query<{ id: string }>(
    `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
     VALUES ($1, $2, 'test', $3, 'A few references stood out.', '{"observations":"complete"}') RETURNING id`,
    [captureId, version, opts.title ?? 'A Rodin sculpture'],
  );
  const analysisId = anRows[0]!.id;
  for (const ref of refs) {
    await isoDb.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, is_anchor, resolution_status, text_only, read_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        analysisId,
        ref.referenceId,
        ref.relation ?? 'depicted',
        ref.resolution === 'user_confirmed' ? 0.9 : 0.8,
        ref.textOnly ? false : (ref.isAnchor ?? true),
        ref.resolution ?? 'resolved',
        ref.textOnly ?? false,
        ref.textOnly ? 'A name read from the analysis reply' : null,
      ],
    );
  }
  if (opts.activate ?? true) {
    await activateAnalysis(isoDb, { captureId, analysisId });
  }
  const { rows: itemRows } = await isoDb.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, canonical_key, capture_id, title)
     VALUES ($1, 'capture', $2, $3, $4) RETURNING id`,
    [accountId, `capture:${captureId}`, captureId, opts.title ?? 'A Rodin sculpture'],
  );
  return { captureId, analysisId, itemId: itemRows[0]!.id };
}

/** Enqueue the real selected-collection operation on an origin and return its identities. */
async function enqueueScoped(
  lib: ScopedPhotoLibrary,
  itemId: string,
  category: 'play' | null,
): Promise<{ jobId: string; discoveryJobId: string; authority: ScopedDiscoveryGrantAuthority }> {
  const started = await startRelatedDiscovery(lib.actx, {
    id: itemId,
    body: category ? { collection_id: lib.col.id, category } : { collection_id: lib.col.id },
  });
  const authority = (await discoveryGrantAuthorityForJob(isoDb, {
    ownerAccountId: lib.accountId,
    discoveryJobId: started.discovery_job_id,
  }))!;
  expect(authority.origin_item_id).toBe(itemId);
  return { jobId: started.job_id, discoveryJobId: started.discovery_job_id, authority };
}

async function scopedRecommendations(db: PoolDb, discoveryJobId: string) {
  const { rows } = await db.query<{
    id: string;
    discovery_item_id: string;
    title: string;
    category: string | null;
    rank: number;
    origin: string;
    display_reason: string | null;
    contributing_reference_ids: string[];
  }>(
    `SELECT id, discovery_item_id, title, category, rank, origin, display_reason, contributing_reference_ids
       FROM recommendations WHERE discovery_job_id = $1 ORDER BY rank`,
    [discoveryJobId],
  );
  return rows;
}

async function scopedProofCount(db: PoolDb, discoveryJobId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
    [discoveryJobId],
  );
  return Number(rows[0]!.n);
}

/** The account-wide graph/feed state a scoped pass must never write. */
async function accountWideState(db: PoolDb, accountId: string) {
  const single = async (sql: string) => {
    const { rows } = await db.query<{ n: number }>(sql, [accountId]);
    return Number(rows[0]!.n);
  };
  return {
    graphRuns: await single('SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1'),
    frontier: await single('SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1'),
    interestEdges: await single('SELECT count(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = $1'),
    feedSnapshots: await single('SELECT count(*)::int AS n FROM feed_snapshots WHERE owner_account_id = $1'),
  };
}

async function nodeIdOf(db: PoolDb, canonicalKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM graph_nodes WHERE canonical_key = $1', [canonicalKey]);
  return rows[0]!.id;
}

/**
 * A Db view of one dedicated pool client that joins the CALLER's already-open
 * transaction instead of issuing its own BEGIN/COMMIT: the real pass runs its
 * exact production statements while the test holds the commit barrier on
 * that connection.
 */
function openTransactionDb(client: PoolClient): Db {
  const self: Db = {
    inTransaction: true,
    query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
      return client.query<R>(text, params as unknown[] | undefined);
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return fn(self);
    },
  };
  return self;
}

/** Fails honestly on timeout, so a barrier test cannot pass by racing past the park. */
async function waitForLockWaiters(pattern: string, atLeast: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await isoDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND datname = current_database()`,
      [pattern],
    );
    if (Number(rows[0]!.n) >= atLeast) return;
    if (Date.now() >= deadline) throw new Error(`expected at least ${atLeast} lock waiter(s) matching ${pattern} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Polls until the parked publisher provably holds the row lock (NOWAIT probe fails 55P03). */
async function waitForHeldLock(sql: string, params: readonly unknown[], timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await isoDb.query(sql, params);
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') return;
      throw err;
    }
    if (Date.now() >= deadline)
      throw new Error(`publisher never acquired the fence lock (${sql.slice(0, 60)}…) within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function appErrorOf(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected the call to reject');
}

// --- DISC-SCR-032: no historical contributor anchors as scoped roots ---------------

describe('scoped origin roots accept only current origin identities (DISC-SCR-032)', () => {
  it('a film carrying a real cross-context contributor anchor is never walked as that contributor', async () => {
    const lib = await scopedPhotoLibrary();
    // The source photo lives in an UNGRANTED second collection: its capture's
    // analysis depicts Rodin, exactly the cross-context B of the finding.
    const otherCol = await createCollection(lib.ownerCtx, { name: `Cross context ${randomUUID().slice(0, 6)}` });
    const cap = await captureWithReferences(lib.accountId, [{ referenceId: rodinRef }]);
    await addCollectionItem(lib.ownerCtx, { id: otherCol.id, item_id: cap.itemId, body: {} });

    // The REAL compiler writer (analyze.ts's insights picks): a recommended
    // film whose contributing references are the source photo's depicted
    // references — `resolvedAnchorIds: contributors.map(r => r.referenceId)`
    // — with a real provider query and a real recommendation under the
    // capture's analysis parent.
    const filmQlooId = randomUUID();
    const filmItem = await compilerUpsertItem(isoDb, { kind: 'account', accountId: lib.accountId }, {
      kind: 'film',
      category: 'watch',
      canonicalKey: `qloo:${filmQlooId}`,
      title: 'The Thinker: a film',
      displayMetadata: { subtitle: '1998', year: 1998 },
      externalIds: { qloo: filmQlooId },
      resolvedAnchorIds: [rodinRef],
    });
    const providerQueryId = await recordProviderQuery(isoDb, {
      parent: { analysisId: cap.analysisId },
      provider: 'qloo',
      operation: 'insights',
      request: { filterType: 'urn:entity:movie', signalEntities: [`qloo:${RODIN_QLOO_ID}`], take: 5 },
      status: 'ok',
    });
    await compilerInsertRecommendation(isoDb, {
      analysisId: cap.analysisId,
      discoveryItemId: filmItem,
      category: 'watch',
      rank: 1,
      title: 'The Thinker: a film',
      externalIds: { qloo: filmQlooId },
      displayReason: 'Inspired by your photo.',
      origin: 'qloo',
      providerQueryIds: [providerQueryId],
      contributingReferenceIds: [rodinRef],
    });

    // The owner saves the FILM into the GRANTED collection and runs the
    // scoped Discover more on it.
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: filmItem, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, filmItem, null);
    const accountWideBefore = await accountWideState(isoDb, lib.accountId);

    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: null,
      ensureActive: async () => undefined,
    });
    // The film is NOT Rodin: no qualified root exists, so nothing is walked,
    // nothing fabricated and no account-wide state is written.
    expect(out.state).toBe('partial');
    expect(out.counts.rootReferences).toBe(0);
    expect(out.counts.roots).toBe(0);
    expect(out.results).toEqual([]);
    expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
    expect(await scopedProofCount(isoDb, discoveryJobId)).toBe(0);
    expect(await accountWideState(isoDb, lib.accountId)).toEqual(accountWideBefore);

    // Contrast: the CAPTURE origin itself (its own live lineage) still walks
    // the reviewed Rodin path — the honest owner of that identity.
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const captureScoped = await enqueueScoped(lib, cap.itemId, 'play');
    const captureOut = await runScopedGraphDiscovery(isoDb, {
      authority: captureScoped.authority,
      category: 'play',
      ensureActive: async () => undefined,
    });
    expect(captureOut.state).toBe('complete');
    expect(captureOut.counts.rootReferences).toBe(1);
    expect(captureOut.results).toHaveLength(1);
    expect(captureOut.results[0]!.reason).toBe('Also work on display at Art Institute of Chicago');
  });

  it('an origin with its own reference walks only that identity after a real provider pick merged a foreign contributor onto it', async () => {
    const lib = await scopedPhotoLibrary();
    // The account's own Rodin identity item, materialized on its cultural
    // reference exactly like the graph materializer does.
    const rodinItem = await composerUpsertItem(isoDb, { kind: 'account', accountId: lib.accountId }, {
      kind: 'artist',
      category: 'play',
      canonical_key: `qloo:${RODIN_QLOO_ID}`,
      title: 'Auguste Rodin',
      display_metadata: { subtitle: 'Artist' },
      external_ids: { qloo: RODIN_QLOO_ID },
      reference_id: rodinRef,
    });
    // A REAL compiler pick of the SAME canonical identity (a later insights
    // run of a Seurat photo) merges its contributing reference onto the item
    // through the owner-keyed union — the historical anchor the walk must
    // ignore.
    await compilerUpsertItem(isoDb, { kind: 'account', accountId: lib.accountId }, {
      kind: 'artist',
      category: 'play',
      canonicalKey: `qloo:${RODIN_QLOO_ID}`,
      title: 'Auguste Rodin',
      displayMetadata: { subtitle: 'Artist' },
      externalIds: { qloo: RODIN_QLOO_ID },
      resolvedAnchorIds: [seuratRef],
    });
    const { rows: anchors } = await isoDb.query<{ resolved_anchor_ids: string[]; reference_id: string | null }>(
      'SELECT resolved_anchor_ids, reference_id FROM discovery_items WHERE id = $1',
      [rodinItem],
    );
    expect(anchors[0]).toMatchObject({ reference_id: rodinRef, resolved_anchor_ids: [seuratRef] });

    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: rodinItem, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, rodinItem, 'play');

    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
    });
    expect(out.state).toBe('complete');
    // Only the item's OWN identity roots the walk — never the merged
    // historical contributor.
    expect(out.counts.rootReferences).toBe(1);
    expect(out.counts.roots).toBe(1);
    const recs = await scopedRecommendations(isoDb, discoveryJobId);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.title).toBe('Georges Seurat');
    // The published card's contributing references name exactly the walked
    // root: the Rodin reference, never the Seurat photo's contributor.
    expect(recs[0]!.contributing_reference_ids).toEqual([rodinRef]);
    const { rows: proofs } = await isoDb.query<{ root_node_id: string }>(
      'SELECT root_node_id FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1',
      [discoveryJobId],
    );
    expect(proofs[0]!.root_node_id).toBe(await nodeIdOf(isoDb, RODIN_KEY));
    expect(proofs[0]!.root_node_id).not.toBe(await nodeIdOf(isoDb, SEURAT_KEY));
  });
});

// --- DISC-SCR-037: the live capture lineage is locked through publication ----------

describe('scoped photo roots walk the locked live capture lineage (DISC-SCR-037)', () => {
  it('a saved capture origin walks exactly its active analysis\'s authorized references end to end', async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [
      { referenceId: rodinRef }, // depicted + resolved: the qualified root
      { referenceId: seuratRef, textOnly: true }, // a text-only mention is never a fact
      { referenceId: unmappedRef, relation: 'user_selected', resolution: 'user_confirmed' }, // authorized but unmapped
    ]);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { jobId, discoveryJobId } = await enqueueScoped(lib, cap.itemId, 'play');
    const accountWideBefore = await accountWideState(isoDb, lib.accountId);

    const qloo = noCallQloo();
    const traceNotes: Array<{ kind: string; name: string; data?: Record<string, unknown> }> = [];
    const out = await runJob(jobId, {
      db: isoDb,
      config: graphOn,
      providers: testProviders({ qloo }),
      onTrace: (event) => traceNotes.push(event),
    });
    // The qualified photo root reaches the reviewed path with ZERO provider
    // calls; the text-only mention and the unmapped confirmation never
    // fabricate a second card.
    expect(out.state).toBe('complete');
    expect(qloo.calls).toEqual([]);
    const recs = await scopedRecommendations(isoDb, discoveryJobId);
    expect(recs.map((r) => r.title)).toEqual(['Georges Seurat']);
    expect(recs[0]!.contributing_reference_ids.sort()).toEqual([rodinRef, unmappedRef].sort());
    const note = traceNotes.find((n) => n.name === 'scoped_graph_discovery');
    expect(note).toMatchObject({
      kind: 'note',
      data: {
        state: 'complete',
        counts: expect.objectContaining({ rootReferences: 2, roots: 1, rootReferencesUnmapped: 1, resultsPublished: 1 }),
      },
    });
    expect(await accountWideState(isoDb, lib.accountId)).toEqual(accountWideBefore);
    // The owner's own surface reads the scoped result through the real item read.
    const detail = await getItem(lib.ownerCtx, { id: cap.itemId, query: { collection_id: lib.col.id } });
    expect(detail.related_state).toBe('cached');
    expect(detail.related.map((r) => r.title)).toEqual(['Georges Seurat']);
  });

  it('a resemblance-only capture origin never roots a scoped walk (fail-closed control)', async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [
      { referenceId: rodinRef, relation: 'resembles', resolution: 'resolved' },
    ]);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');
    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
    });
    expect(out.state).toBe('partial');
    expect(out.counts.rootReferences).toBe(0);
    expect(out.results).toEqual([]);
    expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
  });

  it("the owner's latest correction withdraws a depicted reference before the walk", async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [{ referenceId: rodinRef }]);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');
    // The REAL correction writer rejects the reference while the active
    // analysis still lists it as resolved: the user's current intent.
    await submitCorrection(lib.ownerCtx, {
      id: cap.captureId,
      body: { expected_analysis_version: 1, reject_reference_ids: [rodinRef] },
    });
    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
    });
    expect(out.state).toBe('partial');
    expect(out.counts.rootReferences).toBe(0);
    expect(out.results).toEqual([]);
    expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
  });

  it('a corrected-then-confirmed rejected reference roots again: the user is the evidence', async () => {
    const lib = await scopedPhotoLibrary();
    // The model's rejected guess plus an honest resolved anchor (so the
    // operation's enqueue gate sees a discovery anchor on the photo).
    const cap = await captureWithReferences(lib.accountId, [
      { referenceId: rodinRef, resolution: 'rejected', isAnchor: false },
      { referenceId: unmappedRef },
    ]);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');
    await submitCorrection(lib.ownerCtx, {
      id: cap.captureId,
      body: { expected_analysis_version: 1, confirm_reference_id: rodinRef },
    });
    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
    });
    // The confirmed reference is the user's own evidence: it roots the walk
    // again (the resolved-but-unmapped anchor walks as unmapped, never as a
    // fabricated identity).
    expect(out.state).toBe('complete');
    expect(out.counts.rootReferences).toBe(2);
    expect(out.counts.roots).toBe(1);
    expect(out.counts.rootReferencesUnmapped).toBe(1);
    const recs = await scopedRecommendations(isoDb, discoveryJobId);
    expect(recs.map((r) => r.title)).toEqual(['Georges Seurat']);
  });

  it('activation-first: an A→B activation committed before the pass is the walked lineage', async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [{ referenceId: rodinRef }]);
    // Analysis B (version 2) depicts only the unmapped reference.
    const { rows: bRows } = await isoDb.query<{ id: string }>(
      `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
       VALUES ($1, 2, 'test', 'A re-read', 'A different reading.', '{"observations":"complete"}') RETURNING id`,
      [cap.captureId],
    );
    const analysisB = bRows[0]!.id;
    await isoDb.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, is_anchor, resolution_status)
       VALUES ($1, $2, 'user_selected', 0.9, true, 'user_confirmed')`,
      [analysisB, unmappedRef],
    );
    await activateAnalysis(isoDb, { captureId: cap.captureId, analysisId: analysisB });
    const { rows: active } = await isoDb.query<{ active_analysis_id: string }>(
      'SELECT active_analysis_id FROM captures WHERE id = $1',
      [cap.captureId],
    );
    expect(active[0]!.active_analysis_id).toBe(analysisB);

    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');
    const out = await runScopedGraphDiscovery(isoDb, {
      authority,
      category: 'play',
      ensureActive: async () => undefined,
    });
    // The pass walks B — the current lineage — and publishes nothing from A.
    expect(out.state).toBe('partial');
    expect(out.counts.rootReferences).toBe(1);
    expect(out.counts.rootReferencesUnmapped).toBe(1);
    expect(out.results).toEqual([]);
    expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
  });

  it('publisher-first: a real activateAnalysis(A→B) queues on the capture lock; the pass publishes its held lineage and redelivery converges on B', async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [{ referenceId: rodinRef }]);
    const { rows: bRows } = await isoDb.query<{ id: string }>(
      `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
       VALUES ($1, 2, 'test', 'A re-read', 'A different reading.', '{"observations":"complete"}') RETURNING id`,
      [cap.captureId],
    );
    const analysisB = bRows[0]!.id;
    await isoDb.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, is_anchor, resolution_status)
       VALUES ($1, $2, 'user_selected', 0.9, true, 'user_confirmed')`,
      [analysisB, unmappedRef],
    );
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');

    const client = await isoDb.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      // The real pass on a dedicated open transaction, parked inside its
      // publication transaction AFTER reading A's qualified references.
      const pass = runScopedGraphDiscovery(openTransactionDb(client), {
        authority,
        category: 'play',
        ensureActive: () => gate,
      });
      void pass.catch(() => undefined);
      // The pass provably holds the capture lineage lock before the walk reads it.
      await waitForHeldLock('SELECT 1 FROM captures WHERE id = $1 FOR UPDATE NOWAIT', [cap.captureId]);
      // The REAL activation writer on its own connection.
      const activation = activateAnalysis(isoDb, { captureId: cap.captureId, analysisId: analysisB });
      void activation.catch(() => undefined);
      // It cannot commit between the locked read and the publication commit:
      // it queues on the held capture row lock.
      await waitForLockWaiters('%UPDATE captures c SET active_analysis_id%', 1);
      const { rows: stillA } = await isoDb.query<{ active_analysis_id: string | null }>(
        'SELECT active_analysis_id FROM captures WHERE id = $1',
        [cap.captureId],
      );
      expect(stillA[0]!.active_analysis_id).toBe(cap.analysisId);

      // Publisher-first: the pass completes and commits under the lineage it
      // walked; the activation lands right after the commit.
      openGate();
      const out = await pass;
      expect(out.state).toBe('complete');
      expect(out.counts.resultsPublished).toBe(1);
      committed = true;
      await client.query('COMMIT');
      await activation;
      const { rows: afterB } = await isoDb.query<{ active_analysis_id: string | null }>(
        'SELECT active_analysis_id FROM captures WHERE id = $1',
        [cap.captureId],
      );
      expect(afterB[0]!.active_analysis_id).toBe(analysisB);

      // Redelivery of the same pinned authority converges on B: the walk
      // rebuilds from the CURRENT lineage and the stale card disappears.
      const replay = await runScopedGraphDiscovery(isoDb, {
        authority,
        category: 'play',
        ensureActive: async () => undefined,
      });
      expect(replay.state).toBe('partial');
      expect(replay.counts.rootReferences).toBe(1);
      expect(replay.counts.rootReferencesUnmapped).toBe(1);
      expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('publisher-first: a real deleteCapture queues behind the pass; the publication commits and the deletion then removes the origin', async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [{ referenceId: rodinRef }]);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');

    const client = await isoDb.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      const pass = runScopedGraphDiscovery(openTransactionDb(client), {
        authority,
        category: 'play',
        ensureActive: () => gate,
      });
      void pass.catch(() => undefined);
      await waitForHeldLock('SELECT 1 FROM captures WHERE id = $1 FOR UPDATE NOWAIT', [cap.captureId]);
      // The REAL deletion writer on its own connection (it takes the capture
      // row lock first, exactly like the publication does).
      const deletion = deleteCapture(lib.ownerCtx, { id: cap.captureId });
      void deletion.catch(() => undefined);
      // The deletion queues on the publisher's held capture lock — the same
      // row lock its own path takes first.
      await waitForLockWaiters('%FOR UPDATE OF c%', 1);
      const { rows: stillLive } = await isoDb.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM captures WHERE id = $1',
        [cap.captureId],
      );
      expect(stillLive[0]!.deleted_at).toBeNull();

      openGate();
      const out = await pass;
      expect(out.state).toBe('complete');
      expect(out.counts.resultsPublished).toBe(1);
      committed = true;
      await client.query('COMMIT');
      await deletion;
      // The deletion lands after the publication commit and withdraws the
      // origin with all of its scoped results.
      const { rows: deleted } = await isoDb.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM captures WHERE id = $1',
        [cap.captureId],
      );
      expect(deleted[0]!.deleted_at).not.toBeNull();
      expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
      const err = await appErrorOf(() => getItem(lib.actx, { id: cap.itemId, query: { collection_id: lib.col.id } }));
      expect(err.code).toBe('not_found');
    } finally {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('deletion-first: a capture deleted before the pass rejects with nothing published', async () => {
    const lib = await scopedPhotoLibrary();
    const cap = await captureWithReferences(lib.accountId, [{ referenceId: rodinRef }]);
    await addCollectionItem(lib.ownerCtx, { id: lib.col.id, item_id: cap.itemId, body: {} });
    const { discoveryJobId, authority } = await enqueueScoped(lib, cap.itemId, 'play');

    await deleteCapture(lib.ownerCtx, { id: cap.captureId });
    const err = await appErrorOf(() =>
      runScopedGraphDiscovery(isoDb, { authority, category: 'play', ensureActive: async () => undefined }),
    );
    // Non-disclosing rejection (membership/authority gone with the origin),
    // never a stale publication and never a raw database error.
    expect(['not_found', 'token_revoked']).toContain(err.code);
    expect(await scopedRecommendations(isoDb, discoveryJobId)).toEqual([]);
  });
});
