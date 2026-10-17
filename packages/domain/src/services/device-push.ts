import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { NoopPushDriver, type PushDriver, type PushOutcome } from '@culture-atlas/providers';
import { captureMutation } from '../capture-v2/policy';
import type { CaptureV2Context } from '../capture-v2/types';
import type { Queryable } from '../db/pool';
import { AppError } from '../errors';
import { keyId, parseEncryptionKey } from '../sensor/credentials';

/**
 * Push registration and wake-ups for enrolled phones.
 *
 * - Only the installation's own native session can set or clear its token.
 * - Tokens are encrypted at rest with CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM,
 *   the installation id bound as associated data) and never returned.
 * - A wake carries a fresh random reference only. The phone then long-polls
 *   GET /v2/device/commands with its own credentials; delivery and
 *   authorization never depend on the push.
 * - Ending authority (sign-out, revoke, refresh reuse) clears the token, see
 *   endCaptureAuthority.
 */
export const RegisterPushTokenRequest = z
  .object({
    provider: z.enum(['apns', 'fcm']),
    token: z.string().min(20).max(4096),
    environment: z.enum(['production', 'sandbox']),
  })
  .strict();

let driver: PushDriver = new NoopPushDriver();
export function setPushDriver(next: PushDriver | undefined): void {
  driver = next ?? new NoopPushDriver();
}
export function getPushDriver(): PushDriver {
  return driver;
}

const VERSION = 1;
const aad = (installationId: string) => Buffer.from(`mobile_installation_push:${installationId}`);
function requireKey(value: string | undefined): Buffer {
  const key = parseEncryptionKey(value);
  if (!key)
    throw new AppError('service_unavailable', {
      message: 'Notifications are not configured on this server.',
      retryable: false,
    });
  return key;
}
function encrypt(token: string, key: Buffer, installationId: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(installationId));
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, ct, cipher.getAuthTag()]);
}
function decrypt(blob: Buffer, key: Buffer, installationId: string): string {
  if (blob.byteLength < 29 || blob[0] !== VERSION) throw new Error('corrupt');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13));
  decipher.setAAD(aad(installationId));
  decipher.setAuthTag(blob.subarray(blob.byteLength - 16));
  return Buffer.concat([
    decipher.update(blob.subarray(13, blob.byteLength - 16)),
    decipher.final(),
  ]).toString('utf8');
}

function installationOf(ctx: CaptureV2Context): string {
  if (ctx.authority.kind !== 'installation')
    throw new AppError('scope_denied', {
      message: 'Only the enrolled phone can register for notifications.',
    });
  return ctx.authority.installationId;
}

export async function registerPushToken(
  ctx: CaptureV2Context,
  raw: unknown,
  idempotencyKey: string,
  encryptionKey: string | undefined,
): Promise<{ registered: true; provider: 'apns' | 'fcm' }> {
  const input = RegisterPushTokenRequest.parse(raw);
  const installationId = installationOf(ctx);
  const key = requireKey(encryptionKey);
  // The idempotency record stores a hash of this payload, never the token.
  const fingerprint = {
    provider: input.provider,
    environment: input.environment,
    token_sha256: createHash('sha256').update(input.token).digest('hex'),
  };
  return captureMutation(ctx, 'push-token', idempotencyKey, fingerprint, async (tx) => {
    const { rows } = await tx.query<{ platform: string }>(
      `SELECT platform FROM mobile_installations WHERE account_id=$1 AND id=$2`,
      [ctx.authority.accountId, installationId],
    );
    const platform = rows[0]?.platform;
    if (!platform) throw new AppError('not_found');
    if ((platform === 'ios') !== (input.provider === 'apns'))
      throw new AppError('invalid_input', { message: 'Use APNs on iOS and FCM on Android.' });
    await tx.query(
      `UPDATE mobile_installations SET push_provider=$3,push_environment=$4,push_token_ciphertext=$5,
         push_token_key_id=$6,push_updated_at=$7 WHERE account_id=$1 AND id=$2`,
      [
        ctx.authority.accountId,
        installationId,
        input.provider,
        input.environment,
        encrypt(input.token, key, installationId),
        keyId(key),
        ctx.now(),
      ],
    );
    return { registered: true as const, provider: input.provider };
  });
}

export async function clearPushToken(
  ctx: CaptureV2Context,
  idempotencyKey: string,
): Promise<{ registered: false }> {
  const installationId = installationOf(ctx);
  return captureMutation(ctx, 'push-token-clear', idempotencyKey, {}, async (tx) => {
    await clearPushColumns(tx, ctx.authority.accountId, installationId);
    return { registered: false as const };
  });
}

async function clearPushColumns(db: Queryable, accountId: string, installationId: string | null) {
  await db.query(
    `UPDATE mobile_installations SET push_provider=NULL,push_environment=NULL,push_token_ciphertext=NULL,
       push_token_key_id=NULL,push_updated_at=NULL WHERE account_id=$1 AND ($2::uuid IS NULL OR id=$2)`,
    [accountId, installationId],
  );
}
export { clearPushColumns as clearInstallationPushTokens };

/**
 * Best-effort wake of one installation. Never throws: commands are delivered
 * by the long poll whether or not a push arrives. Returns only an outcome code.
 */
export async function wakeInstallation(
  db: Queryable,
  target: { accountId: string; installationId: string },
  options: { encryptionKey: string | undefined; driver?: PushDriver },
): Promise<PushOutcome> {
  try {
    const key = parseEncryptionKey(options.encryptionKey);
    if (!key) return 'not_configured';
    const { rows } = await db.query<{
      push_provider: 'apns' | 'fcm' | null;
      push_environment: 'production' | 'sandbox' | null;
      push_token_ciphertext: Buffer | null;
      push_token_key_id: string | null;
    }>(
      `SELECT push_provider,push_environment,push_token_ciphertext,push_token_key_id FROM mobile_installations
       WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL AND authority_ended_at IS NULL`,
      [target.accountId, target.installationId],
    );
    const row = rows[0];
    if (!row?.push_provider || !row.push_token_ciphertext || !row.push_environment)
      return 'not_configured';
    if (row.push_token_key_id !== keyId(key)) return 'failed';
    const token = decrypt(row.push_token_ciphertext, key, target.installationId);
    const outcome = await (options.driver ?? driver).wake(
      { provider: row.push_provider, token, environment: row.push_environment },
      randomBytes(16).toString('base64url'),
    );
    if (outcome === 'invalid_token')
      await clearPushColumns(db, target.accountId, target.installationId);
    return outcome;
  } catch {
    return 'failed';
  }
}
