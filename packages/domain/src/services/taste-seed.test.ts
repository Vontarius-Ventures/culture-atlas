import { describe, expect, it } from 'vitest';
import { getTestDb, insertAccount, testConfig } from '../testing';
import { TasteSeedStatus } from '../schemas/onboarding';
import {
  deriveSeedStatus,
  enqueueTasteSeed,
  getTasteSeedStatus,
  readFoodExclusions,
  TASTE_SEED_MAX_ATTEMPTS,
  TASTE_SEED_MAX_QLOO_REQUESTS,
  TASTE_SEED_POLL_MS,
} from './taste-seed';

const now = new Date('2026-10-18T12:00:00Z');
const run = (job_state: string | null, extra: Record<string, unknown> = {}) =>
  ({
    job_id: '00000000-0000-4000-8000-000000000001',
    state: 'running',
    first_ready_at: null,
    job_state,
    job_attempt: 1,
    job_available_at: null,
    ...extra,
  }) as Parameters<typeof deriveSeedStatus>[0];
const cat = (category: 'wear' | 'play' | 'watch' | 'eat', state: 'pending' | 'ready' | 'empty' | 'unavailable', card_count = 0) => ({
  category,
  state,
  card_count,
  ready_at: state === 'ready' ? new Date('2026-10-18T11:59:58Z') : null,
});

describe('deriveSeedStatus', () => {
  it('reports progress category by category while the job runs', () => {
    const s = deriveSeedStatus(run('running', { first_ready_at: new Date('2026-10-18T11:59:58Z') }), [cat('eat', 'pending'), cat('wear', 'ready', 5), cat('play', 'pending'), cat('watch', 'empty')], now);
    expect(TasteSeedStatus.parse(s)).toEqual(s);
    expect(s.state).toBe('running');
    expect(s.categories.map((c) => [c.category, c.state, c.card_count])).toEqual([
      ['wear', 'ready', 5],
      ['play', 'pending', 0],
      ['watch', 'empty', 0],
      ['eat', 'pending', 0],
    ]);
    expect(s.first_ready_at).toBe('2026-10-18T11:59:58.000Z');
    expect(s.poll_after_ms).toBe(TASTE_SEED_POLL_MS);
  });

  it('distinguishes a fresh queue from a retry and waits for the retry time', () => {
    expect(deriveSeedStatus(run('queued', { job_attempt: 0 }), [cat('wear', 'pending')], now).state).toBe('queued');
    const retry = deriveSeedStatus(run('queued', { job_attempt: 1, job_available_at: new Date(now.getTime() + 4_000) }), [cat('wear', 'unavailable')], now);
    expect(retry.state).toBe('retrying');
    expect(retry.poll_after_ms).toBe(4_000);
    expect(retry.categories[0]!.state).toBe('unavailable');
  });

  it('never reports pending once the job finished, and only real cards count', () => {
    const done = deriveSeedStatus(run('complete'), [cat('wear', 'ready', 3), cat('eat', 'empty')], now);
    expect(done.state).toBe('complete');
    expect(done.poll_after_ms).toBeNull();
    const partial = deriveSeedStatus(run('partial'), [cat('wear', 'ready', 3), cat('play', 'unavailable')], now);
    expect(partial.state).toBe('partial');
    const failed = deriveSeedStatus(run('failed'), [cat('wear', 'pending'), cat('play', 'unavailable')], now);
    expect(failed.state).toBe('failed');
    expect(failed.categories.every((c) => c.state === 'unavailable' && c.card_count === 0)).toBe(true);
    const failedAfterSome = deriveSeedStatus(run('failed'), [cat('wear', 'ready', 2), cat('play', 'pending')], now);
    expect(failedAfterSome.state).toBe('partial');
  });
});

