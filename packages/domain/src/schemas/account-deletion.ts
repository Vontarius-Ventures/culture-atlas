import { z } from 'zod';

/**
 * Account deletion contract (VAL-DELETE-002/004): the owner requests deletion,
 * the acceptance revokes everything atomically, and a one-time status token
 * keeps answering the public status route after every authority is gone.
 */

/** The truthful, user-facing disclosure served with every status answer. */
export const AccountDeletionDisclosure = z.object({
  summary: z.string(),
  /** What is revoked in the acceptance transaction itself. */
  immediate: z.array(z.string()),
  /** The durable cleanup steps the purge job runs; completion is claimed only after all of them. */
  cleanup_steps: z.array(z.string()),
  /** What is retained, and why (VAL-DELETE-004: never claim what cannot be honest). */
  retained: z.array(z.string()),
});
export type AccountDeletionDisclosure = z.infer<typeof AccountDeletionDisclosure>;

/** The honest lifecycle snapshot of one account deletion. */
export const AccountDeletionStatus = z.object({
  state: z.enum(['pending', 'purging', 'failed', 'complete']),
  requested_at: z.string(),
  accepted_at: z.string(),
  completed_at: z.string().nullable(),
  /** Steps finished, in run order; a step appears only once it is done. */
  completed_steps: z.array(z.string()),
  /** Steps still owed for completion. */
  pending_steps: z.array(z.string()),
  /** Cleanup attempts so far (every attempt that started work). */
  attempts: z.number().int().nonnegative(),
  /** The last attempt's error code; never a provider or internal detail. */
  last_error_code: z.string().nullable(),
  /** True while private data still exists and the cleanup will retry. */
  retrying: z.boolean(),
});
export type AccountDeletionStatus = z.infer<typeof AccountDeletionStatus>;

/** GET /v2/me/account-deletion — the owner's own state before/without a token. */
export const AccountDeletionOverviewResponse = z.object({
  requested: z.boolean(),
  state: z.enum(['none', 'pending', 'purging', 'failed', 'complete']),
  /** Present when a deletion has been accepted (null while state is 'none'). */
  status: AccountDeletionStatus.nullable(),
  disclosure: AccountDeletionDisclosure,
});
export type AccountDeletionOverviewResponse = z.infer<typeof AccountDeletionOverviewResponse>;

/**
 * POST /v2/me/account-deletion. `confirm` must be literally true. `status_token`
 * is the caller-generated one-time capability for the public status route
 * (>= 32 random bytes, URL-safe); the server stores only its SHA-256. When
 * omitted the server mints one and returns it exactly once.
 */
export const RequestAccountDeletionRequest = z.strictObject({
  confirm: z.literal(true),
  status_token: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43,128}$/)
    .optional(),
});
export type RequestAccountDeletionRequest = z.infer<typeof RequestAccountDeletionRequest>;

export const RequestAccountDeletionResponse = z.object({
  status: AccountDeletionStatus,
  /**
   * The status capability token. Present on first acceptance (caller-supplied
   * or server-minted) and on a retry that presents the same stored token;
   * null when the caller cannot re-present a server-minted token (only its
   * SHA-256 is stored). Never re-minted: a new token never replaces the one
   * the record already holds.
   */
  status_token: z.string().nullable(),
  disclosure: AccountDeletionDisclosure,
});
export type RequestAccountDeletionResponse = z.infer<typeof RequestAccountDeletionResponse>;

/** GET /v2/account-deletion/status — capability-token gated, restores no authority. */
export const AccountDeletionStatusResponse = z.object({
  status: AccountDeletionStatus,
  disclosure: AccountDeletionDisclosure,
});
export type AccountDeletionStatusResponse = z.infer<typeof AccountDeletionStatusResponse>;
