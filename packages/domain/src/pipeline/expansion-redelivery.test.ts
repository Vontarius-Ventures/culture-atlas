import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { DomainConfig } from '../config';
import type { PoolDb } from '../db/pool';
import type { JobType } from '../enums';
import type { JobContext } from '../jobs/handler';
import { claimJobs, getJobById } from '../jobs/queue';
import { runStageOnce } from '../jobs/stages';
import { accountCtx, insertItem, insertReference, runJob } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig, testProviders } from '../testing';
import { recordPreference } from '../services/preferences';
import type { GraphNodeDomain, GraphNodeKind, GraphPredicate } from '../interest-graph/schema';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from '../interest-graph/evidence';
import { projectAccountInterestGraph } from '../interest-graph/projector';
import { loadGraphRefreshRow, noteExpansionDue } from '../interest-graph/refresh';
import { dispatchGraphExpansion } from '../interest-graph/sweeper';
import { JOB_HANDLERS } from './index';

/**
 * At-least-once redelivery of a committed expansion pass (DISC-SCR-012's
 * crash boundary, VAL-DISC-003/006).
 *
 * The expansion pass is one transaction: `graph_runs.job_id` is UNIQUE, and
 * the only committed shape a pass leaves is a complete, published run. The
 * worker's bookkeeping AFTER the pass — consuming the covered due marker,
 * closing the logical budget row, completing the job — is NOT part of that
 * transaction, so a worker that dies between the pass's commit and that
 * bookkeeping leaves the job 'running' with a lease and a COMMITTED run.
 *
 * The old handler re-ran the whole pass on the redelivery: it died on the
 * `graph_runs_job_id_key` UNIQUE violation forever (each retry hit the same
 * committed run) — and had the constraint not existed it would have
 * republished a second set of cards and proofs. The redelivery must instead
 * REUSE the committed run: short-circuit without re-walking, without
 * republishing, without re-anchoring spend, consuming the due markers the
 * pass's own coverage bound owned and closing the window's budget row.
 */

const db: PoolDb = getTestDb();
afterAll(closeTestDb);

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

// --- Fixture helpers (the shared admission pipeline's publishing shape) ----------------

/** A corpus identity with a linked cultural reference (work-like by default). */
async function corpusNode(
  over: { kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string; name?: string; withReference?: boolean } = {},
) {
  const kind = over.kind ?? 'work';
  const name = `${over.name ?? kind}-${randomUUID().slice(0, 6)}`;
  const withReference = over.withReference ?? true;
  const referenceId = withReference ? await insertReference({ name }, db) : null;
  const node = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: name,
    nodeKind: kind,
    domain: over.domain ?? 'art',
    senseKey: over.sense ?? 'painting',
    culturalReferenceId: referenceId,
  });
  return { node, referenceId };
}

/** One reviewed evidence row (CC0 museum record). */
async function evidence() {
  const family = `artic:${randomUUID()}`;
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
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none' },
    documentHash: randomUUID(),
    rightsExpiresAt: null,
  });
  const inserted = await insertEvidence(db, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: null,
  });
  return { evidenceId: inserted.row.id, revision: inserted.revision, familyKey: family };
}

/** A validated, currently justified assertion (one reviewed evidence family). */
async function justifiedEdge(input: { subject: string; predicate: GraphPredicate; object: string }) {
  const support = await evidence();
  const upserted = await upsertGraphAssertion(db, {
    subjectNodeId: input.subject,
    predicate: input.predicate,
    objectNodeId: input.object,
    associationSubtype: null,
    status: 'validated',
  });
  await attachAssertionSupport(db, {
    assertionId: upserted.row.id,
    evidenceId: support.evidenceId,
    derivation: 'primary',
    sourceFamilyKey: support.familyKey,
  });
  const { rows } = await db.query<{ id: string; revision: number }>(
    'SELECT id, revision FROM graph_assertions WHERE id = $1',
    [upserted.row.id],
  );
  return { assertionId: rows[0]!.id, revision: rows[0]!.revision };
}

// --- The account whose window publishes ------------------------------------------------

/** A caught-up account whose expansion window publishes exactly one card. */
async function publishingAccount(): Promise<{ accountId: string; jobId: string; workKey: string }> {
  const { principal, ctx } = await accountCtx({ config: graphOn });
  const accountId = principal.accountId;

  const root = await corpusNode({ kind: 'work' });
  const itemId = await insertItem({ accountId }, { referenceId: root.referenceId, kind: 'film', category: 'watch' }, db);
  await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: itemId });
  const creator = await corpusNode({ kind: 'creator', sense: 'painter', withReference: false });
  const candidate = await corpusNode({ kind: 'work' });
  await justifiedEdge({ subject: root.node.id, predicate: 'CREATED_BY', object: creator.node.id });
  await justifiedEdge({ subject: candidate.node.id, predicate: 'CREATED_BY', object: creator.node.id });
  await insertItem({ accountId }, { referenceId: candidate.referenceId, kind: 'film', category: 'watch' }, db);

  await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });
  await noteExpansionDue(db, accountId);

  // The real ordered dispatch hands the due window to the queue (this also
  // exercises the per-account dispatch operation end to end).
  const swept = await dispatchGraphExpansion(db, { config: graphOn, ownerAccountId: accountId, now: new Date() });
  expect(swept.accounts).toHaveLength(1);
  const jobId = swept.accounts[0]!.jobId;
  const job = await getJobById(db, jobId);
  return { accountId, jobId, workKey: job!.dedupe_key! };
}

async function expansionRunCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function committedRun(accountId: string): Promise<{ id: string; state: string; published: boolean } | null> {
  const { rows } = await db.query<{ id: string; state: string; published: boolean }>(
    `SELECT id, state, published FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion'`,
    [accountId],
  );
  return rows[0] ?? null;
}

