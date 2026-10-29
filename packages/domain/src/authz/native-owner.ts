import type { Queryable } from '../db/pool';
import { AppError } from '../errors';
import type { AccountPrincipal, InstallationPrincipal } from '../principal';
import { operationKey, type OperationPolicy } from './operations';

/**
 * Native owner bridge (spec amendment 2.2, package E).
 *
 * Native phones authenticate with an installation session (`cna_` bearer),
 * which by default has NO authority on `/v1` (authorizeOperation refuses it:
 * "native installation policy belongs to v2"). These operations accept the
 * owner's own enrolled phone as the account owner:
 *
 *  - the onboarding questionnaire (screen 14/15) and Settings → Taste (18);
 *  - Discover (`GET /v1/discoveries`), item detail (`GET /v1/items/{id}`),
 *    related (`POST /v1/items/{id}/discoveries`), and boards (`/v1/collections*`);
 *  - a capture's compiled result (`GET /v1/captures/{id}`: sourced references
 *    and the Qloo-backed recommendations), read-only and scoped to the
 *    owner's own captures (another account's id is `not_found`);
 *  - every other `/v1` route still refuses installations with `scope_denied`,
 *    and agents are unaffected.
 *
 * The owner's phone ALSO reaches the four typed v2 graph operations
 * (`NATIVE_OWNER_V2_GRAPH_OPERATIONS`: the interest-graph summary, settings,
 * tentative-interest controls and the recommendation connection) with the
 * same liveness and expected-account rules. The v1 allowlist itself is
 * never broadened by them.
 *
 * The installation must still be live on every call (not revoked, authority
 * not ended, access token unexpired), and every mutation must name the
 * signed-in account in `X-Atlas-Expected-Account` (the same header the `/v2`
 * native client sends), so a phone that switched accounts can never write to
 * the previous one. The resulting principal is the account owner without a
 * browser session (`sessionId: null`), like other server-side owner contexts.
 */
export const NATIVE_OWNER_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /v1/onboarding/catalog',
  'GET /v1/onboarding/search',
  'POST /v1/onboarding/picks',
  'DELETE /v1/onboarding/picks/{id}',
  'PUT /v1/onboarding/exclusions',
  'POST /v1/onboarding/complete',
  'GET /v1/onboarding/state',
  'GET /v1/onboarding/seed',
  'GET /v1/taste/picks',
  'POST /v1/taste/picks',
  'DELETE /v1/taste/picks/{id}',
  'GET /v1/discoveries',
  'GET /v1/items/{id}',
  'POST /v1/items/{id}/discoveries',
  'GET /v1/captures/{id}',
  'GET /v1/collections',
  'POST /v1/collections',
  'GET /v1/collections/{id}',
  'PUT /v1/collections/{id}/items/{item_id}',
]);

/**
 * The v2 graph operations the native owner bridge also accepts (PR 8 package
 * E; VAL-API-003). Deliberately a SEPARATE set so the v1 allowlist above stays
 * byte-identical: new graph routes never broaden the existing v1 matrix, and
 * every other v2 route keeps refusing installations (capture-v2 has its own
 * installation-native authority; the agent-platform `me` routes are OAuth
 * bearer only). The same live-installation and expected-account rules apply.
 */
export const NATIVE_OWNER_V2_GRAPH_OPERATIONS: ReadonlySet<string> = new Set([
  'GET /v2/me/interest-graph',
  'PATCH /v2/me/interest-graph/settings',
  'PATCH /v2/me/interest-graph/interests/{id}',
  'GET /v2/me/recommendations/{id}/connection',
]);

export function isNativeOwnerOperation(op: Pick<OperationPolicy, 'method' | 'path'>): boolean {
  const key = operationKey(op);
  return NATIVE_OWNER_OPERATIONS.has(key) || NATIVE_OWNER_V2_GRAPH_OPERATIONS.has(key);
}

/**
 * Converts a live installation principal into its account owner for one
 * allowlisted operation, or throws the error the phone must act on:
 * `scope_denied` (operation not bridged), `token_expired`, `token_revoked`
 * (installation revoked or its authority ended) or `account_mismatch`.
 */
export async function nativeOwnerPrincipal(
  db: Queryable,
  principal: InstallationPrincipal,
  op: Pick<OperationPolicy, 'method' | 'path'>,
  expectedAccount: string | null,
  now: Date = new Date(),
): Promise<AccountPrincipal> {
  if (!isNativeOwnerOperation(op)) throw new AppError('scope_denied');
  if (principal.expiresAt <= now) throw new AppError('token_expired');
  // Mutations must name the account; a GET may, and then it must match too.
  const expected = expectedAccount?.trim().toLowerCase() || null;
  if (
    (op.method !== 'GET' && !expected) ||
    (expected && expected !== principal.accountId.toLowerCase())
  )
    throw new AppError('account_mismatch');
  const live = await db.query(
    `SELECT id FROM mobile_installations WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL
       AND authority_ended_at IS NULL`,
    [principal.accountId, principal.installationId],
  );
  if (!live.rowCount) throw new AppError('token_revoked');
  return { kind: 'account', accountId: principal.accountId, sessionId: null, isDemoOwner: false };
}
