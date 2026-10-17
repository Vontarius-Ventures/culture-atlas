import { createHmac } from 'node:crypto';
import { requireAccountOwner } from '../authz';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { AppError } from '../errors';
import {
  AcceptInvitationRequest,
  CreateInvitationRequest,
  CreateShareRequest,
  RedeemShareRequest,
  UpdateShareRequest,
  type ShareDto,
} from '../schemas/collection-shares';
import {
  isPublicCatalogKey,
  projectDiscoveries,
  projectMedia,
  resolveSharedMediaObject,
  type LiveShare,
  type ShareableMediaObject,
} from '../sharing/projection';
import { addDays, iso } from '../util/time';
import { hashToken, randomToken } from './auth';
import { addCollectionItem } from './collections';
import { normalizeEmail } from './passwords';
import { saveItem } from './preferences';

/**
 * Collection sharing (AGENTS-AND-SHARING "Collection sharing product
 * contract"). A share is a read-only audience grant on ONE collection:
 *
 *  - Owner routes require the account owner in the browser
 *    (requireAccountOwner): agents, installations and share viewers can never
 *    create, change or broaden a share.
 *  - Restricted shares admit only accounts whose VERIFIED email matches the
 *    invitation exactly; invitation responses are uniform and never reveal
 *    whether an address has an account.
 *  - Link shares are bearer audiences. The 256-bit secret lives in a URL
 *    fragment, is exchanged once by POST for an HttpOnly session token, and
 *    only hashes are stored.
 *  - Viewers receive only the ShareProjection (sharing/projection.ts). Every
 *    viewer call re-reads the share, session/membership and collection, so
 *    revocation, expiry and deletion take effect on the next request.
 */

const meta = (ctx: ServiceContext) => ({ schema_version: '2.1' as const, request_id: ctx.requestId });
/** The only message a viewer gets for invalid, expired, revoked or deleted shares. */
export const SHARE_UNAVAILABLE = 'This collection is no longer shared.';
const unavailable = () => new AppError('not_found', { message: SHARE_UNAVAILABLE });
const INVITE_INVALID = 'This invitation is not valid for this account. Sign in with the invited, verified email.';

export const LINK_TOKEN_PREFIX = 'cas_';
export const INVITE_TOKEN_PREFIX = 'csi_';
export const SHARE_SESSION_HOURS = 12;
export const INVITE_DAYS = 7;
export const REDEEM_PER_MINUTE = 10;

interface ShareRow {
  id: string;
  owner_account_id: string;
  collection_id: string | null;
  audience: 'restricted' | 'link';
  expires_at: Date | null;
  revoked_at: Date | null;
  include_media: boolean;
  allow_originals: boolean;
  policy_version: number;
  created_at: Date;
}

const SHARE_COLUMNS = `id, owner_account_id, collection_id, audience, expires_at, revoked_at, include_media,
  allow_originals, policy_version, created_at`;

function baseUrl(ctx: ServiceContext): string {
  return ctx.config.APP_BASE_URL.replace(/\/+$/, '');
}

/** Keyed hash of a normalized address: comparable, not reversible without the server secret. */
export function emailHash(ctx: Pick<ServiceContext, 'config'>, email: string): string {
  return createHmac('sha256', ctx.config.SESSION_SECRET).update(`share-invite:${normalizeEmail(email)}`).digest('hex');
}

function isLive(row: Pick<ShareRow, 'revoked_at' | 'expires_at' | 'collection_id'>, now: Date): boolean {
  return !row.revoked_at && row.collection_id !== null && (row.expires_at === null || row.expires_at > now);
}

