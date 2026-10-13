import type { ProviderRegistry } from '@culture-atlas/providers';
import type { DomainConfig } from '../config';
import { createServiceContext } from '../context';
import type { Db, Queryable } from '../db/pool';
import { AppError } from '../errors';
import { enqueueJob } from '../jobs/queue';
import type { AccountPrincipal } from '../principal';
import * as captures from '../services/captures';
import { CredentialError, decryptCredential, parseEncryptionKey } from './credentials';
import {
  RelayClient,
  RelayError,
  SinkError,
  isAllowedOrigin,
  syncOnce,
  type ImportOutcome,
  type RelayAsset,
  type RelayContent,
  type SyncResult,
  type SyncSink,
  type SyncState,
} from './relay';

/**
 * Server-side World Sensor importer ('poll' mode). The sensor_poll job calls
 * `runSensorPoll` every SENSOR_POLL_INTERVAL_MS while the connection is
 * enabled. Photos become captures through the same capture service as
 * uploads (source 'sensor', captured_at preserved, received_at = import time),
 * deduplicated by connection + asset_id in `sensor_imports`. Imports never
 * create saves or preference events, so they never count as likes.
 */

export interface SensorConnectionRow {
  id: string;
  owner_account_id: string;
  configured_origin: string;
  mode: 'poll' | 'bridge';
  encrypted_viewer_credential: Buffer | null;
  credential_key_id: string | null;
  cursor: string | null;
  enabled: boolean;
  pending_selection: string[];
  baseline_at: Date | null;
  consecutive_failures: number;
  disabled_at: Date | null;
}

