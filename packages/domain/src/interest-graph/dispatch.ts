import type { Db } from '../db/pool';
import { interestGraphProjectionDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';
import { projectionEnabledForAccount, type ProjectionGateConfig } from './intent';
import { markGraphOutboxDispatched } from './store';

/**
 * Outbox dispatch (PR 8 package B): at-least-once handoff from durable
 * projection intents to the existing database-backed queue. One account with
 * unsatisfied intents and no active projection job gets exactly one job; the
 * job's dedupe key covers the unsatisfied event set (with each event's attempt
 * count), so concurrent dispatchers never double-enqueue while a fresh set,
 * a re-delivery or a terminally failed job always gets a fresh job. Dispatch
 * is idempotent and crash-safe: enqueue first, mark second; a crash in
 * between re-dispatches (events still pending or their job absent).
 *
 * A dispatcher outage never loses a committed change: the intents simply stay
 * pending until dispatch runs again (VAL-PROJ-007).
 */

export interface DispatchGraphOutboxInput {
  config: ProjectionGateConfig;
  /** Dispatch only this account's intents (feed-read style); omit for all. */
  ownerAccountId?: string;
  /** Max accounts handled in one dispatch pass. */
  limit?: number;
}

export interface DispatchedGraphAccount {
  accountId: string;
  jobId: string;
  /** True when an existing non-failed job already covered the event set. */
  reused: boolean;
  /** Pending events transitioned to dispatched for this account. */
  eventsDispatched: number;
}

export interface DispatchGraphOutboxResult {
  accounts: DispatchedGraphAccount[];
  /** Total pending->dispatched transitions this pass. */
  eventsDispatched: number;
}

export async function dispatchGraphOutbox(db: Db, input: DispatchGraphOutboxInput): Promise<DispatchGraphOutboxResult> {
  const limit = Math.max(1, input.limit ?? 50);
  const ownerFilter = input.ownerAccountId ? 'AND o.owner_account_id = $2' : '';
  const params: unknown[] = [limit, ...(input.ownerAccountId ? [input.ownerAccountId] : [])];
  const { rows } = await db.query<{ owner_account_id: string }>(
    `SELECT o.owner_account_id, min(o.created_at) AS oldest
       FROM graph_outbox o
      WHERE o.dispatch_state IN ('pending','dispatched')
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.owner_account_id = o.owner_account_id
                 AND j.type = 'project_interest_graph'
                 AND j.state IN ('queued','running'))
        ${ownerFilter}
      GROUP BY o.owner_account_id
      ORDER BY oldest, o.owner_account_id
      LIMIT $1`,
    params,
  );

  const accounts: DispatchedGraphAccount[] = [];
  let eventsDispatched = 0;
  for (const row of rows) {
    const accountId = row.owner_account_id;
    // Killed or not opted in: the intents stay exactly where they are; a
    // later dispatch (or backfill) converges the account when re-enabled.
    if (!(await projectionEnabledForAccount(db, { accountId, config: input.config }))) continue;

    const { rows: events } = await db.query<{ id: string; attempts: number; dispatch_state: string }>(
      `SELECT id, attempts, dispatch_state FROM graph_outbox
        WHERE owner_account_id = $1 AND dispatch_state IN ('pending','dispatched')
        ORDER BY target_taste_revision, created_at, id`,
      [accountId],
    );
    if (events.length === 0) continue;

    const { job, reused } = await enqueueJob(db, {
      type: 'project_interest_graph',
      owner: { kind: 'account', accountId },
      payload: { account_id: accountId },
      dedupeKey: interestGraphProjectionDedupeKey({
        accountId,
        events: events.map((e) => ({ id: e.id, attempts: e.attempts })),
      }),
    });
    const pendingIds = events.filter((e) => e.dispatch_state === 'pending').map((e) => e.id);
    await markGraphOutboxDispatched(db, pendingIds);
    eventsDispatched += pendingIds.length;
    // The account is due: its projection state becomes queued (idle, ready
    // and failed states all mean "not being projected right now").
    await db.query(
      `INSERT INTO personal_graph_state (owner_account_id, state) VALUES ($1, 'queued')
       ON CONFLICT (owner_account_id) DO UPDATE
         SET state = CASE WHEN personal_graph_state.state IN ('idle','ready','failed')
                          THEN 'queued' ELSE personal_graph_state.state END,
             updated_at = now()`,
      [accountId],
    );
    accounts.push({ accountId, jobId: job.id, reused, eventsDispatched: pendingIds.length });
  }
  return { accounts, eventsDispatched };
}
