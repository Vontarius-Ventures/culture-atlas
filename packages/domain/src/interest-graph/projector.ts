import type pg from 'pg';
import { AppError, isAppError } from '../errors';
import type { Db, Queryable } from '../db/pool';
import { hiddenKeys } from '../library/access';
import { WEIGHTS } from '../library/taste-fold';
import { loadFoldSaves } from '../services/taste';
import { projectionEnabledForAccount, type ProjectionGateConfig } from './intent';
import { loadExplicitSupport, removeSupersedesSaveSql, type ExplicitSupportSnapshot } from './explicit-support';
import { lockAccountPublicationAuthority, noteExpansionDue } from './refresh';
import { INTEREST_GRAPH_POLICY_VERSION, PROJECTION_SUPPORT_VERSION } from './schema';
import { addEdgeSupport, createGraphRun, setGraphRunState, upsertPersonalEdge } from './store';

/**
 * The account projector (PR 8 package B). One call rebuilds one account's
 * private graph projection deterministically from CURRENT authoritative
 * explicit state:
 *
 *  - every pass runs in one REPEATABLE READ transaction under the account's
 *    publication-authority lock and then its personal_graph_state row lock,
 *    so concurrent projectors serialize, the pass is ordered with the
 *    publishers that fence on account authority (DISC-SCR-021), and a pass
 *    always builds one consistent snapshot (no mixed ready state);
 *  - the build is a full deterministic rebuild: support rows are re-derived
 *    from current authority, so duplicate delivery, lease retries, worker
 *    restarts and out-of-order events converge to the same result and can
 *    never resurrect withdrawn support;
 *  - revision fences: the applied taste revision is the snapshot's current
 *    revision, target >= applied always holds, and only intents the pass
 *    actually saw are marked done; a committed mutation that lands during a
 *    pass is caught by the post-commit outbox tail and forces another pass
 *    before the account may be called ready;
 *  - parity: the explicit roots the projection builds must equal the current
 *    taste fold's save set (minus exposure-only rows); divergence fails the
 *    pass honestly instead of publishing a wrong projection;
 *  - shadow: the projector writes only private graph state. It never touches
 *    recommendations, provider queries or the taste profile.
 */

/** What triggered the projection; recorded in run and support lineage. */
export type ProjectionSource =
  | 'mutation_intent'
  | 'backfill_current_state'
  | 'reconciliation_sweep'
  | 'support_version_catch_up';

/** Reconciliation passes one call may need (bounded; the tail drives more). */
const MAX_PASSES = 4;
/** Bounded retries for repeatable-read serialization under projector races. */
const MAX_SERIALIZATION_RETRIES = 3;

export interface ProjectAccountInterestGraphInput {
  accountId: string;
  config: ProjectionGateConfig;
  source: ProjectionSource;
  /** The queue job driving this projection, recorded on the first pass's run. */
  jobId?: string;
  maxPasses?: number;
}

export interface ProjectionResult {
  /** False (with `reason`) when the flag is off or the account is gone. */
  projected: boolean;
  reason?: 'disabled' | 'account_missing';
  /** The current taste revision the projection applied. */
  appliedTasteRevision: number;
  /** The account's monotonic projection revision after this projection. */
  projectionRevision: number;
  graphRunId: string | null;
  /** Reconciliation passes this call committed (>= 1 when projected). */
  passes: number;
  /** True when the account's committed outbox tail is satisfied. */
  tailClean: boolean;
  /** Explicit roots written. */
  explicitRoots: number;
  /** Derived capture-reference support rows written. */
  derivedSupport: number;
}

type PassKind = 'projected' | 'disabled' | 'account_missing';

interface PassOutcome {
  kind: PassKind;
  appliedTasteRevision: number;
  projectionRevision: number;
  graphRunId: string | null;
  explicitRoots: number;
  derivedSupport: number;
}

