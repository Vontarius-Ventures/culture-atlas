import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed, short-lived, account-bound phone link for the glasses hand-off
 * (SCREEN-CONTRACT 02: "desktop hands off through a signed short-lived
 * account-bound phone link, never Bluetooth pairing in a browser").
 *
 * The token carries no account id: it binds an HMAC of the account, so a
 * leaked link reveals nothing and only opens for the same signed-in account.
 * It is not a credential and grants no access; the phone still needs its own
 * session for that account.
 */
export const HANDOFF_TTL_MS = 10 * 60 * 1000;
const PURPOSE = 'glasses';
const VERSION = 'h1';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function accountBinding(secret: string, accountId: string): string {
  return b64url(createHmac('sha256', secret).update(`handoff-account:${accountId}`).digest()).slice(
    0,
    22,
  );
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac('sha256', secret).update(`${VERSION}.${payload}`).digest());
}

export function createHandoffToken(
  secret: string,
  accountId: string,
  now = Date.now(),
  nonce = b64url(randomBytes(12)),
): { token: string; expiresAt: Date } {
  const expiresAt = new Date(now + HANDOFF_TTL_MS);
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        p: PURPOSE,
        a: accountBinding(secret, accountId),
        e: expiresAt.getTime(),
        n: nonce,
      }),
    ),
  );
  return { token: `${VERSION}.${payload}.${sign(secret, payload)}`, expiresAt };
}

export type HandoffCheck =
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'valid'; expiresAt: Date; sameAccount: boolean | null };

/** `viewerAccountId` null means the phone is not signed in to an account yet. */
export function checkHandoffToken(
  secret: string,
  token: string,
  viewerAccountId: string | null,
  now = Date.now(),
): HandoffCheck {
  if (token.length > 600) return { status: 'invalid' };
  const [version, payload, mac] = token.split('.');
  if (version !== VERSION || !payload || !mac) return { status: 'invalid' };
  const expected = Buffer.from(sign(secret, payload));
  const got = Buffer.from(mac);
  if (expected.length !== got.length || !timingSafeEqual(expected, got))
    return { status: 'invalid' };
  let data: { p?: unknown; a?: unknown; e?: unknown };
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { status: 'invalid' };
  }
  if (data.p !== PURPOSE || typeof data.a !== 'string' || typeof data.e !== 'number')
    return { status: 'invalid' };
  if (data.e <= now) return { status: 'expired' };
  const sameAccount =
    viewerAccountId === null ? null : accountBinding(secret, viewerAccountId) === data.a;
  return { status: 'valid', expiresAt: new Date(data.e), sameAccount };
}
