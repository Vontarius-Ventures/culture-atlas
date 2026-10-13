import { createHash } from 'node:crypto';
import type { DomainConfig } from './config';
import type { Queryable } from './db/pool';
import { AppError } from './errors';
import type { Principal } from './principal';

/**
 * Daily quotas and per-IP abuse limits backed by `usage_counters`.
 *
 * Buckets never merge anonymous users' data: an anonymous session is counted
 * under its own session id, an account (browser or agent) under its account
 * id, and an IP under a hash of the address (raw addresses and images are
 * never stored in rate-limit rows).
 */

export type QuotaMetric = 'analyses' | 'plans';

/** UTC day 'YYYY-MM-DD' for a timestamp. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight (Retry-After for daily limits). */
export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Atomically add `amount` to a counter if it stays within `limit`.
 * Returns the new count, or null when the limit would be exceeded (no change).
 */
export async function tryConsume(
  db: Queryable,
  input: { bucket: string; metric: string; day: string; limit: number; amount?: number },
): Promise<number | null> {
  const amount = input.amount ?? 1;
  if (amount > input.limit) return null;
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO usage_counters (bucket, metric, day, count) VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (bucket, metric, day) DO UPDATE SET count = usage_counters.count + EXCLUDED.count
       WHERE usage_counters.count + EXCLUDED.count <= $5
     RETURNING count`,
    [input.bucket, input.metric, input.day, amount, input.limit],
  );
  return rows[0]?.count ?? null;
}

export async function currentUsage(db: Queryable, bucket: string, metric: string, day: string): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    'SELECT count FROM usage_counters WHERE bucket = $1 AND metric = $2 AND day = $3::date',
    [bucket, metric, day],
  );
  return rows[0]?.count ?? 0;
}

/** Bucket + limit for a principal's daily quota. System principals are unlimited (null). */
export function quotaFor(
  principal: Principal,
  metric: QuotaMetric,
  config: Pick<DomainConfig, 'ANON_DAILY_ANALYSES' | 'ANON_DAILY_PLANS' | 'ACCOUNT_DAILY_ANALYSES' | 'ACCOUNT_DAILY_PLANS'>,
): { bucket: string; limit: number } | null {
  switch (principal.kind) {
    case 'anonymous':
      return {
        bucket: `session:${principal.sessionId}`,
        limit: metric === 'analyses' ? config.ANON_DAILY_ANALYSES : config.ANON_DAILY_PLANS,
      };
    case 'account':
    case 'agent':
      return {
        bucket: `account:${principal.accountId}`,
        limit: metric === 'analyses' ? config.ACCOUNT_DAILY_ANALYSES : config.ACCOUNT_DAILY_PLANS,
      };
    case 'system':
      return null;
  }
}

/**
 * Consume one unit of a daily quota or throw 429 quota_exceeded.
 * Call only when new work is actually created (not for reused jobs), inside
 * the same transaction as the work so a rollback also releases the unit.
 */
export async function consumeDailyQuota(
  db: Queryable,
  input: { principal: Principal; metric: QuotaMetric; config: DomainConfig; now: Date; amount?: number },
): Promise<void> {
  const q = quotaFor(input.principal, input.metric, input.config);
  if (!q) return;
  const used = await tryConsume(db, {
    bucket: q.bucket,
    metric: input.metric,
    day: utcDay(input.now),
    limit: q.limit,
    amount: input.amount,
  });
  if (used === null) {
    throw new AppError('quota_exceeded', {
      message:
        input.metric === 'plans'
          ? 'You have reached today’s plan limit. Try again tomorrow.'
          : 'You have reached today’s photo limit. Try again tomorrow.',
      retryAfter: secondsUntilUtcMidnight(input.now),
    });
  }
}

/** Hash an IP address for the abuse-limit bucket (raw addresses are not stored). */
export function ipBucket(ip: string, secret: string): string {
  return `ip:${createHash('sha256').update(`${secret}:${ip}`).digest('hex').slice(0, 32)}`;
}

/**
 * Per-IP abuse limit (IP_DAILY_REQUESTS). Counts requests that create state
 * (mutations, new anonymous sessions, sign-in attempts). Throws 429 rate_limited.
 */
export async function enforceIpLimit(
  db: Queryable,
  input: { ip: string | null; config: Pick<DomainConfig, 'IP_DAILY_REQUESTS' | 'SESSION_SECRET'>; now: Date; metric?: string; limit?: number },
): Promise<void> {
  if (!input.ip) return;
  const used = await tryConsume(db, {
    bucket: ipBucket(input.ip, input.config.SESSION_SECRET),
    metric: input.metric ?? 'requests',
    day: utcDay(input.now),
    limit: input.limit ?? input.config.IP_DAILY_REQUESTS,
  });
  if (used === null) {
    throw new AppError('rate_limited', { retryAfter: secondsUntilUtcMidnight(input.now) });
  }
}
