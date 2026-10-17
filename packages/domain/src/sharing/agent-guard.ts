import type { Queryable } from '../db/pool';
import { AppError } from '../errors';
import type { Principal } from '../principal';

/**
 * AGENTS-AND-SHARING scope table: collections:write "Cannot create public
 * access", and no tool creates or broadens a share grant. Shares are live
 * views, so an agent adding captured media (or the capture item that carries
 * it) to a collection whose live share includes captured media would show that
 * media to everyone in the share's audience, including anonymous link
 * holders. Only the owner may do that, in the first-party app.
 */
export async function assertAgentCannotExposeMedia(
  db: Queryable,
  principal: Principal,
  accountId: string,
  collectionId: string,
  now: Date,
): Promise<void> {
  if (principal.kind !== 'agent') return;
  const { rowCount } = await db.query(
    `SELECT 1 FROM collection_shares
      WHERE owner_account_id = $1 AND collection_id = $2 AND include_media
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $3)
      LIMIT 1`,
    [accountId, collectionId, now],
  );
  if (rowCount) {
    throw new AppError('scope_denied', {
      message: 'This collection is shared with its photos and videos. Only the owner can add media to it.',
      details: { reason: 'shared_with_media' },
    });
  }
}
