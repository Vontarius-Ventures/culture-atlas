import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import type { ProviderRegistry } from '@culture-atlas/providers';
import type { DomainConfig } from '../config';
import type { ServiceContext } from '../context';
import { PoolDb, type Db, type Queryable } from '../db/pool';
import type { Category, ItemKind, JobType, ReferenceType } from '../enums';
import { claimJobs, completeJob, failJob, getJobById, markJobCancelled, setJobStage, stillOwnsJob } from '../jobs/queue';
import { JobCancelledError, type JobContext } from '../jobs/handler';
import { runStageOnce } from '../jobs/stages';
import { JOB_HANDLERS } from '../pipeline';
import { isAppError } from '../errors';
import type { Principal } from '../principal';
import { getTestDb, insertAccount, insertAnonymousSession, testConfig, testContext, testProviders } from '../testing';

/**
 * Factories for library/plan tests. Every call creates fresh owners and
 * unique keys so test files can run in parallel against one database.
 */

export async function accountCtx(options: { providers?: ProviderRegistry; config?: DomainConfig } = {}) {
  const principal = await insertAccount();
  return { principal, ctx: testContext(principal, options) };
}

export async function anonCtx(options: { providers?: ProviderRegistry } = {}) {
  const principal = await insertAnonymousSession();
  return { principal, ctx: testContext(principal, options) };
}

export function ctxFor(principal: Principal, options: { providers?: ProviderRegistry; config?: DomainConfig } = {}): ServiceContext {
  return testContext(principal, options);
}

export async function insertReference(
  input: { name?: string; type?: ReferenceType; qloo?: string } = {},
  db: Queryable = getTestDb(),
): Promise<string> {
  const name = input.name ?? `Reference ${randomUUID().slice(0, 8)}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids, research_status)
     VALUES ($1, $2, $3, $4::jsonb, 'complete') RETURNING id`,
    [name, `test:${randomUUID()}`, input.type ?? 'style', JSON.stringify(input.qloo ? { qloo: input.qloo } : {})],
  );
  return rows[0]!.id;
}

export type TestOwner = { accountId: string } | { sessionId: string };

export async function insertItem(
  owner: TestOwner | null,
  input: {
    kind?: ItemKind;
    category?: Category | null;
    title?: string;
    key?: string;
    qloo?: string;
    referenceId?: string | null;
    anchorIds?: string[];
    year?: number;
  } = {},
  db: Queryable = getTestDb(),
): Promise<string> {
  const kind = input.kind ?? 'film';
  const category = input.category === undefined ? (kind === 'film' ? 'watch' : kind === 'artist' ? 'play' : kind === 'food' ? 'eat' : kind === 'brand' || kind === 'style' ? 'wear' : null) : input.category;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, owner_session_id, is_sample, kind, category, canonical_key, title,
                                  display_metadata, external_ids, reference_id, resolved_anchor_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::uuid[]) RETURNING id`,
    [
      owner && 'accountId' in owner ? owner.accountId : null,
      owner && 'sessionId' in owner ? owner.sessionId : null,
      owner === null,
      kind,
      category,
      input.key ?? (input.qloo ? `qloo:${input.qloo}` : `test:${randomUUID()}`),
      input.title ?? `${kind} ${randomUUID().slice(0, 6)}`,
      JSON.stringify(input.year ? { year: input.year, subtitle: String(input.year) } : {}),
      JSON.stringify(input.qloo ? { qloo: input.qloo } : {}),
      input.referenceId ?? null,
      input.anchorIds ?? [],
    ],
  );
  return rows[0]!.id;
}

/** A capture with an active analysis, anchors and its own discovery item. */
export async function insertCaptureWithAnalysis(
  owner: TestOwner,
  input: { anchorIds?: string[]; title?: string; recommendItemIds?: string[] } = {},
  db: Queryable & PoolDb = getTestDb(),
): Promise<{ captureId: string; analysisId: string; itemId: string }> {
  return db.transaction(async (tx) => {
    const acc = 'accountId' in owner ? owner.accountId : null;
    const ses = 'sessionId' in owner ? owner.sessionId : null;
    const cap = await tx.query<{ id: string }>(
      `INSERT INTO captures (owner_account_id, owner_session_id, source, image_sha256, private_object_key, status)
       VALUES ($1, $2, 'upload', $3, $4, 'ready') RETURNING id`,
      [acc, ses, randomUUID().replace(/-/g, ''), `captures/test/${randomUUID()}.jpg`],
    );
    const captureId = cap.rows[0]!.id;
    const an = await tx.query<{ id: string }>(
      `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
       VALUES ($1, 1, 'test', $2, 'A few references stood out.', '{"observations":"complete"}') RETURNING id`,
      [captureId, input.title ?? 'A sunny café table'],
    );
    const analysisId = an.rows[0]!.id;
    await tx.query('UPDATE captures SET active_analysis_id = $2 WHERE id = $1', [captureId, analysisId]);
    for (const ref of input.anchorIds ?? []) {
      await tx.query(
        `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, is_anchor) VALUES ($1, $2, 'resembles', 0.8, true)`,
        [analysisId, ref],
      );
    }
    const item = await tx.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, owner_session_id, kind, canonical_key, capture_id, title)
       VALUES ($1, $2, 'capture', $3, $4, $5) RETURNING id`,
      [acc, ses, `capture:${captureId}`, captureId, input.title ?? 'A sunny café table'],
    );
    for (const [i, rid] of (input.recommendItemIds ?? []).entries()) {
      await tx.query(
        `INSERT INTO recommendations (analysis_id, discovery_item_id, category, rank, title, origin, display_reason)
         SELECT $1, id, category, $3, title, 'vlm_creative', 'Inspired by your photo.' FROM discovery_items WHERE id = $2`,
        [analysisId, rid, i + 1],
      );
    }
    return { captureId, analysisId, itemId: item.rows[0]!.id };
  });
}

