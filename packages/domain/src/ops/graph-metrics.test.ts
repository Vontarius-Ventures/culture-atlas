import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, insertAccount, type IsolatedDatabase } from '../testing';
import { setLogSink } from './log';
import {
  collectGraphOpsSnapshot,
  graphRunOutcomeLine,
  recentGraphRunOutcomes,
  toGraphOpsMetricLine,
} from './graph-metrics';

/**
 * VAL-OPS-003: privacy-safe graph observability. The snapshot is computed
 * from DURABLE state only — IDs, revisions, counts, codes and lags; never
 * photos, secrets, private interest text or item titles. Telemetry surfaces
 * projection lag, run rejection/failure, budget state and purge lag.
 */

let isolated: IsolatedDatabase;
beforeAll(async () => {
  isolated = await createIsolatedDatabase('graphops');
}, 60_000);
afterAll(async () => {
  setLogSink(undefined);
  await isolated?.drop();
});

describe('graph ops snapshot (VAL-OPS-003)', () => {
  it('is all zeros on an idle database', async () => {
    expect(await collectGraphOpsSnapshot(isolated.db)).toEqual({
      GraphProjectionLagSeconds: 0,
      GraphOutboxPending: 0,
      GraphRunsFailedLastHour: 0,
      GraphRunLagSeconds: 0,
      GraphExpansionRejectionsLastHour: 0,
      GraphBudgetWindowsStuck: 0,
      ModelReservedMicros: 0,
      ModelSettledMicros: 0,
      ModelUnknownAttempts: 0,
      AccountDeletionsOwed: 0,
      AccountPurgeLagSeconds: 0,
    });
  });

  it('reports projection lag, run failure/rejection, stuck budgets, ledger spend and purge lag from durable rows', async () => {
    const db = isolated.db;
    const now = new Date('2026-10-30T12:00:00Z');
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    const { accountId } = await insertAccount(db);

    // One pending projection intent 300s old (projection lag) + a done one.
    await db.query(
      `INSERT INTO graph_outbox(owner_account_id, event_type, logical_event_key, target_taste_revision, job_intent, dispatch_state, created_at)
       VALUES($1,'taste','t:1',1,'project_interest_graph','pending',$2),
             ($1,'taste','t:0',0,'project_interest_graph','done',$3)`,
      [accountId, ago(300), ago(900)],
    );
    // One failed run (finished 60s ago) and one stuck queued run (1200s old).
    const job = (
      await db.query<{ id: string }>(`INSERT INTO jobs(owner_account_id,type,state,available_at) VALUES($1,'expand_interest_graph','queued',$2) RETURNING id`, [
        accountId,
        ago(1200),
      ])
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO graph_runs(owner_account_id, job_id, run_kind, policy_version, state, published, started_at, finished_at, created_at, updated_at)
       VALUES($1,$2,'expansion','p1','failed',false,$3,$3,$3,$3)`,
      [accountId, job, ago(60)],
    );
    await db.query(
      `INSERT INTO graph_runs(owner_account_id, run_kind, policy_version, state, published, created_at)
       VALUES($1,'expansion','p1','queued',false,$2)`,
      [accountId, ago(1200)],
    );
    // A handler rejection trace 30s ago (in the window) and one 2h ago (out).
    await db.query(
      `INSERT INTO trace_events(job_id, owner_account_id, kind, name, created_at)
       VALUES($1,$2,'note','graph_expansion_fenced',$3),($1,$2,'note','graph_expansion_skipped',$4)`,
      [job, accountId, ago(30), ago(2 * 3600)],
    );
    // One stuck work budget (deadline long past, still active) + one healthy.
    await db.query(
      `INSERT INTO graph_work_budgets(owner_account_id, work_key, work_kind, qloo_attempts_used, qloo_attempts_max, deadline_started_at, deadline_ms, state)
       VALUES($1,'w:stuck','expansion',1,4,$2,45000,'active'),($1,'w:live','expansion',0,4,$3,45000,'active')`,
      [accountId, ago(90_000), ago(10)],
    );
    // Ledger spend: one settled (billed 150) + one unknown (reserved 100).
    await db.query(
      `INSERT INTO inference_attempts(id, account_id, job_id, role, attempt_key, gateway, requested_model, requested_provider,
         profile_version, prompt_version, schema_version, pricing_snapshot_version, reserved_micros, cost_micros, state, outcome, usage_day, started_at)
       VALUES($1,$2,$3,'research_text','k','concentrate','m','fixture','v','p','s','price',100,150,'settled','complete',$4,$5),
             ($6,$2,$3,'research_text','k2','concentrate','m','fixture','v','p','s','price',100,NULL,'unknown','timeout',$4,$5)`,
      [randomUUID(), accountId, 'job-1', '2026-10-30', ago(3600), randomUUID()],
    );
    // One owed account deletion accepted 2 days ago (purge lag).
    await db.query(
      `INSERT INTO account_deletions(account_id, cleanup_state, status_token_hash, requested_at, accepted_at, attempts)
       VALUES($1,'failed',$2,$3,$3,1)`,
      [accountId, randomUUID(), ago(2 * 86400)],
    );

    expect(await collectGraphOpsSnapshot(db, now)).toEqual({
      GraphProjectionLagSeconds: 300,
      GraphOutboxPending: 1,
      GraphRunsFailedLastHour: 1,
      GraphRunLagSeconds: 1200,
      GraphExpansionRejectionsLastHour: 1,
      GraphBudgetWindowsStuck: 1,
      ModelReservedMicros: 100,
      ModelSettledMicros: 150,
      ModelUnknownAttempts: 1,
      AccountDeletionsOwed: 1,
      AccountPurgeLagSeconds: 2 * 86400,
    });
  });

  it('formats an EMF line with counts and lags only', () => {
    const line = JSON.parse(
      toGraphOpsMetricLine(
        {
          GraphProjectionLagSeconds: 4,
          GraphOutboxPending: 2,
          GraphRunsFailedLastHour: 1,
          GraphRunLagSeconds: 0,
          GraphExpansionRejectionsLastHour: 0,
          GraphBudgetWindowsStuck: 0,
          ModelReservedMicros: 100,
          ModelSettledMicros: 0,
          ModelUnknownAttempts: 1,
          AccountDeletionsOwed: 1,
          AccountPurgeLagSeconds: 900,
        },
        { namespace: 'CultureAtlas', environment: 'staging', now: new Date(0) },
      ),
    );
    expect(line.event).toBe('graph_ops_snapshot');
    expect(line._aws.Timestamp).toBe(0);
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe('CultureAtlas');
    expect(line.Environment).toBe('staging');
    expect(line.GraphProjectionLagSeconds).toBe(4);
    expect(line.ModelReservedMicros).toBe(100);
    // Only IDs/counts/lags: no free-text fields exist in the line at all.
    expect(Object.keys(line).filter((k) => !['_aws', 'event', 'Environment'].includes(k)).every((k) => /Seconds|Count|Micros|Attempts|Pending|Owed|Stuck|Lag|Failed|Rejections/.test(k))).toBe(true);
  });

  it('samples recent run outcomes as sanitized, allowlisted log lines', async () => {
    const db = isolated.db;
    const { accountId } = await insertAccount(db);
    const run = (
      await db.query<{ id: string }>(
        `INSERT INTO graph_runs(owner_account_id, run_kind, policy_version, state, published, input_taste_revision, input_projection_revision, created_at)
         VALUES($1,'expansion','p1','complete',true,4,2,$2) RETURNING id`,
        [accountId, new Date('2026-11-01T00:00:00Z')],
      )
    ).rows[0]!;
    const outcomes = await recentGraphRunOutcomes(db, 1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      run_id: run.id,
      run_kind: 'expansion',
      state: 'complete',
      published: true,
      input_taste_revision: 4,
    });

    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    for (const outcome of outcomes) graphRunOutcomeLine(outcome);
    setLogSink(undefined);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.event).toBe('graph_run_outcome');
    expect(parsed.run_id).toBe(run.id);
    expect(parsed.kind).toBe('expansion');
    expect(parsed.outcome).toBe('complete');
    expect(parsed.published).toBe(true);
    expect(parsed.revision).toBe(4);
    // The line carries no titles, emails or interest text — the allowlist
    // cannot pass them even if a future field tried.
    expect(parsed.title).toBeUndefined();
    expect(parsed.data).toBeUndefined();
  });
});