async function audit(
  db: Queryable,
  input: { accountId: string; actor: 'owner' | 'viewer' | 'link' | 'system'; actorAccountId?: string | null; action: string;
    shareId?: string | null; collectionId?: string | null; targetId?: string | null; now: Date },
) {
  await db.query(
    `INSERT INTO audit_events (account_id, actor, actor_account_id, action, share_id, collection_id, target_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [input.accountId, input.actor, input.actorAccountId ?? null, input.action, input.shareId ?? null,
      input.collectionId ?? null, input.targetId ?? null, input.now],
  );
}

async function ownedCollection(db: Queryable, accountId: string, collectionId: string, lock = false) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM collections WHERE id = $1 AND owner_account_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [collectionId, accountId],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0].id;
}

async function toDtos(db: Queryable, rows: ShareRow[], now: Date): Promise<ShareDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const members = await db.query<{ share_id: string; display_name: string | null; created_at: Date }>(
    `SELECT m.share_id, a.display_name, m.created_at FROM collection_share_members m
       JOIN accounts a ON a.id = m.verified_account_id
      WHERE m.share_id = ANY($1::uuid[]) ORDER BY m.created_at, m.verified_account_id`,
    [ids],
  );
  const invites = await db.query<{ id: string; share_id: string; expires_at: Date; accepted_at: Date | null;
    revoked_at: Date | null; created_at: Date }>(
    `SELECT id, share_id, expires_at, accepted_at, revoked_at, created_at FROM share_invites
      WHERE share_id = ANY($1::uuid[]) ORDER BY created_at DESC, id LIMIT 500`,
    [ids],
  );
  return rows.map((r) => ({
    id: r.id,
    collection_id: r.collection_id,
    audience: r.audience,
    status: r.revoked_at || r.collection_id === null ? 'revoked' : r.expires_at && r.expires_at <= now ? 'expired' : 'active',
    include_media: r.include_media,
    allow_originals: r.allow_originals,
    expires_at: iso(r.expires_at),
    revoked_at: iso(r.revoked_at),
    policy_version: r.policy_version,
    created_at: iso(r.created_at)!,
    members: members.rows.filter((m) => m.share_id === r.id).map((m) => ({ display_name: m.display_name, joined_at: iso(m.created_at)! })),
    invitations: invites.rows.filter((i) => i.share_id === r.id).map((i) => ({
      id: i.id,
      status: i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : i.expires_at <= now ? 'expired' : 'pending',
      expires_at: iso(i.expires_at)!,
      created_at: iso(i.created_at)!,
    })),
  }));
}

async function loadOwnedShare(db: Queryable, accountId: string, shareId: string, lock = false): Promise<ShareRow> {
  const { rows } = await db.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM collection_shares WHERE id = $1 AND owner_account_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [shareId, accountId],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

/** GET /v2/collections/{id}/shares — owner only. */
export async function listShares(ctx: ServiceContext, collectionId: string) {
  const owner = requireAccountOwner(ctx.principal);
  await ownedCollection(ctx.db, owner.accountId, collectionId);
  const { rows } = await ctx.db.query<ShareRow>(
    `SELECT ${SHARE_COLUMNS} FROM collection_shares WHERE owner_account_id = $1 AND collection_id = $2
      ORDER BY created_at DESC, id LIMIT 50`,
    [owner.accountId, collectionId],
  );
  return { ...meta(ctx), shares: await toDtos(ctx.db, rows, ctx.now()) };
}

/** POST /v2/collections/{id}/shares — owner only. The bearer link is returned once. */
export async function createShare(ctx: ServiceContext, collectionId: string, raw: unknown) {
  const owner = requireAccountOwner(ctx.principal);
  const body = CreateShareRequest.parse(raw);
  const now = ctx.now();
  if (body.audience === 'link' && !body.confirm_policy) {
    throw new AppError('conflict', {
      message: 'Confirm that anyone with this link can view the items you include.',
      details: { confirmation_required: true },
    });
  }
  const token = body.audience === 'link' ? `${LINK_TOKEN_PREFIX}${randomToken(32)}` : null;
  const expiresAt = body.audience === 'link'
    ? addDays(now, body.expires_in_days ?? 7)
    : body.expires_in_days ? addDays(now, body.expires_in_days) : null;
  const row = await ctx.db.transaction(async (tx) => {
    await ownedCollection(tx, owner.accountId, collectionId, true);
    if (body.audience === 'restricted') {
      const existing = await tx.query<{ id: string }>(
        `SELECT id FROM collection_shares WHERE collection_id = $1 AND owner_account_id = $2
            AND audience = 'restricted' AND revoked_at IS NULL`,
        [collectionId, owner.accountId],
      );
      if (existing.rows[0]) {
        throw new AppError('conflict', { message: 'This collection already has restricted sharing.', details: { share_id: existing.rows[0].id } });
      }
    }
    const { rows } = await tx.query<ShareRow>(
      `INSERT INTO collection_shares (owner_account_id, collection_id, audience, token_hash, expires_at,
                                      include_media, allow_originals, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ${SHARE_COLUMNS}`,
      [owner.accountId, collectionId, body.audience, token ? hashToken(token) : null, expiresAt,
        body.include_media, body.allow_originals, now],
    );
    await audit(tx, { accountId: owner.accountId, actor: 'owner', actorAccountId: owner.accountId, action: 'share.created',
      shareId: rows[0]!.id, collectionId, now });
    return rows[0]!;
  });
  const [share] = await toDtos(ctx.db, [row], now);
  return { ...meta(ctx), share: share!, link: token ? `${baseUrl(ctx)}/shared#share=${token}` : null };
}

/** Parse `If-Match: "<policy_version>"`. */
export function sharePolicyVersion(ifMatch?: string | null): number {
  if (!ifMatch) throw new AppError('precondition_required', { message: 'Send If-Match with the share policy version.' });
  const match = /^"([1-9]\d*)"$/.exec(ifMatch.trim());
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new AppError('invalid_input', { message: 'Use the quoted policy version.' });
  return Number(match[1]);
}

/** Items that would become visible if captured media were included (owner preview). */
async function mediaPreview(db: Queryable, share: LiveShare) {
  const { items } = await projectMedia(db, { ...share, include_media: true });
  const titles = await db.query<{ id: string; title: string | null }>(
    'SELECT id, title FROM media_assets WHERE account_id = $1 AND id = ANY($2::uuid[])',
    [share.owner_account_id, items.map((i) => i.id)],
  );
  const byId = new Map(titles.rows.map((t) => [t.id, t.title]));
  return items.map((i) => ({ id: i.id, kind: i.kind, title: byId.get(i.id) ?? null }));
}

/**
 * PATCH /v2/shares/{id} — owner only, If-Match policy version. Narrowing applies
 * immediately; broadening (include media, allow originals, later expiry)
 * requires confirm_broaden and the 409 lists exactly what would become visible.
 */
export async function updateShare(ctx: ServiceContext, shareId: string, raw: unknown, version: number) {
  const owner = requireAccountOwner(ctx.principal);
  const body = UpdateShareRequest.parse(raw);
  const now = ctx.now();
  const row = await ctx.db.transaction(async (tx) => {
    const current = await loadOwnedShare(tx, owner.accountId, shareId, true);
    if (!isLive(current, now)) throw new AppError('conflict', { message: 'This share is no longer active. Create a new one.' });
    if (current.policy_version !== version) {
      throw new AppError('precondition_failed', { message: 'Sharing settings changed. Reload before saving.' });
    }
    const includeMedia = body.include_media ?? current.include_media;
    const allowOriginals = includeMedia ? (body.allow_originals ?? current.allow_originals) : false;
    if (allowOriginals && !includeMedia) throw new AppError('invalid_input');
    const expiresAt = body.expires_in_days ? addDays(now, body.expires_in_days) : current.expires_at;
    const broadening: string[] = [];
    if (includeMedia && !current.include_media) broadening.push('include_media');
    if (allowOriginals && !current.allow_originals) broadening.push('allow_originals');
    if (expiresAt && (current.expires_at === null ? false : expiresAt > current.expires_at)) broadening.push('expires_at');
    // Adding an expiry to an unbounded restricted share narrows it (not listed above).
    if (broadening.length && !body.confirm_broaden) {
      const live = current as LiveShare;
      throw new AppError('conflict', {
        message: 'Confirm the broader sharing settings.',
        details: {
          confirmation_required: true,
          broadening,
          ...(broadening.includes('include_media') ? { would_include: await mediaPreview(tx, live) } : {}),
        },
      });
    }
    const { rows } = await tx.query<ShareRow>(
      `UPDATE collection_shares SET include_media = $3, allow_originals = $4, expires_at = $5,
              policy_version = policy_version + 1, updated_at = $6
        WHERE id = $1 AND owner_account_id = $2 RETURNING ${SHARE_COLUMNS}`,
      [shareId, owner.accountId, includeMedia, allowOriginals, expiresAt, now],
    );
    await audit(tx, { accountId: owner.accountId, actor: 'owner', actorAccountId: owner.accountId,
      action: broadening.length ? 'share.broadened' : 'share.narrowed', shareId, collectionId: current.collection_id, now });
    return rows[0]!;
  });
  const [share] = await toDtos(ctx.db, [row], now);
  return { ...meta(ctx), share: share! };
}

/** DELETE /v2/shares/{id} — owner only; sessions and pending invitations end immediately. */
export async function revokeShare(ctx: ServiceContext, shareId: string): Promise<void> {
  const owner = requireAccountOwner(ctx.principal);
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    const current = await loadOwnedShare(tx, owner.accountId, shareId, true);
    if (current.revoked_at) return;
    await tx.query(
      `UPDATE collection_shares SET revoked_at = $3, revoke_reason = 'owner', policy_version = policy_version + 1, updated_at = $3
        WHERE id = $1 AND owner_account_id = $2`,
      [shareId, owner.accountId, now],
    );
    await tx.query('UPDATE share_sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE share_id = $1', [shareId, now]);
    await tx.query(
      'UPDATE share_invites SET revoked_at = COALESCE(revoked_at, $2) WHERE share_id = $1 AND accepted_at IS NULL',
      [shareId, now],
    );
    await audit(tx, { accountId: owner.accountId, actor: 'owner', actorAccountId: owner.accountId, action: 'share.revoked',
      shareId, collectionId: current.collection_id, now });
  });
}

