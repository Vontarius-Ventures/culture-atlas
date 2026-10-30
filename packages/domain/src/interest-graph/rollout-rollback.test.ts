import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import type { ServiceContext } from '../context';
import type { Db, PoolDb } from '../db/pool';
import { liftFeatureKill, setFeatureKill } from '../flags/feature-flags';
import { requestAccountDeletion } from '../services/account-deletion';
import { getDiscoveries, rebuildFeedSnapshots } from '../services/discovery';
import { updateInterestGraphInterest } from '../services/interest-graph';
import { recordPreference } from '../services/preferences';
import { insertItem, insertReference } from '../test-support/library';
import { createIsolatedDatabase, insertAccount, testConfig, testContext } from '../testing';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import { expandAccountInterestGraph } from './expansion';
import { projectAccountInterestGraph } from './projector';
import { upsertPersonalEdge } from './store';
import { retractGraphEvidence, revalidateGraphProof } from './validity';
import type { GraphPredicate } from './schema';

/**
 * VAL-OPS-001: default-off staging and NON-DESTRUCTIVE rollback.
 *
 * A rollback (a global or account kill of the graph flags) must stop
 * discovery/expansion and relation-research dispatch AND publication —
 * including work already in flight when the kill lands — while everything
 * safety-critical keeps working:
 *
 *  - graph data is never dropped: the published rows stay in place so the
 *    feature can be re-enabled without losing anything;
 *  - saves/taste and the authorized controls (suppression, pause) survive;
 *  - projection/reconciliation continues while only discovery is killed;
 *  - source invalidation (retraction) still withdraws proofs, and a known
 *    revocation is never resurrected by lifting the kill;
 *  - account deletion is still accepted and fenced.
 */

let isoDb: PoolDb;
let dropIso: () => Promise<void>;

beforeAll(async () => {
  const created = await createIsolatedDatabase('rollkill');
  isoDb = created.db;
  dropIso = created.drop;
});
afterAll(async () => {
  await dropIso();
});

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });
const PAGE = 24;

// --- Fixture helpers (isolated-database shapes of the expansion fixtures) ------------

// Every fixture node gets a unique suffix: one isolated database serves the
// whole file, so a shared canonical key would collide across tests.
let fixtureSeq = 0;
function unique(name: string) {
  fixtureSeq += 1;
  return `${name}-${fixtureSeq}`;
}

