import { randomUUID } from 'node:crypto';
import type { ProviderRegistry } from '@culture-atlas/providers';
import type { DomainConfig } from '../config';
import type { ServiceContext } from '../context';
import type { PoolDb, Queryable } from '../db/pool';
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
