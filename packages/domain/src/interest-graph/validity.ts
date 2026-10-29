import { AppError } from '../errors';
import type { Db, Queryable } from '../db/pool';
import { PREDICATE_ENDPOINT_POLICY } from './assertion-policy';
import type { GraphPredicate, ProofDependency, RecommendationGraphProofRow } from './schema';

/**
 * Source retraction and expiry dependency invalidation (VAL-EVID-004).
 *
 * Retraction is an AUTHORITATIVE invalidation: in the same transaction that
 * marks the evidence (or its whole source revision) retracted, every valid
 * proof pinning that evidence — and every LIVE frontier candidate (active or
 * admitted) whose recorded path pins it — is invalidated immediately, before
 * any asynchronous cleanup. Proofs grounded in independent valid evidence and
 * accounts' explicit private support survive untouched: a cultural entity is
 * never globally deleted because one source became invalid.
 *
 * Overlapping withdrawals serialize: the affected proofs are locked in one
 * consistent ascending-id order before their survival is decided, so two
 * concurrent retractions of INDEPENDENT evidence cannot each observe the
 * other's withdrawal as uncommitted-valid and keep the same proof stored
 * 'valid' after both commit. A repeated (idempotent) withdrawal retracts
 * nothing new but re-runs the same dependent revalidation, so raced or
 * repair-lagged dependents are repaired instead of skipped.
 *
 * Expiry needs no stored flip: evidence rows carry expires_at and their
 * revisions carry rights_expires_at, and every justification and pinned-proof
 * revalidation compares them against the CURRENT time, so an expired right
 * blocks its dependent reasons at read time. Read paths revalidate current
 * dependency versions; the stored validity_state is the durable record of an
 * invalidation, never the only line of defense. (The `retract` outbox event
 * type of migration 240 stays reserved: private projection depends only on
 * explicit user state, not on evidence, so retraction needs no per-account
 * rebuild — only proof/frontier invalidation and honest reads.)
 */

const PROOF_COLUMNS = `id, owner_account_id, recommendation_id, graph_run_id, proof_version, assertion_ids,
  assertion_revisions, evidence_ids, evidence_revisions, intent, reason_template, reason_template_version,
  validity_state, invalidated_at, created_at, updated_at`;

// --- Current justification ------------------------------------------------------------

export type AssertionJustificationRejection =
  | 'assertion_missing'
  | 'assertion_not_validated'
  | 'assertion_invalidated'
  | 'no_valid_support'
  | 'about_requires_subject_matter';

export interface AssertionJustification {
  assertionId: string;
  justified: boolean;
  rejection: AssertionJustificationRejection | null;
  /** Distinct currently-valid supporting source families (family-deduped). */
  independentFamilies: number;
  /** Support rows of currently-valid evidence (any derivation). */
  validSupportRows: number;
  /** True when valid subject-matter support exists (ABOUT gate). */
  subjectSupport: boolean;
}

/**
 * Whether an assertion can justify a factual reason RIGHT NOW: its status is
 * `validated` (never proposed/disputed/rejected/superseded/retracted), and at
 * least one independent source family of currently-valid (unretracted,
 * unexpired, rights-unexpired) REVIEWED evidence exists. Machine-extracted,
 * unreviewed rows never count toward justification — model confidence alone
 * cannot promote or uphold a fact — and ABOUT additionally requires reviewed
 * subject-matter support.
 */
