import { randomUUID } from 'node:crypto';
import { requireAccountOwner } from '../authz';
import type { ServiceContext } from '../context';
import { AppError } from '../errors';
import { cancelJob, enqueueJob } from '../jobs/queue';
import type {
  CreateSensorConnectionRequest,
  CreateSensorConnectionResponse,
  SensorConnectionDto,
  SensorConnectionsListResponse,
} from '../schemas/sensor-connections';
import { encryptCredential, requireEncryptionKey } from '../sensor/credentials';
import { sensorStatus } from '../sensor/importer';
import { canonicalOrigin, isAllowedOrigin } from '../sensor/relay';
import { addDays, iso } from '../util/time';
import { generateAgentCredential } from './auth';

/** Worker healing sweep (re-exported so the worker can reach it via `sensorConnections`). */
export { ensureSensorPollJobs } from '../sensor/importer';

/**
 * World Sensor connections (account owner in the browser only; agents,
 * bridge tokens and anonymous sessions are refused by requireAccountOwner).
 *
 *  - 'poll': the server polls the relay. The origin must be in
 *    SENSOR_ALLOWED_ORIGINS (https in production) and the viewer credential is
 *    encrypted at rest with CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM). It is never
 *    returned. A sensor_poll job runs every SENSOR_POLL_INTERVAL_MS while the
 *    connection is enabled (packages/domain/src/sensor/importer.ts).
 *  - 'bridge': the server never contacts the relay. The response carries a
 *    restricted capture-write token (shown once) for apps/sensor-bridge:
 *    agent_connections.purpose 'sensor_bridge', scopes ['captures:write'],
 *    library_access 'none', bound to this connection. The bridge holds the
 *    viewer credential locally and selects existing photos itself.
 *
 * First connection imports only the explicitly selected existing photos.
 * Later imports are new photos only, and never count as likes.
 */

interface ConnectionRow {
  id: string;
  configured_origin: string;
  mode: 'poll' | 'bridge';
  enabled: boolean;
  disabled_at: Date | null;
  baseline_at: Date | null;
  last_success_at: Date | null;
  last_attempt_at: Date | null;
  last_error_code: string | null;
  last_imported_at: Date | null;
  created_at: Date;
  imported_count: number;
  bridge_last_used_at: Date | null;
}

const SELECT_CONNECTION = `
  SELECT sc.id, sc.configured_origin, sc.mode, sc.enabled, sc.disabled_at, sc.baseline_at, sc.last_success_at,
         sc.last_attempt_at, sc.last_error_code, sc.created_at,
         GREATEST(sc.last_imported_at, (SELECT max(si.imported_at) FROM sensor_imports si
                                         WHERE si.sensor_connection_id = sc.id AND si.status = 'imported')) AS last_imported_at,
         (SELECT count(*)::int FROM sensor_imports si WHERE si.sensor_connection_id = sc.id AND si.status = 'imported') AS imported_count,
         (SELECT max(ac.last_used_at) FROM agent_connections ac
           WHERE ac.sensor_connection_id = sc.id AND ac.purpose = 'sensor_bridge' AND ac.revoked_at IS NULL) AS bridge_last_used_at
    FROM sensor_connections sc`;

function toDto(r: ConnectionRow): SensorConnectionDto {
  // In bridge mode the server only hears from the bridge when it imports, so
  // the bridge token's last use is the last contact.
  const lastAttempt = r.mode === 'bridge' ? (r.bridge_last_used_at ?? r.last_attempt_at) : r.last_attempt_at;
  const lastSuccess = r.mode === 'bridge' ? (r.last_imported_at ?? r.last_success_at) : r.last_success_at;
  return {
    id: r.id,
    origin: r.configured_origin,
    mode: r.mode,
    enabled: r.enabled && !r.disabled_at,
    last_success_at: lastSuccess ? iso(lastSuccess) : null,
    last_attempt_at: lastAttempt ? iso(lastAttempt) : null,
    last_error_code: r.last_error_code,
    created_at: iso(r.created_at),
    status: sensorStatus(r),
    imported_count: r.imported_count,
    last_imported_at: r.last_imported_at ? iso(r.last_imported_at) : null,
  };
}

/** GET /v1/sensor-connections: enabled connections with their last import status. */
export async function listSensorConnections(ctx: ServiceContext): Promise<SensorConnectionsListResponse> {
  const p = requireAccountOwner(ctx.principal);
  const { rows } = await ctx.db.query<ConnectionRow>(
    `${SELECT_CONNECTION} WHERE sc.owner_account_id = $1 AND sc.disabled_at IS NULL ORDER BY sc.created_at DESC`,
    [p.accountId],
  );
  return { connections: rows.map(toDto) };
}

