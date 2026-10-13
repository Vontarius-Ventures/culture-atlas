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
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/**
 * POST /v1/accounts — create an account and (by default) claim the current
 * anonymous session, preserving its captures and intended save.
 */
export const CreateAccountRequest = z.strictObject({
  display_name: z.string().trim().min(1).max(80).optional(),
  claim_session: z.boolean().default(true),
  /** Item the visitor was trying to save when prompted; saved after claim. */
  pending_save: z
    .strictObject({
      target_type: z.enum(['discovery_item', 'capture']),
      target_id: Uuid,
      collection_id: Uuid.optional(),
    })
    .optional(),
});
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

export const CreateAccountResponse = z.object({
  account_id: Uuid,
  session_id: Uuid,
  claimed: z.object({ captures: z.number().int(), saved_items: z.number().int() }),
});
export type CreateAccountResponse = z.infer<typeof CreateAccountResponse>;