export async function currentAssertionJustification(
  db: Queryable,
  input: { assertionId: string; at?: Date },
): Promise<AssertionJustification> {
  const at = input.at ?? new Date();
  const { rows } = await db.query<{
    status: string;
    invalidated_at: Date | null;
    predicate: GraphPredicate;
  }>('SELECT status, invalidated_at, predicate FROM graph_assertions WHERE id = $1', [input.assertionId]);
  const assertion = rows[0];
  if (!assertion) {
    return {
      assertionId: input.assertionId,
      justified: false,
      rejection: 'assertion_missing',
      independentFamilies: 0,
      validSupportRows: 0,
      subjectSupport: false,
    };
  }
  if (assertion.status !== 'validated') {
    return {
      assertionId: input.assertionId,
      justified: false,
      rejection: 'assertion_not_validated',
      independentFamilies: 0,
      validSupportRows: 0,
      subjectSupport: false,
    };
  }
  if (assertion.invalidated_at) {
    return {
      assertionId: input.assertionId,
      justified: false,
      rejection: 'assertion_invalidated',
      independentFamilies: 0,
      validSupportRows: 0,
      subjectSupport: false,
    };
  }
  const support = await db.query<{ family: string; rows: number; subject_matter: number }>(
    `SELECT s.source_family_key AS family, COUNT(*)::int AS rows,
            COUNT(*) FILTER (WHERE e.evidence_kind = 'subject_matter')::int AS subject_matter
       FROM graph_assertion_support s
       JOIN graph_evidence e ON e.id = s.evidence_id
       JOIN graph_source_revisions r ON r.id = e.source_revision_id
      WHERE s.assertion_id = $1 AND s.role = 'supports'
        -- Only reviewed evidence justifies: unreviewed machine extraction is
        -- a proposal, never a fact, however "confident" the extraction was.
        AND e.reviewed_by IS NOT NULL AND e.reviewed_at IS NOT NULL
        AND e.validity_state = 'valid'
        AND r.validity_state = 'valid'
        AND (e.expires_at IS NULL OR e.expires_at > $2)
        AND (r.rights_expires_at IS NULL OR r.rights_expires_at > $2)
      GROUP BY s.source_family_key`,
    [input.assertionId, at],
  );
  const families = support.rows.length;
  const validSupportRows = support.rows.reduce((n, r) => n + r.rows, 0);
  const subjectSupport = support.rows.some((r) => r.subject_matter > 0);
  let rejection: AssertionJustificationRejection | null = null;
  if (families === 0) rejection = 'no_valid_support';
  else if (PREDICATE_ENDPOINT_POLICY[assertion.predicate].requiresSubjectMatterSupport && !subjectSupport) {
    rejection = 'about_requires_subject_matter';
  }
  return {
    assertionId: input.assertionId,
    justified: rejection === null,
    rejection,
    independentFamilies: families,
    validSupportRows,
    subjectSupport,
  };
}

// --- Pinned dependency revalidation ---------------------------------------------------

export type PinnedDependencyRejection =
  | 'assertion_missing'
  | 'assertion_revision_changed'
  | 'assertion_not_validated'
  | 'assertion_invalidated'
  | 'assertion_unjustified'
  | 'evidence_missing'
  | 'evidence_retracted'
  | 'evidence_expired'
  | 'rights_expired'
  | 'evidence_revision_changed';

export interface PinnedDependencyVerdict {
  valid: boolean;
  reason: PinnedDependencyRejection | null;
}

const UNJUSTIFIED_MAP: Partial<Record<string, PinnedDependencyRejection>> = {
  assertion_missing: 'assertion_missing',
  assertion_not_validated: 'assertion_not_validated',
  assertion_invalidated: 'assertion_invalidated',
  no_valid_support: 'assertion_unjustified',
  about_requires_subject_matter: 'assertion_unjustified',
};

/**
 * Revalidates the exact (id, revision) pairs a proof pinned, against CURRENT
 * dependency versions. Every pinned assertion must still be `validated` at
 * the pinned revision and currently justified; and the proof must retain at
 * least ONE currently-valid pinned evidence row as a live grounding witness —
 * so retracting SOLE evidence invalidates its proof, while a proof that also
 * pinned independent valid evidence survives on it. The first concrete
 * evidence failure is the reported reason. An absent id is invalid, never a
 * resurrection.
 */
