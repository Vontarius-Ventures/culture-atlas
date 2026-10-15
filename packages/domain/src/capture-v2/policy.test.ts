import { describe, it, expect } from 'vitest';
import { assertExpectedCaptureAccount } from './policy';

describe('TEN-02 expected-account assertion', () => {
  const account = { kind: 'account' as const, accountId: 'account-a', sessionId: 'session-a' };
  it('rejects switched cookie authority before any side effect', () => {
    expect(() =>
      assertExpectedCaptureAccount({ ...account, accountId: 'account-b' }, 'account-a', true),
    ).toThrow(expect.objectContaining({ code: 'account_mismatch', status: 409 }));
  });
  it('requires the assertion on browser mutations', () => {
    expect(() => assertExpectedCaptureAccount(account, null, true)).toThrow(
      expect.objectContaining({ code: 'account_mismatch' }),
    );
  });
  it('does not use the assertion to select an owner', () => {
    expect(() => assertExpectedCaptureAccount(account, 'account-b', true)).toThrow(
      expect.objectContaining({ code: 'account_mismatch' }),
    );
    expect(() => assertExpectedCaptureAccount(account, 'account-a', true)).not.toThrow();
  });
});
