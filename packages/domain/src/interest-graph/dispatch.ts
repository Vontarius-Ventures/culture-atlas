import type { Db, Queryable } from '../db/pool';
import { interestGraphProjectionDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';
import { getTasteRevision } from '../services/taste';
import { projectionEnabledForAccount, projectionEnabledInConfig, type ProjectionGateConfig } from './intent';
import { PROJECTION_SUPPORT_VERSION } from './schema';
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
 *
 * Batch fairness (VAL-PROJ-007): the batch limit counts ELIGIBLE accounts
 * only. Projection-killed or not-opted-in accounts are filtered out before
 * the limit, so an older killed account with a due intent can never starve
 * newer enabled accounts out of the batch — its intent is retained untouched
 * (never consumed or dropped) and converges through ordinary dispatch once
 * the account is eligible again.
 *
 * The same sweep also hands off support-version catch-up work (upgrade
 * reprojection, VAL-PROJ-009): accounts whose applied projection predates
 * the current projector semantics (a behind-version completeness marker, e.g.
 * ready at an equal revision with a done outbox, silently omitting explicit
 * shared-save roots) get one current-state catch-up job each, without a new
 * user mutation and without touching a single outbox row.
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
  /**
   * Present when the job is a support-version catch-up (upgrade
   * reprojection): no mutation intent exists, the applied projection is
   * behind the current projector semantics and is rebuilt from current state.
   */
  catchUp?: 'support_version';
}

export interface DispatchGraphOutboxResult {
  accounts: DispatchedGraphAccount[];
  /** Total pending->dispatched transitions this pass. */
  eventsDispatched: number;
}

export async function dispatchGraphOutbox(db: Db, input: DispatchGraphOutboxInput): Promise<DispatchGraphOutboxResult> {
  // Config gate first: without the operator opt-in, or with the flag in the
  // environment kill list, no account can be eligible at all. The durable
  // intents stay exactly where they are for a later, enabled sweep.
  if (!projectionEnabledInConfig(input.config)) return { accounts: [], eventsDispatched: 0 };
  const limit = Math.max(1, input.limit ?? 50);
  const ownerFilter = input.ownerAccountId ? 'AND o.owner_account_id = $2' : '';
  const params: unknown[] = [limit, ...(input.ownerAccountId ? [input.ownerAccountId] : [])];
  // Eligibility is decided BEFORE the limit: the kill prefilter below is the
  // database half of `projectionEnabledForAccount` (`activeKills`) for the
  // projection flag and must stay in sync with it, so killed accounts never
  // occupy batch slots. The per-account check in the loop remains the
  // authoritative final gate — the env kill list is invisible to SQL, and a
  // kill can land between this snapshot and the enqueue. Skipped accounts
  // keep their intents exactly where they are; nothing is consumed.
  const { rows } = await db.query<{ owner_account_id: string }>(
    `SELECT o.owner_account_id, min(o.created_at) AS oldest
       FROM graph_outbox o
      WHERE o.dispatch_state IN ('pending','dispatched')
        AND NOT EXISTS (
              SELECT 1 FROM jobs j
               WHERE j.owner_account_id = o.owner_account_id
                 AND j.type = 'project_interest_graph'
                 AND j.state IN ('queued','running'))
        AND NOT EXISTS (
              SELECT 1 FROM feature_flag_kills k
               WHERE k.lifted_at IS NULL
                 AND k.flag = 'interest_graph_projection_enabled'
                 AND (k.account_id IS NULL OR k.account_id = o.owner_account_id))
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
    // Final concurrent kill check: a kill (or env kill list entry) that
    // landed after the candidate snapshot skips the account here; the
    // intents stay exactly where they are for a later sweep.
    if (!(await projectionEnabledForAccount(db, { accountId, config: input.config }))) continue;

    const { rows: events } = await db.query<{
      id: string;
      attempts: number;
      dispatch_state: string;
      target_taste_revision: number;
    }>(
      `SELECT id, attempts, dispatch_state, target_taste_revision FROM graph_outbox
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
    // and failed states all mean "not being projected right now") — but only
    // while the handed-off work is still unapplied; see the helper.
    await markGraphProjectionQueued(db, {
      accountId,
      // The newest intent's target revision (events are ordered by it).
      targetTasteRevision: events[events.length - 1]!.target_taste_revision,
    });
    accounts.push({ accountId, jobId: job.id, reused, eventsDispatched: pendingIds.length });
  }

  // --- Support-version catch-up (upgrade reprojection, VAL-PROJ-009) --------
  // A projection applied by OLDER projector semantics (before migration 270:
  // explicit saves of ownerless shared rows were omitted) can sit ready at the
  // current taste revision with every outbox event done, so no intent will
  // ever re-arm it. The versioned completeness marker makes those state rows
  // durably due; the normal worker sweep repairs them without a new user
  // mutation — the same current-state rebuild the backfill performs, through
  // the same queue, labeled support_version_catch_up. No outbox row is ever
  // touched: the repair is current-state work, not invented event provenance.
  // Accounts with unsatisfied intents are owned by the event phase above (its
  // job satisfies them and stamps the version in the same pass), so this pass
  // hands off only the equal-revision/done-outbox population the event phase
  // can never reach.
  const catchUpParams: unknown[] = input.ownerAccountId
    ? [limit, PROJECTION_SUPPORT_VERSION, input.ownerAccountId]
    : [limit, PROJECTION_SUPPORT_VERSION];
  const { rows: behind } = await db.query<{ owner_account_id: string }>(
    `SELECT s.owner_account_id
       FROM personal_graph_state s
      WHERE s.support_version < $2
        AND NOT EXISTS (SELECT 1 FROM graph_outbox o
                          WHERE o.owner_account_id = s.owner_account_id
                            AND o.dispatch_state IN ('pending','dispatched'))
        AND NOT EXISTS (SELECT 1 FROM jobs j
                          WHERE j.owner_account_id = s.owner_account_id
                            AND j.type = 'project_interest_graph'
                            AND j.state IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM feature_flag_kills k
                          WHERE k.lifted_at IS NULL
                            AND k.flag = 'interest_graph_projection_enabled'
                            AND (k.account_id IS NULL OR k.account_id = s.owner_account_id))
        ${input.ownerAccountId ? 'AND s.owner_account_id = $3' : ''}
      ORDER BY s.updated_at, s.owner_account_id
      LIMIT $1`,
    catchUpParams,
  );
  for (const row of behind) {
    const accountId = row.owner_account_id;
    // Final concurrent kill check, exactly like the event phase: a kill (or
    // env kill list entry) that landed after the candidate snapshot skips the
    // account; its behind-version marker stays exactly where it is.
    if (!(await projectionEnabledForAccount(db, { accountId, config: input.config }))) continue;
    // A concurrent repair (backfill, another worker's pass) may have stamped
    // the version since the snapshot: re-read the row and hand off only
    // accounts still behind.
    const { rows: state } = await db.query<{ support_version: number }>(
      'SELECT support_version FROM personal_graph_state WHERE owner_account_id = $1',
      [accountId],
    );
    if ((state[0]?.support_version ?? PROJECTION_SUPPORT_VERSION) >= PROJECTION_SUPPORT_VERSION) continue;

    const { job, reused } = await enqueueJob(db, {
      type: 'project_interest_graph',
      owner: { kind: 'account', accountId },
      payload: { account_id: accountId, catch_up: 'support_version' },
      // Keyed per target version: a completed catch-up job can never block a
      // future marker bump's fresh job.
      dedupeKey: interestGraphProjectionDedupeKey({
        accountId,
        events: [],
        catchUpTo: PROJECTION_SUPPORT_VERSION,
      }),
    });
    await markGraphProjectionQueued(db, {
      accountId,
      targetTasteRevision: await getTasteRevision(db, { kind: 'account', accountId }),
    });
    accounts.push({ accountId, jobId: job.id, reused, eventsDispatched: 0, catchUp: 'support_version' });
  }
  return { accounts, eventsDispatched };
}

