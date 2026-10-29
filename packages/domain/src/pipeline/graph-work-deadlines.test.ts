import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolDb } from '../db/pool';
import { enqueueJob } from '../jobs/queue';
import { runJob } from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, testConfig } from '../testing';
import { GRAPH_EXPANSION_DEADLINE_MS } from '../interest-graph/budgets';
import { ensureGraphWorkBudget, loadGraphWorkBudget } from '../interest-graph/budgets';

/**
 * VAL-DISC-006 / DISC-SCR-006: the DURABLE logical deadline of one graph work
 * item governs the whole handler, not just its entry.
 *
 *  - A delayed first claim or a redelivery whose anchored window already ended
 *    refuses honestly before any provider call, reservation or publication,
 *    and never receives a fresh 45 seconds; the due marker stays so the next
 *    window retries from current authority.
 *  - A pass that entered legally cannot outlive its window either: the
 *    remaining time bounds stage execution and SQL/lock waits, and the
 *    publication decision is fenced by the same durable row. A delayed
 *    statement or a held lock cannot turn into a commit after the deadline.
 */

const db = getTestDb();
afterAll(closeTestDb);

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

/** One queued expansion job for a fresh account, with its dedupe-keyed logical identity. */
async function queuedExpansion(): Promise<{ accountId: string; jobId: string; workKey: string }> {
  const { accountId } = await insertAccount(db);
  const { job } = await enqueueJob(db, {
    type: 'expand_interest_graph',
    owner: { kind: 'account', accountId },
    payload: { account_id: accountId },
    dedupeKey: `graph_expansion:window:${randomUUID()}`,
    maxAttempts: 3,
    budget: { qloo_requests: 4, deadline_ms: GRAPH_EXPANSION_DEADLINE_MS },
    resultType: 'graph_expansion',
  });
  return { accountId, jobId: job.id, workKey: job.dedupe_key! };
}

async function jobRow(jobId: string): Promise<{ state: string; error_code: string | null; error_retryable: boolean | null }> {
  const { rows } = await db.query<{ state: string; error_code: string | null; error_retryable: boolean | null }>(
    'SELECT state, error_code, error_retryable FROM jobs WHERE id = $1',
    [jobId],
  );
  return rows[0]!;
}

async function graphRunCount(accountId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1',
    [accountId],
  );
  return Number(rows[0]!.n);
}

/**
 * Resolves once an expansion pass is observed WAITING on the held account row
 * lock (its graph_runs insert parks on the FK key-share conflict). Fails
 * honestly if the pass never blocks, so a barrier cannot pass by racing past
 * the wait.
 */
async function waitForAccountLockWait(pool: PoolDb, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%graph_runs%'`,
    );
    if (Number(rows[0]!.n) > 0) return;
    if (Date.now() >= deadline)
      throw new Error(`the expansion pass never blocked on the account lock within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('the anchored logical deadline governs the expansion handler', () => {
  it('a delayed claim whose window already ended refuses before any work: no publication, no fresh 45 seconds', async () => {
    const { accountId, jobId, workKey } = await queuedExpansion();
    // The account's due marker is live: an honest stop must leave it due.
    await db.query(
      `INSERT INTO graph_refresh_state (owner_account_id, expansion_due_since)
       VALUES ($1, now())
       ON CONFLICT (owner_account_id) DO UPDATE SET expansion_due_since = now(), updated_at = now()`,
      [accountId],
    );
    // The window was anchored by an earlier attempt long before this claim
    // (worker restart, long queue) and has ended: the delayed attempt
    // inherits the same durable row and must refuse honestly.
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'expansion',
      workKey,
      at: new Date(Date.now() - (GRAPH_EXPANSION_DEADLINE_MS + 15_000)),
    });

    await expect(runJob(jobId, { config: graphOn })).rejects.toMatchObject({
      details: { rule: 'logical_deadline_expired' },
    });
    // Honest terminal outcome: the job failed non-retryably (never re-queued
    // into a fresh per-attempt window), the logical budget is stopped, and
    // nothing was published or reserved.
    const job = await jobRow(jobId);
    expect(job.state).toBe('failed');
    expect(job.error_code).toBe('service_unavailable');
    expect(job.error_retryable).toBe(false);
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    expect(budget?.qloo_attempts_used).toBe(0);
    expect(await graphRunCount(accountId)).toBe(0);
    // The due marker stays due: the next dispatch window retries from current
    // authority instead of silently dropping the account's refresh.
    const { rows: refresh } = await db.query<{ expansion_due_since: Date | null }>(
      'SELECT expansion_due_since FROM graph_refresh_state WHERE owner_account_id = $1',
      [accountId],
    );
    expect(refresh[0]!.expansion_due_since).toBeInstanceOf(Date);
  });

  it('a pass blocked on a held lock cannot outlive its window: the bounded wait ends it before publication', async () => {
    const { accountId, jobId, workKey } = await queuedExpansion();
    // A short remaining window, exactly as a redelivery near the anchor's end
    // holds: the pass ENTERS legally (the deadline has not passed yet).
    const windowMs = 1_500;
    await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'expansion',
      workKey,
      deadlineMs: windowMs,
    });

    // Another connection holds the account row lock: the pass's graph_runs
    // insert parks on the FK key-share conflict. Without the remaining window
    // bounding its SQL/lock waits, the pass would sit past its deadline and
    // publish once the lock releases.
    const holder = await db.pool.connect();
    let run: Promise<{ state: string }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
      run = runJob(jobId, { config: graphOn });
      // The bounded wait's rejection can land while the lock is still held
      // (before the assertion below attaches): mark the promise handled so
      // the honest outcome is not also an unhandled rejection.
      run.catch(() => undefined);
      await waitForAccountLockWait(db);

      // Hold the lock clearly past the window: the pass must stop on its own
      // bounded wait, not on the lock being released.
      await new Promise((resolve) => setTimeout(resolve, windowMs + 700));
      await holder.query('COMMIT');
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }

    await expect(run).rejects.toMatchObject({ details: { rule: 'logical_deadline_expired' } });
    // The whole pass rolled back: no run row, no publication, no reservation.
    expect(await graphRunCount(accountId)).toBe(0);
    const job = await jobRow(jobId);
    expect(job.state).toBe('failed');
    expect(job.error_retryable).toBe(false);
    const budget = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(budget?.state).toBe('stopped');
    expect(budget?.qloo_attempts_used).toBe(0);
  });
});
