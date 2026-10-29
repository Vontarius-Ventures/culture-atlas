import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { QlooHttpProvider } from '@culture-atlas/providers';
import { BudgetExhaustedError } from '../composer/provider-calls';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import {
  GRAPH_EXPANSION_DEADLINE_MS,
  GRAPH_EXPANSION_QLOO_ATTEMPTS,
  ensureGraphWorkBudget,
  graphWorkQlooSession,
  loadGraphWorkBudget,
  reserveGraphWorkQlooAttempt,
  setGraphWorkBudgetState,
} from './budgets';

/**
 * VAL-DISC-006: the durable budgets of one LOGICAL graph work item. A logical
 * expansion makes at most four Qloo HTTP attempts including retries, honors
 * its 45-second deadline, uses the existing shared throttle, and lease loss,
 * worker restart or redelivery cannot reset attempt, deadline or spend
 * accounting: every later attempt reserves against the same durable row.
 * Exhaustion stops bounded work; it never starts an uncontrolled paid
 * fallback.
 */

const db = getTestDb();
afterAll(closeTestDb);

const workKeyFor = (name: string) => `graph_expansion:${name}:${randomUUID().slice(0, 8)}`;

async function newAccount(): Promise<string> {
  return (await insertAccount(db)).accountId;
}

/** A real HTTP provider against an unreachable endpoint: every call is one honest failing attempt. */
function failingProvider(fetchImpl?: typeof fetch, apiKey = 'test-key'): QlooHttpProvider {
  return new QlooHttpProvider({
    apiKey,
    baseUrl: 'https://qloo.invalid',
    timeoutMs: 2_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    sleep: () => Promise.resolve(),
  });
}