/**
 * The dispatcher's post-enqueue status flip, separate from the enqueue and
 * the dispatched marks because the queued job can already have RUN TO
 * COMPLETION by the time this statement executes (the worker claims jobs
 * concurrently). 'queued' means the queue holds work whose target revision is
 * not applied yet, or whose applied projection predates the CURRENT support
 * semantics (a behind-version completeness marker — the catch-up handed off
 * in this same pass): a projection that fully applied the handed-off newest
 * intent at the current semantics is 'ready', and that state is both truthful
 * and terminal — a ready state with no pending intents and a current marker is
 * never re-dispatched, so flipping it back would durably misreport completed
 * work (VAL-PROJ-008).
 *
 * The guard is deliberately ROW-LOCAL (no subquery over graph_outbox): this
 * statement can park on the projector's `personal_graph_state` row lock
 * while a pass completes. PostgreSQL then re-evaluates the conflict path
 * against the fresh committed row, but subqueries would re-run against the
 * statement's original snapshot — reading the pre-completion outbox and
 * flipping a fully applied projection back to queued. Both row-local
 * comparisons re-read the state row fresh and keep the dispatcher's own
 * parameters, so every ordering decides against current truth: a completed
 * pass has `applied >= target` and the current marker and leaves 'ready'
 * untouched, while a pass that could not see the newest intent has
 * `applied < target` and an equal-revision legacy projection has
 * `support_version < current` — in both cases the honest ready→queued
 * transition happens for exactly the work the next pass must reconcile.
 */
export async function markGraphProjectionQueued(
  db: Queryable,
  input: { accountId: string; targetTasteRevision: number },
): Promise<void> {
  await db.query(
    `INSERT INTO personal_graph_state (owner_account_id, state) VALUES ($1, 'queued')
     ON CONFLICT (owner_account_id) DO UPDATE
       SET state = 'queued', updated_at = now()
      WHERE personal_graph_state.state IN ('idle','ready','failed')
        AND (personal_graph_state.applied_taste_revision < $2
             OR personal_graph_state.support_version < $3)`,
    [input.accountId, input.targetTasteRevision, PROJECTION_SUPPORT_VERSION],
  );
}