/**
 * Rebuild one account's projection from current authority, then keep checking
 * the committed outbox tail until it is clean (or bounds are hit, leaving the
 * account honestly queued). Never publishes while the flag is off.
 */
export async function projectAccountInterestGraph(db: Db, input: ProjectAccountInterestGraphInput): Promise<ProjectionResult> {
  const maxPasses = Math.max(1, input.maxPasses ?? MAX_PASSES);
  try {
    let last: PassOutcome | null = null;
    for (let pass = 1; pass <= maxPasses; pass++) {
      last = await runPassWithRetry(db, input, pass);
      if (last.kind !== 'projected') {
        return { ...resultShape(last), projected: false, passes: pass, tailClean: false };
      }
      const remaining = await countUnsatisfiedGraphOutboxEvents(db, input.accountId);
      if (remaining === 0) {
        return { ...resultShape(last), projected: true, passes: pass, tailClean: true };
      }
      // A mutation committed during (or right after) this pass: reconcile.
    }
    // The account kept mutating through every pass. Whatever committed is
    // applied; the remaining intents keep it queued so the dispatcher or
    // sweeper converges it (at-least-once, never lost).
    await db.query(
      `UPDATE personal_graph_state SET state = 'queued', updated_at = now()
        WHERE owner_account_id = $1 AND state = 'ready'`,
      [input.accountId],
    );
    return { ...resultShape(last!), projected: true, passes: maxPasses, tailClean: false };
  } catch (err) {
    await markProjectionFailed(db, input.accountId, err).catch(() => undefined);
    throw err;
  }
}

function resultShape(outcome: PassOutcome): Omit<ProjectionResult, 'projected' | 'passes' | 'tailClean'> {
  return {
    reason: outcome.kind === 'projected' ? undefined : (outcome.kind as 'disabled' | 'account_missing'),
    appliedTasteRevision: outcome.appliedTasteRevision,
    projectionRevision: outcome.projectionRevision,
    graphRunId: outcome.graphRunId,
    explicitRoots: outcome.explicitRoots,
    derivedSupport: outcome.derivedSupport,
  };
}

async function runPassWithRetry(db: Db, input: ProjectAccountInterestGraphInput, pass: number): Promise<PassOutcome> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runPass(db, input, pass);
    } catch (err) {
      // Concurrent projector commits under repeatable read: retry the pass.
      if ((err as { code?: string }).code === '40001' && attempt < MAX_SERIALIZATION_RETRIES) continue;
      // A foreign-key violation means account deletion ONLY when the violated
      // constraint actually references the accounts table. Any other 23503
      // (an unrelated composite-owner failure) fails the pass honestly: the
      // projection is marked failed, the intents stay retained for retry and
      // the original cause reaches the caller; it is never masked as a
      // missing account.
      if ((err as { code?: string }).code === '23503' && (await fkViolationReferencesAccounts(db, err))) {
        return accountMissing();
      }
      throw err;
    }
  }
}

/**
 * True only when the 23503 error's violated foreign key references the
 * accounts table — the signature of a genuinely deleted account (deletion
 * cascades the projection state row, so the pass's state upsert is the first
 * statement to fail). Unknown or unmappable FK violations resolve to false:
 * the honest direction is a failed projection, never a false deletion.
 */
