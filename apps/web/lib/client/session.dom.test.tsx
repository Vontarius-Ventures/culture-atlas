import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as sessionSync from './session-sync';

/**
 * VAL-CROSS-005 (account-switch isolation, web client): signing out in one
 * tab must revoke the private surfaces every OTHER same-origin tab is still
 * showing. The web shell does that with a cross-tab storage broadcast: the
 * signing-out tab writes a sentinel to shared storage and navigates away;
 * the session provider reloads every other tab so its stale document (and
 * any in-flight private response bound to it) can never render the previous
 * account's Taste, feed, photos or reasons while another account is active.
 */
vi.mock('./session-sync', async (original) => ({
  ...(await original<typeof sessionSync>()),
  reloadForSessionChange: vi.fn(),
}));

const request = vi.fn(async () => ({
  principal: { kind: 'account', account_id: 'acc-1', session_id: 's-1' },
  csrf_token: 't',
}));
vi.mock('@/lib/client/api', () => ({
  api: {
    request: (...args: unknown[]) => request(...(args as [])),
    getSession: () => request(),
    refreshSession: () => request(),
    onSession: () => () => undefined,
  },
}));

const { SESSION_SIGNOUT_KEY, reloadForSessionChange } = await import('./session-sync');
const { SessionProvider } = await import('./session');

function renderProvider() {
  render(
    <SessionProvider>
      <p>shell</p>
    </SessionProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.mocked(reloadForSessionChange).mockClear();
  window.localStorage.clear();
});

describe('cross-tab session revocation', () => {
  it('reloads another tab when a sign-out is broadcast', async () => {
    renderProvider();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(reloadForSessionChange).not.toHaveBeenCalled();

    window.dispatchEvent(new StorageEvent('storage', { key: SESSION_SIGNOUT_KEY }));

    await waitFor(() => expect(reloadForSessionChange).toHaveBeenCalledTimes(1));
  });

  it('ignores storage writes that are not the sign-out sentinel', async () => {
    renderProvider();
    await waitFor(() => expect(request).toHaveBeenCalled());

    window.dispatchEvent(new StorageEvent('storage', { key: 'ca.unrelated', newValue: '1' }));
    window.dispatchEvent(new StorageEvent('storage', { key: null }));

    // The listener stays armed but never reloads for unrelated writes.
    await new Promise((r) => setTimeout(r, 30));
    expect(reloadForSessionChange).not.toHaveBeenCalled();
  });
});
