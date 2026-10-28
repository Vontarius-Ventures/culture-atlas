import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { GraphNodeDomain, GraphNodeKind } from './schema';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import type { PoolDb } from '../db/pool';
import {
  attachAssertionSupport,
  insertEvidence,
  loadEvidenceVersions,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import { createGraphRun, insertGraphRecommendation, insertRecommendationProof, upsertFrontierCandidate } from './store';
import {
  currentAssertionJustification,
  revalidateGraphProof,
  retractGraphEvidence,
  retractGraphSourceRevision,
  revalidatePinnedDependencies,
} from './validity';

/**
 * VAL-EVID-004 (domain slice): retracting or expiring sole evidence
 * immediately invalidates the dependent pinned proofs (before asynchronous
 * cleanup), while independently sourced valid evidence and explicit saves
 * survive. Frontier lifetimes are shortened by evidence/rights expiry. A
 * pinned proof revalidates against CURRENT dependency versions, so an old
 * snapshot can never retain an unsupported explanation.
 */

const db = getTestDb();
afterAll(closeTestDb);

// --- Fixtures -----------------------------------------------------------------

async function identity(dbh: PoolDb, over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string } = {}) {
  return upsertGraphIdentity(dbh, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: `Identity ${randomUUID().slice(0, 8)}`,
    nodeKind: over.kind ?? 'creator',
    domain: over.domain ?? 'art',
    senseKey: over.sense ?? 'person',
  });
}

