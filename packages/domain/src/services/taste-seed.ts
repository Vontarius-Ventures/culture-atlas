import type { Queryable } from '../db/pool';
import { CATEGORIES, type Category, type JobState } from '../enums';
import { serviceFeatureState, type ServiceFeatureEnv } from '../flags/feature-flags';
import { tasteSeedDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';
import { FoodExclusions, type SeedCategoryState, type SeedState, type TasteSeedStatus } from '../schemas/onboarding';
import { iso } from '../util/time';

/**
 * Taste seed (spec amendment 2.2, "Seeding the feed"): service side of the
 * `taste_seed` job (handler: pipeline/taste-seed.ts).
 *
 * Call-site contract for package A (onboarding completion, and optionally
 * Settings → Taste changes): inside or after the transaction that completes
 * onboarding, call
 *   enqueueTasteSeed(db, { accountId, tasteRevision, catalogVersion, config })
 * and return its TasteSeedStatus as `CompleteOnboardingResponse.seed`.
 * GET /v1/onboarding/seed returns getTasteSeedStatus(db, accountId).
 *
 * The seed is bounded: at most TASTE_SEED_MAX_QLOO_REQUESTS Qloo requests per
 * job, across all of its attempts (each request is reserved on
 * taste_seed_runs.qloo_requests_used before it is sent; the adapter's own
 * retries are disabled) and at most TASTE_SEED_MAX_CONCURRENCY at a time. An
 * attempt that meets a throttled or failing Qloo stops asking, and a retry
 * probes with one request before fanning out, so an outage spends little of
 * the cap. It never fabricates: a category Qloo
 * returns nothing for stays `empty` and the feed's labeled examples fill the
 * gap; a Qloo outage leaves it `unavailable` and the job retries with backoff.
 */

export const TASTE_SEED_MAX_QLOO_REQUESTS = 6;
export const TASTE_SEED_MAX_CONCURRENCY = 3;
/** Job attempts (the first run plus retries with backoff while Qloo is down). */
export const TASTE_SEED_MAX_ATTEMPTS = 4;
/** Per-attempt deadline. Eat (cuisine tags) measured ~12 s uncached on the hackathon key. */
export const TASTE_SEED_DEADLINE_MS = 90_000;
/**
 * Inline retries of one Qloo call inside an attempt. None: with a per-job cap
 * of 6, a failed call is retried by the job's next attempt (with backoff), not
 * at once against a key that is throttling.
 */
export const TASTE_SEED_INLINE_RETRIES = 0;
/** Poll interval suggested to screen 15 while the job is active. */
export const TASTE_SEED_POLL_MS = 1_000;
const RETRY_POLL_MAX_MS = 15_000;

interface RunRow {
  id: string;
  job_id: string | null;
  state: SeedState;
  first_ready_at: Date | null;
  job_state: JobState | null;
  job_attempt: number | null;
  job_available_at: Date | null;
}

interface CategoryRow {
  category: Category;
  state: SeedCategoryState;
  card_count: number;
  ready_at: Date | null;
}

const NOT_STARTED: TasteSeedStatus = {
  job_id: null,
  state: 'not_started',
  categories: [],
  first_ready_at: null,
  poll_after_ms: null,
};

/**
 * Pure status derivation (tested on its own). The job row is authoritative
 * for progress (queued, running, re-queued for retry, finished); category rows
 * say what was published. A finished job never reports `pending`: whatever it
 * could not fetch is `unavailable`.
 */
export function deriveSeedStatus(
  run: Pick<RunRow, 'job_id' | 'state' | 'first_ready_at' | 'job_state' | 'job_attempt' | 'job_available_at'>,
  categories: readonly CategoryRow[],
  now: Date,
): TasteSeedStatus {
  let state: SeedState;
  const anyReady = categories.some((c) => c.state === 'ready');
  const allSettled = categories.every((c) => c.state === 'ready' || c.state === 'empty');
  switch (run.job_state) {
    case 'queued':
      state = (run.job_attempt ?? 0) > 0 ? 'retrying' : 'queued';
      break;
    case 'running':
      state = 'running';
      break;
    case 'complete':
    case 'partial':
      state = allSettled ? 'complete' : 'partial';
      break;
    case 'failed':
    case 'cancelled':
      state = anyReady ? 'partial' : 'failed';
      break;
    default:
      // Job row gone (purged): fall back to what the run recorded.
      state = run.state === 'queued' || run.state === 'running' || run.state === 'retrying' ? (anyReady ? 'partial' : 'failed') : run.state;
  }
  const active = state === 'queued' || state === 'running' || state === 'retrying';
  let poll: number | null = null;
  if (active) {
    poll = TASTE_SEED_POLL_MS;
    if (state === 'retrying' && run.job_available_at) {
      poll = Math.min(RETRY_POLL_MAX_MS, Math.max(TASTE_SEED_POLL_MS, run.job_available_at.getTime() - now.getTime()));
    }
  }
  const order = new Map(CATEGORIES.map((c, i) => [c, i]));
  return {
    job_id: run.job_id,
    state,
    categories: [...categories]
      .sort((a, b) => (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0))
      .map((c) => ({
        category: c.category,
        state: !active && c.state === 'pending' ? 'unavailable' : c.state,
        card_count: c.state === 'ready' ? c.card_count : 0,
        ready_at: c.state === 'ready' && c.ready_at ? iso(c.ready_at) : null,
      })),
    first_ready_at: run.first_ready_at ? iso(run.first_ready_at) : null,
    poll_after_ms: poll,
  };
}

/** Latest seed of the account (GET /v1/onboarding/seed, OnboardingStateResponse.seed). */
export async function getTasteSeedStatus(db: Queryable, accountId: string, now: Date = new Date()): Promise<TasteSeedStatus> {
  const { rows } = await db.query<RunRow>(
    `SELECT tr.id, tr.job_id, tr.state, tr.first_ready_at,
            j.state AS job_state, j.attempt AS job_attempt, j.available_at AS job_available_at
       FROM taste_seed_runs tr LEFT JOIN jobs j ON j.id = tr.job_id
      WHERE tr.owner_account_id = $1
      ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1`,
    [accountId],
  );
  const run = rows[0];
  if (!run) return NOT_STARTED;
  const cats = await db.query<CategoryRow>(
    'SELECT category, state, card_count, ready_at FROM taste_seed_categories WHERE run_id = $1',
    [run.id],
  );
  return deriveSeedStatus(run, cats.rows, now);
}

/**
 * The run row for a seed job (created at enqueue; created here too when a job
 * was enqueued some other way). Idempotent per job.
 */
export async function ensureSeedRun(
  db: Queryable,
  input: { accountId: string; jobId: string; tasteRevision: number; catalogVersion: string | null; categories: readonly Category[] },
): Promise<string> {
  await db.query(
    `INSERT INTO taste_seed_runs (owner_account_id, job_id, taste_revision, catalog_version)
     VALUES ($1, $2, $3, $4) ON CONFLICT (job_id) DO NOTHING`,
    [input.accountId, input.jobId, input.tasteRevision, input.catalogVersion],
  );
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM taste_seed_runs WHERE job_id = $1 AND owner_account_id = $2',
    [input.jobId, input.accountId],
  );
  const runId = rows[0]!.id;
  await db.query(
    `INSERT INTO taste_seed_categories (run_id, category)
     SELECT $1, c FROM unnest($2::text[]) AS c ON CONFLICT DO NOTHING`,
    [runId, [...input.categories]],
  );
  return runId;
}

