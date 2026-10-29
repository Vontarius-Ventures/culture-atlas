import type { Queryable } from '../db/pool';
import { discoveryEnabledForAccount, type DiscoveryGateConfig } from './expansion';
import { revalidatePinnedDependencies, scopedRecommendationServingVerdicts } from './validity';

/**
 * READ-side authority of the approved grant-scoped Discover more graph branch
 * (round-8 repairs DISC-SCR-033/034/036; round-9 remnants DISC-SCR-045/046
 * share the per-recommendation verdict below).
 *
 * The branch's producer is honest at publication time: it publishes only
 * admitted results of the authorized exact discovery context and pins a
 * per-result proof (scoped_discovery_result_proofs). These helpers hold the
 * READ paths to the same standard:
 *
 *  - a scoped rail context (a discovery job marked scoped_authority_required)
 *    serves only that context's own results — honestly empty when nothing was
 *    admitted — and is never padded from unrelated interest pools (033);
 *  - before a scoped result or its reason is served, its pinned proof is
 *    rechecked against CURRENT dependency versions (034);
 *  - the read-time graph gate mirrors the producer's: only a graph-on account
 *    reads a scoped rail with scoped semantics; graph-off reads keep the
 *    unchanged legacy behavior.
 *
 * The pinned-proof recheck itself is NOT flag-gated: a published scoped reason
 * must never silently outlive the evidence it rested on, whatever the flag
 * state at read time.
 */

/** True when the scoped graph branch is live for this account at READ time. */
export async function scopedGraphReadEnabled(
  db: Queryable,
  input: { accountId: string; config: DiscoveryGateConfig },
): Promise<boolean> {
  return discoveryEnabledForAccount(db, input);
}

/** One stored scoped result proof, with its pinned (id, revision) pairs. */
interface ScopedResultProofRow {
  id: string;
  recommendation_id: string;
  validity_state: string;
  assertion_ids: string[];
  assertion_revisions: number[];
  evidence_ids: string[];
  evidence_revisions: number[];
}

const PROOF_COLUMNS =
  'id, recommendation_id, validity_state, assertion_ids, assertion_revisions, evidence_ids, evidence_revisions';

/** The fresh pinned-dependency verdict of one stored scoped proof row. */
async function proofServes(db: Queryable, proof: ScopedResultProofRow, at?: Date): Promise<boolean> {
  const verdict = await revalidatePinnedDependencies(db, {
    assertions: proof.assertion_ids.map((id, i) => ({ id, revision: proof.assertion_revisions[i]! })),
    evidence: proof.evidence_ids.map((id, i) => ({ id, revision: proof.evidence_revisions[i]! })),
    at,
  });
  return verdict.valid;
}

/**
 * Read-time serving verdicts for one scoped discovery job's published results
 * (DISC-SCR-034), keyed by recommendation id. A result serves only while its
 * pinned proof still holds: every pinned assertion is still `validated` at its
 * pinned revision and currently justified, and at least one pinned evidence
 * row is still a live grounding witness — so sole-source retraction, natural
 * evidence/rights expiry and revision drift all withdraw the result at read
 * time. The fresh computation is the honest current answer: it subsumes the
 * stored validity_state (the withdrawal that flips it is permanent) and
 * additionally withdraws expired or drifted results no event has flipped.
 * Results without a proof row (the legacy producer never ran for this job's
 * results) keep serving — the caller treats a missing key as serving.
 */
export async function scopedResultServingVerdicts(
  db: Queryable,
  input: { discoveryJobId: string; at?: Date },
): Promise<Map<string, boolean>> {
  const { rows } = await db.query<ScopedResultProofRow>(
    `SELECT ${PROOF_COLUMNS} FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1`,
    [input.discoveryJobId],
  );
  const verdicts = new Map<string, boolean>();
  for (const proof of rows) {
    verdicts.set(proof.recommendation_id, await proofServes(db, proof, input.at));
  }
  return verdicts;
}

/**
 * Whether one recommendation still serves as a scoped result: true when it
 * carries no scoped proof (not a scoped-branch result) or its pinned proof
 * currently holds at `at`. Delegates to the shared batched verdict
 * (validity.ts) so candidate visibility, reason pagination and rail reads
 * apply ONE definition of "a scoped result serves".
 */
export async function scopedRecommendationServes(
  db: Queryable,
  input: { recommendationId: string; at?: Date },
): Promise<boolean> {
  const verdicts = await scopedRecommendationServingVerdicts(db, {
    recommendationIds: [input.recommendationId],
    at: input.at,
  });
  return verdicts.get(input.recommendationId) !== false;
}
