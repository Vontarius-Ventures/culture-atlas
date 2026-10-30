import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, insertAccount, type IsolatedDatabase } from '../testing';
import {
  buildSpendReconciliation,
  collectProviderQueryActivity,
  collectSpendLedgerTotals,
  spendCeilingsFromEnv,
  toSpendReconciliationLine,
} from './spend-report';

/**
 * VAL-OPS-002 evidence: the durable ledger reconciliation against the total
 * ceiling. The report is built from durable rows only — reserved/unknown/
 * billed micros and per-provider request counts, never payloads, identities
 * or secrets — so the operator can reconcile cumulative live provider
 * activity against the configured $-ceiling before any further paid call.
 */

let isolated: IsolatedDatabase;
beforeAll(async () => {
  isolated = await createIsolatedDatabase('spendrep');
}, 60_000);
afterAll(async () => {
  await isolated?.drop();
});

function seedAttempt(accountId: string, over: { state: 'settled' | 'unknown' | 'reserved'; reserved: number; cost: number | null; day: string }) {
  return isolated.db.query(
    `INSERT INTO inference_attempts(id, account_id, job_id, role, attempt_key, gateway, requested_model, requested_provider,
       profile_version, prompt_version, schema_version, pricing_snapshot_version, reserved_micros, cost_micros, state, outcome, usage_day, started_at)
     VALUES($1,$2,$3,'research_text',$4,'concentrate','m','fixture','v','p','s','price',$5,$6,$7,$8,$9,now())`,
    [randomUUID(), accountId, `job-${randomUUID().slice(0, 8)}`, randomUUID(), over.reserved, over.cost, over.state, over.state === 'settled' ? 'complete' : 'dispatched', over.day],
  );
}

describe('spend reconciliation against the total ceiling (VAL-OPS-002)', () => {
  it('totals reserved, unknown and billed ledger rows from durable state', async () => {
    const { accountId } = await insertAccount(isolated.db);
    await seedAttempt(accountId, { state: 'settled', reserved: 100, cost: 100, day: '2026-10-28' });
    await seedAttempt(accountId, { state: 'settled', reserved: 100, cost: 250, day: '2026-10-29' });
    await seedAttempt(accountId, { state: 'unknown', reserved: 100, cost: null, day: '2026-10-30' });

    const totals = await collectSpendLedgerTotals(isolated.db);
    expect(totals).toEqual({
      reservedMicros: 100,
      settledMicros: 350,
      unknownAttempts: 1,
      totalAttempts: 3,
      chargedMicros: 450,
    });
  });

  it('counts provider request activity without any payload or account data', async () => {
    const { accountId } = await insertAccount(isolated.db);
    const run = (
      await isolated.db.query<{ id: string }>(
        `INSERT INTO graph_runs(owner_account_id, run_kind, policy_version, state, published)
         VALUES($1,'expansion','p1','complete',true) RETURNING id`,
        [accountId],
      )
    ).rows[0]!;
    await isolated.db.query(
      `INSERT INTO provider_queries(provider, operation, graph_run_id, owner_account_id)
       VALUES('qloo','search',$1,$2),('qloo','search',$1,$2),('research','find_sources',$1,$2)`,
      [run.id, accountId],
    );

    const activity = await collectProviderQueryActivity(isolated.db);
    expect(activity).toEqual([
      { provider: 'qloo', operation: 'search', count: 2 },
      { provider: 'research', operation: 'find_sources', count: 1 },
    ]);
  });

  it('reconciles charged micros against the configured ceilings with honest status', () => {
    const ceilings = spendCeilingsFromEnv({
      MODEL_DAILY_SPEND_LIMIT_USD: '10',
      MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD: '2',
      MODEL_MAX_UNKNOWN_SPEND_USD: '0.01',
      MODEL_TOTAL_SPEND_LIMIT_USD: '100',
    });
    expect(ceilings).toEqual({
      dailyUsd: 10,
      accountDailyUsd: 2,
      maxUnknownUsd: 0.01,
      totalUsd: 100,
    });

    const within = buildSpendReconciliation({
      totals: { reservedMicros: 100, settledMicros: 350, unknownAttempts: 1, totalAttempts: 3, chargedMicros: 450 },
      activity: [{ provider: 'qloo', operation: 'search', count: 2 }],
      ceilings,
    });
    expect(within.ceilingStatus).toBe('within');
    expect(within.remainingTotalMicros).toBe(100_000_000 - 450);
    expect(within.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Unknown-outcome attempts are charged at their reservation until billing reconciliation'),
        expect.stringContaining('Provider request counts do not establish whether the provider billed them'),
      ]),
    );

    const exceeded = buildSpendReconciliation({
      totals: { reservedMicros: 100, settledMicros: 100_000_000, unknownAttempts: 0, totalAttempts: 2, chargedMicros: 100_000_100 },
      activity: [],
      ceilings,
    });
    expect(exceeded.ceilingStatus).toBe('exceeded');
    expect(exceeded.remainingTotalMicros).toBe(-100);

    const unconfigured = buildSpendReconciliation({
      totals: { reservedMicros: 0, settledMicros: 0, unknownAttempts: 0, totalAttempts: 0, chargedMicros: 0 },
      activity: [],
      ceilings: spendCeilingsFromEnv({}),
    });
    expect(unconfigured.ceilingStatus).toBe('not_configured');
    expect(unconfigured.remainingTotalMicros).toBeNull();
    expect(unconfigured.notes).toEqual(
      expect.arrayContaining([expect.stringContaining('No all-time total ceiling is configured')]),
    );
  });

  it('formats one JSON line with only counts, micros and provider codes', () => {
    const line = JSON.parse(
      toSpendReconciliationLine(
        buildSpendReconciliation({
          totals: { reservedMicros: 100, settledMicros: 350, unknownAttempts: 1, totalAttempts: 3, chargedMicros: 450 },
          activity: [{ provider: 'qloo', operation: 'search', count: 2 }],
          ceilings: { dailyUsd: 10, accountDailyUsd: 2, maxUnknownUsd: 0.01, totalUsd: 100 },
        }),
        { now: new Date(0) },
      ),
    );
    expect(line.event).toBe('spend_reconciliation');
    expect(line.time).toBe('1970-01-01T00:00:00.000Z');
    expect(line.ledger).toEqual({
      reservedMicros: 100,
      settledMicros: 350,
      unknownAttempts: 1,
      totalAttempts: 3,
      chargedMicros: 450,
    });
    expect(line.ceilingStatus).toBe('within');
    expect(line.remainingTotalMicros).toBe(99_999_550);
    expect(line.providerQueries).toEqual([{ provider: 'qloo', operation: 'search', count: 2 }]);
    // No payloads, identities or secrets in the line.
    expect(JSON.stringify(line)).not.toMatch(/(cat_|Bearer |@|[A-Za-z0-9_-]{43,})/);
  });
});
