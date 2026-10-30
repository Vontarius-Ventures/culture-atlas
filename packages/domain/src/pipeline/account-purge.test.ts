import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectStorage, ProviderRegistry } from '@culture-atlas/providers';
import { LocalMultipartStorage, type MultipartStorage } from '@culture-atlas/providers';
import { MemoryObjectStorage } from '@culture-atlas/providers/testing';
import { hashToken, randomToken } from '../services/auth';
import { resolvePrincipal } from '../services/auth';
import { requestAccountDeletion, getAccountDeletionStatusByToken } from '../services/account-deletion';
import { insertCaptureWithAnalysis, insertItem } from '../test-support/library';
import { runJob } from '../test-support/library';
import { createIsolatedDatabase, insertAccount, testConfig, testContext, testProviders } from '../testing';
import type { PoolDb } from '../db/pool';
import { projectAccountInterestGraph } from '../interest-graph/projector';
import { setAccountMediaStorage, ensureAccountDeletionPurgeJobs, ACCOUNT_PURGE_STEPS } from './account-purge';

/**
 * Durable account cleanup (VAL-DELETE-004): the purge job removes every
 * private store — rows and objects — for the deleted account, keeps shared
 * facts and other accounts intact, claims completion only after the required
 * work, and leaves failures pending-and-retrying without ever restoring
 * access. The status record answers honestly through the whole lifecycle.
 */

const config = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

let db: PoolDb;
let drop: () => Promise<void>;
let root: string;
let multipart: LocalMultipartStorage;
let v1: MemoryObjectStorage;
let providers: ProviderRegistry;

beforeAll(async () => {
  ({ db, drop } = await createIsolatedDatabase('accdel'));
  root = await mkdtemp(path.join(os.tmpdir(), 'ca-account-purge-'));
  multipart = new LocalMultipartStorage(root, 'http://localhost:3999', 'test-signing-secret');
  setAccountMediaStorage(multipart);
  v1 = new MemoryObjectStorage();
  providers = { ...testProviders(), storage: v1 } as ProviderRegistry;
}, 180_000);

afterAll(async () => {
  setAccountMediaStorage(undefined);
  await drop();
  await rm(root, { recursive: true, force: true });
}, 60_000);

/** Every account-scoped column the schema knows, for the nothing-survives sweep. */
async function accountScopedColumns(): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('account_id','owner_account_id','verified_account_id','accepted_account_id','actor_account_id')
      ORDER BY table_name, column_name`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name }));
}

async function remainingAccountRows(accountId: string): Promise<string[]> {
  const left: string[] = [];
  for (const { table, column } of await accountScopedColumns()) {
    if (table === 'account_deletions') continue; // the durable record outlives the account on purpose
    const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`, [accountId]);
    if (Number(rows[0]!.n) > 0) left.push(`${table}.${column}=${rows[0]!.n}`);
  }
  return left;
}

