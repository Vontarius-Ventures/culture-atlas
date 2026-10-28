import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { insertAccount, insertAgentConnection } from '../testing';
import { assertSafeDatabaseName, dropOwnedDatabase } from '../testing';
import { MIGRATIONS_DIR, RECONCILED_CHECKSUMS, runMigrations } from './migrate';

/**
 * The capture-v2 p1 (054-057) and p5 (070-073) lines were developed in
 * parallel and both added media_assets.created_by_agent_connection_id. These
 * tests prove a fresh database and a database from either pre-merge line all
 * migrate to the same schema, without renumbering applied files.
 */

const PRE_MERGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pre-merge-migrations');
const P1_055 = path.join(PRE_MERGE, '055_agent_media_fences.p1.sql');
const P5_071 = path.join(PRE_MERGE, '071_agent_resources_commands.p5.sql');

const created: string[] = [];
const tempDirs: string[] = [];

async function freshDatabase(): Promise<string> {
  const base = new URL(inject('databaseUrl'));
  const name = `${base.pathname.slice(1)}_r${randomBytes(3).toString('hex')}`;
  assertSafeDatabaseName(name);
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  created.push(name);
  base.pathname = `/${name}`;
  return base.toString();
}

/** A migrations dir holding the current files named by `keep`, plus pre-merge overrides. */
async function lineDir(keep: (file: string) => boolean, overrides: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-migrations-'));
  tempDirs.push(dir);
  for (const f of await readdir(MIGRATIONS_DIR)) {
    if (f.endsWith('.sql') && keep(f) && !overrides[f]) await cp(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  for (const [file, source] of Object.entries(overrides)) await writeFile(path.join(dir, file), await readFile(source));
  return dir;
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Shape of the reconciled objects, independent of generated constraint names. */
async function agentFenceShape(url: string) {
  return withClient(url, async (c) => {
    const cols = await c.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema='public' AND column_name IN ('created_by_agent_connection_id','authorization_version','hidden_at')
          AND table_name IN ('media_assets','upload_sessions','media_analysis_requests','capture_work')
        ORDER BY 1, 2`,
    );
    const cons = await c.query<{ rel: string; contype: string; def: string }>(
      `SELECT conrelid::regclass::text AS rel, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid::regclass::text IN ('media_assets','upload_sessions','media_analysis_requests','capture_work')
          AND pg_get_constraintdef(oid) LIKE '%created_by_agent_connection_id%'
        ORDER BY 1, 2, 3`,
    );
    return { columns: cols.rows, constraints: cons.rows };
  });
}

afterAll(async () => {
  const admin = new pg.Client({ connectionString: inject('databaseUrl') });
  await admin.connect();
  try {
    // Only the databases this file created; each waits, bounded, for its
    // sessions to exit instead of terminating them (the test role has no
    // pg_signal_backend, so FORCE intermittently failed the afterAll).
    for (const name of created) await dropOwnedDatabase(admin, name);
  } finally {
    await admin.end();
  }
  for (const d of tempDirs) await rm(d, { recursive: true, force: true });
});

describe('merged capture-v2 migrations', () => {
  it('pins the pre-merge checksums that existing deployments recorded', async () => {
    const sha = async (p: string) => createHash('sha256').update(await readFile(p, 'utf8')).digest('hex');
    expect(RECONCILED_CHECKSUMS['055_agent_media_fences.sql']).toContain(await sha(P1_055));
    expect(RECONCILED_CHECKSUMS['071_agent_resources_commands.sql']).toContain(await sha(P5_071));
  });

  it('migrates a fresh database with one creator column, foreign key and pairing check per table', async () => {
    const url = await freshDatabase();
    const result = await runMigrations(url);
    expect(result.reconciled).toEqual([]);
    const shape = await agentFenceShape(url);
    const fks = shape.constraints.filter((c) => c.contype === 'f');
    const checks = shape.constraints.filter((c) => c.contype === 'c');
    expect(fks.map((c) => c.rel)).toEqual(['capture_work', 'media_analysis_requests', 'media_assets', 'upload_sessions']);
    expect(checks.map((c) => c.rel)).toEqual(['capture_work', 'media_analysis_requests', 'media_assets', 'upload_sessions']);
    expect(shape.columns.filter((c) => c.column_name === 'hidden_at').map((c) => c.table_name)).toEqual(['media_assets']);
  });

  it('upgrades a database that applied the p1 line (unguarded 055) and converges on the fresh schema', async () => {
    const fresh = await freshDatabase();
    await runMigrations(fresh);
    const url = await freshDatabase();
    await runMigrations(url, { dir: await lineDir((f) => f < '058', { '055_agent_media_fences.sql': P1_055 }) });

    const result = await runMigrations(url);
    expect(result.reconciled).toEqual(['055_agent_media_fences.sql']);
    expect(result.applied).toEqual(expect.arrayContaining(['070_agent_platform.sql', '071_agent_resources_commands.sql']));
    expect(await agentFenceShape(url)).toEqual(await agentFenceShape(fresh));
    // The record now holds the current checksum, so later runs are plain skips.
    const again = await runMigrations(url);
    expect(again.reconciled).toEqual([]);
    expect(again.applied).toEqual([]);
  });

  it('upgrades a database that applied the p5 line (unguarded 071) and backfills agent creator versions', async () => {
    const fresh = await freshDatabase();
    await runMigrations(fresh);
    const url = await freshDatabase();
    const p5 = (f: string) => f < '054' || (f >= '070' && f < '074');
    await runMigrations(url, { dir: await lineDir(p5, { '071_agent_resources_commands.sql': P5_071 }) });

    // Rows the p5 line could have written: an agent upload with a recorded
    // grant version, and an agent-created asset with no recorded version.
    const { recorded, unrecorded } = await withClient(url, async (c) => {
      const account = await insertAccount(c);
      const agent = await insertAgentConnection(account, { scopes: ['captures:read'] }, c);
      const asset = async () => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO media_assets(account_id,client_capture_id,kind,source,byte_size,content_type,created_by_agent_connection_id)
           VALUES($1,$2,'photo','upload',10,'image/jpeg',$3) RETURNING id`,
          [account.accountId, randomUUID(), agent.principal.connectionId],
        );
        return rows[0]!.id;
      };
      const recordedId = await asset();
      const unrecordedId = await asset();
      const upload = await c.query<{ id: string }>(
        `INSERT INTO upload_sessions(account_id,asset_id,staging_key,expected_bytes,expected_sha256,reserved_bytes,request_hash,expires_at)
         VALUES($1,$2,$3,10,'x',10,'h',now()+interval '1 day') RETURNING id`,
        [account.accountId, recordedId, `staging/${randomUUID()}`],
      );
      await c.query(
        `INSERT INTO agent_media_uploads(account_id,upload_id,connection_id,authorization_version) VALUES($1,$2,$3,7)`,
        [account.accountId, upload.rows[0]!.id, agent.principal.connectionId],
      );
      return { recorded: recordedId, unrecorded: unrecordedId };
    });

    const result = await runMigrations(url);
    expect(result.reconciled).toEqual(['071_agent_resources_commands.sql']);
    expect(result.applied).toEqual(
      expect.arrayContaining(['054_legacy_media_metadata.sql', '055_agent_media_fences.sql', '056_worker_and_reauthentication.sql']),
    );
    expect(await agentFenceShape(url)).toEqual(await agentFenceShape(fresh));
    const versions = await withClient(url, (c) =>
      c.query<{ id: string; authorization_version: string }>(
        'SELECT id, authorization_version FROM media_assets WHERE id = ANY($1)',
        [[recorded, unrecorded]],
      ),
    );
    const byId = Object.fromEntries(versions.rows.map((r) => [r.id, Number(r.authorization_version)]));
    // Unknown provenance fails closed: version 0 never matches a live grant.
    expect(byId).toEqual({ [recorded]: 7, [unrecorded]: 0 });
  });

  it('still refuses an applied migration that changed in an unknown way', async () => {
    const url = await freshDatabase();
    const dir = await lineDir((f) => f < '054', {});
    await runMigrations(url, { dir });
    await writeFile(path.join(dir, '053_enrollment_keys.sql'), '-- edited\n');
    await expect(runMigrations(url, { dir })).rejects.toThrow(/changed after it was applied/);
  });
});
