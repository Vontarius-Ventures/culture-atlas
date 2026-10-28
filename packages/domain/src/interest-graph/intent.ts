import type { Queryable } from '../db/pool';
import { activeKills } from '../flags/feature-flags';
import { enqueueGraphOutboxEvent } from './store';

/**
 * Transactional projection intent for explicit mutations (PR 8, package B).
 *
 * Effective save, pick-group, exclusion and claim mutations enqueue one
 * durable graph_outbox event in the SAME transaction that commits the
 * authoritative rows and the synchronous taste update, so state and intent
 * commit or roll back together and a dispatcher outage can never lose a
 * committed change. No-op mutations (duplicate saves/hides, already-active
 * re-picks, membership-only collection edits) never call in, and exposure-only
 * paths (Interests-board auto-fill of recommendations) must never call in:
 * recommendations cannot endorse themselves.
 *
 * The hooks are gated on the projection flag exactly as documented in
 * specs/capture-platform-v2/feature-flags.json: default off, the operator
 * opt-in must hold, and kill switches (global or per account) only turn it
 * off. While off, no rows are written at all; the current-state backfill
 * reconciles accounts when the flag is enabled.
 */

/** Config subset the gate reads; DomainConfig satisfies it structurally. */
export interface ProjectionGateConfig {
  INTEREST_GRAPH_PROJECTION_ENABLED?: string;
  FEATURE_KILL_SWITCHES?: string;
}

const optedIn = (value: string | undefined) => value === 'true' || value === '1';

/** The projection flag for one account: operator opt-in AND not killed. */
export async function projectionEnabledForAccount(
  db: Queryable,
  input: { accountId: string; config: ProjectionGateConfig },
): Promise<boolean> {
  if (!optedIn(input.config.INTEREST_GRAPH_PROJECTION_ENABLED)) return false;
  const killed = await activeKills(db, input.accountId, input.config);
  return !killed.has('interest_graph_projection_enabled');
}

/** The intent kinds the explicit-mutation hooks emit today. */
export type ExplicitIntentKind = 'taste' | 'picks' | 'claim';

export interface NoteExplicitIntentInput {
  ownerAccountId: string;
  kind: ExplicitIntentKind;
  /** Lineage action: 'save' | 'remove' | 'hide' | 'unhide' | 'pick_created' | 'pick_removed' | 'claim'. */
  action: string;
  /** The taste revision the projection must reach (the mutation's new revision). */
  targetTasteRevision: number;
  config: ProjectionGateConfig;
  payload?: Record<string, unknown>;
}

/**
 * Enqueue the durable projection intent for one effective explicit mutation.
 * Callers run this inside the mutation's transaction. Bursts that land on the
 * same revision collapse into one row (the newest intent wins); a newer
 * revision is a new durable row. Returns whether an intent row was written.
 */
export async function noteExplicitIntent(db: Queryable, input: NoteExplicitIntentInput): Promise<boolean> {
  if (!(await projectionEnabledForAccount(db, { accountId: input.ownerAccountId, config: input.config }))) return false;
  await enqueueGraphOutboxEvent(db, {
    ownerAccountId: input.ownerAccountId,
    eventType: input.kind,
    logicalEventKey: input.kind,
    targetTasteRevision: input.targetTasteRevision,
    jobIntent: 'project_interest_graph',
    payload: { action: input.action, ...(input.payload ?? {}) },
  });
  return true;
}
