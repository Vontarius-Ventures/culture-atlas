import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolDb } from '../db/pool';
import { upsertReference } from '../compiler/store';
import { insertCaptureWithAnalysis, insertItem } from '../test-support/library';
import type { ServiceContext } from '../context';
import {
  closeTestDb,
  createIsolatedDatabase,
  insertAccount,
  testConfig,
  testContext,
} from '../testing';
import { recordPreference } from '../services/preferences';
import { admitGraphCorpus } from './corpus';
import { getCorpusManifestFile } from './corpus-manifest';
import { linkGraphReferenceIdentities } from './identity-links';
import { projectAccountInterestGraph } from './projector';
import { expandAccountInterestGraph } from './expansion';

/**
 * The SHIPPED pilot corpus serves real application references (DISC-SCR-016).
 *
 * The committed 34-identity manifest must actually bridge at least one
 * normal-shaped saved or authorized-photo reference to a reviewed supported
 * candidate with account-owned materialization — not only the manufactured
 * fully mapped test manifest of the corpus-traversal tests. Everything here
 * runs against the real committed manifest (getCorpusManifestFile) and
 * compiler-shaped Qloo references:
 *
 *  - Only verified Qloo identity mappings ship: a live /search could confirm
 *    exactly two pilot creators by a SINGLE exact-name person result. Lookups
 *    that returned several same-named persons (Vincent van Gogh: five; Paul
 *    Cézanne: two) and the works (Qloo has no artwork entity) ship NO
 *    mapping — a name or a plurality of results never infers identity.
 *  - The one supported default-corpus path is the reviewed
 *    co_documented_association through the Art Institute of Chicago: a
 *    creator whose cited work is documented on display there connects to
 *    another such creator, from a personal saved reference or an authorized
 *    photo reference, and materializes onto the account's own item on the
 *    candidate's reference.
 *  - Both orders converge: references that exist before a corpus (re)import
 *    bind durably inside the admission transaction, and references created
 *    after the last import resolve at read time through the same verified
 *    link until the next linkage pass converges the durable bindings.
 *  - Unknown provider ids and the graph-off flags stay fail-closed; replay
 *    adds nothing.
 */

const graphOn = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const projectionOnly = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

/** Verified live Qloo entity ids (see the manifest provenance): single exact-name person results. */
const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
/** One of FIVE same-named "Vincent van Gogh" persons Qloo returned: ambiguous, so NO mapping ships. */
const UNMAPPED_VANGOGH_QLOO_ID = 'FF1DECE6-AB12-47A4-AE63-55ABFA4DA279';

const RODIN_KEY = 'atlas:creator:auguste-rodin';
const SEURAT_KEY = 'atlas:creator:georges-seurat';
const AIC_KEY = 'atlas:place:art-institute-of-chicago';

/** A compiler-shaped Qloo person reference: `qloo:<id>` key + `qloo` external id, exactly as photo resolution writes it. */
async function qlooPersonReference(db: PoolDb, qlooId: string, name: string): Promise<string> {
  return upsertReference(db, {
    canonicalKey: `qloo:${qlooId}`,
    name,
    type: 'creator',
    externalIds: { qloo: qlooId, qloo_types: ['urn:entity:person'] },
  });
}

/** A fresh account + service context bound to the isolated database. */
async function accountOn(
  db: PoolDb,
  config = graphOn,
): Promise<{ principal: { accountId: string }; ctx: ServiceContext }> {
  const principal = await insertAccount(db);
  return { principal, ctx: testContext(principal, { db, config }) };
}

/** A saved capture whose active analysis authorizes one depicted reference (isolated db). */
async function savedCaptureWithReference(
  db: PoolDb,
  ctx: ServiceContext,
  accountId: string,
  referenceId: string,
): Promise<void> {
  const cap = await insertCaptureWithAnalysis({ accountId }, {}, db);
  await db.query(
    `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
     VALUES ($1, $2, 'depicted', 0.82, 'resolved', true, false, NULL)`,
    [cap.analysisId, referenceId],
  );
  await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
}

/** The account's own candidate item on a reference (the shape of an artist save). */
async function candidateItemOn(
  db: PoolDb,
  accountId: string,
  referenceId: string,
  qlooId: string,
): Promise<string> {
  return insertItem(
    { accountId },
    {
      referenceId,
      kind: 'artist',
      category: 'play',
      qloo: qlooId,
      key: `qloo:${qlooId}`,
      title: 'A real artist',
    },
    db,
  );
}

