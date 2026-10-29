import { z } from 'zod';
import type { Queryable } from '../db/pool';
import { AppError } from '../errors';

/**
 * Durable grant authority for the approved grant-scoped Discover more branch
 * (approved 2026-10-29, migration 360).
 *
 * The existing selected-collection REST POST /v1/items/{id}/discoveries /
 * MCP discover_related operation — under its existing collections:read grant,
 * collection and origin-membership checks — is the sole supported grant-scoped
 * graph producer. Its enqueue transaction records ONE immutable
 * `discovery_grant_authorities` row pinning the account owner, the initiating
 * agent connection, the connection's enqueue-time authorization version, the
 * granted collection (with the grant row's granted_at epoch), the origin item
 * and both job identities. A database trigger rejects every in-place rewrite,
 * so retries, redeliveries, dedupe hits and direct SQL can never adopt a
 * later grant epoch, owner or resource: a later epoch is always a fresh
 * enqueue with a fresh row.
 *
 * The graph branch this authority authorizes is deliberately separate from
 * account-owned graph work: nothing here reads or writes graph_runs, frontier
 * or personal edges, and grant revoke/narrow/regrant transitions never touch
 * account-owned state. Legacy whole-library Discover more (no collection)
 * enqueues no authority row and keeps its unchanged operation shape.
 */

/** Row shape of `discovery_grant_authorities` (migration 360). */
export const DiscoveryGrantAuthorityRow = z.object({
  id: z.string().uuid(),
  owner_account_id: z.string().uuid(),
  discovery_job_id: z.string().uuid(),
  job_id: z.string().uuid(),
  agent_connection_id: z.string().uuid().nullable(),
  authorization_version: z.number().int().nullable(),
  collection_granted_at: z.date().nullable(),
  origin_collection_id: z.string().uuid(),
  origin_item_id: z.string().uuid(),
  created_at: z.date(),
});
export type DiscoveryGrantAuthorityRow = z.infer<typeof DiscoveryGrantAuthorityRow>;

/** An authority resolved together with its real queue job's type and state. */
export const ScopedDiscoveryGrantAuthority = DiscoveryGrantAuthorityRow.extend({
  job_type: z.string(),
  job_state: z.string(),
});
export type ScopedDiscoveryGrantAuthority = z.infer<typeof ScopedDiscoveryGrantAuthority>;

const AUTHORITY_COLUMNS = `id, owner_account_id, discovery_job_id, job_id, agent_connection_id,
  authorization_version, collection_granted_at, origin_collection_id, origin_item_id, created_at`;

/**
 * The live grant epoch of an initiating agent connection, read under the
 * connection's row lock inside the enqueue transaction. The lock serializes
 * with the real owner grant mutations (v1 replace, v2 narrow, rotate), so the
 * returned epoch is exactly the live state this enqueue is authorized by:
 * revoke or expiry fail closed, and a vanished per-collection grant row is
 * non-disclosing (the grant changed between the request's checks and the
 * enqueue commit, so the enqueue must not happen at all).
 *
 * Whole-library connections have no per-collection grant row and return a
 * null grant timestamp; their epoch is the connection's authorization version.
 */
export interface AgentGrantEpoch {
  authorizationVersion: number;
  collectionGrantedAt: Date | null;
}

