import type { InferenceAttempt, SpendControl, SpendScope, SpendState, SpendStore } from './budget';
import type { ModelRole } from './types';

/** Structurally compatible with domain Db; no provider -> domain runtime dependency. */
export interface GatewayDb {
  readonly inTransaction: boolean;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[] }>;
  transaction<T>(fn: (tx: GatewayDb) => Promise<T>): Promise<T>;
}

interface AttemptRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  job_id: string;
  asset_id: string | null;
  queue_attempt_id: string | null;
  role: ModelRole;
  attempt_key: string;
  gateway: string;
  requested_model: string;
  requested_provider: string;
  returned_model: string | null;
  actual_provider: string | null;
  profile_version: string;
  prompt_version: string;
  schema_version: string;
  pricing_snapshot_version: string;
  response_id: string | null;
  request_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reserved_micros: string;
  cost_micros: string | null;
  state: InferenceAttempt['state'];
  outcome: string;
  usage_day: string;
  started_at: Date;
  completed_at: Date | null;
}

const COLUMNS = `id, account_id, job_id, asset_id, queue_attempt_id, role, attempt_key, gateway,
  requested_model, requested_provider, returned_model, actual_provider, profile_version,
  prompt_version, schema_version, pricing_snapshot_version, response_id, request_id,
  input_tokens, output_tokens, reserved_micros::text AS reserved_micros,
  cost_micros::text AS cost_micros, state, outcome, to_char(usage_day, 'YYYY-MM-DD') AS usage_day,
  started_at, completed_at`;

function fromRow(r: AttemptRow): InferenceAttempt {
  return {
    id: r.id,
    identity: {
      accountId: r.account_id,
      jobId: r.job_id,
      attemptKey: r.attempt_key,
      ...(r.asset_id ? { assetId: r.asset_id } : {}),
      ...(r.queue_attempt_id ? { queueAttemptId: r.queue_attempt_id } : {}),
    },
    day: r.usage_day,
    role: r.role,
    gateway: r.gateway,
    requestedModel: r.requested_model,
    requestedProvider: r.requested_provider,
    returnedModel: r.returned_model,
    actualProvider: r.actual_provider,
    responseId: r.response_id,
    requestId: r.request_id,
    profileVersion: r.profile_version,
    promptVersion: r.prompt_version,
    schemaVersion: r.schema_version,
    pricingSnapshotVersion: r.pricing_snapshot_version,
    reservedMicros: Number(r.reserved_micros),
    costMicros: r.cost_micros === null ? null : Number(r.cost_micros),
    usage:
      r.input_tokens === null || r.output_tokens === null
        ? null
        : { inputTokens: r.input_tokens, outputTokens: r.output_tokens },
    state: r.state,
    outcome: r.outcome,
    startedAt: r.started_at.getTime(),
    completedAt: r.completed_at ? r.completed_at.getTime() : null,
  };
}

function params(a: InferenceAttempt): unknown[] {
  return [
    a.id,
    a.identity.accountId,
    a.identity.jobId,
    a.identity.assetId ?? null,
    a.identity.queueAttemptId ?? null,
    a.role,
    a.identity.attemptKey,
    a.gateway,
    a.requestedModel,
    a.requestedProvider,
    a.returnedModel,
    a.actualProvider,
    a.profileVersion,
    a.promptVersion,
    a.schemaVersion,
    a.pricingSnapshotVersion,
    a.responseId,
    a.requestId ?? null,
    a.usage?.inputTokens ?? null,
    a.usage?.outputTokens ?? null,
    a.reservedMicros,
    a.costMicros,
    a.state,
    a.outcome.slice(0, 64),
    a.day,
    new Date(a.startedAt),
    a.completedAt === null ? null : new Date(a.completedAt),
  ];
}

/**
 * The control row lock serializes every policy decision across processes; the
 * decision then sees only the rows that can affect it (the UTC day's attempts,
 * every unsettled attempt, and the attempt/identity being touched) instead of
 * the whole history. Deliberately no lease-based reservation expiry: a crashed
 * dispatch remains charged until billing reconciliation.
 */