describe('readFoodExclusions', () => {
  it('reads nested and dotted preferences and ignores invalid values', () => {
    expect(readFoodExclusions({ food: { exclusions: ['peanuts', 'dairy'] } })).toEqual(['peanuts', 'dairy']);
    expect(readFoodExclusions({ 'food.exclusions': ['shellfish'] })).toEqual(['shellfish']);
    expect(readFoodExclusions({ food: { exclusions: 'peanuts' } })).toEqual([]);
    expect(readFoodExclusions({ food: { exclusions: Array.from({ length: 13 }, (_, i) => `x${i}`) } })).toEqual([]);
    expect(readFoodExclusions(null)).toEqual([]);
  });
});

describe('migration 120', () => {
  it('leaves exactly one one-parent CHECK on provider_queries and recommendations', async () => {
    const { rows } = await getTestDb().query<{ table: string; def: string }>(
      `SELECT rel.relname AS table, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname IN ('provider_queries', 'recommendations') AND con.contype = 'c'
          AND pg_get_constraintdef(con.oid) LIKE '%num_nonnulls(analysis_id%'`,
    );
    expect(rows.map((r) => r.table).sort()).toEqual(['provider_queries', 'recommendations']);
    // Migration 240 widens the exclusive-parent set with graph_run_id while
    // keeping the invariant: exactly one parent, never zero, never two.
    for (const r of rows)
      expect(r.def).toContain(
        'num_nonnulls(analysis_id, plan_id, discovery_job_id, taste_seed_run_id, graph_run_id) = 1',
      );
  });
});

describe('enqueueTasteSeed', () => {
  it('queues one bounded job per taste revision and reports it as queued', async () => {
    const db = getTestDb();
    const account = await insertAccount();
    expect(await getTasteSeedStatus(db, account.accountId)).toMatchObject({ state: 'not_started', job_id: null, categories: [] });
    const first = await enqueueTasteSeed(db, { accountId: account.accountId, tasteRevision: 3, catalogVersion: 'test.1', config: testConfig() });
    expect(first.enqueued).toBe(true);
    expect(first.status.state).toBe('queued');
    expect(first.status.categories.map((c) => c.state)).toEqual(['pending', 'pending', 'pending', 'pending']);
    const again = await enqueueTasteSeed(db, { accountId: account.accountId, tasteRevision: 3, catalogVersion: 'test.1', config: testConfig() });
    expect(again).toMatchObject({ enqueued: false, reused: true });
    expect(again.status.job_id).toBe(first.status.job_id);
    const { rows } = await db.query<{ max_attempts: number; budget: Record<string, number>; owner_account_id: string }>(
      'SELECT max_attempts, budget, owner_account_id FROM jobs WHERE id = $1',
      [first.status.job_id],
    );
    expect(rows[0]).toMatchObject({ max_attempts: TASTE_SEED_MAX_ATTEMPTS, owner_account_id: account.accountId });
    expect(rows[0]!.budget.qloo_requests).toBe(TASTE_SEED_MAX_QLOO_REQUESTS);
    const runs = await db.query('SELECT 1 FROM taste_seed_runs WHERE owner_account_id = $1', [account.accountId]);
    expect(runs.rowCount).toBe(1);
  });

  it('queues nothing when the seed is switched off or killed, and onboarding is not blocked', async () => {
    const db = getTestDb();
    for (const config of [testConfig({ TASTE_SEED_ENABLED: 'false' }), testConfig({ FEATURE_KILL_SWITCHES: 'taste_seed_enabled' })]) {
      const account = await insertAccount();
      const out = await enqueueTasteSeed(db, { accountId: account.accountId, tasteRevision: 1, catalogVersion: null, config });
      expect(out).toMatchObject({ enqueued: false, status: { state: 'not_started', job_id: null } });
      const jobs = await db.query(`SELECT 1 FROM jobs WHERE owner_account_id = $1 AND type = 'taste_seed'`, [account.accountId]);
      expect(jobs.rowCount).toBe(0);
    }
  });

  it('only reports the caller account’s seed', async () => {
    const db = getTestDb();
    const a = await insertAccount();
    const b = await insertAccount();
    await enqueueTasteSeed(db, { accountId: a.accountId, tasteRevision: 1, catalogVersion: null, config: testConfig() });
    expect((await getTasteSeedStatus(db, b.accountId)).state).toBe('not_started');
  });
});