export async function lockAgentGrantEpoch(
  db: Queryable,
  input: { accountId: string; connectionId: string; collectionId: string; now: Date },
): Promise<AgentGrantEpoch> {
  const conn = await db.query<{
    authorization_version: number;
    library_access: string;
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT authorization_version, library_access, revoked_at, expires_at
       FROM agent_connections
      WHERE id = $1 AND owner_account_id = $2 AND purpose = 'agent'
      FOR UPDATE`,
    [input.connectionId, input.accountId],
  );
  const row = conn.rows[0];
  if (!row || row.revoked_at) throw new AppError('token_revoked');
  if (row.expires_at <= input.now) throw new AppError('token_expired');
  let collectionGrantedAt: Date | null = null;
  if (row.library_access === 'selected_collections') {
    const grant = await db.query<{ granted_at: Date }>(
      'SELECT granted_at FROM agent_connection_collections WHERE agent_connection_id = $1 AND collection_id = $2',
      [input.connectionId, input.collectionId],
    );
    if (!grant.rows[0]) throw new AppError('not_found');
    collectionGrantedAt = grant.rows[0].granted_at;
  }
  return { authorizationVersion: row.authorization_version, collectionGrantedAt };
}

export interface RecordDiscoveryGrantAuthorityInput {
  ownerAccountId: string;
  discoveryJobId: string;
  jobId: string;
  agentConnectionId: string | null;
  authorizationVersion: number | null;
  collectionGrantedAt: Date | null;
  originCollectionId: string;
  originItemId: string;
}

/**
 * Write-once producer authority for one selected-collection Discover more
 * enqueue. Called inside the enqueue transaction AFTER the dedupe arbiter
 * decided this enqueue owns a fresh job (a dedupe race loser's row is deleted
 * with its discovery job before this can run), so exactly one authority row
 * exists per enqueued scoped discovery. Never call this for updates: the
 * migration-360 trigger rejects every in-place rewrite.
 */
export async function recordDiscoveryGrantAuthority(
  db: Queryable,
  input: RecordDiscoveryGrantAuthorityInput,
): Promise<DiscoveryGrantAuthorityRow> {
  const { rows } = await db.query<DiscoveryGrantAuthorityRow>(
    `INSERT INTO discovery_grant_authorities
       (owner_account_id, discovery_job_id, job_id, agent_connection_id,
        authorization_version, collection_granted_at, origin_collection_id, origin_item_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${AUTHORITY_COLUMNS}`,
    [
      input.ownerAccountId,
      input.discoveryJobId,
      input.jobId,
      input.agentConnectionId,
      input.authorizationVersion,
      input.collectionGrantedAt,
      input.originCollectionId,
      input.originItemId,
    ],
  );
  return rows[0]!;
}

/**
 * The discovery's persisted authority together with its real queue job's type
 * and state, or null when the discovery was not produced by the scoped
 * operation (legacy whole-library Discover more has no authority row).
 */
export async function discoveryGrantAuthorityForJob(
  db: Queryable,
  input: { ownerAccountId: string; discoveryJobId: string },
): Promise<ScopedDiscoveryGrantAuthority | null> {
  const { rows } = await db.query<ScopedDiscoveryGrantAuthority>(
    `SELECT a.id, a.owner_account_id, a.discovery_job_id, a.job_id, a.agent_connection_id,
            a.authorization_version, a.collection_granted_at, a.origin_collection_id, a.origin_item_id,
            a.created_at, j.type AS job_type, j.state AS job_state
       FROM discovery_grant_authorities a
       JOIN jobs j ON j.id = a.job_id AND j.owner_account_id = a.owner_account_id
      WHERE a.discovery_job_id = $1 AND a.owner_account_id = $2`,
    [input.discoveryJobId, input.ownerAccountId],
  );
  return rows[0] ?? null;
}

/**
 * The discovery's persisted authority, failing non-disclosing unless it
 * resolves for THIS owner AND its recorded queue job is a real
 * `discover_related` job — the definition of a supported scoped graph job for
 * the approved graph branch.
 */
export async function requireDiscoveryGrantAuthorityForJob(
  db: Queryable,
  input: { ownerAccountId: string; discoveryJobId: string },
): Promise<ScopedDiscoveryGrantAuthority> {
  const authority = await discoveryGrantAuthorityForJob(db, input);
  if (!authority || authority.job_type !== 'discover_related') {
    throw new AppError('not_found', { message: 'Discovery grant authority not found.' });
  }
  return authority;
}

/**
 * The publication fence of the approved grant-scoped Discover more producer
 * (scoped-discover-revocation-publication; VAL-DISC-007).
 *
 * Called inside the scoped graph pass's ONE publication transaction, it locks
 * the initiating connection's row and the origin collection's row FOR SHARE
 * and rechecks the pinned enqueue-time authority against CURRENT live state,
 * holding both locks through the transaction's commit:
 *
 *  - connection liveness: revoke → token_revoked, expiry (decided by the
 *    database's own clock) → token_expired;
 *  - the pinned authorization version (a v2 narrow/rotate bumped the live
 *    version) → token_revoked — the same mapping the per-request principal
 *    resolution applies;
 *  - the per-collection grant epoch for selected-collection connections: the
 *    live grant row must still exist for the pinned collection with the pinned
 *    granted_at (a v1 remove/regrant changed the epoch) → not_found,
 *    non-disclosing, exactly like the enqueue-time lock;
 *  - collection ownership and the origin's CURRENT membership in the pinned
 *    origin collection (a removed membership or a deleted collection, which
 *    also cascades the authority row away) → not_found.
 *
 * Every real owner mutation path takes one of these two locks first —
 * revoke/narrow/rotate UPDATE or lock agent_connections, v1 grant replace
 * locks agent_connections FOR UPDATE before touching grant rows, and
 * deleteCollection / removeCollectionItem lock the collections row FOR UPDATE
 * before touching memberships — so a mutation either commits before this
 * fence (visible here: the work rejects) or WAITS for the publication commit
 * (the publisher-first ordering: the results were published under valid
 * authority and the mutation's read-time denial applies from then on). Retry,
 * redelivery, dedupe and regrant cannot adopt a newer epoch: the authority
 * row is immutable and this fence compares its pins.
 *
 * The origin's own save row is deliberately NOT locked: unsave deletes
 * saved_items (cascading memberships) without taking the collections lock
 * first, and locking it would invert the lock order against the collection
 * mutators (a deadlock cycle). A mid-pass unsave is instead fenced at READ
 * time — the agent grant-visibility rules recheck CURRENT membership on
 * every job-polling and related-read request — and the owner's own surfaces
 * stay first-party authorized.
 *
 * The rejection surfaces as a typed, non-retryable AppError: the whole pass
 * rolls back, nothing publishes, and the queue job records the code.
 */
export async function lockScopedPublicationAuthority(
  db: Queryable,
  input: { authority: DiscoveryGrantAuthorityRow },
): Promise<void> {
  const { authority } = input;
  const nonDisclosing = () => new AppError('not_found', { message: 'Discovery grant authority not found.' });

  // --- The initiating connection: liveness, version, grant epoch -----------
  // FOR SHARE blocks every row modification (revoke, narrow, rotate, v1
  // replace) while staying compatible with foreign-key key-share inserts and
  // concurrent publishers, and it is held to this transaction's commit.
  if (authority.agent_connection_id != null) {
    const conn = await db.query<{
      authorization_version: number;
      library_access: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT authorization_version, library_access, revoked_at, expires_at
         FROM agent_connections
        WHERE id = $1 AND owner_account_id = $2 AND purpose = 'agent'
        FOR SHARE`,
      [authority.agent_connection_id, authority.owner_account_id],
    );
    const row = conn.rows[0];
    if (!row) throw nonDisclosing();
    if (row.revoked_at) throw new AppError('token_revoked');
    // Expiry is decided by the database's own clock, never the pass's
    // run-start clock (the DISC-SCR-009 discipline).
    const clock = await db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    if (row.expires_at <= clock.rows[0]!.now) throw new AppError('token_expired');
    // A v2 narrow/rotate bumped the live version: the pinned epoch is gone.
    if (row.authorization_version !== authority.authorization_version) throw new AppError('token_revoked');
    if (row.library_access === 'selected_collections') {
      const grant = await db.query<{ granted_at: Date }>(
        'SELECT granted_at FROM agent_connection_collections WHERE agent_connection_id = $1 AND collection_id = $2',
        [authority.agent_connection_id, authority.origin_collection_id],
      );
      const granted = grant.rows[0];
      // The pinned grant epoch (granted_at) is compared as an exact pair with
      // the pinned version: v1 remove/regrant advances it at an unchanged
      // version, so the regranted state never authorizes the old job.
      if (
        !granted ||
        authority.collection_granted_at == null ||
        granted.granted_at.getTime() !== authority.collection_granted_at.getTime()
      ) {
        throw nonDisclosing();
      }
    }
  }

  // --- Collection ownership + origin membership under the collection lock --
  // deleteCollection / removeCollectionItem / addCollectionItem lock this row
  // FOR UPDATE first, so the membership read below is serialized with them
  // through the commit (a change either committed before this fence — visible
  // — or waits behind it).
  const collection = await db.query('SELECT 1 FROM collections WHERE id = $1 AND owner_account_id = $2 FOR SHARE', [
    authority.origin_collection_id,
    authority.owner_account_id,
  ]);
  if (!collection.rowCount) throw nonDisclosing();
  const member = await db.query(
    `SELECT 1 FROM collection_items ci JOIN saved_items si ON si.id = ci.saved_item_id
      WHERE ci.collection_id = $1 AND ci.owner_account_id = $2 AND si.discovery_item_id = $3`,
    [authority.origin_collection_id, authority.owner_account_id, authority.origin_item_id],
  );
  if (!member.rowCount) throw nonDisclosing();
}
