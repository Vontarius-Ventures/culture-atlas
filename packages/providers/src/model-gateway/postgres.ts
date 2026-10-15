import type { SpendState, SpendStore, InferenceAttempt } from './budget';

/** Structurally compatible with domain Db; no provider -> domain runtime dependency. */
export interface GatewayDb {
  readonly inTransaction: boolean;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
  transaction<T>(fn: (tx: GatewayDb) => Promise<T>): Promise<T>;
}

/**
 * Global row lock serializes policy decisions across processes, then attempt rows
 * persist the ledger. Deliberately no lease-based reservation expiry: a crashed
 * dispatch remains charged until billing reconciliation.
 */
export class PostgresSpendStore implements SpendStore {
  readonly durable = true;
  constructor(private readonly db: GatewayDb) {
    // A caller transaction might roll back AFTER HTTP dispatch. Require an independently committed ledger.
    if (db.inTransaction) throw new Error('Spend ledger requires a pool-level database handle');
  }
  async read(): Promise<SpendState> {
    const result = await this.db.query<{
      pause: SpendState['pause'];
      attempts: InferenceAttempt[];
    }>(
      `SELECT pause, COALESCE((SELECT jsonb_agg(payload ORDER BY started_at, id) FROM model_gateway_attempts), '[]'::jsonb) AS attempts
       FROM model_gateway_control WHERE id = 1`,
    );
    if (result.rows.length !== 1) throw new Error('Model gateway migration required');
    return result.rows[0]!;
  }
  async transaction<T>(update: (state: SpendState) => T): Promise<T> {
    return this.db.transaction(async (tx) => {
      const control = await tx.query<{ pause: SpendState['pause'] }>(
        'SELECT pause FROM model_gateway_control WHERE id = 1 FOR UPDATE',
      );
      if (control.rows.length !== 1) throw new Error('Model gateway migration required');
      const rows = await tx.query<{ payload: InferenceAttempt }>(
        'SELECT payload FROM model_gateway_attempts ORDER BY started_at, id',
      );
      const state: SpendState = {
        pause: control.rows[0]!.pause,
        attempts: rows.rows.map((r) => r.payload),
      };
      const prior = new Map(state.attempts.map((a) => [a.id, JSON.stringify(a)]));
      const result = update(state);
      for (const attempt of state.attempts) {
        if (prior.get(attempt.id) === JSON.stringify(attempt)) continue;
        await tx.query(
          `INSERT INTO model_gateway_attempts (id, account_id, job_id, role, attempt_key, state, started_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
           ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state, payload=EXCLUDED.payload`,
          [
            attempt.id,
            attempt.identity.accountId,
            attempt.identity.jobId,
            attempt.role,
            attempt.identity.attemptKey,
            attempt.state,
            new Date(attempt.startedAt),
            JSON.stringify(attempt),
          ],
        );
      }
      await tx.query('UPDATE model_gateway_control SET pause = $1::jsonb WHERE id = 1', [
        JSON.stringify(state.pause),
      ]);
      return result;
    });
  }
}