/**
 * POST /v2/shares/{id}/invitations — owner only, restricted shares only. The
 * response is identical for every address; account existence is never checked.
 * The owner delivers the link themselves (no email service in v2).
 */
export async function createInvitation(ctx: ServiceContext, shareId: string, raw: unknown) {
  const owner = requireAccountOwner(ctx.principal);
  const body = CreateInvitationRequest.parse(raw);
  const now = ctx.now();
  const token = `${INVITE_TOKEN_PREFIX}${randomToken(32)}`;
  const expiresAt = addDays(now, INVITE_DAYS);
  const invite = await ctx.db.transaction(async (tx) => {
    const share = await loadOwnedShare(tx, owner.accountId, shareId, true);
    if (!isLive(share, now)) throw new AppError('conflict', { message: 'This share is no longer active.' });
    if (share.audience !== 'restricted') throw new AppError('invalid_input', { message: 'Invitations belong to restricted sharing.' });
    const { rows } = await tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO share_invites (owner_account_id, share_id, normalized_email_hash, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [owner.accountId, shareId, emailHash(ctx, body.email), hashToken(token), expiresAt, now],
    );
    await audit(tx, { accountId: owner.accountId, actor: 'owner', actorAccountId: owner.accountId, action: 'invitation.created',
      shareId, collectionId: share.collection_id, targetId: rows[0]!.id, now });
    return rows[0]!;
  });
  return {
    ...meta(ctx),
    invitation: { id: invite.id, status: 'pending' as const, expires_at: iso(expiresAt)!, created_at: iso(invite.created_at)! },
    link: `${baseUrl(ctx)}/shared/invite#invite=${token}`,
  };
}

