import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIsolatedDatabase,
  insertAccount,
  insertAgentConnection,
  type IsolatedDatabase,
} from '../packages/domain/src/testing';
import { runRestoreDrill, type Tombstone } from './restore-drill-lib';

/**
 * Local restore drill: real pg_dump (scripts/capture-backup.ts) -> real
 * pg_restore into a new database -> authority neutralised, tombstones and
 * the newer deletion journal replayed, every object verified by SHA-256.
 * This is development evidence only; OPS-01 still needs the managed cloud
 * drill (docs/runbooks/restore-drill.md).
 */
const run = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
let source: IsolatedDatabase;
const targets: IsolatedDatabase[] = [];
let work: string;
let backupDir: string;
let objectsRoot: string;
let journal: Tombstone[];
let accountId: string;
let liveKey: string;

async function putObject(key: string, bytes: Buffer) {
  const file = join(objectsRoot, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const reader = (key: string) =>
  import('node:fs/promises').then((fs) => fs.readFile(join(objectsRoot, key)).catch(() => null));

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'ca-restore-'));
  objectsRoot = join(work, 'objects');
  source = await createIsolatedDatabase();
  const db = source.db;
  const owner = await insertAccount(db);
  accountId = owner.accountId;
  const agent = await insertAgentConnection(owner, {}, db);
  const installation = (
    await db.query<{ id: string }>(
      `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version,readiness,app_state)
       VALUES($1,$2,'ios','1.0','ready','foreground') RETURNING id`,
      [accountId, randomUUID()],
    )
  ).rows[0]!.id;
  const session = (
    await db.query<{ id: string }>(
      `INSERT INTO capture_sessions(account_id,installation_id,source,media_mode,remote_arm_expires_at,allowed_agent_connection_ids)
       VALUES($1,$2,'phone_camera','photo',now()+interval '10 minutes',$3) RETURNING id`,
      [accountId, installation, [agent.principal.connectionId]],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO device_commands(account_id,installation_id,capture_session_id,connection_id,authorization_version,generation,
       action,capture_client_id,idempotency_key,payload_hash,expires_at)
     VALUES($1,$2,$3,$4,1,1,'capture_photo',$5,$6,'h',now()+interval '30 seconds')`,
    [accountId, installation, session, agent.principal.connectionId, randomUUID(), randomUUID()],
  );
  const asset = async (deleted: boolean) => {
    const id = randomUUID();
    const key = `accounts/${accountId}/media/${id}/1/original`;
    const bytes = randomBytes(2048);
    await putObject(key, bytes);
    await db.query(
      `INSERT INTO media_assets(id,account_id,client_capture_id,kind,source,status,original_key,sha256,byte_size,content_type,deleted_at)
       VALUES($1,$2,$3,'photo','upload',$4,$5,$6,$7,'image/jpeg',$8)`,
      [
        id,
        accountId,
        randomUUID(),
        deleted ? 'deleted' : 'ready',
        key,
        sha(bytes),
        bytes.length,
        deleted ? new Date() : null,
      ],
    );
    return { id, key };
  };
  liveKey = (await asset(false)).key;
  const deletedLater = await asset(false);
  await asset(true);

  await run('pnpm', ['exec', 'tsx', 'scripts/capture-backup.ts'], {
    cwd: repo,
    env: { ...process.env, DATABASE_URL: source.url, CAPTURE_BACKUP_DIR: join(work, 'backups') },
    timeout: 120_000,
  });
  const [dir] = await readdir(join(work, 'backups'));
  backupDir = join(work, 'backups', dir!);

  // Deleted after the snapshot: only the journal knows. Its bytes are gone too.
  const deletedAt = new Date();
  await db.query(`UPDATE media_assets SET deleted_at=$2,status='deleted' WHERE id=$1`, [
    deletedLater.id,
    deletedAt,
  ]);
  await rm(join(objectsRoot, deletedLater.key));
  journal = [
    {
      account_id: accountId,
      id: deletedLater.id,
      generation: 1,
      deleted_at: deletedAt.toISOString(),
    },
  ];
}, 120_000);

afterAll(async () => {
  for (const t of targets) await t.drop();
  await source?.drop();
  await rm(work, { recursive: true, force: true });
});

describe('restore drill (local evidence)', () => {
  it('restores, neutralises authority, replays the journal and verifies objects', async () => {
    const target = await createIsolatedDatabase({ migrate: false });
    targets.push(target);
    const report = await runRestoreDrill({
      backupDir,
      targetUrl: target.url,
      readObject: reader,
      journal,
    });
    expect(report).toMatchObject({
      migrations_match: true,
      restored_media: 1,
      tombstones_applied: 0,
      journal_entries_applied: 1,
      remote_arms_cleared: 1,
      commands_cancelled: 1,
      agent_connections_revoked: 1,
      objects_checked: 1,
      objects_missing: 0,
      objects_size_mismatch: 0,
      objects_checksum_mismatch: 0,
    });
    expect(report.sessions_revoked).toBeGreaterThanOrEqual(1);
    const check = await target.db.query(
      `SELECT (SELECT count(*)::int FROM sessions WHERE revoked_at IS NULL) AS live_sessions,
              (SELECT count(*)::int FROM device_commands WHERE state='queued') AS queued,
              (SELECT count(*)::int FROM mobile_installations WHERE authority_ended_at IS NULL) AS live_phones`,
    );
    expect(check.rows[0]).toEqual({ live_sessions: 0, queued: 0, live_phones: 0 });
    // The report carries counts only: no keys, IDs or URLs.
    const text = JSON.stringify(report);
    expect(text).not.toContain(accountId);
    expect(text).not.toContain('accounts/');
  });

  it('fails loudly on a corrupted object and refuses a non-empty target', async () => {
    const target = await createIsolatedDatabase({ migrate: false });
    targets.push(target);
    await putObject(liveKey, randomBytes(2048));
    const report = await runRestoreDrill({
      backupDir,
      targetUrl: target.url,
      readObject: reader,
      journal,
    });
    expect(report.objects_checksum_mismatch).toBe(1);
    await expect(
      runRestoreDrill({ backupDir, targetUrl: target.url, readObject: reader, journal }),
    ).rejects.toThrow(/not empty/);
  });
});
