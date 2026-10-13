import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AppError } from '../errors';

/**
 * Viewer credentials are encrypted at rest with AES-256-GCM.
 *
 * Key: CREDENTIAL_ENCRYPTION_KEY, 32 random bytes in base64 (generate with
 * `openssl rand -base64 32`). Stored blob: version (1 byte) | IV (12 bytes) |
 * ciphertext | tag (16 bytes). The sensor connection id is bound as additional
 * authenticated data, so a ciphertext copied onto another row fails to
 * decrypt. `credential_key_id` stores a fingerprint of the key so a rotated or
 * wrong key is reported as such instead of as corrupt data. The plaintext is
 * never logged or returned by any API.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function parseEncryptionKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  return key.byteLength === 32 ? key : null;
}

/** Non-secret fingerprint identifying which key encrypted a blob. */
export function keyId(key: Buffer): string {
  return createHash('sha256').update('culture-atlas:credential-key:').update(key).digest('hex').slice(0, 16);
}

/** The configured key, or a 503 explaining that credential storage is not configured. */
export function requireEncryptionKey(value: string | undefined): Buffer {
  const key = parseEncryptionKey(value);
  if (!key) {
    throw new AppError('service_unavailable', {
      message: 'Sensor credential storage is not configured on this server.',
      retryable: false,
    });
  }
  return key;
}

export function encryptCredential(plaintext: string, key: Buffer, connectionId: string): { blob: Buffer; keyId: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`sensor_connection:${connectionId}`));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { blob: Buffer.concat([Buffer.from([VERSION]), iv, ct, cipher.getAuthTag()]), keyId: keyId(key) };
}

export class CredentialError extends Error {
  constructor(readonly code: 'credential_missing' | 'credential_key_mismatch' | 'credential_corrupt') {
    super(code);
    this.name = 'CredentialError';
  }
}

export function decryptCredential(blob: Buffer | null, storedKeyId: string | null, key: Buffer, connectionId: string): string {
  if (!blob || blob.byteLength === 0) throw new CredentialError('credential_missing');
  if (storedKeyId && storedKeyId !== keyId(key)) throw new CredentialError('credential_key_mismatch');
  if (blob.byteLength < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) throw new CredentialError('credential_corrupt');
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(blob.byteLength - TAG_BYTES);
  const ct = blob.subarray(1 + IV_BYTES, blob.byteLength - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`sensor_connection:${connectionId}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialError('credential_corrupt');
  }
}
