import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { CredentialError, decryptCredential, encryptCredential, keyId, parseEncryptionKey, requireEncryptionKey } from './credentials';

const key = randomBytes(32);

describe('viewer credential encryption', () => {
  it('round-trips and never stores the plaintext', () => {
    const id = randomUUID();
    const secret = 'viewer-secret-ÄÖ-123';
    const { blob, keyId: kid } = encryptCredential(secret, key, id);
    expect(blob.includes(Buffer.from(secret))).toBe(false);
    expect(kid).toBe(keyId(key));
    expect(decryptCredential(blob, kid, key, id)).toBe(secret);
    // Fresh IV every time.
    expect(encryptCredential(secret, key, id).blob.equals(blob)).toBe(false);
  });

  it('binds the ciphertext to its connection id', () => {
    const { blob, keyId: kid } = encryptCredential('s', key, randomUUID());
    expect(() => decryptCredential(blob, kid, key, randomUUID())).toThrow(CredentialError);
  });

  it('detects a different key, tampering and missing data', () => {
    const id = randomUUID();
    const { blob, keyId: kid } = encryptCredential('s', key, id);
    const other = randomBytes(32);
    expect(() => decryptCredential(blob, kid, other, id)).toThrow(expect.objectContaining({ code: 'credential_key_mismatch' }));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decryptCredential(tampered, kid, key, id)).toThrow(expect.objectContaining({ code: 'credential_corrupt' }));
    expect(() => decryptCredential(null, kid, key, id)).toThrow(expect.objectContaining({ code: 'credential_missing' }));
  });

  it('requires a 32-byte base64 key', () => {
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey(randomBytes(16).toString('base64'))).toBeNull();
    expect(parseEncryptionKey(key.toString('base64'))?.equals(key)).toBe(true);
    expect(() => requireEncryptionKey('short')).toThrow(AppError);
  });
});