export class PostgresSpendStore implements SpendStore {
  readonly durable = true;
  constructor(private readonly db: GatewayDb) {
    // A caller transaction might roll back AFTER HTTP dispatch. Require an independently committed ledger.
    if (db.inTransaction) throw new Error('Spend ledger requires a pool-level database handle');
  }
  async readControl(): Promise<SpendControl> {
    const result = await this.db.query<{
      pause: SpendState['pause'];
      circuits: SpendControl['circuits'];
    }>('SELECT pause, circuits FROM model_gateway_control WHERE id = 1');
    if (result.rows.length !== 1) throw new Error('Model gateway migration required');
    return { pause: result.rows[0]!.pause, circuits: result.rows[0]!.circuits ?? {} };
  }
  async read(): Promise<SpendState> {
    const control = await this.readControl();
    const rows = await this.db.query<AttemptRow>(
      `SELECT ${COLUMNS} FROM inference_attempts ORDER BY started_at, id`,
    );
    return { ...control, attempts: rows.rows.map(fromRow) };
  }
  async transaction<T>(update: (state: SpendState) => T, scope?: SpendScope): Promise<T> {
    return this.db.transaction(async (tx) => {
      const control = await tx.query<{
        pause: SpendState['pause'];
        circuits: SpendControl['circuits'];
      }>('SELECT pause, circuits FROM model_gateway_control WHERE id = 1 FOR UPDATE');
      if (control.rows.length !== 1) throw new Error('Model gateway migration required');
      const rows = scope
        ? await tx.query<AttemptRow>(
            `SELECT ${COLUMNS} FROM inference_attempts
              WHERE usage_day = $1::date OR state <> 'settled' OR id = $2::uuid
                 OR (account_id = $3::uuid AND job_id = $4 AND role = $5 AND attempt_key = $6)
              ORDER BY started_at, id`,
            [
              scope.day,
              scope.attemptId ?? null,
              scope.identity?.accountId ?? null,
              scope.identity?.jobId ?? null,
              scope.identity?.role ?? null,
              scope.identity?.attemptKey ?? null,
            ],
          )
        : await tx.query<AttemptRow>(
            `SELECT ${COLUMNS} FROM inference_attempts ORDER BY started_at, id`,
          );
      const state: SpendState = {
        pause: control.rows[0]!.pause,
        circuits: control.rows[0]!.circuits ?? {},
        attempts: rows.rows.map(fromRow),
      };
      const prior = new Map(state.attempts.map((a) => [a.id, JSON.stringify(a)]));
      const priorControl = JSON.stringify({ pause: state.pause, circuits: state.circuits });
      const result = update(state);
      for (const attempt of state.attempts) {
        if (prior.get(attempt.id) === JSON.stringify(attempt)) continue;
        await tx.query(
          `INSERT INTO inference_attempts (id, account_id, job_id, asset_id, queue_attempt_id, role,
             attempt_key, gateway, requested_model, requested_provider, returned_model, actual_provider,
             profile_version, prompt_version, schema_version, pricing_snapshot_version, response_id,
             request_id, input_tokens, output_tokens, reserved_micros, cost_micros, state, outcome,
             usage_day, started_at, completed_at, settled_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,
             $25::date,$26,$27, CASE WHEN $23 = 'settled' THEN now() END)
           ON CONFLICT (id) DO UPDATE SET returned_model=EXCLUDED.returned_model,
             actual_provider=EXCLUDED.actual_provider, response_id=EXCLUDED.response_id,
             request_id=EXCLUDED.request_id, input_tokens=EXCLUDED.input_tokens,
             output_tokens=EXCLUDED.output_tokens, cost_micros=EXCLUDED.cost_micros,
             state=EXCLUDED.state, outcome=EXCLUDED.outcome, completed_at=EXCLUDED.completed_at,
             settled_at=COALESCE(inference_attempts.settled_at, EXCLUDED.settled_at)`,
          params(attempt),
        );
      }
      if (JSON.stringify({ pause: state.pause, circuits: state.circuits }) !== priorControl)
        await tx.query(
          'UPDATE model_gateway_control SET pause = $1::jsonb, circuits = $2::jsonb WHERE id = 1',
          [JSON.stringify(state.pause), JSON.stringify(state.circuits ?? {})],
        );
      return result;
    });
  }
}