async function graphRecommendationCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function proofCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM recommendation_graph_proofs WHERE owner_account_id = $1`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function budgetState(accountId: string, workKey: string): Promise<string | null> {
  const { rows } = await db.query<{ state: string }>(
    `SELECT state FROM graph_work_budgets WHERE owner_account_id = $1 AND work_key = $2`,
    [accountId, workKey],
  );
  return rows[0]?.state ?? null;
}

// --- The crash seam ---------------------------------------------------------------------

/**
 * Runs the real handler like apps/worker, but the "worker" dies right after
 * the expansion pass commits: no due consumption, no budget close, no job
 * completion or failure bookkeeping — the job stays 'running' with its lease
 * while the run, its card and its proof persist.
 */
async function runCrashingAfterPublication(jobId: string, config: DomainConfig): Promise<void> {
  const workerId = `crash-${randomUUID()}`;
  const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: 60_000, ids: [jobId] });
  if (!job) throw new Error('expansion job not claimable');
  const controller = new AbortController();
  const ctx: JobContext = {
    job,
    payload: job.payload,
    attempt: job.attempt,
    workerId,
    db,
    providers: testProviders(),
    config,
    signal: controller.signal,
    budget: {
      qlooRequests: job.budget.qloo_requests ?? 4,
      researchRefs: 0,
      providerRetries: 0,
      deadlineMs: 60_000,
    },
    setStage: async () => undefined,
    runStage: (stage, fn) => runStageOnce(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
    ensureActive: async () => undefined,
    trace: async (event) => {
      if (event.name === 'graph_expansion_published')
        throw new Error('simulated worker crash after expansion publication');
    },
    log: () => undefined,
  };
  const handler = JOB_HANDLERS[job.type as JobType] as (c: JobContext) => Promise<unknown>;
  try {
    await handler(ctx);
    throw new Error('the crash injection never fired');
  } catch (err) {
    if (!(err instanceof Error) || err.message !== 'simulated worker crash after expansion publication') throw err;
  }
}

describe('at-least-once redelivery of a committed expansion pass', () => {
  it('a redelivery after the pass committed but before job completion reuses the run instead of failing forever', async () => {
    const { accountId, jobId, workKey } = await publishingAccount();

    // Attempt 1: the pass commits, then the worker dies before any
    // bookkeeping.
    await runCrashingAfterPublication(jobId, graphOn);

    const run = await committedRun(accountId);
    expect(run).not.toBeNull();
    expect(run!.state).toBe('complete');
    expect(run!.published).toBe(true);
    expect(await graphRecommendationCount(accountId)).toBe(1);
    expect(await proofCount(accountId)).toBe(1);
    // The job is still leased 'running' — the crash skipped completion.
    expect((await getJobById(db, jobId))!.state).toBe('running');
    // The due marker and the window's budget row are still open.
    expect((await loadGraphRefreshRow(db, accountId))!.expansion_due_since).toBeInstanceOf(Date);
    expect(await budgetState(accountId, workKey)).toBe('active');

    // At-least-once delivery: the lease expires and a worker redelivers.
    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const redelivered = await runJob(jobId, { config: graphOn });

    // The redelivery completes the job by REUSING the committed run — no
    // re-walk, no second run row, no republished card or proof.
    expect(redelivered.state).toBe('complete');
    expect(await expansionRunCount(accountId)).toBe(1);
    expect(await graphRecommendationCount(accountId)).toBe(1);
    expect(await proofCount(accountId)).toBe(1);
    const done = await getJobById(db, jobId);
    expect(done!.state).toBe('complete');
    expect(done!.result_id).toBe(run!.id);

    // The window's logical budget closed on the redelivery, and the due
    // markers the pass's own coverage bound owned were consumed with it.
    expect(await budgetState(accountId, workKey)).toBe('complete');
    expect((await loadGraphRefreshRow(db, accountId))!.expansion_due_since).toBeNull();
  });

  it('a due marker stamped inside the dead window stays due and gets the next dispatch', async () => {
    const { accountId, jobId, workKey } = await publishingAccount();

    await runCrashingAfterPublication(jobId, graphOn);
    // Fresh support landed while the worker was dead — AFTER the committed
    // pass's own read, so it was never covered by that pass.
    await db.query(`UPDATE graph_refresh_state SET expansion_due_since = now() WHERE owner_account_id = $1`, [
      accountId,
    ]);

    await db.query(`UPDATE jobs SET lease_expiry = now() - interval '1 second' WHERE id = $1`, [jobId]);
    const redelivered = await runJob(jobId, { config: graphOn });
    expect(redelivered.state).toBe('complete');

    // The uncovered marker survives the redelivery's consumption bound.
    const marker = (await loadGraphRefreshRow(db, accountId))!.expansion_due_since;
    expect(marker).toBeInstanceOf(Date);
    expect(await budgetState(accountId, workKey)).toBe('complete');

    // The next sweep hands the fresh support to a NEW window: a fresh
    // dispatch stamp and dedupe key, exactly one active expansion.
    const reswept = await dispatchGraphExpansion(db, {
      config: graphOn,
      ownerAccountId: accountId,
      now: new Date(Date.now() + 1_000),
    });
    expect(reswept.accounts).toHaveLength(1);
    expect(reswept.accounts[0]!.trigger).toBe('due');
    expect(reswept.accounts[0]!.jobId).not.toBe(jobId);
    const { rows: active } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs
        WHERE owner_account_id = $1 AND type = 'expand_interest_graph' AND state IN ('queued','running')`,
      [accountId],
    );
    expect(Number(active[0]!.n)).toBe(1);
  });
});
