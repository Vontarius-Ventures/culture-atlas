import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../../domain/src/db/migrate';
import type { PoolDb } from '../../../domain/src/db/pool';
import { createIsolatedDatabase } from '../../../domain/src/testing/isolated-db';
import { limits, profile, response } from '../concentrate/test-fixtures';
import { ModelSpendLedger } from './budget';
import { PostgresSpendStore, type GatewayDb } from './postgres';

/**
 * inference_attempts (migration 066) and the scoped PostgreSQL ledger. Runs in
 * its own database because it sets the GLOBAL credit pause and role circuits.
 */
let db: PoolDb;
let drop: () => Promise<void>;
beforeAll(async () => {
  ({ db, drop } = await createIsolatedDatabase('conc'));
}, 120_000);
afterAll(() => drop(), 60_000);

async function account(handle: GatewayDb = db) {
  const rows = await handle.query<{ id: string }>(
    'INSERT INTO accounts (auth_subject) VALUES ($1) RETURNING id',
    [`p4:${randomUUID()}`],
  );
  return {
    accountId: rows.rows[0]!.id,
    jobId: randomUUID(),
    attemptKey: 'stage',
    assetId: randomUUID(),
  };
}

/** Counts attempt rows the store loads on the dispatch path. */
function counting(inner: PoolDb) {
  const loaded: number[] = [];
  const wrap = (h: GatewayDb): GatewayDb => ({
    get inTransaction() {
      return h.inTransaction;
    },
    async query<R extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const result = await h.query<R>(sql, params);
      if (/FROM inference_attempts/.test(sql)) loaded.push(result.rows.length);
      return result;
    },
    transaction: (fn) => h.transaction((tx) => fn(wrap(tx as unknown as GatewayDb))),
  });
  return { handle: wrap(inner as unknown as GatewayDb), loaded };
}

