import { ProviderError } from '../errors';
import type { GatewayDb } from '../model-gateway/postgres';
import type { QlooRateGate } from './client';

export interface QlooRateGateOptions {
  /** Stable, non-secret id for the key (a fingerprint, never the key). */
  keyId: string;
  /** Sustained dispatches per second across every process (default 8; the key allows 10). */
  ratePerSecond: number;
  /** Admitted requests per UTC day across every process; past it every acquire throws budget_exhausted. */
  dailyLimit: number;
  /** Bucket size (default = ratePerSecond): the largest burst after an idle period. */
  burst?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called once when the table cannot be used (migration missing): the gate then admits (fail open). */
  onError?: (err: unknown) => void;
}

interface BucketRow extends Record<string, unknown> {
  tokens: number;
  elapsed_ms: number;
  day_changed: boolean;
  day_count: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('qloo', 'aborted', 'qloo request aborted while waiting for the rate gate'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Cross-process token bucket and daily request counter for one Qloo key
 * (style design R-11). web, worker and media-worker share the key, so
 * in-process spacing alone cannot keep it under 10 requests a second. The
 * bucket lives in `qloo_rate_buckets` and is refilled from the database
 * clock inside a row-locked transaction, so every process sees one rate.
 */
export class PostgresQlooRateGate implements QlooRateGate {
  /** After a database error the gate admits for a minute (fail open), then tries again. */
  private bypassUntil = 0;
  private reported = false;
  constructor(
    private readonly db: GatewayDb | (() => GatewayDb),
    private readonly opts: QlooRateGateOptions,
  ) {
    if (!(opts.ratePerSecond > 0) || !(opts.dailyLimit > 0)) throw new Error('Invalid Qloo rate gate limits');
  }

  private handle(): GatewayDb {
    return typeof this.db === 'function' ? this.db() : this.db;
  }

  /** One admission decision: admitted, or the wait (ms) before the next token. Throws past the daily limit. */
  async tryAcquire(): Promise<{ admitted: boolean; waitMs: number }> {
    const rate = this.opts.ratePerSecond;
    const burst = this.opts.burst ?? rate;
    return this.handle().transaction(async (tx) => {
      await tx.query(
        `INSERT INTO qloo_rate_buckets (key_id, tokens, refilled_at, day, day_count)
         VALUES ($1, $2, clock_timestamp(), (clock_timestamp() AT TIME ZONE 'utc')::date, 0)
         ON CONFLICT (key_id) DO NOTHING`,
        [this.opts.keyId, burst],
      );
      const { rows } = await tx.query<BucketRow>(
        `SELECT tokens, EXTRACT(EPOCH FROM (clock_timestamp() - refilled_at)) * 1000 AS elapsed_ms,
                day <> (clock_timestamp() AT TIME ZONE 'utc')::date AS day_changed, day_count
           FROM qloo_rate_buckets WHERE key_id = $1 FOR UPDATE`,
        [this.opts.keyId],
      );
      const row = rows[0]!;
      const dayCount = row.day_changed ? 0 : Number(row.day_count);
      if (dayCount >= this.opts.dailyLimit)
        throw new ProviderError('qloo', 'budget_exhausted', 'qloo daily request limit reached');
      const tokens = Math.min(burst, Number(row.tokens) + (Math.max(0, Number(row.elapsed_ms)) / 1000) * rate);
      const admitted = tokens >= 1;
      await tx.query(
        `UPDATE qloo_rate_buckets
            SET tokens = $2, refilled_at = clock_timestamp(),
                day = (clock_timestamp() AT TIME ZONE 'utc')::date, day_count = $3
          WHERE key_id = $1`,
        [this.opts.keyId, admitted ? tokens - 1 : tokens, admitted ? dayCount + 1 : dayCount],
      );
      return { admitted, waitMs: admitted ? 0 : Math.ceil(((1 - tokens) / rate) * 1000) };
    });
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (Date.now() < this.bypassUntil) return;
    const sleep = this.opts.sleep ?? defaultSleep;
    for (;;) {
      if (signal?.aborted) throw new ProviderError('qloo', 'aborted', 'qloo request aborted while waiting for the rate gate');
      let decision: { admitted: boolean; waitMs: number };
      try {
        decision = await this.tryAcquire();
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        // No table yet (migration 190 not applied) or the database is down: in-process spacing still applies.
        this.bypassUntil = Date.now() + 60_000;
        if (!this.reported) this.opts.onError?.(err);
        this.reported = true;
        return;
      }
      if (decision.admitted) return;
      await sleep(Math.max(5, decision.waitMs), signal);
    }
  }
}