/**
 * POST /v2/share-invitations/accept — a signed-in account whose VERIFIED email
 * is exactly the invited address. One use. Every failure is the same 404.
 */
export async function acceptInvitation(ctx: ServiceContext, raw: unknown) {
  const viewer = requireAccountOwner(ctx.principal);
  const body = AcceptInvitationRequest.parse(raw);
  const now = ctx.now();
  const invalid = () => new AppError('not_found', { message: INVITE_INVALID });
  const shareId = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string; share_id: string; owner_account_id: string; normalized_email_hash: string;
      expires_at: Date; accepted_at: Date | null; accepted_account_id: string | null; revoked_at: Date | null }>(
      'SELECT * FROM share_invites WHERE token_hash = $1 FOR UPDATE',
      [hashToken(body.token)],
    );
    const invite = rows[0];
    if (!invite || invite.revoked_at) throw invalid();
    if (invite.accepted_at) {
      if (invite.accepted_account_id === viewer.accountId) return invite.share_id;
      throw invalid();
    }
    if (invite.expires_at <= now) throw invalid();
    const email = await tx.query<{ email: string }>(
      'SELECT email FROM account_emails WHERE account_id = $1 AND verified_at IS NOT NULL',
      [viewer.accountId],
    );
    if (!email.rows[0] || emailHash(ctx, email.rows[0].email) !== invite.normalized_email_hash) throw invalid();
    if (viewer.accountId === invite.owner_account_id) throw invalid();
    const share = await tx.query<ShareRow>(`SELECT ${SHARE_COLUMNS} FROM collection_shares WHERE id = $1 FOR UPDATE`, [invite.share_id]);
    if (!share.rows[0] || !isLive(share.rows[0], now)) throw invalid();
    await tx.query(
      `INSERT INTO collection_share_members (share_id, owner_account_id, verified_account_id, invite_id, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (share_id, verified_account_id) DO NOTHING`,
      [invite.share_id, invite.owner_account_id, viewer.accountId, invite.id, now],
    );
    await tx.query('UPDATE share_invites SET accepted_at = $2, accepted_account_id = $3 WHERE id = $1', [invite.id, now, viewer.accountId]);
    await audit(tx, { accountId: invite.owner_account_id, actor: 'viewer', actorAccountId: viewer.accountId,
      action: 'invitation.accepted', shareId: invite.share_id, collectionId: share.rows[0].collection_id, targetId: invite.id, now });
    return invite.share_id;
  });
  return { ...meta(ctx), share_id: shareId };
}