export async function revalidatePinnedDependencies(
  db: Queryable,
  input: { assertions: readonly ProofDependency[]; evidence: readonly ProofDependency[]; at?: Date },
): Promise<PinnedDependencyVerdict> {
  const at = input.at ?? new Date();

  let liveEvidence = 0;
  let evidenceFailure: PinnedDependencyRejection | null = null;
  if (input.evidence.length > 0) {
    const { rows } = await db.query<{
      id: string;
      revision: number;
      validity_state: 'valid' | 'retracted';
      expires_at: Date | null;
      rights_expires_at: Date | null;
    }>(
      `SELECT e.id, r.revision, e.validity_state, e.expires_at, r.rights_expires_at
         FROM graph_evidence e
         JOIN graph_source_revisions r ON r.id = e.source_revision_id
        WHERE e.id = ANY($1::uuid[])`,
      [input.evidence.map((e) => e.id)],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const pinned of input.evidence) {
      const current = byId.get(pinned.id);
      if (!current) {
        evidenceFailure ??= 'evidence_missing';
        continue;
      }
      if (current.validity_state === 'retracted') {
        evidenceFailure ??= 'evidence_retracted';
        continue;
      }
      if (current.expires_at && current.expires_at <= at) {
        evidenceFailure ??= 'evidence_expired';
        continue;
      }
      if (current.rights_expires_at && current.rights_expires_at <= at) {
        evidenceFailure ??= 'rights_expired';
        continue;
      }
      if (current.revision !== pinned.revision) {
        evidenceFailure ??= 'evidence_revision_changed';
        continue;
      }
      liveEvidence += 1;
    }
    // Sole-evidence retraction/expiry invalidates; independent pinned support
    // keeps the proof alive (VAL-EVID-004).
    if (liveEvidence === 0) return { valid: false, reason: evidenceFailure ?? 'evidence_missing' };
  }

  for (const pinned of input.assertions) {
    const { rows } = await db.query<{ revision: number; status: string; invalidated_at: Date | null }>(
      'SELECT revision, status, invalidated_at FROM graph_assertions WHERE id = $1',
      [pinned.id],
    );
    const current = rows[0];
    if (!current) return { valid: false, reason: 'assertion_missing' };
    if (current.revision !== pinned.revision) return { valid: false, reason: 'assertion_revision_changed' };
    if (current.status !== 'validated') return { valid: false, reason: 'assertion_not_validated' };
    if (current.invalidated_at) return { valid: false, reason: 'assertion_invalidated' };
    const justification = await currentAssertionJustification(db, { assertionId: pinned.id, at });
    if (!justification.justified) {
      return { valid: false, reason: UNJUSTIFIED_MAP[justification.rejection ?? 'no_valid_support'] ?? 'assertion_unjustified' };
    }
  }
  return { valid: true, reason: null };
}

/**
 * Read-time revalidation of one stored proof against current dependency
 * versions. The stored validity_state is the durable invalidation record;
 * this computation is the honest answer to "may this reason be shown now".
 */
export async function revalidateGraphProof(
  db: Queryable,
  input: { proofId: string; at?: Date },
): Promise<PinnedDependencyVerdict> {
  const { rows } = await db.query<RecommendationGraphProofRow>(
    `SELECT ${PROOF_COLUMNS} FROM recommendation_graph_proofs WHERE id = $1`,
    [input.proofId],
  );
  const proof = rows[0];
  if (!proof) throw new AppError('not_found', { message: 'Recommendation proof not found.' });
  return revalidatePinnedDependencies(db, {
    assertions: proof.assertion_ids.map((id, i) => ({ id, revision: proof.assertion_revisions[i]! })),
    evidence: proof.evidence_ids.map((id, i) => ({ id, revision: proof.evidence_revisions[i]! })),
    at: input.at,
  });
}

// --- Retraction: the authoritative invalidation path ----------------------------------

export interface RetractionResult {
  /** True when this call performed the retraction; false when it was already retracted. */
  retracted: boolean;
  evidenceRetracted: number;
  proofsInvalidated: number;
  frontierEntriesExpired: number;
  /** Assertions whose support included the retracted evidence. */
  assertionsAffected: number;
}