export async function loadSensorConnection(db: Queryable, id: string): Promise<SensorConnectionRow | null> {
  const { rows } = await db.query<SensorConnectionRow>(
    `SELECT id, owner_account_id, configured_origin, mode, encrypted_viewer_credential, credential_key_id, cursor,
            enabled, pending_selection, baseline_at, consecutive_failures, disabled_at
       FROM sensor_connections WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Ledger-backed sink that imports through the capture service as the connection's owner. */
export class DbSyncSink implements SyncSink {
  constructor(
    private readonly deps: { db: Db; providers: ProviderRegistry; config: DomainConfig; now: () => Date },
    private readonly connection: Pick<SensorConnectionRow, 'id' | 'owner_account_id'>,
  ) {}

  async isKnown(assetId: string): Promise<boolean> {
    const { rows } = await this.deps.db.query('SELECT 1 FROM sensor_imports WHERE sensor_connection_id = $1 AND asset_id = $2', [this.connection.id, assetId]);
    return rows.length > 0;
  }

  async importAsset(asset: RelayAsset, content: RelayContent): Promise<ImportOutcome> {
    const principal: AccountPrincipal = { kind: 'account', accountId: this.connection.owner_account_id, sessionId: null, isDemoOwner: false };
    const ctx = createServiceContext(principal, { ...this.deps, surface: 'worker' });
    try {
      const upload = await captures.createUpload(ctx, { bytes: content.bytes, declaredContentType: content.content_type });
      const res = await captures.createCapture(ctx, {
        kind: 'json',
        body: {
          upload_id: upload.upload_id,
          sensor: {
            connection_id: this.connection.id,
            asset_id: asset.asset_id,
            ...(asset.captured_at ? { captured_at: asset.captured_at } : {}),
            ...(asset.sha256 ? { declared_sha256: asset.sha256 } : {}),
          },
        },
      });
      return res.reused ? 'duplicate' : 'imported';
    } catch (err) {
      // Already imported (for example, imported and then deleted by the user).
      if (err instanceof AppError && err.code === 'conflict') return 'duplicate';
      throw toSinkError(err);
    }
  }

  async recordSkipped(asset: RelayAsset, status: 'failed' | 'skipped', code: string): Promise<void> {
    await this.deps.db.query(
      `INSERT INTO sensor_imports (sensor_connection_id, asset_id, declared_sha256, captured_at, status, error_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (sensor_connection_id, asset_id) DO NOTHING`,
      [this.connection.id, asset.asset_id, asset.sha256, asset.captured_at, status, code],
    );
  }

  async saveState(state: SyncState): Promise<void> {
    await this.deps.db.query(
      `UPDATE sensor_connections
          SET cursor = $2,
              pending_selection = $3,
              baseline_at = CASE WHEN $4::boolean THEN COALESCE(baseline_at, $5) ELSE baseline_at END,
              updated_at = $5
        WHERE id = $1`,
      [this.connection.id, state.cursor, state.selection, state.baselineDone, this.deps.now()],
    );
  }
}

/** Map capture-service failures onto the sync's asset/connection scopes. */
export function toSinkError(err: unknown): unknown {
  if (!(err instanceof AppError)) return err;
  switch (err.code) {
    case 'unsupported_image':
    case 'payload_too_large':
    case 'invalid_input':
      return new SinkError('asset', err.code, err.message);
    case 'not_found':
    case 'scope_denied':
    case 'account_required':
      return new SinkError('connection', 'connection_unavailable', err.message, { fatal: true });
    case 'quota_exceeded':
    case 'rate_limited':
      return new SinkError('connection', err.code, err.message, { retryAfterMs: 15 * 60_000 });
    default:
      if (err.retryable) return new SinkError('connection', err.code, err.message);
      return err;
  }
}

/** Errors that mean "the relay is offline/unhealthy" rather than "something needs fixing". */
const OFFLINE_CODES = new Set(['relay_unreachable', 'relay_timeout', 'relay_server_error', 'relay_rate_limited']);

export type SensorStatus = 'connecting' | 'active' | 'offline' | 'needs_attention' | 'disabled';

export function sensorStatus(row: { enabled: boolean; disabled_at: Date | null; baseline_at: Date | null; last_error_code: string | null; mode: 'poll' | 'bridge' }): SensorStatus {
  if (!row.enabled || row.disabled_at) return 'disabled';
  if (row.last_error_code) return OFFLINE_CODES.has(row.last_error_code) ? 'offline' : 'needs_attention';
  if (row.mode === 'poll' && !row.baseline_at) return 'connecting';
  return 'active';
}

export interface SensorPollDeps {
  db: Db;
  providers: ProviderRegistry;
  config: DomainConfig;
  now?: () => Date;
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

export interface SensorPollOutcome {
  /** False when the connection is gone, disabled or not in poll mode: stop polling. */
  reschedule: boolean;
  nextPollAt: Date | null;
  errorCode: string | null;
  sync: Pick<SyncResult, 'imported' | 'duplicates' | 'failed' | 'baselineSkipped' | 'selectionNotFound' | 'pendingUncommitted' | 'pagesRead' | 'more'> | null;
}

/** Backoff while failing: interval * 2^failures, capped at 5 minutes, at least Retry-After. */
export function nextPollDelayMs(intervalMs: number, failures: number, opts: { more?: boolean; retryAfterMs?: number } = {}): number {
  if (failures <= 0) return opts.more ? Math.min(1000, intervalMs) : intervalMs;
  const backoff = Math.min(intervalMs * 2 ** Math.min(failures, 8), 5 * 60_000);
  return Math.max(backoff, Math.min(opts.retryAfterMs ?? 0, 60 * 60_000));
}

function errorCode(err: RelayError | SinkError | CredentialError | { code: string }): string {
  return err instanceof RelayError ? `relay_${err.code}` : err.code;
}

/** One poll: list newly committed photos and import them. Never throws for relay or credential problems. */
export async function runSensorPoll(connectionId: string, deps: SensorPollDeps): Promise<SensorPollOutcome> {
  const now = deps.now ?? (() => new Date());
  const conn = await loadSensorConnection(deps.db, connectionId);
  if (!conn || !conn.enabled || conn.disabled_at || conn.mode !== 'poll') {
    return { reschedule: false, nextPollAt: null, errorCode: null, sync: null };
  }
  const interval = deps.config.SENSOR_POLL_INTERVAL_MS;

  const fail = async (code: string, retryAfterMs?: number): Promise<SensorPollOutcome> => {
    const failures = conn.consecutive_failures + 1;
    const at = now();
    await deps.db.query(
      `UPDATE sensor_connections SET last_attempt_at = $2, last_error_code = $3, consecutive_failures = $4, updated_at = $2 WHERE id = $1`,
      [conn.id, at, code, failures],
    );
    deps.log?.('sensor poll failed', { connection_id: conn.id, code, failures });
    return { reschedule: true, nextPollAt: new Date(at.getTime() + nextPollDelayMs(interval, failures, { retryAfterMs })), errorCode: code, sync: null };
  };

  // The allowlist is re-checked on every poll: removing an origin stops fetching.
  if (!isAllowedOrigin(conn.configured_origin, deps.config.SENSOR_ALLOWED_ORIGINS)) return fail('origin_not_allowed');
  const key = parseEncryptionKey(deps.config.CREDENTIAL_ENCRYPTION_KEY);
  if (!key) return fail('credential_key_missing');
  let credential: string;
  try {
    credential = decryptCredential(conn.encrypted_viewer_credential, conn.credential_key_id, key, conn.id);
  } catch (err) {
    if (err instanceof CredentialError) return fail(err.code);
    throw err;
  }

  const client = new RelayClient({
    origin: conn.configured_origin,
    allowedOrigins: deps.config.SENSOR_ALLOWED_ORIGINS,
    credential,
    maxAssetBytes: Math.min(deps.config.SENSOR_MAX_ASSET_BYTES, deps.config.UPLOAD_MAX_BYTES),
    timeoutMs: 15_000,
    fetch: deps.fetch,
  });
  const sink = new DbSyncSink({ db: deps.db, providers: deps.providers, config: deps.config, now }, conn);
  const result = await syncOnce(
    client,
    { cursor: conn.cursor, baselineDone: conn.baseline_at !== null, selection: conn.pending_selection },
    sink,
    { pageSize: 50, maxPages: 20, maxImports: 25, signal: deps.signal },
  );

  const at = now();
  const summary = {
    imported: result.imported,
    duplicates: result.duplicates,
    failed: result.failed,
    baselineSkipped: result.baselineSkipped,
    selectionNotFound: result.selectionNotFound,
    pendingUncommitted: result.pendingUncommitted,
    pagesRead: result.pagesRead,
    more: result.more,
  };
  if (result.error) {
    const code = errorCode(result.error);
    const failures = conn.consecutive_failures + 1;
    await deps.db.query(
      `UPDATE sensor_connections
          SET last_attempt_at = $2, last_error_code = $3, consecutive_failures = $4, updated_at = $2,
              last_imported_at = CASE WHEN $5::int > 0 THEN $2 ELSE last_imported_at END
        WHERE id = $1`,
      [conn.id, at, code, failures, result.imported.length],
    );
    const fatal = result.error instanceof SinkError && result.error.options.fatal === true;
    deps.log?.('sensor poll stopped', { connection_id: conn.id, code, imported: result.imported.length });
    return {
      reschedule: !fatal,
      nextPollAt: fatal ? null : new Date(at.getTime() + nextPollDelayMs(interval, failures, { retryAfterMs: result.error.options.retryAfterMs })),
      errorCode: code,
      sync: summary,
    };
  }
  await deps.db.query(
    `UPDATE sensor_connections
        SET last_attempt_at = $2, last_success_at = $2, last_error_code = NULL, consecutive_failures = 0, updated_at = $2,
            last_imported_at = CASE WHEN $3::int > 0 THEN $2 ELSE last_imported_at END
      WHERE id = $1`,
    [conn.id, at, result.imported.length],
  );
  return { reschedule: true, nextPollAt: new Date(at.getTime() + nextPollDelayMs(interval, 0, { more: result.more })), errorCode: null, sync: summary };
}

/**
 * Ensure exactly one active poll job exists for a connection. Serialized per
 * connection with an advisory lock, so concurrent callers (the poll handler
 * rescheduling itself, connection setup, the worker's healing sweep) agree.
 */
export async function scheduleSensorPoll(
  db: Db,
  input: { connectionId: string; ownerAccountId: string; availableAt: Date; excludeJobId?: string },
): Promise<{ jobId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sensor_poll:${input.connectionId}`]);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM jobs
        WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1 AND state IN ('queued', 'running')
          AND ($2::uuid IS NULL OR id <> $2::uuid)
        LIMIT 1`,
      [input.connectionId, input.excludeJobId ?? null],
    );
    if (rows[0]) return { jobId: rows[0].id, created: false };
    const { job } = await enqueueJob(tx, {
      type: 'sensor_poll',
      owner: { kind: 'account', accountId: input.ownerAccountId },
      payload: { sensor_connection_id: input.connectionId },
      availableAt: input.availableAt,
      maxAttempts: 3,
      // Polls are short; this bounds one attempt well under the analysis deadline.
      budget: { deadline_ms: 55_000 },
      resultType: 'sensor_connection',
      resultId: input.connectionId,
    });
    return { jobId: job.id, created: true };
  });
}

/**
 * Healing sweep for the worker: every enabled poll-mode connection gets a
 * poll job if its chain was broken (for example, a poll that failed every
 * attempt). Returns the number of jobs created.
 */
export async function ensureSensorPollJobs(db: Db, now: Date = new Date()): Promise<number> {
  const { rows } = await db.query<{ id: string; owner_account_id: string }>(
    `SELECT sc.id, sc.owner_account_id FROM sensor_connections sc
      WHERE sc.enabled AND sc.disabled_at IS NULL AND sc.mode = 'poll'
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.type = 'sensor_poll'
                          AND j.payload->>'sensor_connection_id' = sc.id::text AND j.state IN ('queued', 'running'))`,
  );
  let created = 0;
  for (const r of rows) {
    const res = await scheduleSensorPoll(db, { connectionId: r.id, ownerAccountId: r.owner_account_id, availableAt: now });
    if (res.created) created++;
  }
  return created;
}
