import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MockRelay } from '../../../../fixtures/sensor/mock-relay';
import type { DomainConfig } from '../config';
import { enqueueJob } from '../jobs/queue';
import type { JobContext } from '../jobs/handler';
import { sensorPoll } from '../pipeline/sensor-poll';
import { CreateSensorConnectionRequest } from '../schemas/sensor-connections';
import { deleteCapture } from '../services/captures';
import { createSensorConnection, listSensorConnections } from '../services/sensor-connections';
import { getTestDb, insertAccount, testConfig, testContext, testProviders } from '../testing';
import { encryptCredential } from './credentials';
import { ensureSensorPollJobs, nextPollDelayMs, runSensorPoll, scheduleSensorPoll } from './importer';

const db = getTestDb();
const KEY = randomBytes(32).toString('base64');
const relays: MockRelay[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.stop()));
});

async function setup(opts: { existing?: number; select?: number[]; pageSize?: number } = {}) {
  const relay = new MockRelay({ pageSize: opts.pageSize ?? 7 });
  relays.push(relay);
  const existing = Array.from({ length: opts.existing ?? 0 }, () => relay.addPhoto());
  await relay.start();
  const config: DomainConfig = testConfig({ SENSOR_ALLOWED_ORIGINS: relay.origin, CREDENTIAL_ENCRYPTION_KEY: KEY, SENSOR_POLL_INTERVAL_MS: '10000' });
  const account = await insertAccount(db);
  const ctx = testContext(account, { config });
  const providers = testProviders();
  const res = await createSensorConnection(
    ctx,
    CreateSensorConnectionRequest.parse({
      origin: relay.origin,
      viewer_credential: relay.credential,
      import_existing_asset_ids: (opts.select ?? []).map((i) => existing[i]!.asset_id),
    }),
  );
  const id = res.connection.id;
  const poll = (over: Partial<DomainConfig> = {}) => runSensorPoll(id, { db, providers, config: { ...config, ...over } });
  const captures = async () =>
    (
      await db.query<{ id: string; sensor_asset_id: string; source: string; captured_at: Date | null; received_at: Date; image_sha256: string }>(
        'SELECT id, sensor_asset_id, source, captured_at, received_at, image_sha256 FROM captures WHERE sensor_connection_id = $1 AND deleted_at IS NULL ORDER BY created_at, sensor_asset_id',
        [id],
      )
    ).rows;
  const ledger = async () =>
    Object.fromEntries(
      (await db.query<{ asset_id: string; status: string; error_code: string | null }>('SELECT asset_id, status, error_code FROM sensor_imports WHERE sensor_connection_id = $1', [id])).rows.map((r) => [
        r.asset_id,
        r.error_code ? `${r.status}:${r.error_code}` : r.status,
      ]),
    );
  return { relay, config, account, ctx, providers, id, existing, poll, captures, ledger };
}

