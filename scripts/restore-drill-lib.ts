import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { libpqEnv } from './pg-env';

/**
 * Automates the scriptable part of the restore drill in
 * docs/runbooks/restore-drill.md (docs/capture-v2-operations.md "Restore
 * drill"). It restores a scripts/capture-backup.ts snapshot into an EMPTY,
 * isolated database, neutralises restored authority, replays tombstones,
 * verifies every inventoried object and returns a report of counts only.
 *
 * It never connects to anything except the target it is given, refuses a
 * non-empty target, and never prints record contents, keys or credentials.
 */
export interface InventoryRow {
  account_id: string;
  asset_id: string;
  generation: number;
  object_key: string;
  checksum: string | null;
  byte_size: string | number | null;
}
export interface Tombstone {
  account_id: string;
  id: string;
  generation: number;
  deleted_at: string;
}
export type ObjectReader = (key: string) => Promise<Uint8Array | null>;

export interface RestoreDrillReport {
  snapshot_created_at: string;
  migrations_match: boolean;
  restored_accounts: number;
  restored_media: number;
  tombstones_applied: number;
  journal_entries_applied: number;
  sessions_revoked: number;
  native_sessions_revoked: number;
  agent_connections_revoked: number;
  remote_arms_cleared: number;
  commands_cancelled: number;
  uploads_expired: number;
  work_requeued: number;
  objects_checked: number;
  objects_missing: number;
  objects_size_mismatch: number;
  objects_checksum_mismatch: number;
  elapsed_ms: number;
}

const run = promisify(execFile);

export async function assertEmptyTarget(targetUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: targetUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public'`,
    );
    if (Number(rows[0]!.n) > 0)
      throw new Error(
        'Restore target is not empty. Create a new, isolated database for the drill.',
      );
  } finally {
    await client.end();
  }
}

export async function restoreDatabase(
  backupDir: string,
  targetUrl: string,
  pgRestoreBin = process.env.PG_RESTORE_BIN ?? 'pg_restore',
): Promise<void> {
  await assertEmptyTarget(targetUrl);
  // Credentials go through libpq environment variables, never argv (visible in `ps`).
  const env = libpqEnv(targetUrl);
  try {
    await run(
      pgRestoreBin,
      [
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        `--dbname=${env.PGDATABASE}`,
        join(backupDir, 'database.dump'),
      ],
      { timeout: 900_000, maxBuffer: 1_048_576, env },
    );
  } catch {
    throw new Error(
      'pg_restore failed. Check the dump, the target database and the pg_restore version.',
    );
  }
}

/** Revokes restored authority and fences side effects before anyone can use the restored copy. */
export async function neutraliseRestoredAuthority(
  client: pg.ClientBase,
  now: Date,
): Promise<
  Pick<
    RestoreDrillReport,
    | 'sessions_revoked'
    | 'native_sessions_revoked'
    | 'agent_connections_revoked'
    | 'remote_arms_cleared'
    | 'commands_cancelled'
    | 'uploads_expired'
  >
> {
  const count = async (sql: string, params: unknown[] = [now]) =>
    (await client.query(sql, params)).rowCount ?? 0;
  const sessions_revoked = await count(
    `UPDATE sessions SET revoked_at=$1 WHERE revoked_at IS NULL`,
  );
  const native_sessions_revoked = await count(
    `UPDATE native_sessions SET revoked_at=$1,revoke_reason='restore_drill' WHERE revoked_at IS NULL`,
  );
  await client.query(
    `UPDATE native_enrollment_grants SET consumed_at=$1 WHERE consumed_at IS NULL`,
    [now],
  );
  await client.query(`UPDATE identity_challenges SET consumed_at=$1 WHERE consumed_at IS NULL`, [
    now,
  ]);
  const agent_connections_revoked = await count(
    `UPDATE agent_connections SET revoked_at=$1 WHERE revoked_at IS NULL`,
  );
  const remote_arms_cleared = await count(
    `UPDATE capture_sessions SET state='ended',stopped_at=COALESCE(stopped_at,$1),remote_arm_expires_at=NULL,
       allowed_agent_connection_ids='{}',generation=generation+1 WHERE state='active'`,
  );
  await client.query(
    `UPDATE mobile_installations SET authority_ended_at=COALESCE(authority_ended_at,$1),readiness='unavailable',
       app_state='terminated'`,
    [now],
  );
  // Push tokens (migration 085) must never be used from a restored copy.
  await client.query(
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mobile_installations'
                  AND column_name='push_token_ciphertext') THEN
         UPDATE mobile_installations SET push_provider=NULL,push_environment=NULL,push_token_ciphertext=NULL,
           push_token_key_id=NULL,push_updated_at=NULL;
       END IF;
     END $$`,
  );
  // Camera commands are never replayed from a backup.
  const commands_cancelled = await count(
    `UPDATE device_commands SET state='cancelled',error_code='restored'
     WHERE state IN ('queued','delivered','awaiting_user','executing')`,
    [],
  );
  const uploads_expired = await count(
    `UPDATE upload_sessions SET state='expired' WHERE state IN ('created','uploading','paused') AND expires_at<=$1`,
  );
  return {
    sessions_revoked,
    native_sessions_revoked,
    agent_connections_revoked,
    remote_arms_cleared,
    commands_cancelled,
    uploads_expired,
  };
}

/** A backup must never resurrect deleted media: apply snapshot tombstones and the newer journal. */
export async function applyTombstones(
  client: pg.ClientBase,
  tombstones: Tombstone[],
): Promise<number> {
  let applied = 0;
  for (const t of tombstones) {
    const r = await client.query(
      `UPDATE media_assets SET deleted_at=$3,status='deleted',generation=GREATEST(generation,$4)
       WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [t.account_id, t.id, t.deleted_at, t.generation],
    );
    applied += r.rowCount ?? 0;
    await client.query(
      `UPDATE capture_work SET state='cancelled' WHERE account_id=$1 AND asset_id=$2 AND state IN ('queued','running')
         AND kind<>'purge_media'`,
      [t.account_id, t.id],
    );
  }
  return applied;
}