/** A broad private footprint for one account, spanning every storage family. */
async function seedAccountFootprint(accountId: string): Promise<{ purgeJobId: () => Promise<string>; sessionToken: string }> {
  const sessionToken = randomToken();
  await db.query(`INSERT INTO sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
    accountId,
    hashToken(sessionToken),
  ]);
  await db.query(`INSERT INTO account_credentials (account_id, email, password_hash) VALUES ($1, $2, 'x')`, [
    accountId,
    `seed-${randomUUID()}@example.test`,
  ]);
  await db.query(`INSERT INTO account_emails (account_id, email, verified_at) VALUES ($1, $2, now())`, [
    accountId,
    `seed-${randomUUID()}@example.test`,
  ]);
  await db.query(
    `INSERT INTO agent_connections (owner_account_id, client_name, credential_hash, credential_prefix, library_access, expires_at)
     VALUES ($1, 'seed agent', $2, 'cat_seed', 'all', now() + interval '30 days')`,
    [accountId, hashToken(randomToken())],
  );
  await db.query(
    `INSERT INTO sensor_connections (owner_account_id, configured_origin, mode) VALUES ($1, $2, 'poll')`,
    [accountId, `https://relay.example.test/${randomUUID()}`],
  );
  const { rows: installation } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations (account_id, installation_public_id, platform, app_version)
     VALUES ($1, $2, 'ios', '1') RETURNING id`,
    [accountId, randomUUID()],
  );
  const installationId = installation[0]!.id;
  await db.query(
    `INSERT INTO native_sessions (account_id, installation_id, created_at, authenticated_at, idle_expires_at, absolute_expires_at)
     VALUES ($1, $2, now(), now(), now() + interval '30 days', now() + interval '90 days')`,
    [accountId, installationId],
  );
  await db.query(
    `INSERT INTO capture_sessions (account_id, installation_id, source, media_mode) VALUES ($1, $2, 'phone_camera', 'photo')`,
    [accountId, installationId],
  );
  await db.query(`INSERT INTO device_events (account_id, installation_id, sequence, event_type) VALUES ($1, $2, 1, 'app_opened')`, [
    accountId,
    installationId,
  ]);
  await db.query(
    `INSERT INTO wearable_connections (account_id, installation_id, sdk_reference_hash, display_name, capabilities, permission_state)
     VALUES ($1, $2, $3, 'Watch', '{}', 'granted')`,
    [accountId, installationId, randomUUID()],
  );

  const item = await insertItem({ accountId }, { title: 'Purge fixture save' }, db);
  const secondItem = await insertItem({ accountId }, { title: 'Purge fixture save 2' }, db);
  await db.query(`INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)`, [accountId, item]);
  const { rows: collection } = await db.query<{ id: string }>(
    `INSERT INTO collections (owner_account_id, name) VALUES ($1, 'Purge board') RETURNING id`,
    [accountId],
  );
  await db.query(
    `INSERT INTO collection_items (collection_id, owner_account_id, saved_item_id, position)
     VALUES ($1, $2, (SELECT id FROM saved_items WHERE owner_account_id = $2 AND discovery_item_id = $3), 0)`,
    [collection[0]!.id, accountId, item],
  );
  await db.query(
    `INSERT INTO collection_shares (owner_account_id, collection_id, audience, token_hash, expires_at)
     VALUES ($1, $2, 'link', $3, now() + interval '7 days')`,
    [accountId, collection[0]!.id, hashToken(randomToken())],
  );
  const { rows: share } = await db.query<{ id: string }>(
    `SELECT id FROM collection_shares WHERE owner_account_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [accountId],
  );
  await db.query(
    `INSERT INTO share_sessions (owner_account_id, share_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '7 days')`,
    [accountId, share[0]!.id, hashToken(randomToken())],
  );
  await db.query(
    `INSERT INTO share_invites (owner_account_id, share_id, normalized_email_hash, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
    [accountId, share[0]!.id, hashToken('x@example.test'), hashToken(randomToken())],
  );
  await db.query(
    `INSERT INTO preference_events (owner_account_id, action, target_type, target_id) VALUES ($1, 'save', 'discovery_item', $2)`,
    [accountId, item],
  );
  await db.query(`INSERT INTO plans (owner_account_id, selected_item_ids) VALUES ($1, ARRAY[$2, $3]::uuid[])`, [
    accountId,
    item,
    secondItem,
  ]);
  await db.query(
    `INSERT INTO feed_snapshots (owner_account_id, taste_revision, ordered_item_ids, created_at, expires_at)
     VALUES ($1, 1, ARRAY[$2]::uuid[], now(), now() + interval '1 hour')`,
    [accountId, item],
  );

  // The shared public fact the account contributed to (never account-owned).
  const { rows: reference } = await db.query<{ id: string }>(
    `INSERT INTO cultural_references (canonical_name, canonical_key, type, external_ids)
     VALUES ($1, $2, 'style', '{}') RETURNING id`,
    [`Shared fact ${randomUUID().slice(0, 6)}`, `shared:${randomUUID()}`],
  );
  const cap = await insertCaptureWithAnalysis({ accountId }, { anchorIds: [reference[0]!.id] }, db);
  await db.query(
    `INSERT INTO preference_events (owner_account_id, action, target_type, target_id) VALUES ($1, 'save', 'capture', $2)`,
    [accountId, cap.captureId],
  );

  // v2 media: asset, derivative, analysis request, work, upload, reservation.
  const { rows: asset } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (account_id, client_capture_id, kind, source, byte_size, content_type, status)
     VALUES ($1, $2, 'photo', 'upload', 1024, 'image/jpeg', 'ready') RETURNING id`,
    [accountId, randomUUID()],
  );
  const assetId = asset[0]!.id;
  await db.query(
    `INSERT INTO media_derivatives (account_id, asset_id, generation, kind, processing_version, object_key, checksum, byte_size)
     VALUES ($1, $2, 1, 'normalized', 'v1', $3, 'abc', 100)`,
    [accountId, assetId, `accounts/${accountId}/assets/${assetId}/normalized.jpg`],
  );
  const { rows: analysisRequest } = await db.query<{ id: string }>(
    `INSERT INTO media_analysis_requests (account_id, asset_id, generation, mode, selected_frames, request_hash, state)
     VALUES ($1, $2, 1, 'photo', '[]'::jsonb, $3, 'queued') RETURNING id`,
    [accountId, assetId, randomUUID()],
  );
  await db.query(
    `INSERT INTO capture_work (account_id, generation, kind, state, analysis_id) VALUES ($1, 1, 'prepare_media', 'queued', $2)`,
    [accountId, analysisRequest[0]!.id],
  );
  await db.query(
    `INSERT INTO audio_analysis_requests (account_id, asset_id, generation, requested_components, selection, request_hash)
     VALUES ($1, $2, 1, '{}'::jsonb, '{}'::jsonb, $3)`,
    [accountId, assetId, randomUUID()],
  );
  await db.query(
    `INSERT INTO saved_moments (account_id, asset_id, generation, start_ms, end_ms) VALUES ($1, $2, 1, 0, 1000)`,
    [accountId, assetId],
  );
  const { rows: upload } = await db.query<{ id: string }>(
    `INSERT INTO upload_sessions (account_id, asset_id, staging_key, expected_bytes, expected_sha256, reserved_bytes, request_hash, expires_at)
     VALUES ($1, $2, $3, 100, 'hash', 100, $4, now() + interval '1 day') RETURNING id`,
    [accountId, assetId, `accounts/${accountId}/staging/${randomUUID()}/original.jpg`, randomUUID()],
  );
  await db.query(
    `INSERT INTO usage_reservations (account_id, upload_id, amount, expires_at) VALUES ($1, $2, 100, now() + interval '1 day')`,
    [accountId, upload[0]!.id],
  );
  // The v1→v2 bridge the legacy backfill creates on real accounts: the
  // capture and the media asset reference each other without a cascade
  // (captures.media_asset_id → media_assets, media_assets.legacy_capture_id
  // → captures). A purge cycle the account purge must still complete through.
  await db.query(`UPDATE captures SET media_asset_id = $2 WHERE id = $1`, [cap.captureId, assetId]);
  await db.query(
    `UPDATE media_assets SET legacy_capture_id = $2, legacy_imported = true WHERE account_id = $1 AND id = $3`,
    [accountId, cap.captureId, assetId],
  );
  const { rows: connection } = await db.query<{ id: string; authorization_version: number }>(
    `SELECT id, authorization_version FROM agent_connections WHERE owner_account_id = $1`,
    [accountId],
  );
  await db.query(
    `INSERT INTO agent_media_uploads (account_id, upload_id, connection_id, authorization_version) VALUES ($1, $2, $3, $4)`,
    [accountId, upload[0]!.id, connection[0]!.id, connection[0]!.authorization_version],
  );
  const { rows: captureSession } = await db.query<{ id: string }>(
    `SELECT id FROM capture_sessions WHERE account_id = $1`,
    [accountId],
  );
  await db.query(
    `INSERT INTO device_commands (account_id, installation_id, capture_session_id, connection_id, authorization_version,
                                  generation, action, capture_client_id, idempotency_key, payload_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, 1, 'capture_photo', $6, $7, 'hash', now() + interval '10 minutes')`,
    [accountId, installationId, captureSession[0]!.id, connection[0]!.id, connection[0]!.authorization_version, randomUUID(), randomUUID()],
  );
  const { rows: command } = await db.query<{ id: string }>(`SELECT id FROM device_commands WHERE account_id = $1`, [accountId]);
  await db.query(`INSERT INTO device_command_ack_keys (account_id, installation_id, key, command_id, payload_hash) VALUES ($1, $2, $3, $4, 'hash')`, [
    accountId,
    installationId,
    randomUUID(),
    command[0]!.id,
  ]);

  await db.query(
    `INSERT INTO capture_v2_idempotency (account_id, authority, operation, key, request_hash, response, expires_at)
     VALUES ($1, 'installation', 'complete_upload', $2, $3, '{}'::jsonb, now() + interval '1 day')`,
    [accountId, randomUUID(), randomUUID()],
  );
  await db.query(
    `INSERT INTO capture_enrollment_challenges (account_id, session_id, installation_public_id, proof_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '10 minutes')`,
    [accountId, randomUUID(), randomUUID(), randomUUID()],
  );
  await db.query(
    `INSERT INTO inference_attempts (id, account_id, job_id, role, attempt_key, gateway, requested_model, requested_provider,
                                      profile_version, prompt_version, schema_version, pricing_snapshot_version, reserved_micros, state, outcome, usage_day, started_at)
     VALUES ($1, $2, 'job', 'vision_photo', $3, 'fixture', 'fixture/model', 'fixture', 'v1', 'p1', 's1', 'price-1', 1000, 'reserved', 'unknown', current_date, now())`,
    [randomUUID(), accountId, randomUUID()],
  );
  await db.query(
    `INSERT INTO model_gateway_attempts (id, account_id, job_id, role, attempt_key, state, started_at, payload)
     VALUES ($1, $2, 'job', 'vision_photo', $3, 'reserved', now(), '{}'::jsonb)`,
    [randomUUID(), accountId, randomUUID()],
  );

  // A queued v1 job and a projected graph state.
  const { enqueueJob } = await import('../jobs/queue');
  const { job } = await enqueueJob(db, {
    type: 'taste_seed',
    owner: { kind: 'account', accountId },
    payload: { taste_revision: 1, catalog_version: null, categories: ['watch'] },
  });
  expect(job.state).toBe('queued');
  await projectAccountInterestGraph(db, { accountId, config, source: 'mutation_intent' });

  // Private objects in both storage namespaces.
  await v1.put(`owners/a-${accountId}/captures/${cap.captureId}/derivative.jpg`, new Uint8Array([1, 2, 3]), { contentType: 'image/jpeg' });
  await v1.put(`owners/a-${accountId}/uploads/${randomUUID()}.jpg`, new Uint8Array([4, 5, 6]), { contentType: 'image/jpeg' });
  const bytes = new Uint8Array([7, 8, 9]);
  await multipart.put(
    `accounts/${accountId}/assets/${assetId}/normalized.jpg`,
    (async function* () {
      yield bytes;
    })(),
    'image/jpeg',
    bytes.length,
  );

  return {
    sessionToken,
    purgeJobId: async () => {
      const { rows } = await db.query<{ id: string }>(
        `SELECT id FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1 ORDER BY created_at DESC LIMIT 1`,
        [accountId],
      );
      if (!rows[0]) throw new Error('purge job missing');
      return rows[0]!.id;
    },
  };
}

