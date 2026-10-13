import { createHash } from 'node:crypto';
import type { Queryable } from './db/pool';
import { AppError } from './errors';
import { principalKey, type Principal } from './principal';
import { stableStringify } from './util/stable-json';

/**
 * Idempotency-Key support for mutations (REST and MCP).
 * Scope: principal + route. Stored for 24 hours with the request hash and
 * response. Same key + same payload -> stored response is replayed.
 * Same key + different payload -> 409 idempotency_conflict.
 * Same key while the first request is still running -> 409 idempotency_in_progress (retryable).
 * If the handler throws, the key is released so the client can retry.
 */

export interface StoredResponse {
  status: number;
  body: unknown;
}

export interface IdempotencyInput {
  principal: Principal;
  /** e.g. "POST /v1/collections" (use the route template, not the concrete URL). */
  route: string;
  key: string;
  /** Anything identifying the request: params + body. */
  request: unknown;
}

export function hashRequest(request: unknown): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-:.]{1,255}$/;

export async function withIdempotency(
  db: Queryable,
  input: IdempotencyInput,
  run: () => Promise<StoredResponse>,
): Promise<StoredResponse & { replayed: boolean }> {
  if (!IDEMPOTENCY_KEY_PATTERN.test(input.key)) {
    throw new AppError('invalid_input', { message: 'Idempotency-Key is not valid.' });
  }
  const pKey = principalKey(input.principal);
  const requestHash = hashRequest(input.request);

  // Expired keys are treated as absent.
  await db.query(
    `DELETE FROM idempotency_keys WHERE principal_key = $1 AND route = $2 AND key = $3 AND expires_at < now()`,
    [pKey, input.route, input.key],
  );
  const claimed = await db.query(
    `INSERT INTO idempotency_keys (principal_key, route, key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (principal_key, route, key) DO NOTHING
     RETURNING id`,
    [pKey, input.route, input.key, requestHash],
  );

  if (claimed.rowCount === 0) {
    const { rows } = await db.query<{
      request_hash: string;
      state: 'in_progress' | 'complete';
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT request_hash, state, response_status, response_body FROM idempotency_keys
        WHERE principal_key = $1 AND route = $2 AND key = $3`,
      [pKey, input.route, input.key],
    );
    const existing = rows[0];
    if (!existing) throw new AppError('idempotency_in_progress');
    if (existing.request_hash !== requestHash) throw new AppError('idempotency_conflict');
    if (existing.state !== 'complete') throw new AppError('idempotency_in_progress');
    return { status: existing.response_status ?? 200, body: existing.response_body, replayed: true };
  }

  let response: StoredResponse;
  try {
    response = await run();
  } catch (err) {
    await db.query(`DELETE FROM idempotency_keys WHERE principal_key = $1 AND route = $2 AND key = $3`, [
      pKey,
      input.route,
      input.key,
    ]);
    throw err;
  }
  await db.query(
    `UPDATE idempotency_keys SET state = 'complete', response_status = $4, response_body = $5::jsonb
      WHERE principal_key = $1 AND route = $2 AND key = $3`,
    [pKey, input.route, input.key, response.status, JSON.stringify(response.body ?? null)],
  );
  return { ...response, replayed: false };
}

/** Housekeeping: remove expired keys. */
export async function purgeExpiredIdempotencyKeys(db: Queryable): Promise<number> {
  const r = await db.query('DELETE FROM idempotency_keys WHERE expires_at < now()');
  return r.rowCount ?? 0;
}
