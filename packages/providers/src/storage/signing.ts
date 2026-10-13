import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-signed short-lived media URLs for the local/memory storage drivers:
 *   ${APP_BASE_URL}/v1/media?key=<key>&exp=<unix seconds>&sig=<base64url hmac>
 * The signature covers key and expiry. apps/web/app/v1/media verifies it.
 */

export function signMedia(secret: string, key: string, exp: number): string {
  return createHmac('sha256', secret).update(`${key}\n${exp}`).digest('base64url');
}

export function buildSignedMediaUrl(baseUrl: string, secret: string, key: string, ttlSeconds: number, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const params = new URLSearchParams({ key, exp: String(exp), sig: signMedia(secret, key, exp) });
  return `${baseUrl.replace(/\/+$/, '')}/v1/media?${params.toString()}`;
}

export type MediaVerification = { ok: true; key: string } | { ok: false; reason: 'missing' | 'expired' | 'bad_signature' | 'bad_key' };

/** Verifies key/exp/sig query parameters. Constant-time signature comparison. */
export function verifySignedMedia(secret: string, params: URLSearchParams, nowMs = Date.now()): MediaVerification {
  const key = params.get('key');
  const expRaw = params.get('exp');
  const sig = params.get('sig');
  if (!key || !expRaw || !sig || !/^\d+$/.test(expRaw)) return { ok: false, reason: 'missing' };
  if (!isSafeObjectKey(key)) return { ok: false, reason: 'bad_key' };
  const exp = Number(expRaw);
  if (exp * 1000 < nowMs) return { ok: false, reason: 'expired' };
  const expected = Buffer.from(signMedia(secret, key, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, key };
}

/** Object keys are relative, slash-separated, with no traversal or control characters. */
export function isSafeObjectKey(key: string): boolean {
  if (!key || key.length > 512 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  for (let i = 0; i < key.length; i++) if (key.charCodeAt(i) < 0x20) return false;
  return key.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Per-process secret when STORAGE_SIGNING_SECRET is unset (single-process dev only). */
let processSecret: string | undefined;
export function ephemeralSigningSecret(): string {
  processSecret ??= randomBytes(32).toString('base64url');
  return processSecret;
}