async function fkViolationReferencesAccounts(db: Queryable, err: unknown): Promise<boolean> {
  const e = err as { constraint?: unknown; table?: unknown; schema?: unknown };
  const constraint = typeof e.constraint === 'string' ? e.constraint : null;
  const table = typeof e.table === 'string' ? e.table : null;
  const schema = typeof e.schema === 'string' && e.schema ? e.schema : 'public';
  if (!constraint || !table) return false;
  try {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*) AS n
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conname = $1
          AND c.conrelid = to_regclass($2 || '.' || $3)
          AND c.confrelid = to_regclass($2 || '.accounts')`,
      [constraint, schema, table],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

async function runPass(db: Db, input: ProjectAccountInterestGraphInput, pass: number): Promise<PassOutcome> {
  const { accountId } = input;
  return db.transaction(
    async (rawTx) => {
      // One client underlies the whole repeatable-read pass, and shared
      // readers (loadExplicitSupport) fire concurrent queries by design on
      // pools. Serialize every query onto that client: a failed query in a
      // concurrent batch would strand the client's queue mid-pass.
      const tail: { p: Promise<unknown> } = { p: Promise.resolve() };
      const tx: Queryable = {
        query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: readonly unknown[]) {
          const p = tail.p.then(() => rawTx.query<R>(text, params));
          tail.p = p.then(
            () => undefined,
            () => undefined,
          );
          return p;
        },
      };
      // The per-account publication-authority lock (the accounts row), taken
      // FIRST and held through this pass's commit: this pass's
      // projection_revision bump is exactly what makes relation research's
      // storage-fence version comparison stale, so the pass is ordered with
      // that publisher under the same account-row lock pause uses
      // (DISC-SCR-021). This also closes the ABSENT-state-row case: the
      // FIRST projection is the writer that creates the row, and a fence
      // locking a missing row would lock nothing — but it holds the account
      // row through its commit, and this pass cannot even start (let alone
      // insert the row) until that publication commits, while a pass already
      // holding the row forces the fence to queue and see its newer version.
      // The pass never locks in the other direction (account row first, then
      // the state row), so it cannot deadlock against a publisher.
      const present = await lockAccountPublicationAuthority(tx, accountId);
      if (!present) return accountMissing();
      // The per-account projector fence: create the state row if absent, then
      // hold its lock for the whole build. Mutations never take this lock;
      // they commit independently and are picked up by the tail check.
      await tx.query('INSERT INTO personal_graph_state (owner_account_id) VALUES ($1) ON CONFLICT DO NOTHING', [accountId]);
      const state = await lockPersonalGraphState(tx, accountId);

      // The flag is re-checked inside the locked pass: a kill that landed
      // between dispatch and run must halt publication. Intents stay where
      // they are so a later dispatch or backfill converges the account.
      if (!(await projectionEnabledForAccount(tx, { accountId, config: input.config }))) {
        return {
          kind: 'disabled',
          appliedTasteRevision: state.applied_taste_revision,
          projectionRevision: state.projection_revision,
          graphRunId: null,
          explicitRoots: 0,
          derivedSupport: 0,
        };
      }

      // Unsatisfied intents visible to THIS snapshot. Intents committed after
      // it are invisible by design: they drive the post-commit tail check.
      const events = await unsatisfiedGraphOutboxEventIds(tx, accountId);

      // Authoritative current state, one consistent snapshot. The account's
      // own discovery items root on their item edges; saves of ownerless
      // shared rows root on the account's own save (see the rebuild below).
      // The parity guard reads the same save set both sides cover.
      const owned = await ownedItemIds(tx, accountId);
      const snapshot = await loadExplicitSupport(tx, accountId);
      await assertFreshFoldParity(tx, accountId, snapshot);

      const built = await rebuildAccountProjection(tx, {
        accountId,
        snapshot,
        source: input.source,
        owned,
      });

      const run = await createGraphRun(tx, {
        ownerAccountId: accountId,
        runKind: 'projection',
        jobId: pass === 1 ? input.jobId : undefined,
        inputTasteRevision: snapshot.tasteRevision,
        inputProjectionRevision: state.projection_revision,
        inputGeneration: state.deletion_generation,
        policyVersion: INTEREST_GRAPH_POLICY_VERSION,
        budget: {
          source: input.source,
          explicit_roots: built.explicitRoots,
          derived_support: built.derivedSupport,
          events_satisfied: events.length,
        },
      });
      await setGraphRunState(tx, { runId: run.id, ownerAccountId: accountId, state: 'complete', published: true });

      // Revision fences: target catches up to the snapshot's current revision
      // and applied records exactly what this pass built. The table's CHECK
      // (applied <= target) plus the row lock keep this monotonic. The pass
      // also stamps the versioned completeness marker: a committed projection
      // now certifies it was built by the CURRENT projector semantics, which
      // is what due checks (backfill, dispatch catch-up, reads) trust — an
      // equal-revision legacy projection stays durably due until a current
      // semantics pass replaces it.
      await tx.query(
        `UPDATE personal_graph_state
            SET target_taste_revision = GREATEST(target_taste_revision, $2),
                applied_taste_revision = $2,
                projection_revision = projection_revision + 1,
                state = 'ready',
                support_version = $4,
                last_projected_at = now(),
                last_error_code = NULL,
                last_graph_run_id = $3,
                updated_at = now()
          WHERE owner_account_id = $1`,
        [accountId, snapshot.tasteRevision, run.id, PROJECTION_SUPPORT_VERSION],
      );

      // Committed fresh support is durably due for one bounded expansion
      // refresh (VAL-DISC-003): the marker survives dispatcher outages and
      // restarts, and the closed-app sweeper — never a feed read — hands it
      // to the queue. Pause never blocks projection; it only stops the
      // downstream dispatch/publication, and the marker stays in place for a
      // resumed sweep that reads CURRENT authority.
      await noteExpansionDue(tx, accountId);

      // Only the intents this pass saw are satisfied; the effects of every one
      // of them are part of the current-state rebuild above.
      if (events.length > 0) {
        await tx.query(
          `UPDATE graph_outbox SET dispatch_state = 'done', processed_at = now()
            WHERE id = ANY($1::uuid[]) AND dispatch_state IN ('pending','dispatched')`,
          [events],
        );
      }

      return {
        kind: 'projected',
        appliedTasteRevision: snapshot.tasteRevision,
        projectionRevision: state.projection_revision + 1,
        graphRunId: run.id,
        ...built,
      };
    },
    { isolation: 'repeatable read' },
  );
}

interface PersonalGraphStateLock {
  applied_taste_revision: number;
  projection_revision: number;
  deletion_generation: number;
}

async function lockPersonalGraphState(tx: Queryable, accountId: string): Promise<PersonalGraphStateLock> {
  const { rows } = await tx.query<PersonalGraphStateLock>(
    `SELECT applied_taste_revision, projection_revision, deletion_generation
       FROM personal_graph_state WHERE owner_account_id = $1 FOR UPDATE`,
    [accountId],
  );
  if (rows.length === 0) throw new AppError('internal', { message: 'Projection state vanished mid-pass.', retryable: true });
  return rows[0]!;
}

function accountMissing(): PassOutcome {
  return {
    kind: 'account_missing',
    appliedTasteRevision: 0,
    projectionRevision: 0,
    graphRunId: null,
    explicitRoots: 0,
    derivedSupport: 0,
  };
}

async function markProjectionFailed(db: Queryable, accountId: string, err: unknown): Promise<void> {
  // AppError codes stay; raw PostgreSQL failures record their SQLSTATE so the
  // honest cause survives in last_error_code.
  const pgCode = (err as { code?: unknown }).code;
  const code = (
    isAppError(err) ? err.code : typeof pgCode === 'string' && /^[0-9A-Z]{5}$/.test(pgCode) ? `pg_${pgCode}` : 'internal'
  ).slice(0, 100);
  await db.query(
    `INSERT INTO personal_graph_state (owner_account_id, state, last_error_code)
     VALUES ($1, 'failed', $2)
     ON CONFLICT (owner_account_id) DO UPDATE
       SET state = 'failed', last_error_code = $2, updated_at = now()`,
    [accountId, code],
  );
}

// --- Shared outbox helpers ------------------------------------------------------------

/** Ids of the account's unsatisfied intents in the caller's current snapshot. */
export async function unsatisfiedGraphOutboxEventIds(db: Queryable, accountId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM graph_outbox
      WHERE owner_account_id = $1 AND dispatch_state IN ('pending','dispatched')
      ORDER BY target_taste_revision, created_at, id`,
    [accountId],
  );
  return rows.map((r) => r.id);
}