describe('durable account cleanup', () => {
  it('purges every private row and object, keeps other accounts and shared facts, and completes honestly', async () => {
    const principal = await insertAccount(db);
    const accountId = principal.accountId;
    const survivor = await insertAccount(db);
    const ctx = testContext(principal, { db, providers, config });
    const seed = await seedAccountFootprint(accountId);

    // The survivor owns private rows, objects and a reference of its own.
    const survivorItem = await insertItem({ accountId: survivor.accountId }, { title: 'Survivor save' }, db);
    await db.query(`INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)`, [survivor.accountId, survivorItem]);
    await v1.put(`owners/a-${survivor.accountId}/captures/x.jpg`, new Uint8Array([9]), { contentType: 'image/jpeg' });
    const survivorBytes = new Uint8Array([10]);
    await multipart.put(
      `accounts/${survivor.accountId}/assets/${randomUUID()}/normalized.jpg`,
      (async function* () {
        yield survivorBytes;
      })(),
      'image/jpeg',
      survivorBytes.length,
    );
    const sharedReference = (
      await db.query<{ id: string }>(`SELECT id FROM cultural_references WHERE id IN (SELECT reference_id FROM capture_references WHERE analysis_id IN (SELECT id FROM analyses WHERE capture_id IN (SELECT id FROM captures WHERE owner_account_id = $1)))`, [accountId])
    ).rows[0]!.id;

    const token = randomToken(32);
    const accepted = await requestAccountDeletion(ctx, { confirm: true, status_token: token });
    expect(accepted.status.state).toBe('pending');

    const jobId = await seed.purgeJobId();
    const outcome = await runJob(jobId, { db, providers, config });
    expect(outcome.state).toBe('complete');

    // The durable record is honest and complete.
    const record = (
      await db.query<{ cleanup_state: string; completed_steps: string[]; completed_at: Date; attempts: number; last_error_code: string | null }>(
        `SELECT cleanup_state, completed_steps, completed_at, attempts, last_error_code FROM account_deletions WHERE account_id = $1`,
        [accountId],
      )
    ).rows[0]!;
    expect(record.cleanup_state).toBe('complete');
    expect(record.completed_steps).toEqual([...ACCOUNT_PURGE_STEPS]);
    expect(record.completed_at).toBeInstanceOf(Date);
    expect(record.attempts).toBe(1);
    expect(record.last_error_code).toBeNull();

    // The account row is gone and nothing account-scoped survives anywhere.
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [accountId])).rows).toEqual([]);
    expect(await remainingAccountRows(accountId)).toEqual([]);

    // Objects: both namespaces are empty for the account, intact for the survivor.
    const v1Keys = [...v1.objects.keys()].filter((k) => k.startsWith(`owners/a-${accountId}`));
    expect(v1Keys).toEqual([]);
    expect([...v1.objects.keys()]).toContain(`owners/a-${survivor.accountId}/captures/x.jpg`);
    const listed: string[] = [];
    for await (const info of multipart.list(`accounts/${accountId}`)) listed.push(info.key);
    expect(listed).toEqual([]);
    const survivorListed: string[] = [];
    for await (const info of multipart.list(`accounts/${survivor.accountId}`)) survivorListed.push(info.key);
    expect(survivorListed.length).toBe(1);
    // No empty directory shell remains for the purged account (the account-ID
    // skeleton itself is gone), and the survivor's directory is untouched.
    expect(existsSync(path.join(root, 'objects', 'accounts', accountId))).toBe(false);
    expect(existsSync(path.join(root, 'objects', 'accounts', survivor.accountId))).toBe(true);

    // The shared fact and the survivor's rows survive untouched.
    expect((await db.query(`SELECT 1 FROM cultural_references WHERE id = $1`, [sharedReference])).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM saved_items WHERE owner_account_id = $1`, [survivor.accountId])).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [survivor.accountId])).rows).toHaveLength(1);

    // Status answers complete with nothing pending, and restores no authority.
    const status = await getAccountDeletionStatusByToken(db, token);
    expect(status!.status.state).toBe('complete');
    expect(status!.status.retrying).toBe(false);
    expect(status!.status.pending_steps).toEqual([]);
    expect((await db.query(`SELECT 1 FROM sessions WHERE account_id = $1`, [accountId])).rows).toEqual([]);

    // The purge job itself survives its own work (system-owned).
    expect((await db.query(`SELECT 1 FROM jobs WHERE id = $1`, [jobId])).rows).toHaveLength(1);
    // A later sweep finds nothing owed for a completed deletion.
    expect(await ensureAccountDeletionPurgeJobs(db)).toBe(0);
  });

  it('a storage failure leaves the cleanup failed-but-owed: access stays revoked, and the retry completes', async () => {
    const principal = await insertAccount(db);
    const accountId = principal.accountId;
    const ctx = testContext(principal, { db, providers, config });
    const seed = await seedAccountFootprint(accountId);

    const token = randomToken(32);
    await requestAccountDeletion(ctx, { confirm: true, status_token: token });
    const jobId = await seed.purgeJobId();

    // Storage is down for this attempt.
    const failing: ObjectStorage = {
      ...v1,
      deletePrefix: async () => {
        throw new Error('storage outage');
      },
    } as unknown as ObjectStorage;
    const failingProviders = { ...providers, storage: failing } as ProviderRegistry;
    await expect(runJob(jobId, { db, providers: failingProviders, config })).rejects.toMatchObject({ message: expect.stringContaining('storage') });

    // The record is honest: the last attempt failed with an error code, the
    // work is still owed, and completion is NOT claimed.
    const failed = (
      await db.query<{ cleanup_state: string; completed_steps: string[]; attempts: number; last_error_code: string | null }>(
        `SELECT cleanup_state, completed_steps, attempts, last_error_code FROM account_deletions WHERE account_id = $1`,
        [accountId],
      )
    ).rows[0]!;
    expect(failed.cleanup_state).toBe('failed');
    expect(failed.attempts).toBe(1);
    expect(failed.last_error_code).toBeTruthy();
    expect(failed.completed_steps).toEqual([]);
    const statusAfterFailure = await getAccountDeletionStatusByToken(db, token);
    expect(statusAfterFailure!.status.state).toBe('failed');
    expect(statusAfterFailure!.status.retrying).toBe(true);
    expect(statusAfterFailure!.status.pending_steps).toEqual([...ACCOUNT_PURGE_STEPS]);

    // No authority came back while cleanup was owed.
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1 AND deleted_at IS NOT NULL`, [accountId])).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM sessions WHERE account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
    expect(await resolvePrincipal(db, { sessionToken: seed.sessionToken })).toBeNull();
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [accountId])).rows).toHaveLength(1);

    // The restart sweep re-arms the durable cleanup; the retry completes.
    expect(await ensureAccountDeletionPurgeJobs(db)).toBe(1);
    const retryJob = (
      await db.query<{ id: string }>(`SELECT id FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1 AND state = 'queued'`, [accountId])
    ).rows[0]!;
    const outcome = await runJob(retryJob.id, { db, providers, config });
    expect(outcome.state).toBe('complete');
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [accountId])).rows).toEqual([]);
    expect(await remainingAccountRows(accountId)).toEqual([]);
    // The retried purge leaves no empty directory shell behind either.
    expect(existsSync(path.join(root, 'objects', 'accounts', accountId))).toBe(false);
    const statusAfterRetry = await getAccountDeletionStatusByToken(db, token);
    expect(statusAfterRetry!.status.state).toBe('complete');
  });

  it('marks purging honestly mid-attempt: no step is claimed before it is done', async () => {
    const principal = await insertAccount(db);
    const accountId = principal.accountId;
    const ctx = testContext(principal, { db, providers, config });
    const seed = await seedAccountFootprint(accountId);
    const token = randomToken(32);
    await requestAccountDeletion(ctx, { confirm: true, status_token: token });
    const jobId = await seed.purgeJobId();

    const observed: Array<{ state: string; steps: string[] }> = [];
    // The v2 media objects go through the registered account media storage, so
    // the gate wraps THAT surface: it observes the durable record mid-attempt
    // (after the v1 deletePrefix already succeeded) and throws before v2.
    const gatedMultipart = {
      ...multipart,
      deletePrefix: async (prefix: string) => {
        const record = (
          await db.query<{ cleanup_state: string; completed_steps: string[] }>(
            `SELECT cleanup_state, completed_steps FROM account_deletions WHERE account_id = $1`,
            [accountId],
          )
        ).rows[0]!;
        observed.push({ state: record.cleanup_state, steps: [...record.completed_steps] });
        throw new Error('gate');
      },
    } as unknown as MultipartStorage;
    setAccountMediaStorage(gatedMultipart);
    try {
      await expect(runJob(jobId, { db, providers, config })).rejects.toThrow();
    } finally {
      setAccountMediaStorage(multipart);
    }
    // During the storage step the record said 'purging' with nothing claimed.
    expect(observed).toEqual([{ state: 'purging', steps: [] }]);

    // With storage healthy the same attempt shape completes and claims steps in order.
    await ensureAccountDeletionPurgeJobs(db);
    const retryJob = (
      await db.query<{ id: string }>(`SELECT id FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1 AND state = 'queued'`, [accountId])
    ).rows[0]!;
    expect((await runJob(retryJob.id, { db, providers, config })).state).toBe('complete');
    const done = (
      await db.query<{ cleanup_state: string; completed_steps: string[] }>(
        `SELECT cleanup_state, completed_steps FROM account_deletions WHERE account_id = $1`,
        [accountId],
      )
    ).rows[0]!;
    expect(done.cleanup_state).toBe('complete');
    expect(done.completed_steps).toEqual([...ACCOUNT_PURGE_STEPS]);
    expect(existsSync(path.join(root, 'objects', 'accounts', accountId))).toBe(false);
  });
});