async function invalidateDependentsOfEvidence(
  tx: Db,
  evidenceIds: readonly string[],
  assertionIds: readonly string[],
  at: Date,
): Promise<{ proofsInvalidated: number; frontierEntriesExpired: number }> {
  if (evidenceIds.length === 0) return { proofsInvalidated: 0, frontierEntriesExpired: 0 };
  // Lock every candidate proof BEFORE deciding survival, in one consistent
  // ascending-id order (DISC-SCR-003): two retractions of INDEPENDENT
  // evidence that both reach the same proof serialize here. Under READ
  // COMMITTED the transaction that waits re-reads the row — and every
  // dependency it revalidates — after the other commits, so the decision
  // that commits last sees every committed withdrawal and can never observe
  // the other's uncommitted withdrawal as surviving support. The shared
  // ascending order means overlapping retraction transactions cannot
  // deadlock on these rows.
  const candidateProofs = await tx.query<RecommendationGraphProofRow>(
    `SELECT ${PROOF_COLUMNS} FROM recommendation_graph_proofs
      WHERE validity_state = 'valid' AND (evidence_ids && $1::uuid[] OR assertion_ids && $2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [evidenceIds, assertionIds],
  );
  let proofsInvalidated = 0;
  for (const proof of candidateProofs.rows) {
    const verdict = await revalidatePinnedDependencies(tx, {
      assertions: proof.assertion_ids.map((id, i) => ({ id, revision: proof.assertion_revisions[i]! })),
      evidence: proof.evidence_ids.map((id, i) => ({ id, revision: proof.evidence_revisions[i]! })),
      at,
    });
    if (verdict.valid) continue;
    await tx.query(
      `UPDATE recommendation_graph_proofs SET validity_state = 'invalid', invalidated_at = $2, updated_at = now()
        WHERE id = $1 AND validity_state = 'valid'`,
      [proof.id, at],
    );
    proofsInvalidated += 1;
  }
  // Frontier candidates whose recorded approved path pinned the retracted
  // evidence (or an assertion it supported) expire immediately, inside the
  // retraction transaction — their lifetime never outlives their grounding.
  // EVERY live state is covered (DISC-SCR-002): normal expansion promotes
  // ranked observations to 'admitted' before publication, and unmaterialized
  // or diversified-out candidates stay admitted (they count as live frontier
  // capacity), so expiring only 'active' rows would leave an unsupported
  // candidate live until ordinary expiry. Terminal states keep their record.
  const frontier = await tx.query(
    `UPDATE graph_frontier SET state = 'expired', updated_at = now()
      WHERE state IN ('active','admitted')
        AND (
          (path_versions -> 'evidence_ids') ?| $1::text[]
          OR (path_versions -> 'assertion_ids') ?| $2::text[]
        )`,
    [evidenceIds, assertionIds],
  );
  return { proofsInvalidated, frontierEntriesExpired: frontier.rowCount ?? 0 };
}

/**
 * Retracts one evidence row and, in the same transaction, invalidates every
 * currently-valid proof pinning it (or pinning an assertion it supported that
 * is no longer justified) and expires every live (active or admitted)
 * frontier candidate whose recorded path pins it. Idempotent: a repeated
 * withdrawal retracts nothing new but RE-RUNS the dependent revalidation, so
 * a proof left valid by overlapping withdrawals — or any repair-lagged
 * dependent — is repaired instead of being skipped by an early return.
 */
export async function retractGraphEvidence(
  db: Db,
  input: { evidenceId: string; reason: string; at?: Date },
): Promise<RetractionResult> {
  const at = input.at ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx.query<{ id: string }>(
      `UPDATE graph_evidence SET validity_state = 'retracted', invalidated_at = $2, invalidation_reason = $3
        WHERE id = $1 AND validity_state = 'valid' RETURNING id`,
      [input.evidenceId, at, input.reason],
    );
    const affected = await tx.query<{ assertion_id: string }>(
      'SELECT assertion_id FROM graph_assertion_support WHERE evidence_id = $1',
      [input.evidenceId],
    );
    const assertionIds = affected.rows.map((r) => r.assertion_id);
    if (updated.rows.length === 0) {
      const exists = await tx.query<{ id: string }>('SELECT id FROM graph_evidence WHERE id = $1', [input.evidenceId]);
      if (exists.rows.length === 0) throw new AppError('not_found', { message: 'Evidence row not found.' });
      // Already retracted: an idempotent RETRY, never a silent no-op
      // (DISC-SCR-003's retry-skip-repair consequence). Re-run the dependent
      // revalidation over the same evidence so a proof raced valid by
      // concurrent withdrawals cannot stay stored-valid because nothing new
      // was retracted. The pass is itself idempotent: proofs grounded in
      // surviving independent evidence keep surviving, invalid dependents
      // flip at most once, and already-expired frontier rows stay expired.
      const dependents = await invalidateDependentsOfEvidence(tx, [input.evidenceId], assertionIds, at);
      return { retracted: false, evidenceRetracted: 0, proofsInvalidated: dependents.proofsInvalidated, frontierEntriesExpired: dependents.frontierEntriesExpired, assertionsAffected: assertionIds.length };
    }
    const dependents = await invalidateDependentsOfEvidence(tx, [input.evidenceId], assertionIds, at);
    return {
      retracted: true,
      evidenceRetracted: 1,
      proofsInvalidated: dependents.proofsInvalidated,
      frontierEntriesExpired: dependents.frontierEntriesExpired,
      assertionsAffected: assertionIds.length,
    };
  });
}

/**
 * Retracts a whole source revision together with every evidence row read from
 * it: a withdrawn page invalidates all of its extractions atomically, while
 * independently sourced evidence of the same assertions survives. A repeated
 * withdrawal retracts nothing new but re-runs the dependent revalidation over
 * the revision's FULL evidence set, so raced dependents are repaired rather
 * than skipped.
 */
export async function retractGraphSourceRevision(
  db: Db,
  input: { sourceRevisionId: string; reason: string; at?: Date },
): Promise<RetractionResult> {
  const at = input.at ?? new Date();
  return db.transaction(async (tx) => {
    const updated = await tx.query<{ id: string }>(
      `UPDATE graph_source_revisions SET validity_state = 'retracted', invalidated_at = $2, invalidation_reason = $3
        WHERE id = $1 AND validity_state = 'valid' RETURNING id`,
      [input.sourceRevisionId, at, input.reason],
    );
    if (updated.rows.length === 0) {
      const exists = await tx.query<{ id: string }>('SELECT id FROM graph_source_revisions WHERE id = $1', [
        input.sourceRevisionId,
      ]);
      if (exists.rows.length === 0) throw new AppError('not_found', { message: 'Source revision not found.' });
      // Already retracted: an idempotent RETRY (DISC-SCR-003's retry-skip
      // repair consequence). The repair rescan covers the revision's FULL
      // evidence set — including rows an earlier per-row withdrawal already
      // retracted — because a raced proof pinned those rows even though this
      // call retracts nothing new. Idempotent like the fresh path.
      const all = await tx.query<{ id: string }>('SELECT id FROM graph_evidence WHERE source_revision_id = $1', [
        input.sourceRevisionId,
      ]);
      const evidenceIds = all.rows.map((r) => r.id);
      const affected = await tx.query<{ assertion_id: string }>(
        'SELECT DISTINCT assertion_id FROM graph_assertion_support WHERE evidence_id = ANY($1::uuid[])',
        [evidenceIds],
      );
      const assertionIds = affected.rows.map((r) => r.assertion_id);
      const dependents = await invalidateDependentsOfEvidence(tx, evidenceIds, assertionIds, at);
      return { retracted: false, evidenceRetracted: 0, proofsInvalidated: dependents.proofsInvalidated, frontierEntriesExpired: dependents.frontierEntriesExpired, assertionsAffected: assertionIds.length };
    }
    // Lock the revision's evidence rows in ONE consistent ascending-id order
    // BEFORE the withdrawal (DISC-SCR-009 lock coordination): the expansion
    // publication fence locks the pinned evidence rows FOR SHARE in the same
    // ascending order and holds them to its commit, so an unordered multi-row
    // withdrawal here could take its locks in any order and deadlock against a
    // publication transaction that holds one pinned row and wants the next.
    // Both sides ascending keeps the wait graph acyclic; the FOR UPDATE
    // re-check also drops any row a concurrent transaction retracted while
    // this one waited.
    const toRetract = await tx.query<{ id: string }>(
      `SELECT id FROM graph_evidence
        WHERE source_revision_id = $1 AND validity_state = 'valid'
        ORDER BY id FOR UPDATE`,
      [input.sourceRevisionId],
    );
    const retractIds = toRetract.rows.map((r) => r.id);
    const evidence =
      retractIds.length > 0
        ? await tx.query<{ id: string }>(
            `UPDATE graph_evidence SET validity_state = 'retracted', invalidated_at = $2, invalidation_reason = $3
              WHERE id = ANY($1::uuid[]) AND validity_state = 'valid' RETURNING id`,
            [retractIds, at, input.reason],
          )
        : { rows: [] as Array<{ id: string }>, rowCount: 0 };
    const evidenceIds = evidence.rows.map((r) => r.id);
    const affected = await tx.query<{ assertion_id: string }>(
      'SELECT DISTINCT assertion_id FROM graph_assertion_support WHERE evidence_id = ANY($1::uuid[])',
      [evidenceIds],
    );
    const assertionIds = affected.rows.map((r) => r.assertion_id);
    const dependents = await invalidateDependentsOfEvidence(tx, evidenceIds, assertionIds, at);
    return {
      retracted: true,
      evidenceRetracted: evidenceIds.length,
      proofsInvalidated: dependents.proofsInvalidated,
      frontierEntriesExpired: dependents.frontierEntriesExpired,
      assertionsAffected: assertionIds.length,
    };
  });
}
