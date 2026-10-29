import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolDb } from '../db/pool';
import {
  createIsolatedDatabase,
  insertAccount,
  testConfig,
  type IsolatedDatabase,
} from '../testing';
import { PROJECTION_SUPPORT_VERSION } from './schema';
import { GRAPH_EXPANSION_PERIODIC_MS, dispatchGraphExpansion } from './sweeper';
import {
  loadGraphRefreshRow,
  noteExpansionDue,
  pauseGraphDiscovery,
  resumeGraphDiscovery,
} from './refresh';

/**
 * VAL-DISC-003: the closed-app expansion sweeper. Fresh projected support is
 * durably DUE (the projector stamps the marker) and a later sweep hands it to
 * the queue as one bounded expansion job — with the client closed, no feed
 * read, no new user mutation. The sweep never spends anything itself, an
 * ineligible account (flag off, killed, paused, behind projection, or busy)
 * keeps its due marker untouched, and windows coalesce through the queue
 * dedupe so concurrent sweeps never double-dispatch one account.
 *
 * The file runs on one private isolated database. The unscoped global pass
 * defaults to a 50-account batch ordered `COALESCE(marker, stamp) NULLS
 * FIRST`, so in the run's shared database it competes with every caught-up
 * account earlier files left behind — and a never-dispatched leftover (no
 * refresh row) always sorts BEFORE this file's freshly-created account. With
 * ≥50 such leftovers the account under test misses the batch and the
 * containment assertion failed intermittently as `expected undefined to be
 * defined` (recorded in the mission library, raw exits retained; a passing
 * rerun was never proof of stability). A population this file owns makes the
 * global pass's ordering and its counts deterministic, so the flake cannot
 * fire and the test keeps asserting the real sweep shape.
 */

const config = testConfig({
  INTEREST_GRAPH_PROJECTION_ENABLED: 'true',
  INTEREST_GRAPH_DISCOVERY_ENABLED: 'true',
});
const configOff = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

let iso: IsolatedDatabase;
let db: PoolDb;

beforeAll(async () => {
  iso = await createIsolatedDatabase('gswp');
  db = iso.db;
});
afterAll(async () => {
  await iso.drop();
});

/** T0: a fixed clock far from the real now so periodic windows are unambiguous. */
const T0 = new Date('2026-10-28T12:00:00Z');
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);

/** The sweeper dispatch scoped to one account, as the feed read and most tests use it. */
function sweep(accountId: string, offsetMs: number, overrides: { config?: typeof config } = {}) {
  return dispatchGraphExpansion(db, {
    config: overrides.config ?? config,
    ownerAccountId: accountId,
    now: () => at(offsetMs),
  });
}

async function newAccount(): Promise<string> {
  return (await insertAccount(db)).accountId;
}

/** A caught-up, ready projection: the sweeper's only eligible shape. */
async function projectAccount(accountId: string): Promise<void> {
  await db.query(
    `INSERT INTO personal_graph_state (owner_account_id, state, target_taste_revision, applied_taste_revision, projection_revision, support_version)
     VALUES ($1, 'ready', 3, 3, 1, $2)`,
    [accountId, PROJECTION_SUPPORT_VERSION],
  );
}

/** Controlled marker/stamp writes the sweeper's clock comparisons see exactly. */
async function setRefresh(
  accountId: string,
  row: { dueSince?: Date | null; lastExpansion?: Date | null },
): Promise<void> {
  await db.query(
    `INSERT INTO graph_refresh_state (owner_account_id, expansion_due_since, last_expansion_at)
     VALUES ($1, $2, $3)
       ON CONFLICT (owner_account_id)
         DO UPDATE SET expansion_due_since = $2, last_expansion_at = $3, updated_at = now()`,
    [accountId, row.dueSince ?? null, row.lastExpansion ?? null],
  );
}

