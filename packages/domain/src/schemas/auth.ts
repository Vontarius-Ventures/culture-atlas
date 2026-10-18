import { z } from 'zod';
import { Timestamp, Uuid } from './common';

/** GET /v1/session — current principal; creates an anonymous session cookie when absent. */
export const SessionResponse = z.object({
  principal: z.object({
    kind: z.enum(['anonymous', 'account']),
    account_id: Uuid.nullable(),
    session_id: Uuid,
    expires_at: Timestamp.nullable(),
    is_demo_owner: z.boolean(),
  }),
  /** Double-submit CSRF token; send as `x-csrf-token` on cookie-authenticated mutations. */
  csrf_token: z.string(),
  /**
   * Amendment 2.2 (additive): true while this account must finish the taste
   * questionnaire (/welcome/taste) before its personal feed. Absent for
   * anonymous visitors, who never see it.
   */
  onboarding_required: z.boolean().optional(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Email used for demo sign-in (lower-cased on the server). */
export const Email = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email');
/** Demo password: 8-200 characters, stored only as a scrypt hash. */
export const Password = z.string().min(8).max(200);

/** Item the visitor was trying to save when prompted to create an account. */
export const PendingSave = z
  .strictObject({
    target_type: z.enum(['discovery_item', 'capture']),
    target_id: Uuid,
    collection_id: Uuid.optional(),
    /** "New collection" chosen in the picker before the account existed. */
    new_collection_name: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => !(v.collection_id && v.new_collection_name), {
    message: 'Use collection_id or new_collection_name, not both',
  });
export type PendingSave = z.infer<typeof PendingSave>;

/**
 * POST /v1/accounts — create an account and (by default) claim the current
 * anonymous session, preserving its captures and intended save.
 *
 * Sign-in mechanism (demo): email + password (scrypt). Both are optional; an
 * account created without them is bound to this browser's session only (a
 * "device account") and cannot sign in elsewhere.
 */
export const CreateAccountRequest = z
  .strictObject({
    display_name: z.string().trim().min(1).max(80).optional(),
    email: Email.optional(),
    password: Password.optional(),
    claim_session: z.boolean().default(true),
    /** Item the visitor was trying to save when prompted; saved after claim. */
    pending_save: PendingSave.optional(),
  })
  .refine((v) => Boolean(v.email) === Boolean(v.password), {
    message: 'Provide both email and password, or neither',
    path: ['password'],
  });
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

/** Outcome of a pending save performed right after the session was claimed. */
export const PendingSaveResult = z.object({
  saved_item_id: Uuid,
  discovery_item_id: Uuid,
  collection_id: Uuid.nullable(),
});
export type PendingSaveResult = z.infer<typeof PendingSaveResult>;

export const ClaimSummary = z.object({ captures: z.number().int(), saved_items: z.number().int() });
export type ClaimSummary = z.infer<typeof ClaimSummary>;

export const CreateAccountResponse = z.object({
  account_id: Uuid,
  session_id: Uuid,
  claimed: ClaimSummary,
  /** CSRF token for the NEW session (the session id rotates on account creation). */
  csrf_token: z.string().optional(),
  pending_save: PendingSaveResult.nullable().optional(),
  /** Amendment 2.2 (additive): the taste questionnaire comes next (/welcome/taste). */
  onboarding_required: z.boolean().optional(),
});
export type CreateAccountResponse = z.infer<typeof CreateAccountResponse>;

/** POST /v1/session/sign-in — email + password; claims the current anonymous session. */
export const SignInRequest = z.strictObject({
  email: Email,
  password: z.string().min(1).max(200),
  claim_session: z.boolean().default(true),
  pending_save: PendingSave.optional(),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

export const SignInResponse = SessionResponse.extend({
  claimed: ClaimSummary,
  pending_save: PendingSaveResult.nullable(),
});
export type SignInResponse = z.infer<typeof SignInResponse>;

/** POST /v1/session/sign-out — revokes the session and starts a fresh anonymous one. */
export const SignOutRequest = z.strictObject({});
export type SignOutRequest = z.infer<typeof SignOutRequest>;