/** Leases from the old world are void: running work goes back to queued with no lease. */
export async function requeueWork(client: pg.ClientBase): Promise<number> {
  const r = await client.query(
    `UPDATE capture_work w SET state='queued',lease_token=NULL,lease_expires_at=NULL,attempt_id=NULL
     WHERE w.state='running' AND NOT EXISTS (
       SELECT 1 FROM media_assets m WHERE m.account_id=w.account_id AND m.id=w.asset_id AND m.deleted_at IS NOT NULL)`,
  );
  return r.rowCount ?? 0;
}

export async function verifyObjects(
  inventory: InventoryRow[],
  readObject: ObjectReader,
): Promise<
  Pick<
    RestoreDrillReport,
    'objects_checked' | 'objects_missing' | 'objects_size_mismatch' | 'objects_checksum_mismatch'
  >
> {
  let missing = 0,
    size = 0,
    checksum = 0;
  for (const row of inventory) {
    const bytes = await readObject(row.object_key).catch(() => null);
    if (!bytes) {
      missing++;
      continue;
    }
    if (row.byte_size !== null && Number(row.byte_size) !== bytes.byteLength) size++;
    // SHA-256 of the actual bytes, never a multipart ETag.
    if (row.checksum && createHash('sha256').update(bytes).digest('hex') !== row.checksum)
      checksum++;
  }
  return {
    objects_checked: inventory.length,
    objects_missing: missing,
    objects_size_mismatch: size,
    objects_checksum_mismatch: checksum,
  };
}

export async function runRestoreDrill(input: {
  backupDir: string;
  targetUrl: string;
  readObject: ObjectReader;
  /** Deletion journal newer than the snapshot (same shape as tombstones.json). */
  journal?: Tombstone[];
  now?: Date;
  pgRestoreBin?: string;
}): Promise<RestoreDrillReport> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const manifest = JSON.parse(await readFile(join(input.backupDir, 'manifest.json'), 'utf8')) as {
    created_at: string;
    migrations: { version: string; checksum: string }[];
  };
  const inventory = JSON.parse(
    await readFile(join(input.backupDir, 'objects.json'), 'utf8'),
  ) as InventoryRow[];
  const tombstones = JSON.parse(
    await readFile(join(input.backupDir, 'tombstones.json'), 'utf8'),
  ) as Tombstone[];
  await restoreDatabase(input.backupDir, input.targetUrl, input.pgRestoreBin);
  const client = new pg.Client({ connectionString: input.targetUrl });
  await client.connect();
  try {
    const recorded = await client.query<{ version: string; checksum: string }>(
      `SELECT version,checksum FROM schema_migrations ORDER BY version`,
    );
    const migrations_match = JSON.stringify(recorded.rows) === JSON.stringify(manifest.migrations);
    await client.query('BEGIN');
    const neutralised = await neutraliseRestoredAuthority(client, now);
    const tombstones_applied = await applyTombstones(client, tombstones);
    const journal_entries_applied = await applyTombstones(client, input.journal ?? []);
    const work_requeued = await requeueWork(client);
    await client.query('COMMIT');
    const counts = await client.query<{ accounts: string; media: string }>(
      `SELECT (SELECT count(*) FROM accounts) AS accounts,
              (SELECT count(*) FROM media_assets WHERE deleted_at IS NULL) AS media`,
    );
    // Objects of media deleted after the snapshot must not be counted as required.
    const deleted = new Set(
      [...tombstones, ...(input.journal ?? [])].map((t) => `${t.account_id}:${t.id}`),
    );
    const live = inventory.filter((row) => !deleted.has(`${row.account_id}:${row.asset_id}`));
    const objects = await verifyObjects(live, input.readObject);
    return {
      snapshot_created_at: manifest.created_at,
      migrations_match,
      restored_accounts: Number(counts.rows[0]!.accounts),
      restored_media: Number(counts.rows[0]!.media),
      tombstones_applied,
      journal_entries_applied,
      ...neutralised,
      work_requeued,
      ...objects,
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