describe('server-side sensor poller', () => {
  it('first poll imports only the selected existing photo, as a capture that is not a like', async () => {
    const t = await setup({ existing: 3, select: [1] });
    const before = Date.now();
    const out = await t.poll();
    expect(out.errorCode).toBeNull();
    expect(out.reschedule).toBe(true);
    expect(out.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(9000);

    const caps = await t.captures();
    expect(caps).toHaveLength(1);
    const selected = t.existing[1]!;
    expect(caps[0]).toMatchObject({ sensor_asset_id: selected.asset_id, source: 'sensor' });
    // captured_at comes from the relay; received_at is the import time.
    expect(caps[0]!.captured_at!.toISOString()).toBe(selected.captured_at);
    expect(caps[0]!.received_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await t.ledger()).toEqual({
      [t.existing[0]!.asset_id]: 'skipped:existing_not_selected',
      [selected.asset_id]: 'imported',
      [t.existing[2]!.asset_id]: 'skipped:existing_not_selected',
    });

    // Analysis is queued like any capture...
    const jobs = await db.query(`SELECT 1 FROM jobs WHERE type = 'analyze_capture' AND result_id = $1`, [caps[0]!.id]);
    expect(jobs.rows).toHaveLength(1);
    // ...but an import never saves anything or records a preference.
    const saves = await db.query('SELECT 1 FROM saved_items WHERE owner_account_id = $1', [t.account.accountId]);
    const prefs = await db.query('SELECT 1 FROM preference_events WHERE owner_account_id = $1', [t.account.accountId]);
    expect(saves.rows).toHaveLength(0);
    expect(prefs.rows).toHaveLength(0);

    const [conn] = (await listSensorConnections(t.ctx)).connections;
    expect(conn).toMatchObject({ status: 'active', imported_count: 1, last_error_code: null });
    expect(conn!.last_success_at).not.toBeNull();
  });

  it('paginates through many new photos with no skips and no duplicates', async () => {
    const t = await setup({ existing: 2, pageSize: 7 });
    await t.poll();
    const fresh = Array.from({ length: 30 }, () => t.relay.addPhoto().asset_id);
    const first = await t.poll();
    // 25 imports per poll; the next poll is scheduled soon.
    expect(first.sync!.imported).toHaveLength(25);
    expect(first.sync!.more).toBe(true);
    expect(first.nextPollAt!.getTime() - Date.now()).toBeLessThanOrEqual(1500);
    await t.poll();
    await t.poll();
    const caps = await t.captures();
    expect(caps.map((c) => c.sensor_asset_id).sort()).toEqual([...fresh].sort());
    for (const id of fresh) expect(t.relay.contentFetches(id)).toBe(1);
  });

  it('recovers after the relay goes offline: backs off, then imports everything once', async () => {
    const t = await setup();
    await t.poll();
    const a = t.relay.addPhoto().asset_id;
    t.relay.setOffline(true);
    const off1 = await t.poll();
    expect(off1).toMatchObject({ errorCode: 'relay_unreachable', reschedule: true });
    expect(off1.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(19_000);
    const off2 = await t.poll();
    expect(off2.nextPollAt!.getTime() - Date.now()).toBeGreaterThan(39_000);
    const [conn] = (await listSensorConnections(t.ctx)).connections;
    expect(conn).toMatchObject({ status: 'offline', last_error_code: 'relay_unreachable' });

    // Photos keep arriving on the relay while we cannot reach it.
    t.relay.setOffline(false);
    const b = t.relay.addPhoto().asset_id;
    const c = t.relay.addPhoto().asset_id;
    const back = await t.poll();
    expect(back.errorCode).toBeNull();
    expect((await t.captures()).map((x) => x.sensor_asset_id).sort()).toEqual([a, b, c].sort());
    const [after] = (await listSensorConnections(t.ctx)).connections;
    expect(after).toMatchObject({ status: 'active', last_error_code: null, imported_count: 3 });
    await t.poll();
    expect(await t.captures()).toHaveLength(3);
  });

  it('records a hash mismatch once and never imports those bytes', async () => {
    const t = await setup();
    await t.poll();
    const bad = t.relay.addPhoto({ declare_hash: 'wrong' }).asset_id;
    const good = t.relay.addPhoto().asset_id;
    const out = await t.poll();
    expect(out.sync!.failed).toEqual([{ asset_id: bad, code: 'hash_mismatch' }]);
    expect((await t.captures()).map((c) => c.sensor_asset_id)).toEqual([good]);
    expect((await t.ledger())[bad]).toBe('failed:hash_mismatch');
  });

  it('does not re-import a photo the user deleted, even if the relay is re-read from the start', async () => {
    const t = await setup();
    await t.poll();
    const a = t.relay.addPhoto().asset_id;
    await t.poll();
    const [cap] = await t.captures();
    await deleteCapture(t.ctx, { id: cap!.id });
    await db.query('UPDATE sensor_connections SET cursor = NULL WHERE id = $1', [t.id]);
    const again = await t.poll();
    expect(again.sync!.imported).toEqual([]);
    expect(await t.captures()).toEqual([]);
    expect((await t.ledger())[a]).toBe('imported');
  });

  it('stops fetching when the origin leaves the allowlist or the credential is rejected', async () => {
    const t = await setup();
    const requests = t.relay.requests.length;
    const out = await t.poll({ SENSOR_ALLOWED_ORIGINS: ['https://another.example'] });
    expect(out).toMatchObject({ errorCode: 'origin_not_allowed', reschedule: true });
    expect(t.relay.requests.length).toBe(requests);
    const [conn] = (await listSensorConnections(t.ctx)).connections;
    expect(conn!.status).toBe('needs_attention');

    expect((await t.poll({ CREDENTIAL_ENCRYPTION_KEY: randomBytes(32).toString('base64') })).errorCode).toBe('credential_key_mismatch');
    expect((await t.poll({ CREDENTIAL_ENCRYPTION_KEY: undefined })).errorCode).toBe('credential_key_missing');

    // The relay rejects a stale viewer credential.
    const stale = encryptCredential('stale-credential', Buffer.from(KEY, 'base64'), t.id);
    await db.query(`UPDATE sensor_connections SET encrypted_viewer_credential = $2, credential_key_id = $3 WHERE id = $1`, [t.id, stale.blob, stale.keyId]);
    expect((await t.poll()).errorCode).toBe('relay_unauthorized');

    await db.query(`UPDATE sensor_connections SET encrypted_viewer_credential = NULL WHERE id = $1`, [t.id]);
    expect((await t.poll()).errorCode).toBe('credential_missing');
  });

  it('stops polling a disabled connection', async () => {
    const t = await setup();
    await db.query('UPDATE sensor_connections SET enabled = false WHERE id = $1', [t.id]);
    expect(await t.poll()).toMatchObject({ reschedule: false, nextPollAt: null });
  });

  it('the job handler reschedules exactly one next poll; the sweep heals broken chains', async () => {
    const t = await setup({ existing: 1 });
    const [queued] = (await db.query<{ id: string }>(`SELECT id FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1`, [t.id])).rows;
    const job = (await db.query(`SELECT * FROM jobs WHERE id = $1`, [queued!.id])).rows[0];
    const traces: unknown[] = [];
    const ctx = {
      job,
      payload: { sensor_connection_id: t.id },
      attempt: 1,
      workerId: 'test',
      db,
      providers: t.providers,
      config: t.config,
      signal: new AbortController().signal,
      budget: { qlooRequests: 0, researchRefs: 0, providerRetries: 0, deadlineMs: 55_000 },
      setStage: async () => undefined,
      runStage: async <R>(_s: string, fn: () => Promise<R>) => fn(),
      ensureActive: async () => undefined,
      trace: async (e: unknown) => void traces.push(e),
      log: () => undefined,
    } as unknown as JobContext<'sensor_poll'>;
    await expect(sensorPoll(ctx)).resolves.toMatchObject({ state: 'complete', resultType: 'sensor_connection', resultId: t.id });
    expect(traces).toEqual([expect.objectContaining({ name: 'sensor_poll', data: expect.objectContaining({ baseline_skipped: 1, error_code: null }) })]);
    const next = (await db.query<{ id: string; available_at: Date }>(
      `SELECT id, available_at FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1 AND id <> $2`,
      [t.id, queued!.id],
    )).rows;
    expect(next).toHaveLength(1);
    expect(next[0]!.available_at.getTime() - Date.now()).toBeGreaterThan(9000);

    // Scheduling is idempotent per connection.
    const again = await scheduleSensorPoll(db, { connectionId: t.id, ownerAccountId: t.account.accountId, availableAt: new Date() });
    expect(again.created).toBe(false);

    // Break the chain; the worker sweep restores it.
    await db.query(`UPDATE jobs SET state = 'failed' WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1`, [t.id]);
    expect(await ensureSensorPollJobs(db)).toBeGreaterThanOrEqual(1);
    const active = await db.query(`SELECT 1 FROM jobs WHERE type = 'sensor_poll' AND payload->>'sensor_connection_id' = $1 AND state = 'queued'`, [t.id]);
    expect(active.rows).toHaveLength(1);
  });

  it('backoff grows while failing and honors Retry-After', () => {
    expect(nextPollDelayMs(10_000, 0)).toBe(10_000);
    expect(nextPollDelayMs(10_000, 0, { more: true })).toBe(1000);
    expect(nextPollDelayMs(10_000, 1)).toBe(20_000);
    expect(nextPollDelayMs(10_000, 3)).toBe(80_000);
    expect(nextPollDelayMs(10_000, 20)).toBe(300_000);
    expect(nextPollDelayMs(10_000, 1, { retryAfterMs: 900_000 })).toBe(900_000);
  });

  it('enqueue validates the poll payload', async () => {
    await expect(enqueueJob(db, { type: 'sensor_poll', owner: null, payload: { sensor_connection_id: 'nope' } })).rejects.toThrow();
  });
});