describe('durable graph work budgets (VAL-DISC-006)', () => {
  it('anchors the deadline at the first attempt and never re-anchors on redelivery', async () => {
    const accountId = await newAccount();
    const workKey = workKeyFor('anchor');
    const t0 = new Date('2026-10-28T12:00:00Z');
    const first = await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'expansion',
      workKey,
      at: t0,
      now: t0,
    });
    expect(first.created).toBe(true);
    expect(first.row.qloo_attempts_max).toBe(GRAPH_EXPANSION_QLOO_ATTEMPTS);
    expect(first.deadlineAt.toISOString()).toBe(new Date(t0.getTime() + GRAPH_EXPANSION_DEADLINE_MS).toISOString());
    expect(first.deadlineExpired).toBe(false);

    // A "restart": the same logical item re-ensured at a much later time
    // inherits the original anchor and remaining allowance, never a reset.
    const later = new Date('2026-10-28T12:00:30Z');
    const redelivered = await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'expansion',
      workKey,
      at: later,
      now: later,
    });
    expect(redelivered.created).toBe(false);
    expect(redelivered.row.id).toBe(first.row.id);
    expect(redelivered.row.deadline_started_at.toISOString()).toBe(first.row.deadline_started_at.toISOString());
    expect(redelivered.deadlineAt.toISOString()).toBe(first.deadlineAt.toISOString());
    expect(redelivered.remainingQlooAttempts).toBe(GRAPH_EXPANSION_QLOO_ATTEMPTS);

    // Once the anchored deadline passes, the logical item is expired — even
    // though a fresh process would have started a new 45 seconds.
    const after = await ensureGraphWorkBudget(db, {
      ownerAccountId: accountId,
      workKind: 'expansion',
      workKey,
      at: later,
      now: new Date(t0.getTime() + GRAPH_EXPANSION_DEADLINE_MS + 1_000),
    });
    expect(after.deadlineExpired).toBe(true);
    expect(after.deadlineRemainingMs).toBeLessThanOrEqual(-1_000);
  });

  it('reserves at most four Qloo attempts total, atomically, across concurrent callers', async () => {
    const accountId = await newAccount();
    const workKey = workKeyFor('cap');
    await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });

    // Eight concurrent reservations against one logical item: exactly four succeed.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveGraphWorkQlooAttempt(db, { ownerAccountId: accountId, workKey })),
    );
    expect(results.filter(Boolean)).toHaveLength(GRAPH_EXPANSION_QLOO_ATTEMPTS);
    const row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.qloo_attempts_used).toBe(GRAPH_EXPANSION_QLOO_ATTEMPTS);

    // A "restart" sees the spent budget; a new reservation sends nothing.
    const again = await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
    expect(again.remainingQlooAttempts).toBe(0);
    expect(await reserveGraphWorkQlooAttempt(db, { ownerAccountId: accountId, workKey })).toBe(false);
  });

  it('refuses a new attempt after the anchored deadline even while attempts remain', async () => {
    const accountId = await newAccount();
    const workKey = workKeyFor('expired-window');
    // The window was anchored by an earlier attempt and has since ended: the
    // row is still active with the full allowance left, but the LOGICAL
    // deadline is durably past. A delayed first claim or redelivery — a fresh
    // process would start a new 45 seconds — must not reserve a new attempt.
    const anchored = new Date(Date.now() - (GRAPH_EXPANSION_DEADLINE_MS + 5_000));
    await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey, at: anchored });
    const row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.state).toBe('active');
    expect(row?.qloo_attempts_used).toBe(0);

    // Delayed work cannot reserve a new attempt after its original deadline...
    expect(await reserveGraphWorkQlooAttempt(db, { ownerAccountId: accountId, workKey })).toBe(false);
    // ...and the refusal charged nothing and left the window state intact.
    const after = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(after?.qloo_attempts_used).toBe(0);
    expect(after?.state).toBe('active');

    // The same durable refusal holds through the real Qloo session: every
    // counted HTTP attempt reserves through the same guarded statement, so a
    // session over the expired window stops with BudgetExhaustedError before
    // any request is sent — no uncontrolled paid fallback.
    const budget = await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
    expect(budget.deadlineExpired).toBe(true);
    const session = graphWorkQlooSession(failingProvider(), db, {
      ownerAccountId: accountId,
      workKey,
      remainingQlooAttempts: budget.remainingQlooAttempts,
    });
    expect(session.searchUsable()).toBe(true);
    await expect(session.search('late query', undefined, { attempt: 'delayed' })).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    const finalRow = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(finalRow?.qloo_attempts_used).toBe(0);
  });

  it('a stopped budget refuses further reservations', async () => {
    const accountId = await newAccount();
    const workKey = workKeyFor('stopped');
    await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
    await setGraphWorkBudgetState(db, { ownerAccountId: accountId, workKey, state: 'stopped' });
    expect(await reserveGraphWorkQlooAttempt(db, { ownerAccountId: accountId, workKey })).toBe(false);
    const row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.state).toBe('stopped');
    expect(row?.qloo_attempts_used).toBe(0);
  });

  it('charges the durable budget through the real session: exact call counts, exhaustion stops work', async () => {
    const accountId = await newAccount();
    const workKey = workKeyFor('session');
    const budget = await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
    const provider = failingProvider();

    // Job attempt 1: two counted HTTP attempts through the real session.
    const session1 = graphWorkQlooSession(provider, db, {
      ownerAccountId: accountId,
      workKey,
      remainingQlooAttempts: budget.remainingQlooAttempts,
    });
    expect(session1.searchUsable()).toBe(true);
    for (let i = 0; i < 2; i++) {
      await expect(session1.search('test query', undefined, { i })).rejects.toThrow();
    }
    let row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.qloo_attempts_used).toBe(2);

    // Job attempt 2 (a "restart"): a NEW session over the same durable row.
    const budget2 = await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
    const session2 = graphWorkQlooSession(provider, db, {
      ownerAccountId: accountId,
      workKey,
      remainingQlooAttempts: budget2.remainingQlooAttempts,
    });
    await expect(session2.search('test query', undefined, { attempt: 2 })).rejects.toThrow();
    await expect(session2.search('test query', undefined, { attempt: 2, n: 1 })).rejects.toThrow();
    row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.qloo_attempts_used).toBe(4);

    // The cap is durable now: a third "process" gets an immediate honest
    // BudgetExhaustedError and NO further HTTP attempt happens.
    const budget3 = await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });
    const session3 = graphWorkQlooSession(provider, db, {
      ownerAccountId: accountId,
      workKey,
      remainingQlooAttempts: budget3.remainingQlooAttempts,
    });
    await expect(session3.search('test query', undefined, { attempt: 3 })).rejects.toBeInstanceOf(BudgetExhaustedError);
    row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.qloo_attempts_used).toBe(4);
    // Bounded work stopped: no uncontrolled fallback, no fifth reservation.
    expect(await reserveGraphWorkQlooAttempt(db, { ownerAccountId: accountId, workKey })).toBe(false);
  });

  it('graph Qloo sessions share the process-wide throttle', async () => {
    const accountId = await newAccount();
    const workKey = workKeyFor('throttle');
    const budget = await ensureGraphWorkBudget(db, { ownerAccountId: accountId, workKind: 'expansion', workKey });

    // A hanging fetch holds each HTTP attempt open until released, honoring
    // the client's abort signal so the request timeout still settles it.
    let release: (() => void) | undefined;
    const started: number[] = [];
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      started.push(started.length);
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return new Response(JSON.stringify({ entities: [], tags: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = failingProvider(fetchImpl, `throttle-${randomUUID()}`);
    expect(provider.limiter.max).toBe(3);

    const session = graphWorkQlooSession(provider, db, {
      ownerAccountId: accountId,
      workKey,
      remainingQlooAttempts: budget.remainingQlooAttempts,
    });
    const calls = Array.from({ length: 4 }, (_, i) =>
      session.search(`throttle ${i}`, undefined, { i }).catch((err: unknown) => err),
    );
    // Exactly limiter.max calls reach the wire at once; the fourth waits for
    // a slot — graph work shares the throttle with every other Qloo caller.
    for (let i = 0; i < 200 && started.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(started).toHaveLength(3);
    expect(provider.limiter.inFlight).toBe(3);
    release!();
    // The released attempt settles and the hanging ones settle at their own
    // 2s timeouts; only then does the fourth reach the wire.
    await Promise.all(calls);
    expect(started).toHaveLength(4);
    expect(provider.limiter.peak).toBeLessThanOrEqual(3);
    const row = await loadGraphWorkBudget(db, { ownerAccountId: accountId, workKey });
    expect(row?.qloo_attempts_used).toBe(4);
  });
});