describe('inference_attempts ledger (AI-02), isolated database', () => {
  it('records the contract columns: requested/returned identifiers, versions, request id, nullable usage and cost', async () => {
    const ledger = new ModelSpendLedger(new PostgresSpendStore(db), limits);
    const identity = await account();
    const id = await ledger.reserve({ ...identity, queueAttemptId: 'lease-1' }, profile);
    await ledger.finish(id, 'complete', { ...response, requestId: 'req_1', usage: null });
    const { rows } = await db.query('SELECT * FROM inference_attempts WHERE id=$1', [id]);
    expect(rows[0]).toMatchObject({
      account_id: identity.accountId,
      job_id: identity.jobId,
      asset_id: identity.assetId,
      queue_attempt_id: 'lease-1',
      role: 'research_text',
      attempt_key: 'stage',
      gateway: 'concentrate',
      requested_model: 'fixture/model-1',
      requested_provider: 'fixture',
      returned_model: 'fixture/model-1',
      actual_provider: null,
      profile_version: 'test-v1',
      prompt_version: 'test-p1',
      schema_version: 'test-s1',
      pricing_snapshot_version: 'test-price1',
      response_id: 'r1',
      request_id: 'req_1',
      input_tokens: null,
      output_tokens: null,
      reserved_micros: 100,
      cost_micros: null,
      state: 'unknown',
      outcome: 'complete',
    });
    await ledger.reconcile(id, 40);
    const settled = await db.query(
      'SELECT state, cost_micros, settled_at FROM inference_attempts WHERE id=$1',
      [id],
    );
    expect(settled.rows[0]).toMatchObject({ state: 'settled', cost_micros: 40 });
    expect(settled.rows[0]!.settled_at).toBeInstanceOf(Date);
    await expect(
      db.query(`UPDATE inference_attempts SET cost_micros=NULL WHERE id=$1`, [id]),
    ).rejects.toThrow('check constraint');
  });

  it('loads only decision-relevant rows (today, unsettled, target) while keeping old unknown charges counted', async () => {
    const identity = await account();
    // 300 settled attempts from earlier days: history that must not be scanned per decision.
    await db.query(
      `INSERT INTO inference_attempts (id, account_id, job_id, role, attempt_key, gateway, requested_model,
         requested_provider, profile_version, prompt_version, schema_version, pricing_snapshot_version,
         reserved_micros, cost_micros, state, outcome, usage_day, started_at)
       SELECT gen_random_uuid(), $1, 'old-'||g, 'research_text', 'k', 'concentrate', 'fixture/model-1', 'fixture',
         'v', 'p', 's', 'price', 100, 10, 'settled', 'complete', DATE '2026-01-01' + (g % 200), TIMESTAMPTZ '2026-01-01'
       FROM generate_series(1, 300) g`,
      [identity.accountId],
    );
    // One unsettled charge from a previous day still counts.
    await db.query(
      `INSERT INTO inference_attempts (id, account_id, job_id, role, attempt_key, gateway, requested_model,
         requested_provider, profile_version, prompt_version, schema_version, pricing_snapshot_version,
         reserved_micros, state, outcome, usage_day, started_at)
       VALUES (gen_random_uuid(), $1, 'old-unknown', 'research_text', 'k', 'concentrate', 'fixture/model-1', 'fixture',
         'v', 'p', 's', 'price', 450, 'unknown', 'timeout', DATE '2026-01-02', TIMESTAMPTZ '2026-01-02')`,
      [identity.accountId],
    );
    const { handle, loaded } = counting(db);
    const ledger = new ModelSpendLedger(new PostgresSpendStore(handle), {
      ...limits,
      maxUnknownMicros: 10_000,
      accountDailyMicros: 10_000,
      dailyMicros: 10_000,
    });
    const before = loaded.length;
    await ledger.reserve(identity, profile);
    const scanned = loaded.slice(before);
    expect(scanned).toHaveLength(1);
    const total = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM inference_attempts',
    );
    expect(scanned[0]).toBeLessThan(Number(total.rows[0]!.n) - 250);
    // The old unknown 450 is included: a 600 account cap leaves no room for another 100 + 100.
    const capped = new ModelSpendLedger(new PostgresSpendStore(db), {
      ...limits,
      accountDailyMicros: 600,
      maxUnknownMicros: 10_000,
      dailyMicros: 100_000,
    });
    await expect(
      capped.reserve({ ...identity, attemptKey: 'more' }, profile),
    ).rejects.toMatchObject({ kind: 'budget_exhausted' });
  });

  it('persists role circuits across store instances; credits pause and circuits clear only by operator resume', async () => {
    const roomy = {
      ...limits,
      dailyMicros: 100_000,
      accountDailyMicros: 100_000,
      maxUnknownMicros: 100_000,
    };
    const a = new ModelSpendLedger(new PostgresSpendStore(db), roomy);
    const id = await a.reserve(await account(), { ...profile, role: 'composer' });
    await a.finish(id, 'auth', undefined, { circuit: { role: 'composer', reason: 'auth' } });
    const b = new ModelSpendLedger(new PostgresSpendStore(db), roomy);
    expect(await b.circuit('composer')).toMatchObject({ reason: 'auth' });
    expect(await b.circuit('research_text')).toBeNull();
    await expect(
      b.reserve(await account(), { ...profile, role: 'composer' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await b.reserve(await account(), profile);
    await b.resume();
    expect(await b.circuit('composer')).not.toBeNull();
    await b.resume({ roles: ['composer'] });
    expect(await b.circuit('composer')).toBeNull();
  });
});

describe('migration 066 upgrade', () => {
  const tempDirs: string[] = [];
  afterAll(async () => {
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });
  it(
    'carries 065 ledger rows into inference_attempts so unknown charges stay counted',
    { timeout: 120_000 },
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-mig065-'));
      tempDirs.push(dir);
      for (const f of await readdir(MIGRATIONS_DIR))
        if (f.endsWith('.sql') && f < '066')
          await cp(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
      const iso = await createIsolatedDatabase('concmig', { migrationsDir: dir });
      try {
        const owner = await account(iso.db as unknown as GatewayDb);
        const id = randomUUID();
        const payload = {
          id,
          identity: {
            accountId: owner.accountId,
            jobId: 'job-legacy',
            attemptKey: 'observe:0',
            assetId: 'asset-x',
          },
          day: '2026-10-14',
          role: 'vision_photo',
          gateway: 'concentrate',
          requestedModel: 'fixture/model-1',
          requestedProvider: 'fixture',
          returnedModel: 'fixture/model-1',
          actualProvider: null,
          responseId: 'resp-legacy',
          profileVersion: 'v1',
          promptVersion: 'p1',
          schemaVersion: 's1',
          pricingSnapshotVersion: 'price1',
          reservedMicros: 250,
          costMicros: null,
          usage: { inputTokens: 10, outputTokens: 20 },
          state: 'unknown',
          outcome: 'timeout',
          startedAt: Date.parse('2026-10-14T10:00:00Z'),
          completedAt: Date.parse('2026-10-14T10:00:30Z'),
        };
        await iso.db.query(
          `INSERT INTO model_gateway_attempts (id, account_id, job_id, role, attempt_key, state, started_at, payload)
         VALUES ($1,$2,'job-legacy','vision_photo','observe:0','unknown',$3,$4::jsonb)`,
          [id, owner.accountId, new Date(payload.startedAt), JSON.stringify(payload)],
        );
        await runMigrations(iso.url);
        const { rows } = await iso.db.query(
          `SELECT *, to_char(usage_day,'YYYY-MM-DD') AS day FROM inference_attempts WHERE id=$1`,
          [id],
        );
        expect(rows[0]).toMatchObject({
          job_id: 'job-legacy',
          asset_id: 'asset-x',
          role: 'vision_photo',
          attempt_key: 'observe:0',
          reserved_micros: 250,
          cost_micros: null,
          state: 'unknown',
          outcome: 'timeout',
          response_id: 'resp-legacy',
          input_tokens: 10,
          output_tokens: 20,
          day: '2026-10-14',
        });
        const ledger = new ModelSpendLedger(new PostgresSpendStore(iso.db), {
          ...limits,
          maxUnknownMicros: 300,
        });
        await expect(
          ledger.reserve(await account(iso.db as unknown as GatewayDb), profile),
        ).rejects.toMatchObject({ kind: 'budget_exhausted' });
        const control = await iso.db.query(
          'SELECT circuits FROM model_gateway_control WHERE id = 1',
        );
        expect(control.rows[0]!.circuits).toEqual({});
      } finally {
        await iso.drop();
      }
    },
  );
});