async function corpusNode(over: { kind?: 'work' | 'creator'; name?: string } = {}) {
  const kind = over.kind ?? 'work';
  const name = unique(`${over.name ?? kind}-rollkill`);
  const referenceId = await insertReference({ name }, isoDb);
  const node = await upsertGraphIdentity(isoDb, {
    canonicalKey: `atlas:rollkill:${kind}:${name}`,
    canonicalName: name,
    nodeKind: kind,
    domain: 'art',
    senseKey: 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId, name };
}

async function plainNode(over: { kind?: 'creator'; name?: string } = {}) {
  const kind = over.kind ?? 'creator';
  const name = unique(`${over.name ?? kind}-rollkill-mid`);
  const node = await upsertGraphIdentity(isoDb, {
    canonicalKey: `atlas:rollkill:mid:${name}`,
    canonicalName: name,
    nodeKind: kind,
    domain: 'art',
    senseKey: 'painting',
  });
  return node;
}

async function evidenceFixture() {
  const family = `artic:rollkill-${Math.random().toString(36).slice(2, 10)}`;
  const recorded = await recordSourceRevision(isoDb, {
    provider: 'artic_open_access',
    url: `https://www.artic.edu/artworks/rollkill-${Math.random().toString(36).slice(2, 10)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none' },
    documentHash: family,
    rightsExpiresAt: null,
  });
  const inserted = await insertEvidence(isoDb, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${family}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: null,
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, familyKey: family };
}

async function justifiedEdge(input: { subject: string; predicate: GraphPredicate; object: string }) {
  const support = await evidenceFixture();
  const upserted = await upsertGraphAssertion(isoDb, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: null,
    status: 'validated',
  });
  await attachAssertionSupport(isoDb, {
    assertionId: upserted.row.id,
    evidenceId: support.evidenceId,
    derivation: 'primary',
    sourceFamilyKey: support.familyKey,
  });
  const { rows } = await isoDb.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision, evidence: [support] };
}

async function accountOn(config = graphOn) {
  const principal = await insertAccount(isoDb);
  return { principal, ctx: testContext(principal, { db: isoDb, config }) };
}

/** A saved + projected explicit personal root (an owned item on a corpus work). */
async function savedRoot(ctx: ServiceContext, accountId: string) {
  const work = await corpusNode({ kind: 'work', name: 'rootwork' });
  const itemId = await insertItem({ accountId }, { referenceId: work.referenceId, kind: 'film', category: 'watch' }, isoDb);
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemId });
  return { node: work.node, referenceId: work.referenceId, itemId };
}

/** The full same-creator pass fixture: root → creator midpoint → candidate work. */
async function passFixture(accountId: string, ctx: ServiceContext) {
  const root = await savedRoot(ctx, accountId);
  const creator = await plainNode({ kind: 'creator', name: 'creator' });
  const candidate = await corpusNode({ kind: 'work', name: 'candidate' });
  await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.id });
  const candidatePath = await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.id });
  const candidateItemId = await insertItem(
    { accountId },
    { referenceId: candidate.referenceId, kind: 'film', category: 'watch' },
    isoDb,
  );
  await projectAccountInterestGraph(isoDb, { accountId, config: graphOn, source: 'mutation_intent' });
  return { root, creator, candidate, candidateItemId, candidatePath };
}

/** Runs the real pass and the worker's post-publication feed rebuild. */
async function publishOnce(accountId: string) {
  const published = await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });
  expect(published.expanded).toBe(true);
  await rebuildFeedSnapshots(isoDb, { kind: 'account', accountId }, { config: graphOn });
  return published;
}

async function project(accountId: string) {
  await projectAccountInterestGraph(isoDb, { accountId, config: graphOn, source: 'mutation_intent' });
}

async function countRows(sql: string, params: readonly unknown[]): Promise<number> {
  const { rows } = await isoDb.query<{ n: number }>(sql, params);
  return Number(rows[0]!.n);
}

/**
 * A Db view that parks ONE in-transaction statement (the pass's assertion pin
 * locks) until a caller-controlled gate resolves, so the test can commit a
 * kill MID-PASS while the engine genuinely holds its open publication
 * transaction. Pool-level statements pass straight through.
 */
function parkedPassDb(onParked: () => Promise<void>): { db: PoolDb; release: () => Promise<void> } {
  let parked = false;
  let resolvePark: (() => void) | undefined;
  const parkedGate = new Promise<void>((resolve) => {
    resolvePark = resolve;
  });
  const wrap = (handle: Db): Db => {
    const self: Db = {
      get inTransaction() {
        return handle.inTransaction;
      },
      query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
        if (
          handle.inTransaction &&
          !parked &&
          text.includes('graph_assertions') &&
          text.includes('FOR SHARE')
        ) {
          parked = true;
          return (async () => {
            await onParked();
            resolvePark?.();
            return handle.query<R>(text, params);
          })();
        }
        return handle.query<R>(text, params);
      },
      transaction<T>(fn: (tx: Db) => Promise<T>, options?: Parameters<Db['transaction']>[1]): Promise<T> {
        return handle.transaction<T>((tx) => fn(wrap(tx)), options);
      },
    };
    return self;
  };
  const view = wrap(isoDb);
  const db = Object.assign(view, { pool: isoDb.pool }) as unknown as PoolDb;
  return {
    db,
    release: async () => {
      await parkedGate;
    },
  };
}

// --- Mid-pass rollback stops publication ---------------------------------------------

describe('graph rollback stops in-flight publication (VAL-OPS-001)', () => {
  it('a discovery kill landing mid-pass rejects the whole pass: nothing publishes, the run reports disabled', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    await passFixture(accountId, ctx);

    // A GLOBAL rollback kill lands while the pass holds its open publication
    // transaction (parked at its assertion pin locks, after the entry gate
    // check, before the publication fence).
    const parked = parkedPassDb(async () => {
      await setFeatureKill(isoDb, {
        flag: 'interest_graph_discovery_enabled',
        accountId: null,
        reason: 'rollback drill',
        actor: 'operator',
      });
    });
    try {
      const result = await expandAccountInterestGraph(parked.db, { accountId, config: graphOn });
      await parked.release();

      expect(result.expanded).toBe(false);
      expect(result.reason).toBe('disabled');
      // The whole pass rolled back: no expansion run, no cards, no proofs,
      // no frontier. (passFixture's earlier projection run is untouched —
      // a discovery rollback never rolls projection back.)
      expect(await countRows("SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'", [accountId])).toBe(0);
      expect(await countRows('SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1', [accountId])).toBe(0);
      expect(await countRows('SELECT count(*)::int AS n FROM recommendation_graph_proofs WHERE owner_account_id = $1', [accountId])).toBe(0);
      expect(await countRows('SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1', [accountId])).toBe(0);
    } finally {
      // Cleanup: lift the global kill even when the expectation fails, so
      // later cases on this isolated DB stay unaffected.
      await parked.release();
      await liftFeatureKill(isoDb, { flag: 'interest_graph_discovery_enabled', accountId: null });
    }
  });
});

// --- Post-publication rollback filters reads without dropping data ------------------

describe('rollback after publication filters graph-only reads without dropping data (VAL-OPS-001)', () => {
  it('a killed account stops serving its graph card, keeps every graph row, and re-serving resumes when the kill lifts', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const { candidateItemId } = await passFixture(accountId, ctx);

    // Publish one graph card through the real engine.
    await publishOnce(accountId);

    const feedWithGraph = await getDiscoveries(ctx, { refresh: false, limit: PAGE });
    expect(feedWithGraph.items.map((i) => i.id)).toContain(candidateItemId);

    // The taste revision and the save survive the rollback untouched.
    const revisionBefore = await isoDb
      .query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]);
    const savesBefore = await countRows(
      'SELECT count(*)::int AS n FROM saved_items WHERE owner_account_id = $1',
      [accountId],
    );

    // Rollback: an account-scoped discovery kill.
    await setFeatureKill(isoDb, {
      flag: 'interest_graph_discovery_enabled',
      accountId,
      reason: 'rollback drill',
      actor: 'operator',
    });

    const feedUnderRollback = await getDiscoveries(ctx, { refresh: false, limit: PAGE });
    expect(feedUnderRollback.items.map((i) => i.id)).not.toContain(candidateItemId);

    // Graph data is NOT dropped: run, card, proof and frontier all survive.
    expect(await countRows("SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND published AND run_kind = 'expansion'", [accountId])).toBe(1);
    expect(await countRows('SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1', [accountId])).toBe(1);
    expect(await countRows('SELECT count(*)::int AS n FROM recommendation_graph_proofs WHERE owner_account_id = $1', [accountId])).toBe(1);
    expect(await countRows("SELECT count(*)::int AS n FROM graph_frontier WHERE owner_account_id = $1 AND state = 'published'", [accountId])).toBe(1);

    // Saves/taste untouched.
    const revisionAfter = await isoDb
      .query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]);
    expect(revisionAfter.rows[0]!.revision).toBe(revisionBefore.rows[0]!.revision);
    expect(await countRows('SELECT count(*)::int AS n FROM saved_items WHERE owner_account_id = $1', [accountId])).toBe(savesBefore);

    // Lifting the kill restores serving from the SAME retained rows — the
    // rollback was a filter, never a deletion.
    await liftFeatureKill(isoDb, { flag: 'interest_graph_discovery_enabled', accountId });
    const feedAfterLift = await getDiscoveries(ctx, { refresh: false, limit: PAGE });
    expect(feedAfterLift.items.map((i) => i.id)).toContain(candidateItemId);
  });
});

// --- Rollback cannot disable safety work ---------------------------------------------

describe('rollback preserves projection, suppression, invalidation and deletion (VAL-OPS-001)', () => {
  it('while discovery is killed, projection continues, suppression persists and retraction still withdraws proofs', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    const { candidateItemId, candidate } = await passFixture(accountId, ctx);
    await publishOnce(accountId);

    // Rollback (account kill) — projection stays enabled.
    await setFeatureKill(isoDb, {
      flag: 'interest_graph_discovery_enabled',
      accountId,
      reason: 'rollback drill',
      actor: 'operator',
    });

    // (a) Projection continues: a new explicit save queues its intent and the
    // projector completes it while discovery is killed.
    const freshWork = await corpusNode({ kind: 'work', name: 'postrollback' });
    const freshItem = await insertItem(
      { accountId },
      { referenceId: freshWork.referenceId, kind: 'film', category: 'watch' },
      isoDb,
    );
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: freshItem });
    const pending = await countRows(
      `SELECT count(*)::int AS n FROM graph_outbox WHERE owner_account_id = $1 AND dispatch_state = 'pending'`,
      [accountId],
    );
    expect(pending).toBeGreaterThan(0);
    const stateBefore = await isoDb.query<{ projection_revision: number }>(
      'SELECT projection_revision FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    await project(accountId);
    const stateAfter = await isoDb.query<{ projection_revision: number }>(
      'SELECT projection_revision FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    expect(stateAfter.rows[0]!.projection_revision).toBeGreaterThan(stateBefore.rows[0]!.projection_revision);

    // (b) Suppression persists through the rollback: a tentative edge control
    // still writes its durable marker.
    const tentative = await upsertPersonalEdge(isoDb, {
      ownerAccountId: accountId,
      target: { kind: 'node', nodeId: candidate.node.id },
      origin: 'derived',
      policyVersion: 'graph-policy-1',
    });
    const suppressed = await updateInterestGraphInterest(ctx, tentative.id, {
      expected_revision: 0,
      state: 'suppressed',
    });
    expect(suppressed.state).toBe('suppressed');
    const marker = await countRows(
      `SELECT count(*)::int AS n FROM personal_edge_suppressions
        WHERE owner_account_id = $1 AND node_id = $2 AND restored_at IS NULL`,
      [accountId, candidate.node.id],
    );
    expect(marker).toBe(1);

    // (c) Invalidation is not disabled by the rollback: retracting the sole
    // evidence of the published card withdraws its proof durably.
    const { rows: proof } = await isoDb.query<{ id: string; evidence_ids: string[] }>(
      'SELECT id, evidence_ids FROM recommendation_graph_proofs WHERE owner_account_id = $1',
      [accountId],
    );
    expect(proof[0]).toBeDefined();
    await retractGraphEvidence(isoDb, { evidenceId: proof[0]!.evidence_ids[0]!, reason: 'rollback retraction drill' });
    const verdict = await revalidateGraphProof(isoDb, { proofId: proof[0]!.id, at: new Date() });
    expect(verdict.valid).toBe(false);

    // (d) A known revocation is never resurrected: lifting the kill does not
    // bring the retracted card back.
    await liftFeatureKill(isoDb, { flag: 'interest_graph_discovery_enabled', accountId });
    const feedAfterLift = await getDiscoveries(ctx, { refresh: false, limit: PAGE });
    expect(feedAfterLift.items.map((i) => i.id)).not.toContain(candidateItemId);
  });

  it('account deletion is still accepted and fenced while every graph flag is killed', async () => {
    const { principal, ctx } = await accountOn();
    const accountId = principal.accountId;
    await passFixture(accountId, ctx);
    await expandAccountInterestGraph(isoDb, { accountId, config: graphOn });

    // Rollback of every graph flag at once (global kills).
    const allFlags = [
      'interest_graph_projection_enabled',
      'interest_graph_discovery_enabled',
      'interest_graph_research_enabled',
      'interest_graph_framework_shadow_enabled',
    ];
    for (const flag of allFlags) {
      await setFeatureKill(isoDb, { flag, accountId: null, reason: 'rollback drill', actor: 'operator' });
    }

    try {
      const accepted = await requestAccountDeletion(ctx, {
        confirm: true,
        status_token: 'example-rollkill-deletion-token-not-a-real-secret-0000000000',
      });
      expect(accepted.status.state).toBe('pending');
      const tombstone = await isoDb.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM accounts WHERE id = $1',
        [accountId],
      );
      expect(tombstone.rows[0]!.deleted_at).not.toBeNull();
      const purgeJobs = await countRows(
        `SELECT count(*)::int AS n FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1`,
        [accountId],
      );
      expect(purgeJobs).toBe(1);
    } finally {
      // Lift the global kills so the isolated DB returns to its default state.
      for (const flag of allFlags) {
        await liftFeatureKill(isoDb, { flag, accountId: null });
      }
    }
  });
});
