import type { Queryable } from '../db/pool';
import { CATEGORIES, type Category } from '../enums';
import { serviceFeatureState, type ServiceFeatureEnv } from '../flags/feature-flags';
import { interestExpandDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';

/** Pull-to-refresh inside this window reuses the in-flight or completed wave. */
export const INTEREST_EXPAND_WINDOW_MS = 15 * 60 * 1000;
export const INTEREST_EXPAND_MAX_QLOO_REQUESTS = 4;
export const INTEREST_EXPAND_DEADLINE_MS = 45_000;
export const INTEREST_EXPAND_MAX_ATTEMPTS = 3;

export function interestExpandWave(now: Date): number {
  return Math.floor(now.getTime() / INTEREST_EXPAND_WINDOW_MS);
}

export function interestExpandCategory(wave: number): Category {
  return CATEGORIES[wave % CATEGORIES.length]!;
}

/**
 * Ask the worker to walk one more lane of the owner's interest graph.
 * Pull-to-refresh enqueues this; the GET itself never calls Qloo. Failures
 * here must not fail the feed read — the cards already on screen stay.
 */
export async function enqueueInterestExpand(
  db: Queryable,
  input: { accountId: string; now?: Date; traceId?: string; config: ServiceFeatureEnv },
): Promise<{ enqueued: boolean; reused: boolean }> {
  try {
    const now = input.now ?? new Date();
    const flag = await serviceFeatureState(db, { accountId: input.accountId, env: input.config }, 'taste_seed_enabled');
    if (!flag.enabled) return { enqueued: false, reused: false };
    const seed = await db.query<{ id: string }>(
      `SELECT id FROM taste_seed_runs
        WHERE owner_account_id = $1 AND state IN ('complete', 'partial')
        ORDER BY updated_at DESC LIMIT 1`,
      [input.accountId],
    );
    if (!seed.rows[0]) return { enqueued: false, reused: false };
    const owner = { kind: 'account' as const, accountId: input.accountId };
    const wave = interestExpandWave(now);
    const { reused } = await enqueueJob(db, {
      type: 'interest_expand',
      owner,
      payload: { wave, category: interestExpandCategory(wave) },
      dedupeKey: interestExpandDedupeKey({ owner, wave }),
      maxAttempts: INTEREST_EXPAND_MAX_ATTEMPTS,
      budget: {
        qloo_requests: INTEREST_EXPAND_MAX_QLOO_REQUESTS,
        provider_retries: 0,
        deadline_ms: INTEREST_EXPAND_DEADLINE_MS,
      },
      traceId: input.traceId,
      resultType: 'interest_expand',
    });
    return { enqueued: !reused, reused };
  } catch {
    return { enqueued: false, reused: false };
  }
}
