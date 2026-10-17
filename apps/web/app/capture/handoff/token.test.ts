import { describe, expect, it } from 'vitest';
import { checkHandoffToken, createHandoffToken, HANDOFF_TTL_MS } from './token';

const SECRET = 'test-secret-0123456789';
const A = '6f0c2a6e-3c1f-4b77-9d1a-1a2b3c4d5e6f';
const B = '7a1d3b7f-4d2a-4c88-8e2b-2b3c4d5e6f70';

describe('glasses hand-off link token', () => {
  it('opens for the same account until it expires', () => {
    const now = 1_760_000_000_000;
    const { token, expiresAt } = createHandoffToken(SECRET, A, now);
    expect(expiresAt.getTime()).toBe(now + HANDOFF_TTL_MS);
    expect(checkHandoffToken(SECRET, token, A, now + 1000)).toEqual({
      status: 'valid',
      expiresAt,
      sameAccount: true,
    });
    expect(checkHandoffToken(SECRET, token, A, now + HANDOFF_TTL_MS)).toEqual({
      status: 'expired',
    });
  });

  it('is bound to the account: another account sees sameAccount false, a signed-out phone null', () => {
    const { token } = createHandoffToken(SECRET, A);
    expect(checkHandoffToken(SECRET, token, B)).toMatchObject({
      status: 'valid',
      sameAccount: false,
    });
    expect(checkHandoffToken(SECRET, token, null)).toMatchObject({
      status: 'valid',
      sameAccount: null,
    });
  });

  it('does not reveal the account id in the link', () => {
    const { token } = createHandoffToken(SECRET, A);
    expect(token).not.toContain(A);
    expect(Buffer.from(token.split('.')[1]!, 'base64url').toString()).not.toContain(A);
  });

  it('rejects tampered, foreign-secret and malformed tokens', () => {
    const { token } = createHandoffToken(SECRET, A);
    const [v, payload, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        e: Date.now() + 1e9,
      }),
    ).toString('base64url');
    expect(checkHandoffToken(SECRET, `${v}.${forged}.${mac}`, A)).toEqual({ status: 'invalid' });
    expect(checkHandoffToken('other-secret', token, A)).toEqual({ status: 'invalid' });
    expect(checkHandoffToken(SECRET, 'nonsense', A)).toEqual({ status: 'invalid' });
    expect(checkHandoffToken(SECRET, `${token}x`, A)).toEqual({ status: 'invalid' });
  });
});
