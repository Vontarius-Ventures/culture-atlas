import { z } from 'zod';
import { Category, ItemKind } from '../enums';
import { Timestamp, Uuid } from './common';

/**
 * Collection sharing wire contract (AGENTS-AND-SHARING "Collection sharing").
 * Owner routes manage audiences; viewer routes return only the public-safe
 * ShareProjection. Bearer link secrets travel in a URL fragment and are
 * exchanged by POST for an HttpOnly session; they never appear in a query.
 */

const Meta = { schema_version: z.literal('2.1'), request_id: z.string() };

export const ShareAudience = z.enum(['restricted', 'link']);
export type ShareAudience = z.infer<typeof ShareAudience>;
/** Link expiry choices (default 7). Restricted shares may also be bounded. */
export const ShareExpiryDays = z.union([z.literal(1), z.literal(7), z.literal(30)]);

export const ShareMember = z.object({
  display_name: z.string().nullable(),
  joined_at: Timestamp,
});
export const ShareInvitationSummary = z.object({
  id: Uuid,
  status: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expires_at: Timestamp,
  created_at: Timestamp,
});

export const ShareDto = z.object({
  id: Uuid,
  collection_id: Uuid.nullable(),
  audience: ShareAudience,
  status: z.enum(['active', 'expired', 'revoked']),
  include_media: z.boolean(),
  allow_originals: z.boolean(),
  expires_at: Timestamp.nullable(),
  revoked_at: Timestamp.nullable(),
  policy_version: z.number().int().positive(),
  created_at: Timestamp,
  members: z.array(ShareMember),
  invitations: z.array(ShareInvitationSummary),
});
export type ShareDto = z.infer<typeof ShareDto>;

export const ShareListResponse = z.object({ ...Meta, shares: z.array(ShareDto) });

export const CreateShareRequest = z
  .strictObject({
    audience: ShareAudience.default('restricted'),
    expires_in_days: ShareExpiryDays.optional(),
    include_media: z.boolean().default(false),
    allow_originals: z.boolean().default(false),
    /** Required for link audiences: the owner confirmed the actual bearer policy. */
    confirm_policy: z.boolean().default(false),
  })
  .refine((v) => !v.allow_originals || v.include_media, {
    message: 'Original downloads require included photos and videos.',
    path: ['allow_originals'],
  });
export type CreateShareRequest = z.infer<typeof CreateShareRequest>;

export const CreateShareResponse = z.object({
  ...Meta,
  share: ShareDto,
  /** Bearer link, returned exactly once for link audiences (fragment token). */
  link: z.string().nullable(),
});

export const UpdateShareRequest = z
  .strictObject({
    include_media: z.boolean().optional(),
    allow_originals: z.boolean().optional(),
    expires_in_days: ShareExpiryDays.optional(),
    /** Broadening (more media, originals, later expiry) needs explicit confirmation. */
    confirm_broaden: z.boolean().default(false),
  })
  .refine((v) => v.include_media !== undefined || v.allow_originals !== undefined || v.expires_in_days !== undefined, {
    message: 'Choose a sharing setting to change.',
  });
export type UpdateShareRequest = z.infer<typeof UpdateShareRequest>;
export const UpdateShareResponse = z.object({ ...Meta, share: ShareDto });

export const CreateInvitationRequest = z.strictObject({ email: z.string().trim().email().max(254) });
/** Uniform: identical shape whether or not the address belongs to an account. */
export const CreateInvitationResponse = z.object({
  ...Meta,
  invitation: ShareInvitationSummary,
  link: z.string(),
});

export const AcceptInvitationRequest = z.strictObject({ token: z.string().min(16).max(512) });
export const AcceptInvitationResponse = z.object({ ...Meta, share_id: Uuid });

export const RedeemShareRequest = z.strictObject({ token: z.string().min(16).max(512) });
export const RedeemShareResponse = z.object({ ...Meta, share_id: Uuid, expires_at: Timestamp });

export const SharedDiscovery = z.object({
  id: Uuid,
  kind: ItemKind,
  category: Category.nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  description: z.string().nullable(),
  detail: z.string().nullable(),
  image: z.object({ url: z.string(), width: z.number().int().nullable(), height: z.number().int().nullable(), alt: z.string() }).nullable(),
  destination_url: z.string().nullable(),
  is_example: z.boolean(),
  /** Public catalog references may be saved by a signed-in viewer. */
  saveable: z.boolean(),
});
export type SharedDiscovery = z.infer<typeof SharedDiscovery>;

export const SharedMedia = z.object({
  id: Uuid,
  kind: z.enum(['photo', 'video']),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  duration_ms: z.number().int().nullable(),
  poster_url: z.string().nullable(),
  playback_url: z.string().nullable(),
  original_url: z.string().nullable(),
});
export type SharedMedia = z.infer<typeof SharedMedia>;

/** ShareProjection: the only shape a viewer ever receives. */
export const SharedCollectionResponse = z.object({
  ...Meta,
  share: z.object({
    id: Uuid,
    audience: ShareAudience,
    view_only: z.literal(true),
    include_media: z.boolean(),
    allow_originals: z.boolean(),
    expires_at: Timestamp.nullable(),
    policy_version: z.number().int(),
  }),
  collection: z.object({
    title: z.string(),
    description: z.string().nullable(),
    owner_display_name: z.string().nullable(),
  }),
  discoveries: z.array(SharedDiscovery),
  media: z.array(SharedMedia),
  truncated: z.boolean(),
});
export type SharedCollectionResponse = z.infer<typeof SharedCollectionResponse>;

export const SaveSharedItemResponse = z.object({ ...Meta, item_id: Uuid, saved: z.literal(true) });