/** Per-address redemption limit; failures and successes both count. */
export async function enforceRedeemLimit(db: Queryable, bucket: string, now: Date): Promise<void> {
  const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO share_redeem_windows (bucket, window_at, count) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_at) DO UPDATE SET count = share_redeem_windows.count + 1 RETURNING count`,
    [bucket, window],
  );
  if (rows[0]!.count > REDEEM_PER_MINUTE) throw new AppError('rate_limited', { retryAfter: 60 });
}

/**
 * POST /v2/shared/redeem — exchange a bearer link secret for a new session
 * token (set as an HttpOnly cookie by the HTTP adapter). Generic failure.
 */
export async function redeemLink(ctx: ServiceContext, raw: unknown) {
  const body = RedeemShareRequest.safeParse(raw);
  if (!body.success || !body.data.token.startsWith(LINK_TOKEN_PREFIX)) throw unavailable();
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM collection_shares WHERE token_hash = $1 AND audience = 'link'`,
      [hashToken(body.data.token)],
    );
    const share = rows[0];
    if (!share || !isLive(share, now)) throw unavailable();
    const sessionToken = randomToken(32);
    const expiresAt = new Date(Math.min(now.getTime() + SHARE_SESSION_HOURS * 3_600_000, share.expires_at!.getTime()));
    await tx.query(
      `INSERT INTO share_sessions (owner_account_id, share_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [share.owner_account_id, share.id, hashToken(sessionToken), now, expiresAt],
    );
    return { ...meta(ctx), share_id: share.id, expires_at: iso(expiresAt)!, sessionToken, expiresAt };
  });
}

/** How a viewer proves access: a link session cookie, or a signed-in member account. */
export interface ShareViewer {
  sessionToken?: string | null;
  shareId?: string | null;
}

/**
 * Resolve the share for a viewer request against CURRENT state. Never trusts
 * anything cached: session, membership, revocation, expiry and the collection
 * itself are re-read. All failures are the same 404.
 */
export async function resolveViewerShare(ctx: ServiceContext, viewer: ShareViewer, db: Queryable = ctx.db): Promise<LiveShare> {
  const now = ctx.now();
  if (viewer.sessionToken) {
    const { rows } = await db.query<ShareRow & { session_expires_at: Date; session_revoked_at: Date | null }>(
      `SELECT ${SHARE_COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ')},
              ss.expires_at AS session_expires_at, ss.revoked_at AS session_revoked_at
         FROM share_sessions ss JOIN collection_shares s ON s.id = ss.share_id AND s.owner_account_id = ss.owner_account_id
        WHERE ss.token_hash = $1`,
      [hashToken(viewer.sessionToken)],
    );
    const row = rows[0];
    if (row && !row.session_revoked_at && row.session_expires_at > now && isLive(row, now) &&
        (!viewer.shareId || viewer.shareId === row.id)) {
      return row as LiveShare;
    }
    if (!viewer.shareId) throw unavailable();
  }
  if (viewer.shareId && ctx.principal.kind === 'account') {
    const { rows } = await db.query<ShareRow>(
      `SELECT ${SHARE_COLUMNS.split(',').map((c) => `s.${c.trim()}`).join(', ')}
         FROM collection_shares s JOIN collection_share_members m ON m.share_id = s.id AND m.owner_account_id = s.owner_account_id
        WHERE s.id = $1 AND s.audience = 'restricted' AND m.verified_account_id = $2`,
      [viewer.shareId, ctx.principal.accountId],
    );
    const row = rows[0];
    if (row && isLive(row, now)) return row as LiveShare;
  }
  throw unavailable();
}

/** GET /v2/shared/collection — the public-safe projection. */
export async function getSharedCollection(ctx: ServiceContext, viewer: ShareViewer) {
  const share = await resolveViewerShare(ctx, viewer);
  const { rows } = await ctx.db.query<{ name: string; description: string | null; display_name: string | null }>(
    `SELECT c.name, c.description, a.display_name FROM collections c JOIN accounts a ON a.id = c.owner_account_id
      WHERE c.id = $1 AND c.owner_account_id = $2`,
    [share.collection_id, share.owner_account_id],
  );
  if (!rows[0]) throw unavailable();
  const discoveries = await projectDiscoveries(ctx.db, share);
  const media = await projectMedia(ctx.db, share);
  return {
    ...meta(ctx),
    share: {
      id: share.id, audience: share.audience, view_only: true as const, include_media: share.include_media,
      allow_originals: share.allow_originals, expires_at: iso(share.expires_at), policy_version: share.policy_version,
    },
    collection: { title: rows[0].name, description: rows[0].description, owner_display_name: rows[0].display_name },
    discoveries: discoveries.items,
    media: media.items,
    truncated: discoveries.truncated || media.truncated,
  };
}

/**
 * GET /v2/shared/media/{id}/{variant} — re-checks session/membership, current
 * collection membership and current policy on EVERY request (and so on every
 * range). Original downloads are audited.
 */
export async function getSharedMedia(
  ctx: ServiceContext,
  viewer: ShareViewer,
  assetId: string,
  variant: 'poster' | 'playback' | 'original',
): Promise<ShareableMediaObject> {
  const share = await resolveViewerShare(ctx, viewer);
  const object = await resolveSharedMediaObject(ctx.db, share, assetId, variant);
  if (!object) throw new AppError('not_found');
  if (variant === 'original') {
    await audit(ctx.db, { accountId: share.owner_account_id, actor: viewer.sessionToken ? 'link' : 'viewer',
      actorAccountId: ctx.principal.kind === 'account' && !viewer.sessionToken ? ctx.principal.accountId : null,
      action: 'media.original_downloaded', shareId: share.id, collectionId: share.collection_id, targetId: assetId, now: ctx.now() });
  }
  return object;
}

/**
 * POST /v2/shared/items/{id}/save — a signed-in viewer copies a PUBLIC catalog
 * reference into their own library (optionally one of their own collections).
 * Only the public card fields are copied; private media, reasons and the
 * owner's references are never copied.
 */
export async function saveSharedItem(ctx: ServiceContext, viewer: ShareViewer, itemId: string, collectionId?: string) {
  const account = requireAccountOwner(ctx.principal);
  const share = await resolveViewerShare(ctx, viewer);
  if (account.accountId === share.owner_account_id) throw new AppError('invalid_input', { message: 'This is already your collection.' });
  const visible = await projectDiscoveries(ctx.db, share);
  const card = visible.items.find((i) => i.id === itemId);
  if (!card) throw new AppError('not_found');
  const source = await ctx.db.query<{ canonical_key: string; external_ids: unknown }>(
    'SELECT canonical_key, external_ids FROM discovery_items WHERE id = $1',
    [itemId],
  );
  const key = source.rows[0]?.canonical_key;
  if (!card.saveable || !key || !isPublicCatalogKey(key)) {
    throw new AppError('invalid_input', { message: 'Only public catalog discoveries can be saved.' });
  }
  const copiedId = await ctx.db.transaction(async (tx) => {
    const publicMeta = {
      subtitle: card.subtitle, description: card.description, detail: card.detail, destination_url: card.destination_url,
      ...(card.image ? { image: { url: card.image.url, width: card.image.width, height: card.image.height, alt: card.image.alt } } : {}),
      ...(card.is_example ? { example: true } : {}),
    };
    await tx.query(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, display_metadata, external_ids)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) ON CONFLICT (owner_account_id, canonical_key) DO NOTHING`,
      [account.accountId, card.kind, card.category, key, card.title, JSON.stringify(publicMeta),
        JSON.stringify(source.rows[0]!.external_ids ?? {})],
    );
    const { rows } = await tx.query<{ id: string; canonical_key: string; kind: typeof card.kind; capture_id: string | null; is_sample: boolean }>(
      'SELECT id, canonical_key, kind, capture_id, is_sample FROM discovery_items WHERE owner_account_id = $1 AND canonical_key = $2',
      [account.accountId, key],
    );
    const target = rows[0]!;
    if (!collectionId) await saveItem(ctx, tx, target, { action: 'save', target_type: 'discovery_item', target_id: target.id });
    return target.id;
  });
  if (collectionId) await addCollectionItem(ctx, { id: collectionId, item_id: copiedId, body: {} });
  return { ...meta(ctx), item_id: copiedId, saved: true as const };
}

/** Owner-visible sharing audit history for one collection. */
export async function listShareAudit(ctx: ServiceContext, collectionId: string) {
  const owner = requireAccountOwner(ctx.principal);
  await ownedCollection(ctx.db, owner.accountId, collectionId);
  const { rows } = await ctx.db.query<{ id: string; action: string; actor: string; share_id: string | null; created_at: Date }>(
    `SELECT id, action, actor, share_id, created_at FROM audit_events WHERE account_id = $1 AND collection_id = $2
      ORDER BY created_at DESC, id LIMIT 100`,
    [owner.accountId, collectionId],
  );
  return { ...meta(ctx), items: rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() })) };
}