async function evidence(dbh: PoolDb, over: {
  family?: string;
  expiresAt?: Date | null;
  rightsExpiresAt?: Date | null;
} = {}) {
  const family = over.family ?? `artic:${randomUUID()}`;
  const recorded = await recordSourceRevision(dbh, {
    provider: 'artic_open_access',
    url: `https://www.artic.edu/artworks/${randomUUID().slice(0, 8)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { provider: 'artic_open_access', title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
    documentHash: randomUUID(),
    rightsExpiresAt: over.rightsExpiresAt ?? null,
  });
  const inserted = await insertEvidence(dbh, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: over.expiresAt ?? null,
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, sourceRevisionId: recorded.sourceRevisionId, familyKey: family };
}

/** A validated CREATED_BY assertion with the given evidence families attached. */
async function justifiedAssertion(dbh: PoolDb, supports: Awaited<ReturnType<typeof evidence>>[]) {
  const work = await identity(dbh, { kind: 'work', sense: 'painting' });
  const creator = await identity(dbh, { kind: 'creator', sense: 'painter' });
  const upserted = await upsertGraphAssertion(dbh, {
    subjectNodeId: work.id,
    predicate: 'CREATED_BY',
    objectNodeId: creator.id,
    status: 'validated',
  });
  for (const support of supports) {
    await attachAssertionSupport(dbh, {
      assertionId: upserted.row.id,
      evidenceId: support.evidenceId,
      derivation: 'primary',
      sourceFamilyKey: support.familyKey,
    });
  }
  // Evidence attachment versions the assertion row; re-read so callers pin
  // the CURRENT revision, exactly like a real publisher would.
  const { rows } = await dbh.query<{ id: string; revision: number; status: string; invalidated_at: Date | null }>(
    'SELECT id, revision, status, invalidated_at FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertion: rows[0]!, work, creator };
}

/** Account + expansion run + recommendation + proof pinned to the assertion/evidence. */
async function pinnedProof(
  dbh: PoolDb,
  assertion: { id: string; revision: number },
  pinned: { evidenceId: string; revision: number }[],
) {
  const account = await insertAccount(dbh);
  const { rows: itemRows } = await dbh.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
     VALUES ($1, 'film', 'watch', $2, 'A card') RETURNING id`,
    [account.accountId, `qloo:${randomUUID()}`],
  );
  const run = await createGraphRun(dbh, {
    ownerAccountId: account.accountId,
    runKind: 'expansion',
    policyVersion: 'graph-policy-1',
  });
  const rec = await insertGraphRecommendation(dbh, {
    ownerAccountId: account.accountId,
    runId: run.id,
    discoveryItemId: itemRows[0]!.id,
    origin: 'catalog',
    title: 'A graph-backed card',
  });
  const proof = await insertRecommendationProof(dbh, {
    ownerAccountId: account.accountId,
    recommendationId: rec.id,
    graphRunId: run.id,
    intent: 'personal',
    reasonTemplate: 'created_by',
    assertions: [{ id: assertion.id, revision: assertion.revision }],
    evidence: pinned.map((p) => ({ id: p.evidenceId, revision: p.revision })),
  });
  return { account, run, rec, proof };
}

// --- Retraction invalidates only dependent proofs ----------------------------------

describe('retraction and expiry invalidation (VAL-EVID-004)', () => {
  it('retracting sole evidence immediately invalidates dependent proofs and the assertion justification', async () => {
    const sole = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [sole]);
    const { proof } = await pinnedProof(db, assertion, [sole]);

    // Before retraction everything is valid.
    expect((await currentAssertionJustification(db, { assertionId: assertion.id })).justified).toBe(true);
    expect((await revalidateGraphProof(db, { proofId: proof.id })).valid).toBe(true);

    const result = await retractGraphEvidence(db, { evidenceId: sole.evidenceId, reason: 'source corrected the caption' });
    expect(result.retracted).toBe(true);
    expect(result.proofsInvalidated).toBe(1);
    expect(result.frontierEntriesExpired).toBe(0);

    // The stored proof is invalid immediately (before any cleanup job).
    const { rows } = await db.query<{ validity_state: string; invalidated_at: Date }>(
      'SELECT validity_state, invalidated_at FROM recommendation_graph_proofs WHERE id = $1',
      [proof.id],
    );
    expect(rows[0]!.validity_state).toBe('invalid');
    expect(rows[0]!.invalidated_at).not.toBeNull();

    // The justification is gone and the pinned pair revalidates as invalid:
    // an old snapshot cannot retain the unsupported explanation.
    const justification = await currentAssertionJustification(db, { assertionId: assertion.id });
    expect(justification.justified).toBe(false);
    expect(justification.rejection).toBe('no_valid_support');
    const verdict = await revalidateGraphProof(db, { proofId: proof.id });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('evidence_retracted');

    // Retraction is idempotent: a repeated retraction changes nothing.
    const again = await retractGraphEvidence(db, { evidenceId: sole.evidenceId, reason: 'source corrected the caption' });
    expect(again.retracted).toBe(false);
    expect(again.proofsInvalidated).toBe(0);
  });

  it('keeps independent support: a proof backed by a second family survives retraction of the first', async () => {
    const familyOne = await evidence(db);
    const familyTwo = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [familyOne, familyTwo]);
    const soleProof = await pinnedProof(db, assertion, [familyOne]);
    const independentProof = await pinnedProof(db, assertion, [familyTwo]);
    const bothProof = await pinnedProof(db, assertion, [familyOne, familyTwo]);

    const result = await retractGraphEvidence(db, { evidenceId: familyOne.evidenceId, reason: 'mirror page removed' });
    expect(result.retracted).toBe(true);

    // The proof pinned only to the retracted family is invalid...
    expect((await revalidateGraphProof(db, { proofId: soleProof.proof.id })).valid).toBe(false);
    // ...but proofs grounded in the independent family survive.
    expect((await revalidateGraphProof(db, { proofId: independentProof.proof.id })).valid).toBe(true);
    expect((await revalidateGraphProof(db, { proofId: bothProof.proof.id })).valid).toBe(true);

    // The assertion itself remains justified by the surviving family, and the
    // explicit interest state of the accounts is untouched by retraction.
    const justification = await currentAssertionJustification(db, { assertionId: assertion.id });
    expect(justification.justified).toBe(true);
    expect(justification.independentFamilies).toBe(1);
    const { rows: edgeRows } = await db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM personal_interest_edges WHERE owner_account_id = ANY($1::uuid[])',
      [[soleProof.account.accountId, independentProof.account.accountId]],
    );
    expect(edgeRows[0]!.n).toBe(0);
  });

  it('treats expired evidence and expired rights as invalid without any retraction write', async () => {
    const at = new Date('2026-10-28T12:00:00Z');
    const expiring = await evidence(db, { expiresAt: new Date('2026-10-28T11:00:00Z') });
    const rightsLapsed = await evidence(db, { rightsExpiresAt: new Date('2026-10-28T10:00:00Z') });
    const live = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [expiring, rightsLapsed, live]);

    // The assertion keeps its live family, but a proof pinned ONLY to the
    // expired evidence is invalid at read time with an honest reason.
    const { proof } = await pinnedProof(db, assertion, [expiring]);
    expect((await revalidateGraphProof(db, { proofId: proof.id, at })).valid).toBe(false);
    expect((await revalidateGraphProof(db, { proofId: proof.id, at })).reason).toBe('evidence_expired');

    const rightsProof = await pinnedProof(db, assertion, [rightsLapsed]);
    expect((await revalidateGraphProof(db, { proofId: rightsProof.proof.id, at })).reason).toBe('rights_expired');

    // Before the expiry moment the same pinned pair is valid (controlled clock).
    const before = await revalidateGraphProof(db, { proofId: proof.id, at: new Date('2026-10-28T09:00:00Z') });
    expect(before.valid).toBe(true);
  });

  it('invalidates a proof whose pinned assertion was retracted or superseded', async () => {
    const sole = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [sole]);
    const { proof } = await pinnedProof(db, assertion, [sole]);

    // A review retracts the assertion itself: the evidence stays valid but the
    // assertion can no longer justify a factual reason.
    await db.query(`UPDATE graph_assertions SET status = 'retracted', invalidated_at = now() WHERE id = $1`, [assertion.id]);
    const verdict = await revalidateGraphProof(db, { proofId: proof.id });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toBe('assertion_not_validated');

    // A pinned revision change also invalidates: the proof pinned an older
    // version of the truth.
    await db.query(`UPDATE graph_assertions SET status = 'validated', invalidated_at = NULL, revision = revision + 1 WHERE id = $1`, [assertion.id]);
    const staleRevision = await revalidatePinnedDependencies(db, {
      assertions: [{ id: assertion.id, revision: assertion.revision }],
      evidence: [],
    });
    expect(staleRevision.valid).toBe(false);
    expect(staleRevision.reason).toBe('assertion_revision_changed');
  });

  it('retracts a whole source revision: every evidence row of the revision dies together', async () => {
    const familyOne = await evidence(db);
    const familyTwo = await evidence(db);
    const { assertion } = await justifiedAssertion(db, [familyOne, familyTwo]);
    const { proof } = await pinnedProof(db, assertion, [familyOne]);

    const result = await retractGraphSourceRevision(db, {
      sourceRevisionId: familyOne.sourceRevisionId,
      reason: 'the page was withdrawn by the publisher',
    });
    expect(result.evidenceRetracted).toBe(1);
    expect((await revalidateGraphProof(db, { proofId: proof.id })).valid).toBe(false);
    expect((await revalidateGraphProof(db, { proofId: proof.id })).reason).toBe('evidence_retracted');

    // The independent family keeps the assertion justified.
    expect((await currentAssertionJustification(db, { assertionId: assertion.id })).justified).toBe(true);

    // The retracted evidence row records the reason and the moment durably.
    const { rows } = await db.query<{ validity_state: string; invalidation_reason: string }>(
      'SELECT validity_state, invalidation_reason FROM graph_evidence WHERE id = $1',
      [familyOne.evidenceId],
    );
    expect(rows[0]!.validity_state).toBe('retracted');
    expect(rows[0]!.invalidation_reason).toBe('the page was withdrawn by the publisher');
  });

  it('expires frontier entries whose pinned path evidence was retracted, and caps frontier lifetime at evidence/rights expiry', async () => {
    const familyOne = await evidence(db);
    const familyTwo = await evidence(db);
    const { assertion, creator } = await justifiedAssertion(db, [familyOne, familyTwo]);
    const account = await insertAccount(db);
    const run = await createGraphRun(db, {
      ownerAccountId: account.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });

    // A frontier candidate created from an approved path records the pinned
    // path (template + assertion/evidence versions) in path_versions.
    const candidate = await upsertFrontierCandidate(db, {
      ownerAccountId: account.accountId,
      runId: run.id,
      nodeId: creator.id,
      dedupeKey: `frontier:${randomUUID()}`,
      expiresInDays: 7,
      pathVersions: {
        template: 'same_creator',
        assertion_ids: [assertion.id],
        assertion_revisions: [assertion.revision],
        evidence_ids: [familyOne.evidenceId, familyTwo.evidenceId],
        evidence_revisions: [familyOne.revision, familyTwo.revision],
      },
    });
    expect(candidate.created).toBe(true);

    // Evidence/rights expiry shortens the frontier lifetime, never extends it.
    const rightsExpiry = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    const shortLived = await upsertFrontierCandidate(db, {
      ownerAccountId: account.accountId,
      runId: run.id,
      nodeId: creator.id,
      dedupeKey: `frontier:${randomUUID()}`,
      expiresInDays: 7,
      expiresAt: rightsExpiry,
    });
    expect(shortLived.row.expires_at.getTime()).toBe(rightsExpiry.getTime());

    // Retracting the sole family of the path expires the candidate...
    await retractGraphEvidence(db, { evidenceId: familyOne.evidenceId, reason: 'gallery record corrected' });
    await retractGraphEvidence(db, { evidenceId: familyTwo.evidenceId, reason: 'gallery record corrected' });
    const { rows } = await db.query<{ state: string }>('SELECT state FROM graph_frontier WHERE id = $1', [
      candidate.row.id,
    ]);
    expect(rows[0]!.state).toBe('expired');

    // ...while an unrelated candidate (no pinned path) stays active.
    const { rows: other } = await db.query<{ state: string }>('SELECT state FROM graph_frontier WHERE id = $1', [
      shortLived.row.id,
    ]);
    expect(other[0]!.state).toBe('active');
  });

  it('reports the exact evidence version including retraction state to pinned-version readers', async () => {
    const sole = await evidence(db);
    await retractGraphEvidence(db, { evidenceId: sole.evidenceId, reason: 'withdrawn' });
    const versions = await loadEvidenceVersions(db, [sole.evidenceId]);
    const version = versions.get(sole.evidenceId)!;
    expect(version.validityState).toBe('retracted');
    expect(version.revision).toBe(sole.revision);

    // A missing evidence id is simply absent: it can never resurrect.
    const missing = await loadEvidenceVersions(db, [randomUUID()]);
    expect(missing.size).toBe(0);
  });
});