/** How many of the account's intents are still unsatisfied right now. */
export async function countUnsatisfiedGraphOutboxEvents(db: Queryable, accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM graph_outbox
      WHERE owner_account_id = $1 AND dispatch_state IN ('pending','dispatched')`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

// --- Parity ----------------------------------------------------------------------------

/**
 * Discovery items the account actually owns. Items outside this set (ownerless
 * shared sample rows) are real confirmed taste whose private graph target is
 * the account's own save, never the shared row itself.
 */
async function ownedItemIds(tx: Queryable, accountId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ id: string }>('SELECT id FROM discovery_items WHERE owner_account_id = $1', [accountId]);
  return new Set(rows.map((r) => r.id));
}

/**
 * The projection's explicit roots must equal the current taste fold's save
 * set minus exposure-only rows (both exclude hidden canonical keys). The two
 * are computed by different readers; this guard fails the pass honestly if
 * they ever diverge instead of publishing a wrong projection. Both sides
 * cover every explicit save: owned discovery items AND saves of ownerless
 * shared rows, which project as private saved-item roots.
 */
async function assertFreshFoldParity(
  tx: Queryable,
  accountId: string,
  snapshot: ExplicitSupportSnapshot,
): Promise<void> {
  // Sequential on purpose: inside the RR pass both readers share one client,
  // and a failed query in a concurrent batch can strand the client's queue.
  const saves = await loadFoldSaves(tx, { kind: 'account', accountId });
  const hidden = await hiddenKeys(tx, { kind: 'account', accountId });
  const exposureOnly = new Set(snapshot.exposureOnlyItemIds);
  const expected = new Set(
    saves.filter((s) => !hidden.has(s.canonical_key) && !exposureOnly.has(s.item_id)).map((s) => s.item_id),
  );
  const projected = new Set(snapshot.saves.filter((s) => !hidden.has(s.canonicalKey)).map((s) => s.itemId));
  if (expected.size !== projected.size || [...expected].some((id) => !projected.has(id))) {
    throw new AppError('internal', {
      message: 'Interest-graph projection diverged from the current taste fold.',
      retryable: true,
    });
  }
}

// --- Deterministic rebuild ---------------------------------------------------------------

interface BuiltProjection {
  explicitRoots: number;
  derivedSupport: number;
}

/**
 * Full deterministic rebuild of one account's edges and support from the
 * snapshot. Support rows are wiped and re-derived, so replays produce exactly
 * the same content and withdrawn authority simply disappears. Edge identity
 * stays stable per target (upsert), and suppression markers live in their own
 * table so they survive rebuilds.
 *
 * Explicit roots come in two target forms. Saves of the account's OWN
 * discovery items root on the item (the composite owner FK holds). Saves of
 * rows the account does not own — ownerless shared sample catalog rows — root
 * on the account's own saved_items row: private, account-owned support with no
 * forged item owner, no weakened foreign key and no invented shared identity.
 */
async function rebuildAccountProjection(
  tx: Queryable,
  input: { accountId: string; snapshot: ExplicitSupportSnapshot; source: ProjectionSource; owned: Set<string> },
): Promise<BuiltProjection> {
  const { accountId, snapshot, source, owned } = input;
  const hidden = new Set(snapshot.exclusions);
  const roots = snapshot.saves.filter((s) => !hidden.has(s.canonicalKey));

  await tx.query('DELETE FROM personal_interest_support WHERE owner_account_id = $1', [accountId]);

  // Real event provenance where it survives (informational lineage; never invented).
  const saveEvents = await latestSaveEvents(tx, accountId, roots.map((r) => r.canonicalKey));
  // Shared identity for referenced works: only pre-existing reviewed identities
  // attach (graph_nodes linked to the cultural reference). Identity creation
  // and merging arrive with the reviewed corpus feature, not the projector.
  const nodeByReference = await nodesForReferences(tx, snapshot.captures.flatMap((c) => c.references.map((r) => r.referenceId)));

  const edgeByItemId = new Map<string, string>();
  const edgeBySavedItemId = new Map<string, string>();
  for (const root of roots) {
    // Owned items keep the item edge; shared/ownerless rows target the
    // account's own save, the private account-owned root.
    const edge = owned.has(root.itemId)
      ? await upsertPersonalEdge(tx, {
          ownerAccountId: accountId,
          target: { kind: 'item', discoveryItemId: root.itemId },
          origin: 'explicit',
          policyVersion: INTEREST_GRAPH_POLICY_VERSION,
        })
      : await upsertPersonalEdge(tx, {
          ownerAccountId: accountId,
          target: { kind: 'saved_item', savedItemId: root.savedItemId },
          origin: 'explicit',
          policyVersion: INTEREST_GRAPH_POLICY_VERSION,
        });
    edgeByItemId.set(root.itemId, edge.id);
    edgeBySavedItemId.set(root.savedItemId, edge.id);
    await addEdgeSupport(tx, {
      ownerAccountId: accountId,
      edgeId: edge.id,
      originKind: 'saved_item',
      savedItemId: root.savedItemId,
      originatingEventId: saveEvents.get(root.canonicalKey),
      dependencyVersions: { origin: source },
      weight: WEIGHTS.item,
    });
  }

  // Pick groups: one support row per still-rooted member. A grouped choice
  // counts once per group (pick id), never as extra item weight. Members on
  // shared rows attach to that save's private edge.
  for (const group of snapshot.pickGroups) {
    for (const member of group.members) {
      const edgeId = edgeByItemId.get(member.itemId) ?? edgeBySavedItemId.get(member.savedItemId);
      if (!edgeId) continue; // hidden or withdrawn members stay excluded
      await addEdgeSupport(tx, {
        ownerAccountId: accountId,
        edgeId,
        originKind: 'pick_group',
        pickId: group.pickId,
        dependencyVersions: { origin: source, pick_source: group.source },
      });
    }
  }

  // Capture dependencies: derived support at exact dependency versions. The
  // referenced work's identity gets a tentative derived edge when it exists;
  // otherwise the support rests on the saved capture's own edge until the
  // corpus provides one. Derived edges never confirm anything.
  let derivedSupport = 0;
  for (const capture of snapshot.captures) {
    const captureEdgeId = edgeByItemId.get(capture.captureItemId) ?? edgeBySavedItemId.get(capture.savedItemId);
    if (!captureEdgeId || !capture.analysisId) continue;
    for (const ref of capture.references) {
      let edgeId = captureEdgeId;
      const nodeId = nodeByReference.get(ref.referenceId);
      if (nodeId) {
        const edge = await upsertPersonalEdge(tx, {
          ownerAccountId: accountId,
          target: { kind: 'node', nodeId },
          origin: 'derived',
          policyVersion: INTEREST_GRAPH_POLICY_VERSION,
        });
        edgeId = edge.id;
      }
      await addEdgeSupport(tx, {
        ownerAccountId: accountId,
        edgeId,
        originKind: 'capture_reference',
        captureId: capture.captureId,
        analysisId: capture.analysisId,
        captureReferenceId: ref.captureReferenceId,
        dependencyVersions: {
          origin: source,
          analysis_id: capture.analysisId,
          analysis_version: capture.analysisVersion,
          relation: ref.relation,
        },
        weight: ref.relation === 'user_selected' ? WEIGHTS.selectedAnchor : WEIGHTS.captureAnchor,
      });
      derivedSupport += 1;
    }
  }

  // Withdrawal: edges without remaining support lost their authority.
  await tx.query(
    `DELETE FROM personal_interest_edges e
      WHERE e.owner_account_id = $1
        AND NOT EXISTS (SELECT 1 FROM personal_interest_support s WHERE s.edge_id = e.id)`,
    [accountId],
  );
  // Suppression markers survive rebuilds: restored markers free the edge,
  // active markers keep it suppressed.
  await tx.query(
    `UPDATE personal_interest_edges e SET state = 'tentative', updated_at = now()
       WHERE e.owner_account_id = $1 AND e.state = 'suppressed' AND e.origin = 'derived'
         AND NOT EXISTS (SELECT 1 FROM personal_edge_suppressions m
                          WHERE m.owner_account_id = e.owner_account_id
                            AND m.node_id = e.node_id AND m.restored_at IS NULL)`,
    [accountId],
  );
  await tx.query(
    `UPDATE personal_interest_edges e SET state = 'suppressed', updated_at = now()
       WHERE e.owner_account_id = $1 AND e.state = 'tentative'
         AND EXISTS (SELECT 1 FROM personal_edge_suppressions m
                      WHERE m.owner_account_id = e.owner_account_id
                        AND m.node_id = e.node_id AND m.restored_at IS NULL)`,
    [accountId],
  );
  await refreshSupportSummaries(tx, accountId);

  return { explicitRoots: roots.length, derivedSupport };
}

/** Latest un-superseded save event per canonical key: the real origin of explicitness. */
async function latestSaveEvents(tx: Queryable, accountId: string, canonicalKeys: readonly string[]): Promise<Map<string, string>> {
  if (canonicalKeys.length === 0) return new Map();
  const { rows } = await tx.query<{ key: string; id: string }>(
    `SELECT DISTINCT ON (e.payload->>'canonical_key') e.payload->>'canonical_key' AS key, e.id
       FROM preference_events e
      WHERE e.owner_account_id = $1 AND e.action = 'save' AND e.payload->>'canonical_key' = ANY($2::text[])
        AND NOT ${removeSupersedesSaveSql(`e.payload->>'canonical_key'`)}
      ORDER BY e.payload->>'canonical_key', e.created_at DESC, e.id DESC`,
    [accountId, [...canonicalKeys]],
  );
  return new Map(rows.map((r) => [r.key, r.id]));
}

/** Active reviewed identities for the given cultural references. */
async function nodesForReferences(tx: Queryable, referenceIds: readonly string[]): Promise<Map<string, string>> {
  if (referenceIds.length === 0) return new Map();
  const { rows } = await tx.query<{ cultural_reference_id: string; id: string }>(
    `SELECT cultural_reference_id, id FROM graph_nodes
      WHERE cultural_reference_id = ANY($1::uuid[]) AND status = 'active'`,
    [[...referenceIds]],
  );
  return new Map(rows.map((r) => [r.cultural_reference_id, r.id]));
}

/** Per-edge support summaries for later reads. */
async function refreshSupportSummaries(tx: Queryable, accountId: string): Promise<void> {
  await tx.query(
    `UPDATE personal_interest_edges e
        SET support_summary = sub.summary, updated_at = now()
       FROM (SELECT s.edge_id,
                    jsonb_build_object(
                      'saved_items', count(*) FILTER (WHERE s.origin_kind = 'saved_item'),
                      'pick_groups', count(DISTINCT s.pick_id) FILTER (WHERE s.pick_id IS NOT NULL),
                      'capture_references', count(*) FILTER (WHERE s.origin_kind = 'capture_reference')) AS summary
               FROM personal_interest_support s
              WHERE s.owner_account_id = $1
              GROUP BY s.edge_id) sub
      WHERE e.id = sub.edge_id AND e.owner_account_id = $1`,
    [accountId],
  );
}