/**
 * Queue the seed for an account that completed onboarding. Reuses the active
 * job for the same taste revision (dedupe). When taste_seed_enabled is off for
 * the account nothing is queued and the current status is returned (the feed
 * keeps its labeled examples); onboarding completion never fails because of it.
 */
export async function enqueueTasteSeed(
  db: Queryable,
  input: {
    accountId: string;
    tasteRevision: number;
    catalogVersion: string | null;
    categories?: readonly Category[];
    config: ServiceFeatureEnv;
    traceId?: string;
    now?: Date;
    /** Debounced start (Settings -> Taste reseeds); default now. */
    availableAt?: Date;
  },
): Promise<{ status: TasteSeedStatus; enqueued: boolean; reused: boolean }> {
  const now = input.now ?? new Date();
  const flag = await serviceFeatureState(db, { accountId: input.accountId, env: input.config }, 'taste_seed_enabled');
  if (!flag.enabled) return { status: await getTasteSeedStatus(db, input.accountId, now), enqueued: false, reused: false };
  const categories = input.categories?.length ? [...new Set(input.categories)] : [...CATEGORIES];
  const owner = { kind: 'account' as const, accountId: input.accountId };
  const { job, reused } = await enqueueJob(db, {
    type: 'taste_seed',
    owner,
    payload: { taste_revision: input.tasteRevision, catalog_version: input.catalogVersion, categories },
    dedupeKey: tasteSeedDedupeKey({ owner, tasteRevision: input.tasteRevision }),
    maxAttempts: TASTE_SEED_MAX_ATTEMPTS,
    budget: {
      qloo_requests: TASTE_SEED_MAX_QLOO_REQUESTS,
      provider_retries: TASTE_SEED_INLINE_RETRIES,
      deadline_ms: TASTE_SEED_DEADLINE_MS,
    },
    traceId: input.traceId,
    availableAt: input.availableAt,
    resultType: 'taste_seed',
  });
  await ensureSeedRun(db, {
    accountId: input.accountId,
    jobId: job.id,
    tasteRevision: input.tasteRevision,
    catalogVersion: input.catalogVersion,
    categories: job.payload.categories,
  });
  return { status: await getTasteSeedStatus(db, input.accountId, now), enqueued: !reused, reused };
}

/**
 * Food exclusions from account preferences (`food.exclusions`), accepted as
 * a nested object or a dotted key. Invalid values read as none. Used only to
 * filter Eat suggestions; never sent to a provider.
 */
export function readFoodExclusions(preferences: unknown): string[] {
  if (!preferences || typeof preferences !== 'object') return [];
  const prefs = preferences as Record<string, unknown>;
  const nested = prefs['food'] && typeof prefs['food'] === 'object' ? (prefs['food'] as Record<string, unknown>)['exclusions'] : undefined;
  const raw = nested ?? prefs['food.exclusions'];
  const parsed = FoodExclusions.safeParse(raw ?? []);
  return parsed.success ? parsed.data : [];
}