/** Saves an item (and optionally adds it to collections) directly in SQL for setup. */
export async function saveDirect(accountId: string, itemId: string, collectionIds: string[] = [], db: Queryable = getTestDb()): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)
     ON CONFLICT (owner_account_id, discovery_item_id) DO UPDATE SET saved_at = saved_items.saved_at RETURNING id`,
    [accountId, itemId],
  );
  for (const c of collectionIds) {
    await db.query(
      `INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position)
       VALUES ($1, $2, $3, COALESCE((SELECT max(position) + 1 FROM collection_items WHERE collection_id = $1), 0))
       ON CONFLICT DO NOTHING`,
      [c, rows[0]!.id, accountId],
    );
  }
  return rows[0]!.id;
}

/**
 * Run one queued job through its registered handler with the same contract
 * as apps/worker (lease, idempotent stages, ensureActive, completion).
 * `onTrace` observes the handler's trace events (the production worker
 * persists them; tests usually only assert their shape).
 */
export async function runJob(
  jobId: string,
  options: {
    providers?: ProviderRegistry;
    config?: DomainConfig;
    db?: PoolDb;
    beforePublish?: () => Promise<void>;
    onTrace?: (event: { kind: string; name: string; data?: Record<string, unknown> }) => void;
  } = {},
): Promise<{ state: string }> {
  const db = options.db ?? getTestDb();
  const config = options.config ?? testConfig();
  const providers = options.providers ?? testProviders();
  const workerId = `test-${randomUUID()}`;
  const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: 60_000, ids: [jobId] });
  if (!job) throw new Error(`job ${jobId} not claimable`);
  const controller = new AbortController();
  let hookRan = false;
  const ctx: JobContext = {
    job,
    payload: job.payload,
    attempt: job.attempt,
    workerId,
    db,
    providers,
    config,
    signal: controller.signal,
    budget: {
      qlooRequests: job.budget.qloo_requests ?? config.JOB_MAX_QLOO_REQUESTS,
      researchRefs: config.JOB_MAX_RESEARCH_REFS,
      providerRetries: job.budget.provider_retries ?? config.JOB_MAX_PROVIDER_RETRIES,
      deadlineMs: config.ANALYSIS_DEADLINE_MS,
    },
    setStage: async (stage) => {
      await setJobStage(db, job.id, workerId, job.attempt, stage);
    },
    runStage: (stage, fn) => runStageOnce(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
    ensureActive: async () => {
      if (options.beforePublish && !hookRan) {
        hookRan = true;
        await options.beforePublish();
      }
      if (!(await stillOwnsJob(db, job.id, workerId, job.attempt))) throw new JobCancelledError('cancelled');
    },
    trace: async (event) => {
      options.onTrace?.(event);
    },
    log: () => undefined,
  };
  const handler = JOB_HANDLERS[job.type as JobType] as (c: JobContext) => Promise<{ state: 'complete' | 'partial'; resultType?: string; resultId?: string }>;
  try {
    const outcome = await handler(ctx);
    await completeJob(db, job.id, workerId, job.attempt, outcome);
  } catch (err) {
    if (err instanceof JobCancelledError) {
      await markJobCancelled(db, job.id, workerId, job.attempt);
    } else {
      await failJob(db, job.id, workerId, job.attempt, {
        code: isAppError(err) ? err.code : 'internal',
        message: (err as Error).message,
        retryable: false,
      });
      throw err;
    }
  }
  const done = await getJobById(db, job.id);
  return { state: done!.state };
}

/** The interruption marker of `runClaimedAttempt`'s publication barrier. */
class PublicationBarrierError extends Error {
  constructor() {
    super('publication barrier');
    this.name = 'PublicationBarrierError';
  }
}

/**
 * A Db wrapper whose FIRST `transaction()` call rejects — the execution's
 * publication barrier. Plain queries pass through untouched, so the claimed
 * attempt first persists exactly the durable stage evidence its producer
 * branch records (`runStageOnce` writes the scoped pass's 'graph' running
 * then failed marker; the legacy provider path completes its
 * 'resolve'/'insights:*' stages), and the barrier then aborts it precisely
 * where the branch would publish — before any publication statement runs.
 */
function publicationBarrierDb(base: Db): Db {
  let tripped = false;
  return {
    inTransaction: base.inTransaction,
    query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]) {
      return base.query<R>(text, params);
    },
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (!tripped) {
        tripped = true;
        return Promise.reject(new PublicationBarrierError());
      }
      return base.transaction(fn);
    },
  };
}

export interface ClaimedAttemptResult {
  /** The queue row's state after this execution (read back like `runJob`). */
  state: string;
  /** The real attempt this execution claimed. */
  attempt: number;
  /** True when this execution was interrupted without a terminal queue write. */
  interrupted: boolean;
  /**
   * True when that interruption happened AFTER the durable publication
   * committed (`crashAfterPublication`): results, their pinned proofs and
   * the discovery parent's terminal status all stand, while the queue row
   * keeps its 'running' state and the claim's lease — the worker that died
   * between its publication commit and queue completion.
   */
  published?: boolean;
}

/**
 * Claim `jobId` at its NEXT real attempt and run its REAL handler once —
 * the redelivery counterpart of `runJob`, for reproducing mixed
 * graph/legacy attempt histories on ONE job (DISC-SCR-049):
 *
 *  - the claim is the real `claimJobs` lease — a fresh claim, or the
 *    expired-lease reclaim of an abandoned 'running' row (the crashed-worker
 *    redelivery path), never a synthetic stage fixture;
 *  - `interruptPublication` aborts the execution exactly at its publication
 *    barrier (the handler's first `transaction`: the scoped graph pass's
 *    publication, or the legacy provider path's step-4 publication) WITHOUT
 *    any terminal queue write: the claimed row keeps its 'running' state and
 *    the lease the claim granted, exactly like a worker that crashed after
 *    persisting its stage evidence, so a later attempt can redeliver the
 *    same job once the lease lapses (pass a short `leaseMs` and wait, or
 *    claim the abandoned row directly);
 *  - `crashAfterPublication` interrupts one step LATER: the handler runs to
 *    completion through its REAL publication transaction (the scoped graph
 *    pass commits its results, their pinned proofs and the discovery
 *    parent's terminal status together, then reports `publicationCommitted`),
 *    and the crash lands between that commit and the terminal queue write —
 *    again NO `completeJob`, so the claimed row keeps 'running' with the
 *    claim's lease while the DURABLE publication stands (DISC-SCR-050's
 *    crashed-after-publication shape: an expired-lease redelivery can then
 *    legitimately re-publish on the same discovery parent);
 *  - an uninterrupted execution completes through the real `completeJob`
 *    with the handler's own outcome (and reads its state back like `runJob`).
 */
export async function runClaimedAttempt(
  jobId: string,
  options: {
    db?: PoolDb;
    config?: DomainConfig;
    providers?: ProviderRegistry;
    interruptPublication?: boolean;
    crashAfterPublication?: boolean;
    leaseMs?: number;
  } = {},
): Promise<ClaimedAttemptResult> {
  const db = options.db ?? getTestDb();
  const config = options.config ?? testConfig();
  const providers = options.providers ?? testProviders();
  const workerId = `test-${randomUUID()}`;
  const [job] = await claimJobs(db, { workerId, limit: 1, leaseMs: options.leaseMs ?? 60_000, ids: [jobId] });
  if (!job) throw new Error(`job ${jobId} not claimable`);
  const controller = new AbortController();
  const handlerDb = options.interruptPublication ? publicationBarrierDb(db) : db;
  const ctx: JobContext = {
    job,
    payload: job.payload,
    attempt: job.attempt,
    workerId,
    db: handlerDb,
    providers,
    config,
    signal: controller.signal,
    budget: {
      qlooRequests: job.budget.qloo_requests ?? config.JOB_MAX_QLOO_REQUESTS,
      researchRefs: config.JOB_MAX_RESEARCH_REFS,
      providerRetries: job.budget.provider_retries ?? config.JOB_MAX_PROVIDER_RETRIES,
      deadlineMs: config.ANALYSIS_DEADLINE_MS,
    },
    setStage: async (stage) => {
      await setJobStage(db, job.id, workerId, job.attempt, stage);
    },
    runStage: (stage, fn) => runStageOnce(handlerDb, { jobId: job.id, stage, attempt: job.attempt }, fn),
    ensureActive: async () => {
      if (!(await stillOwnsJob(db, job.id, workerId, job.attempt))) throw new JobCancelledError('cancelled');
    },
    trace: async () => undefined,
    log: () => undefined,
  };
  const handler = JOB_HANDLERS[job.type as JobType] as (c: JobContext) => Promise<{
    state: 'complete' | 'partial';
    resultType?: string;
    resultId?: string;
    publicationCommitted?: true;
  }>;
  try {
    const outcome = await handler(ctx);
    if (options.crashAfterPublication && outcome.publicationCommitted) {
      // The worker that died AFTER its durable publication committed: no
      // terminal queue write. The claimed row keeps its 'running' state and
      // the claim's lease; the committed publication (scoped results, their
      // pinned proofs and the parent's terminal status) stands.
      return { state: 'running', attempt: job.attempt, interrupted: true, published: true };
    }
    await completeJob(db, job.id, workerId, job.attempt, outcome);
  } catch (err) {
    if (err instanceof PublicationBarrierError) {
      // The crashed worker: no terminal write. The claimed row keeps its
      // 'running' state and lease; the durable stage evidence stands.
      return { state: 'running', attempt: job.attempt, interrupted: true };
    }
    if (err instanceof JobCancelledError) {
      await markJobCancelled(db, job.id, workerId, job.attempt);
    } else {
      await failJob(db, job.id, workerId, job.attempt, {
        code: isAppError(err) ? err.code : 'internal',
        message: (err as Error).message,
        retryable: false,
      });
      throw err;
    }
  }
  const done = await getJobById(db, job.id);
  return { state: done!.state, attempt: job.attempt, interrupted: false };
}

/** The item read's statements a `gatedReadDb` barrier can observe (DISC-SCR-050). */
export interface ReadBarrierGates {
  /** Invoked after each discovery-context classification query returns. */
  onClassified?: () => void;
  /** Invoked after the rail's recommendation-rows query returns. */
  onRowsLoaded?: () => void;
  /** Awaited — and the read parked — before the rail's recommendation-rows query runs. */
  beforeRowsLoad?: () => Promise<void>;
  /** Awaited — and the read parked — before the rail's scoped-proof verdict query runs. */
  beforeProofLoad?: () => Promise<void>;
}

/**
 * A read-path barrier db (DISC-SCR-050): wraps a real pool and lets a test
 * park the item read BETWEEN its own statements — after the discovery-context
 * CLASSIFICATION (`latestDiscoveryJobs`' 'WITH visible_jobs' statement) and
 * before/after the rail's RESULT-LOADING query, and before the scoped-PROOF
 * verdict query — the exact windows where a concurrent publication can
 * substitute the rows a classified context selected. The parked read holds no
 * database connection while it waits, and every other query passes through
 * untouched, so the genuine read path runs unmodified.
 */
export function gatedReadDb(base: PoolDb, gates: ReadBarrierGates): PoolDb {
  const rowsQuery = 'di.canonical_key, r.id AS recommendation_id';
  const proofQuery = 'FROM scoped_discovery_result_proofs WHERE discovery_job_id = $1';
  return new (class extends PoolDb {
    constructor() {
      super(base.pool);
    }
    override async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (gates.beforeRowsLoad && text.includes(rowsQuery)) await gates.beforeRowsLoad();
      if (gates.beforeProofLoad && text.includes(proofQuery)) await gates.beforeProofLoad();
      const result = await super.query<R>(text, params);
      if (gates.onClassified && text.includes('WITH visible_jobs AS (')) gates.onClassified();
      if (gates.onRowsLoaded && text.includes(rowsQuery)) gates.onRowsLoaded();
      return result;
    }
  })();
}