async function expansionJobs(
  accountId: string,
): Promise<{ id: string; state: string; budget: { qloo_requests?: number; deadline_ms?: number }; dedupe_key: string | null }[]> {
  const { rows } = await db.query<{
    id: string;
    state: string;
    budget: { qloo_requests?: number; deadline_ms?: number };
    dedupe_key: string | null;
  }>(
    `SELECT id, state, budget, dedupe_key FROM jobs
      WHERE owner_account_id = $1 AND type = 'expand_interest_graph' ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

/** A dispatched window's job is still active until a worker completes it. */
async function finishExpansion(accountId: string): Promise<void> {
  await db.query(
    `UPDATE jobs SET state = 'complete', finished_at = now()
      WHERE owner_account_id = $1 AND type = 'expand_interest_graph' AND state IN ('queued','running')`,
    [accountId],
  );
}

describe('the closed-app expansion sweeper (VAL-DISC-003)', () => {
  it('the global pass dispatches durably-due projected support as one bounded expansion job', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    // The projector's successful pass stamped fresh support due.
    await noteExpansionDue(db, accountId);

    // The unscoped global sweep (what the worker tick runs).
    const swept = await dispatchGraphExpansion(db, { config, now: () => at(0) });
    const mine = swept.accounts.find((entry) => entry.accountId === accountId);
    expect(mine).toBeDefined();
    expect(mine!.trigger).toBe('due');
    expect(mine!.reused).toBe(false);

    const jobs = await expansionJobs(accountId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('queued');
    // The job carries the queue budget of the logical window: four Qloo
    // attempts including retries inside a 45-second deadline.
    expect(jobs[0]!.budget.qloo_requests).toBe(4);
    expect(jobs[0]!.budget.deadline_ms).toBe(45_000);
    expect(mine!.jobId).toBe(jobs[0]!.id);
    // The dispatch stamped the window this job owns.
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.last_expansion_at!.toISOString()).toBe(at(0).toISOString());
  });

  it('never re-dispatches inside the same window, and dispatch alone consumes nothing', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    const first = await sweep(accountId, 0);
    expect(first.accounts).toHaveLength(1);
    // A second sweep one minute later: the marker is covered by the stamp and
    // the 15-minute window has not reopened. The queued job is still queued.
    const second = await sweep(accountId, 60_000);
    expect(second.accounts).toEqual([]);
    expect((await expansionJobs(accountId))[0]!.state).toBe('queued');

    // Even once the job finishes, the window — the dispatch stamp — holds:
    // dispatch alone consumed neither the marker nor the window.
    await finishExpansion(accountId);
    const third = await sweep(accountId, 90_000);
    expect(third.accounts).toEqual([]);
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.expansion_due_since!.toISOString()).toBe(at(-60_000).toISOString());
  });

  it('hands an account to the queue again once the 15-minute periodic window reopens', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    const first = await sweep(accountId, 0);
    expect(first.accounts).toHaveLength(1);
    await finishExpansion(accountId);
    // 16 minutes later the periodic window reopens; the trigger is honest
    // ('periodic', not 'due') and the window key is fresh.
    const second = await sweep(accountId, 16 * 60_000);
    expect(second.accounts).toHaveLength(1);
    expect(second.accounts[0]!.trigger).toBe('periodic');
    const jobs = await expansionJobs(accountId);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.dedupe_key).not.toBe(jobs[1]!.dedupe_key);
    expect(second.accounts[0]!.jobId).toBe(jobs[1]!.id);
  });

  it('refreshes sooner when a fresh marker lands after the last dispatch stamp', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    const first = await sweep(accountId, 0);
    expect(first.accounts[0]!.trigger).toBe('due');
    await finishExpansion(accountId);
    // A projection committed after that dispatch: fresh support is due again
    // even though the 15-minute window is still occupied.
    await setRefresh(accountId, { dueSince: at(30_000), lastExpansion: at(0) });
    const second = await sweep(accountId, 45_000);
    expect(second.accounts).toHaveLength(1);
    expect(second.accounts[0]!.trigger).toBe('due');
    expect(await expansionJobs(accountId)).toHaveLength(2);
  });

  it('concurrent sweeps of the same window coalesce to one job per account', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    // The feed read and the closed-app sweeper race on the same account.
    const [a, b] = await Promise.all([sweep(accountId, 0), sweep(accountId, 0)]);
    const jobIds = [...a.accounts, ...b.accounts].map((entry) => entry.jobId);
    // Whatever interleaving the pool chose, exactly one expansion job exists
    // and every sweep points at it: no duplicate dispatch, no duplicate spend.
    expect(jobIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(jobIds)).toHaveLength(1);
    expect(await expansionJobs(accountId)).toHaveLength(1);
  });

  it('an active expansion keeps the account out of later sweeps until it finishes', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });
    await sweep(accountId, 0);

    // Fresh support lands while the first expansion is still queued.
    await setRefresh(accountId, { dueSince: at(30_000), lastExpansion: at(0) });
    const during = await sweep(accountId, 45_000);
    expect(during.accounts).toEqual([]);
    expect(await expansionJobs(accountId)).toHaveLength(1);

    // The queued expansion "finishes"; the next sweep picks the marker up.
    await finishExpansion(accountId);
    const after = await sweep(accountId, 50_000);
    expect(after.accounts).toHaveLength(1);
    expect(after.accounts[0]!.trigger).toBe('due');
  });

  it('a paused account is skipped with its due marker retained; resume re-enables it', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });
    await pauseGraphDiscovery(db, accountId);

    const swept = await sweep(accountId, 0);
    expect(swept.accounts).toEqual([]);
    expect(await expansionJobs(accountId)).toHaveLength(0);
    // Ineligibility consumed nothing: the marker is exactly where it was.
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.expansion_due_since!.toISOString()).toBe(at(-60_000).toISOString());

    await resumeGraphDiscovery(db, accountId);
    const resumed = await sweep(accountId, 1_000);
    expect(resumed.accounts).toHaveLength(1);
    expect(resumed.accounts[0]!.trigger).toBe('due');
  });

  it('is inert while the server has not opted in, and does not touch due markers', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });

    const swept = await sweep(accountId, 0, { config: configOff });
    expect(swept.accounts).toEqual([]);
    expect(await expansionJobs(accountId)).toHaveLength(0);
    const refresh = await loadGraphRefreshRow(db, accountId);
    expect(refresh!.expansion_due_since!.toISOString()).toBe(at(-60_000).toISOString());
  });

  it('a database kill switch skips the account without consuming due-ness', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    await setRefresh(accountId, { dueSince: at(-60_000) });
    // A kill scoped to THIS account (the shared test database must stay clean
    // for every later account in this run).
    await db.query(
      `INSERT INTO feature_flag_kills (flag, account_id, reason, created_by)
       VALUES ('interest_graph_discovery_enabled', $1, 'test', 'test')`,
      [accountId],
    );

    const swept = await sweep(accountId, 0);
    expect(swept.accounts).toEqual([]);
    expect(await expansionJobs(accountId)).toHaveLength(0);
    expect((await loadGraphRefreshRow(db, accountId))!.expansion_due_since).toBeInstanceOf(Date);

    // Lifting the kill restores eligibility without any new mutation.
    await db.query(
      `UPDATE feature_flag_kills SET lifted_at = now()
        WHERE flag = 'interest_graph_discovery_enabled' AND account_id = $1 AND lifted_at IS NULL`,
      [accountId],
    );
    const restored = await sweep(accountId, 1_000);
    expect(restored.accounts).toHaveLength(1);
    expect(restored.accounts[0]!.trigger).toBe('due');
  });

  it('never sweeps accounts whose projection is behind, incomplete, or absent', async () => {
    const behind = await newAccount();
    await db.query(
      `INSERT INTO personal_graph_state (owner_account_id, state, target_taste_revision, applied_taste_revision, support_version)
       VALUES ($1, 'ready', 4, 3, $2)`,
      [behind, PROJECTION_SUPPORT_VERSION],
    );
    const pending = await newAccount();
    await db.query(
      `INSERT INTO personal_graph_state (owner_account_id, state, target_taste_revision, applied_taste_revision, support_version)
       VALUES ($1, 'ready', 3, 3, $2)`,
      [pending, PROJECTION_SUPPORT_VERSION],
    );
    // An unsatisfied projection intent keeps the account out of the sweeper.
    await db.query(
      `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, job_intent, target_taste_revision)
       VALUES ($1, 'taste', $2, 'project_interest_graph', 4)`,
      [pending, `test:taste:${pending}`],
    );
    const absent = await newAccount();
    await noteExpansionDue(db, absent);

    // A scoped sweep of each shape returns nothing: none of them is eligible.
    for (const accountId of [behind, pending, absent]) {
      const swept = await sweep(accountId, 0);
      expect(swept.accounts).toEqual([]);
      expect(await expansionJobs(accountId)).toHaveLength(0);
    }
  });

  it('a scoped feed-read sweep never touches other accounts, paused or not', async () => {
    const mine = await newAccount();
    const other = await newAccount();
    await projectAccount(mine);
    await projectAccount(other);
    await setRefresh(mine, { dueSince: at(-60_000) });
    await setRefresh(other, { dueSince: at(-60_000) });

    const swept = await sweep(mine, 0);
    expect(swept.accounts).toHaveLength(1);
    expect(swept.accounts[0]!.accountId).toBe(mine);
    expect(await expansionJobs(other)).toHaveLength(0);
    // The scoped sweep did not consume the other account's due-ness either.
    expect((await loadGraphRefreshRow(db, other))!.expansion_due_since).toBeInstanceOf(Date);

    // A scoped sweep against a paused account is a clean no-op, never a throw.
    const pausedAccount = await newAccount();
    await projectAccount(pausedAccount);
    await setRefresh(pausedAccount, { dueSince: at(-60_000) });
    await pauseGraphDiscovery(db, pausedAccount);
    const pausedSwept = await sweep(pausedAccount, 0);
    expect(pausedSwept.accounts).toEqual([]);
  });

  it('honors the periodic bound only from the dispatch stamp, not the due marker', async () => {
    const accountId = await newAccount();
    await projectAccount(accountId);
    // No marker at all: a never-refreshed account is handed over once, then
    // the periodic bound holds it for 15 minutes.
    const first = await sweep(accountId, 0);
    expect(first.accounts).toHaveLength(1);
    expect(first.accounts[0]!.trigger).toBe('periodic');
    const second = await sweep(accountId, 14 * 60_000);
    expect(second.accounts).toEqual([]);
    await finishExpansion(accountId);
    const third = await sweep(accountId, 15 * 60_000 + 1_000);
    expect(third.accounts).toHaveLength(1);
    expect(third.accounts[0]!.trigger).toBe('periodic');
    expect(GRAPH_EXPANSION_PERIODIC_MS).toBe(15 * 60_000);
  });
});