/** The reviewed creator→museum association assertion id, by identity keys. */
async function associationAssertionId(db: PoolDb, subjectKey: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT a.id
       FROM graph_assertions a
       JOIN graph_nodes s ON s.id = a.subject_node_id AND s.canonical_key = $1
       JOIN graph_nodes o ON o.id = a.object_node_id AND o.canonical_key = $2
      WHERE a.predicate = 'DOCUMENTED_ASSOCIATION' AND a.association_subtype = 'work_on_display_at'`,
    [subjectKey, AIC_KEY],
  );
  return rows[0]!.id;
}

async function nodeByKey(
  db: PoolDb,
  key: string,
): Promise<{ id: string; cultural_reference_id: string | null }> {
  const { rows } = await db.query<{ id: string; cultural_reference_id: string | null }>(
    'SELECT id, cultural_reference_id FROM graph_nodes WHERE canonical_key = $1',
    [key],
  );
  return rows[0]!;
}

// --- The shipped manifest and the reference-before-import order ---------------------

describe('the shipped pilot corpus serves real application references (DISC-SCR-016)', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('pilotpath');
    isoDb = created.db;
    dropIso = created.drop;
  });
  afterAll(async () => {
    await dropIso();
  });

  it('imports the committed manifest with exactly the verified Qloo mappings a live lookup could confirm', async () => {
    const manifest = getCorpusManifestFile();
    const first = await admitGraphCorpus(isoDb, manifest);
    // The committed manifest loads whole on a fresh database with its own counts.
    expect(first.corpusVersion).toBe(manifest.corpus_version);
    expect(first.identitiesCreated).toBe(manifest.identities.length);
    expect(first.externalIdsCreated).toBe(manifest.external_ids.length);
    expect(first.assertionsCreated).toBe(manifest.assertions.length);
    expect(first.referencesLinked).toBe(0);
    expect(first.referenceLinksAmbiguous).toBe(0);

    // Only the two creators a live /search resolved to a SINGLE exact-name
    // person entity carry a Qloo mapping, with the lookup recorded as provenance.
    const qlooMappings = manifest.external_ids.filter((e) => e.provider === 'qloo');
    expect(qlooMappings.map((e) => e.identity).sort()).toEqual([RODIN_KEY, SEURAT_KEY]);
    for (const mapping of qlooMappings) {
      expect(mapping.provenance).toContain('Qloo /search 2026-10-29');
    }
    // Ambiguous live lookups never ship a mapping: van Gogh (five same-named
    // persons) and Cézanne (two) keep only their Wikidata mappings.
    for (const ambiguous of ['atlas:creator:vincent-van-gogh', 'atlas:creator:paul-cezanne']) {
      expect(
        manifest.external_ids.filter((e) => e.identity === ambiguous).map((e) => e.provider),
      ).toEqual(['wikidata']);
    }
    // The one supported default path is a reviewed same-subtype creator→museum
    // association pair through the Art Institute of Chicago.
    const creatorAssociations = manifest.assertions.filter(
      (a) => a.predicate === 'DOCUMENTED_ASSOCIATION' && a.subject.startsWith('atlas:creator:'),
    );
    expect(creatorAssociations.map((a) => a.association_subtype)).toEqual([
      'work_on_display_at',
      'work_on_display_at',
    ]);
    expect([...new Set(creatorAssociations.map((a) => a.object))]).toEqual([AIC_KEY]);
    for (const association of creatorAssociations) {
      for (const evidence of association.evidence) {
        expect(evidence.validation.method).toBe('provider_metadata');
      }
    }
  });

  it('serves the authorized-photo path when the references existed before the (re)import: the admission binds them durably', async () => {
    // Compiler-shaped references that already exist when the corpus (re)imports.
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    const seuratRef = await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');
    const rodinAssociation = await associationAssertionId(isoDb, RODIN_KEY);
    const seuratAssociation = await associationAssertionId(isoDb, SEURAT_KEY);

    const admission = await admitGraphCorpus(isoDb, getCorpusManifestFile());
    // Reference-before-import order: the in-transaction linkage pass binds
    // both identities to their real references; nothing was created twice.
    expect(admission.referencesLinked).toBe(2);
    expect(admission.referencesAlreadyLinked).toBe(0);
    expect(admission.identitiesCreated).toBe(0);
    expect(admission.externalIdsCreated).toBe(0);
    expect(await nodeByKey(isoDb, RODIN_KEY)).toMatchObject({ cultural_reference_id: rodinRef });
    expect(await nodeByKey(isoDb, SEURAT_KEY)).toMatchObject({ cultural_reference_id: seuratRef });

    // A saved capture whose active analysis authorizes the Rodin reference
    // (the production photo path: depicted, resolved), plus the account's own
    // item on the candidate's reference.
    const { principal, ctx } = await accountOn(isoDb);
    const accountId = principal.accountId;
    await savedCaptureWithReference(isoDb, ctx, accountId, rodinRef);
    const candidateItem = await candidateItemOn(isoDb, accountId, seuratRef, SEURAT_QLOO_ID);
    await projectAccountInterestGraph(isoDb, {
      accountId,
      config: graphOn,
      source: 'mutation_intent',
    });

    const result = await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    // One authorized photo root reached the corpus; the saved capture's own
    // item edge carries no cultural reference (the honest unmapped count).
    expect(result.counts.photoRoots).toBe(1);
    expect(result.counts.unmappedPersonalRoots).toBe(1);
    // Durably bound roots and candidates resolve without the read-time link.
    expect(result.counts.referencesLinked).toBe(0);
    expect(result.counts.candidatesResolvedByLink).toBe(0);
    expect(result.counts.admitted).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);

    const obs = result.candidates.find((o) => o.intent === 'photo');
    expect(obs).toBeDefined();
    // The candidate materialized onto the account's OWN item on the candidate reference.
    expect(obs!.discoveryItemId).toBe(candidateItem);
    expect(obs!.templateKey).toBe('co_documented_association');
    expect(obs!.reason).toBe('Also work on display at Art Institute of Chicago');
    // The walked connection pins exactly the two reviewed creator→museum
    // assertions, once each.
    expect([...obs!.assertions.map((a) => a.id)].sort()).toEqual(
      [rodinAssociation, seuratAssociation].sort(),
    );

    // The published card and its pinned proof are account-owned and honest.
    const { rows: recs } = await isoDb.query<{
      id: string;
      discovery_item_id: string;
      owner_account_id: string;
      origin: string;
      display_reason: string;
    }>(
      'SELECT id, discovery_item_id, owner_account_id, origin, display_reason FROM recommendations WHERE owner_account_id = $1',
      [accountId],
    );
    expect(recs).toHaveLength(1);
    expect(recs[0]!.discovery_item_id).toBe(candidateItem);
    expect(recs[0]!.origin).toBe('catalog');
    expect(recs[0]!.display_reason).toBe('Also work on display at Art Institute of Chicago');
    const { rows: proofs } = await isoDb.query<{ reason_template: string }>(
      'SELECT reason_template FROM recommendation_graph_proofs WHERE owner_account_id = $1',
      [accountId],
    );
    expect(proofs).toHaveLength(1);
    expect(proofs[0]!.reason_template).toBe('co_documented_association');
  });

  it("serves the personal saved path through the same durable bindings, materializing only the owning account's item", async () => {
    const rodinRef = (await nodeByKey(isoDb, RODIN_KEY)).cultural_reference_id!;
    const seuratRef = (await nodeByKey(isoDb, SEURAT_KEY)).cultural_reference_id!;

    // A second account saves a normal-shaped artist item on the Rodin reference.
    const { principal, ctx } = await accountOn(isoDb);
    const accountId = principal.accountId;
    const savedItem = await insertItem(
      { accountId },
      {
        referenceId: rodinRef,
        kind: 'artist',
        category: 'play',
        qloo: RODIN_QLOO_ID,
        key: `qloo:${RODIN_QLOO_ID}`,
        title: 'A real artist',
      },
      isoDb,
    );
    await recordPreference(ctx, {
      action: 'save',
      target_type: 'discovery_item',
      target_id: savedItem,
    });
    const candidateItem = await candidateItemOn(isoDb, accountId, seuratRef, SEURAT_QLOO_ID);
    await projectAccountInterestGraph(isoDb, {
      accountId,
      config: graphOn,
      source: 'mutation_intent',
    });

    const result = await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.admitted).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const obs = result.candidates.find((o) => o.intent === 'personal');
    expect(obs).toBeDefined();
    expect(obs!.discoveryItemId).toBe(candidateItem);
    expect(obs!.reason).toBe('Also work on display at Art Institute of Chicago');

    // Cross-account isolation: this account never claims the first account's
    // candidate item, and it published exactly its own one card.
    const { rows: mine } = await isoDb.query<{ discovery_item_id: string }>(
      'SELECT discovery_item_id FROM recommendations WHERE owner_account_id = $1',
      [accountId],
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.discovery_item_id).toBe(candidateItem);
  });

  it('fails closed on a normal-shaped reference whose provider id has no confirmed mapping', async () => {
    // A same-name person reference Qloo DID return — one of five identical
    // "Vincent van Gogh" results. No mapping ships for it, so it can never
    // become a root or a card.
    const unmapped = await qlooPersonReference(isoDb, UNMAPPED_VANGOGH_QLOO_ID, 'Vincent van Gogh');
    const { principal, ctx } = await accountOn(isoDb);
    const accountId = principal.accountId;
    await savedCaptureWithReference(isoDb, ctx, accountId, unmapped);
    await projectAccountInterestGraph(isoDb, {
      accountId,
      config: graphOn,
      source: 'mutation_intent',
    });

    const result = await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(0);
    expect(result.counts.photoReferencesUnmapped).toBe(1);
    expect(result.counts.admitted).toBe(0);
    expect(result.counts.recommendationsPublished).toBe(0);
    expect(result.candidates).toHaveLength(0);
    // No corpus identity ever holds the unmapped reference, and nothing was published.
    const { rows: holders } = await isoDb.query<{ id: string }>(
      'SELECT id FROM graph_nodes WHERE cultural_reference_id = $1',
      [unmapped],
    );
    expect(holders).toHaveLength(0);
    const { rows: recs } = await isoDb.query<{ id: string }>(
      'SELECT id FROM recommendations WHERE owner_account_id = $1',
      [accountId],
    );
    expect(recs).toHaveLength(0);
  });

  it('replays the corpus without writing anything, and the linkage stays converged', async () => {
    const { rows: before } = await isoDb.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM recommendations',
    );
    const replay = await admitGraphCorpus(isoDb, getCorpusManifestFile());
    expect(replay.identitiesCreated).toBe(0);
    expect(replay.externalIdsCreated).toBe(0);
    expect(replay.sourceRevisionsCreated).toBe(0);
    expect(replay.evidenceCreated).toBe(0);
    expect(replay.assertionsCreated).toBe(0);
    expect(replay.supportAttached).toBe(0);
    // The two bound references read back as already linked; the unmapped
    // reference never matched (unmatched references are not counted).
    expect(replay.referencesMatched).toBe(2);
    expect(replay.referencesLinked).toBe(0);
    expect(replay.referencesAlreadyLinked).toBe(2);
    const { rows: after } = await isoDb.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM recommendations',
    );
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
  });

  it('keeps the graph-off flags compatible: the corpus is imported, but nothing expands or publishes', async () => {
    const rodinRef = (await nodeByKey(isoDb, RODIN_KEY)).cultural_reference_id!;
    const seuratRef = (await nodeByKey(isoDb, SEURAT_KEY)).cultural_reference_id!;
    const { principal, ctx } = await accountOn(isoDb, projectionOnly);
    const accountId = principal.accountId;
    await savedCaptureWithReference(isoDb, ctx, accountId, rodinRef);
    await candidateItemOn(isoDb, accountId, seuratRef, SEURAT_QLOO_ID);
    await projectAccountInterestGraph(isoDb, {
      accountId,
      config: projectionOnly,
      source: 'mutation_intent',
    });

    const result = await expandAccountInterestGraph(isoDb, { accountId, config: projectionOnly });
    expect(result.expanded).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(result.runId).toBeNull();
    const { rows: runs } = await isoDb.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'",
      [accountId],
    );
    expect(Number(runs[0]!.n)).toBe(0);
    const { rows: recs } = await isoDb.query<{ id: string }>(
      'SELECT id FROM recommendations WHERE owner_account_id = $1',
      [accountId],
    );
    expect(recs).toHaveLength(0);
  });
});

// --- References created after the import resolve at read time -----------------------

describe('references created after the corpus import reach the same supported path', () => {
  let isoDb: PoolDb;
  let dropIso: () => Promise<void>;

  beforeAll(async () => {
    const created = await createIsolatedDatabase('pilotpathrt');
    isoDb = created.db;
    dropIso = created.drop;
    // The corpus lands FIRST (the production shape: references accumulate later).
    const admission = await admitGraphCorpus(isoDb, getCorpusManifestFile());
    expect(admission.referencesLinked).toBe(0);
  });
  afterAll(async () => {
    await dropIso();
  });

  it('resolves a later saved reference through the verified link at read time', async () => {
    // References appear AFTER the import, in the exact compiler shape.
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    const seuratRef = await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');

    const { principal, ctx } = await accountOn(isoDb);
    const accountId = principal.accountId;
    const savedItem = await insertItem(
      { accountId },
      {
        referenceId: rodinRef,
        kind: 'artist',
        category: 'play',
        qloo: RODIN_QLOO_ID,
        key: `qloo:${RODIN_QLOO_ID}`,
        title: 'A real artist',
      },
      isoDb,
    );
    await recordPreference(ctx, {
      action: 'save',
      target_type: 'discovery_item',
      target_id: savedItem,
    });
    const candidateItem = await candidateItemOn(isoDb, accountId, seuratRef, SEURAT_QLOO_ID);
    await projectAccountInterestGraph(isoDb, {
      accountId,
      config: graphOn,
      source: 'mutation_intent',
    });

    // No durable binding exists yet: the root resolves through the verified
    // provider-id link at read time, and the candidate materializes the same way.
    const result = await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    expect(result.counts.personalRoots).toBe(1);
    expect(result.counts.unmappedPersonalRoots).toBe(0);
    expect(result.counts.referencesLinked).toBe(1);
    expect(result.counts.admitted).toBe(1);
    expect(result.counts.candidatesResolvedByLink).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const obs = result.candidates.find((o) => o.intent === 'personal');
    expect(obs).toBeDefined();
    expect(obs!.discoveryItemId).toBe(candidateItem);
    expect(obs!.templateKey).toBe('co_documented_association');
  });

  it('serves the later authorized-photo reference through the same read-time verified link', async () => {
    // Still before any linkage pass: the photo root and the candidate resolve
    // through the verified provider-id link at read time.
    const rodinRef = await qlooPersonReference(isoDb, RODIN_QLOO_ID, 'Auguste Rodin');
    const seuratRef = await qlooPersonReference(isoDb, SEURAT_QLOO_ID, 'Georges Seurat');

    const { principal, ctx } = await accountOn(isoDb);
    const accountId = principal.accountId;
    await savedCaptureWithReference(isoDb, ctx, accountId, rodinRef);
    const candidateItem = await candidateItemOn(isoDb, accountId, seuratRef, SEURAT_QLOO_ID);
    await projectAccountInterestGraph(isoDb, {
      accountId,
      config: graphOn,
      source: 'mutation_intent',
    });

    const result = await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
    expect(result.expanded).toBe(true);
    expect(result.counts.photoRoots).toBe(1);
    expect(result.counts.referencesLinked).toBe(1);
    expect(result.counts.candidatesResolvedByLink).toBe(1);
    expect(result.counts.admitted).toBe(1);
    expect(result.counts.recommendationsPublished).toBe(1);
    const obs = result.candidates.find((o) => o.intent === 'photo');
    expect(obs).toBeDefined();
    expect(obs!.discoveryItemId).toBe(candidateItem);
    expect(obs!.reason).toBe('Also work on display at Art Institute of Chicago');
  });

  it('converges the durable bindings with the linkage pass, and the next expansions keep the same connection', async () => {
    const seuratNode = await nodeByKey(isoDb, SEURAT_KEY);

    // The durable linkage pass converges the bindings for both references.
    const pass = await linkGraphReferenceIdentities(isoDb);
    expect(pass.referencesLinked).toBe(2);
    const { rows: refs } = await isoDb.query<{ id: string }>(
      'SELECT id FROM cultural_references WHERE canonical_key IN ($1, $2)',
      [`qloo:${RODIN_QLOO_ID}`, `qloo:${SEURAT_QLOO_ID}`],
    );
    const refIds = refs.map((r) => r.id).sort();
    expect(
      [
        (await nodeByKey(isoDb, RODIN_KEY)).cultural_reference_id,
        (await nodeByKey(isoDb, SEURAT_KEY)).cultural_reference_id,
      ].sort(),
    ).toEqual(refIds);

    // ...and the next expansions keep recommending the same connections, now
    // through the durable bindings (no read-time fallback needed).
    const { rows: accounts } = await isoDb.query<{ owner_account_id: string }>(
      'SELECT DISTINCT owner_account_id FROM recommendations',
    );
    expect(accounts).toHaveLength(2);
    for (const row of accounts) {
      const again = await expandAccountInterestGraph(isoDb, {
        accountId: row.owner_account_id,
        config: graphOn,
      });
      expect(again.expanded).toBe(true);
      expect(again.counts.referencesLinked).toBe(0);
      expect(again.counts.candidatesResolvedByLink).toBe(0);
      expect(again.counts.admitted).toBe(1);
      const obs = again.candidates.find((o) => o.nodeId === seuratNode.id);
      expect(obs).toBeDefined();
      expect(obs!.reason).toBe('Also work on display at Art Institute of Chicago');
    }
  });
});

afterAll(async () => {
  await closeTestDb();
});