/** POST /v1/sensor-connections (201). */
export async function createSensorConnection(ctx: ServiceContext, body: CreateSensorConnectionRequest): Promise<CreateSensorConnectionResponse> {
  const p = requireAccountOwner(ctx.principal);
  const origin = canonicalOrigin(body.origin);
  if (!origin) {
    throw new AppError('invalid_input', {
      message: 'Use the relay origin only, like https://relay.example.com:8443 (no path, query or credentials).',
      details: { field: 'origin' },
    });
  }
  if (body.mode === 'poll') {
    if (!isAllowedOrigin(origin, ctx.config.SENSOR_ALLOWED_ORIGINS)) {
      throw new AppError('invalid_input', { message: 'This relay origin is not allowed on this server.', details: { field: 'origin' } });
    }
    if (ctx.config.NODE_ENV === 'production' && !origin.startsWith('https://')) {
      throw new AppError('invalid_input', { message: 'Use an https relay origin.', details: { field: 'origin' } });
    }
    if (!body.viewer_credential) {
      throw new AppError('invalid_input', { message: 'A viewer credential is required in poll mode.', details: { field: 'viewer_credential' } });
    }
  } else if (body.import_existing_asset_ids.length > 0) {
    throw new AppError('invalid_input', {
      message: 'In bridge mode, choose existing photos on the bridge (BRIDGE_IMPORT_EXISTING).',
      details: { field: 'import_existing_asset_ids' },
    });
  }

  const id = randomUUID();
  const encrypted = body.viewer_credential
    ? encryptCredential(body.viewer_credential, requireEncryptionKey(ctx.config.CREDENTIAL_ENCRYPTION_KEY), id)
    : null;
  const selection = [...new Set(body.import_existing_asset_ids)];
  const now = ctx.now();

  return ctx.db.transaction(async (tx) => {
    // One active connection per owner and origin.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`sensor_connection:${p.accountId}:${origin}`]);
    const dup = await tx.query(
      'SELECT 1 FROM sensor_connections WHERE owner_account_id = $1 AND configured_origin = $2 AND disabled_at IS NULL',
      [p.accountId, origin],
    );
    if (dup.rows.length > 0) {
      throw new AppError('conflict', { message: 'This relay is already connected. Disconnect it first to reconnect.' });
    }
    await tx.query(
      `INSERT INTO sensor_connections (id, owner_account_id, configured_origin, mode, encrypted_viewer_credential,
                                       credential_key_id, enabled, pending_selection, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $8)`,
      [id, p.accountId, origin, body.mode, encrypted?.blob ?? null, encrypted?.keyId ?? null, selection, now],
    );

    let bridgeToken: string | null = null;
    if (body.mode === 'bridge') {
      const cred = generateAgentCredential();
      await tx.query(
        `INSERT INTO agent_connections (owner_account_id, client_name, purpose, credential_hash, credential_prefix, scopes,
                                        library_access, sensor_connection_id, expires_at)
         VALUES ($1, 'World Sensor bridge', 'sensor_bridge', $2, $3, ARRAY['captures:write'], 'none', $4, $5)`,
        [p.accountId, cred.hash, cred.prefix, id, addDays(now, ctx.config.AGENT_TOKEN_DEFAULT_TTL_DAYS)],
      );
      bridgeToken = cred.credential;
    } else {
      // First poll right away: classifies existing photos and imports the selection.
      await enqueueJob(tx, {
        type: 'sensor_poll',
        owner: { kind: 'account', accountId: p.accountId },
        payload: { sensor_connection_id: id },
        availableAt: now,
        maxAttempts: 3,
        budget: { deadline_ms: 55_000 },
        resultType: 'sensor_connection',
        resultId: id,
      });
    }

    const { rows } = await tx.query<ConnectionRow>(`${SELECT_CONNECTION} WHERE sc.id = $1`, [id]);
    return { connection: toDto(rows[0]!), bridge_token: bridgeToken };
  });
}

/**
 * DELETE /v1/sensor-connections/{id}: stops imports immediately, deletes the
 * stored credential, revokes the bridge token and cancels pending polls.
 * Imported captures stay (delete them individually); the import ledger stays
 * so the same photos are not re-imported by this connection.
 */
export async function deleteSensorConnection(ctx: ServiceContext, input: { id: string }): Promise<void> {
  const p = requireAccountOwner(ctx.principal);
  const now = ctx.now();
  const jobIds = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE sensor_connections
          SET enabled = false, disabled_at = COALESCE(disabled_at, $3), encrypted_viewer_credential = NULL,
              credential_key_id = NULL, pending_selection = ARRAY[]::text[], updated_at = $3
        WHERE id = $1 AND owner_account_id = $2
        RETURNING id`,
      [input.id, p.accountId, now],
    );
    if (rows.length === 0) throw new AppError('not_found');
    await tx.query(
      `UPDATE agent_connections SET revoked_at = $2
        WHERE sensor_connection_id = $1 AND purpose = 'sensor_bridge' AND revoked_at IS NULL`,
      [input.id, now],
    );
    const jobs = await tx.query<{ id: string }>(
      `SELECT id FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1 AND state IN ('queued', 'running')`,
      [input.id],
    );
    return jobs.rows.map((j) => j.id);
  });
  for (const jobId of jobIds) await cancelJob(ctx.db, jobId);
}
