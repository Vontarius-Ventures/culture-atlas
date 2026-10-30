import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountDeletion } from '@culture-atlas/domain';
import {
  clearStoredAccountDeletion,
  readStoredAccountDeletion,
  storeAccountDeletion,
} from '@/lib/client/account-deletion';
import { AccountDeletionView } from './AccountDeletionView';

/**
 * First-party Settings deletion UI (VAL-DELETE-001): the entry explains the
 * server's own disclosure (private-data removal, authority revocation, real
 * retention limits), cancel changes nothing, a request error is never shown
 * as an accepted deletion, and pending/completed cleanup is reported exactly
 * as the server's status says.
 */

const DISCLOSURE = accountDeletion.ACCOUNT_DELETION_DISCLOSURE;
/** Fast polling so the progress reads happen inside the test. */
const POLL_MS = 20;

interface StatusBody {
  state: 'pending' | 'purging' | 'failed' | 'complete';
  completed_steps?: readonly string[];
  last_error_code?: string | null;
}

const status = (over: StatusBody) => ({
  state: over.state,
  requested_at: '2026-10-30T00:00:00.000Z',
  accepted_at: '2026-10-30T00:00:01.000Z',
  completed_at: over.state === 'complete' ? '2026-10-30T00:00:30.000Z' : null,
  completed_steps: over.completed_steps ?? [],
  pending_steps: accountDeletion.ACCOUNT_PURGE_STEPS.filter((s) => !(over.completed_steps ?? []).includes(s)),
  attempts: 1,
  last_error_code: over.last_error_code ?? null,
  retrying: over.state !== 'complete',
});

const accountSession = (id: string) => ({
  principal: { kind: 'account', account_id: id, session_id: 's-1', expires_at: null, is_demo_owner: false },
  csrf_token: 'csrf',
});
const anonymousSession = {
  principal: { kind: 'anonymous', account_id: null, session_id: 's-2', expires_at: null, is_demo_owner: false },
  csrf_token: 'csrf2',
};

let sessionMock: ReturnType<typeof accountSession> | typeof anonymousSession | null = null;

/** The api.request shape the view calls (loosely typed: each test returns what it needs). */
type MockRequest = (name: string, options?: { headers?: Record<string, string>; body?: unknown }) => Promise<unknown>;

const baseRequest: MockRequest = async (name, options) => {
  switch (name) {
    case 'getMyAccountDeletion':
      return { requested: false, state: 'none', status: null, disclosure: DISCLOSURE };
    case 'requestMyAccountDeletion': {
      const body = options?.body as { status_token?: string } | undefined;
      return { status: status({ state: 'pending' }), status_token: body?.status_token ?? null, disclosure: DISCLOSURE };
    }
    case 'getAccountDeletionStatus':
      return { status: status({ state: 'pending' }), disclosure: DISCLOSURE };
    default:
      throw new Error(`unexpected api call ${name}`);
  }
};
const request = vi.fn(baseRequest);
const refreshSession = vi.fn(async () => {
  sessionMock = anonymousSession;
  return anonymousSession;
});

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('@/lib/client/session', () => ({
  useSession: () => ({
    session: sessionMock,
    error: null,
    isAccount: sessionMock?.principal?.kind === 'account',
    refresh: vi.fn(),
  }),
}));
vi.mock('@/lib/client/api', () => ({
  api: {
    request: (name: string, options?: { headers?: Record<string, string>; body?: unknown }) =>
      request(name, options),
    refreshSession: () => refreshSession(),
  },
  ApiError: class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: { code: string; message: string; retryable: boolean; request_id: string },
    ) {
      super(body.message);
    }
  },
  newIdempotencyKey: () => 'key',
}));

beforeEach(() => {
  request.mockReset();
  request.mockImplementation(baseRequest);
  refreshSession.mockClear();
  clearStoredAccountDeletion();
  sessionMock = null;
});
afterEach(() => {
  cleanup();
  clearStoredAccountDeletion();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Settings account deletion entry (VAL-DELETE-001)', () => {
  it('renders the server disclosure and cancel changes nothing', async () => {
    sessionMock = accountSession('acc-1');
    render(<AccountDeletionView />);
    expect(await screen.findByRole('heading', { name: 'Delete your account' })).toBeTruthy();
    // The disclosure is the server's own: private-data removal, authority
    // revocation and the real retention limits all appear.
    for (const text of [DISCLOSURE.summary, ...DISCLOSURE.immediate, ...DISCLOSURE.cleanup_steps, ...DISCLOSURE.retained]) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    const back = screen.getByRole('link', { name: 'Back to settings' });
    expect(back.closest('a')?.getAttribute('href')).toBe('/settings');
    expect(request).toHaveBeenCalledWith('getMyAccountDeletion', {});
    expect(request).not.toHaveBeenCalledWith('requestMyAccountDeletion', expect.anything());
  });

  it('confirm sends the typed acceptance with a client status token, stores it and shows the honest pending state', async () => {
    sessionMock = accountSession('acc-1');
    render(<AccountDeletionView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    await screen.findByRole('heading', { name: 'Your account is being deleted' });
    const call = request.mock.calls.find(([name]) => name === 'requestMyAccountDeletion');
    expect(call).toBeTruthy();
    const body = (call![1] as { body: { confirm: boolean; status_token?: string } }).body;
    expect(body.confirm).toBe(true);
    expect(body.status_token).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    // The capability is kept locally so the status keeps answering after the
    // session itself is revoked, and the session is refreshed (now anonymous).
    const stored = readStoredAccountDeletion();
    expect(stored?.account_id).toBe('acc-1');
    expect(stored?.status_token).toBe(body.status_token);
    expect(refreshSession).toHaveBeenCalled();
    // Honest pending state: the already-revoked list and the step still owed.
    expect(screen.getByText(DISCLOSURE.immediate[0]!)).toBeTruthy();
    expect(screen.getByText(DISCLOSURE.cleanup_steps[0]!)).toBeTruthy();
    expect(screen.getByText(/still removing your private data/i)).toBeTruthy();
  });

  it('a failed request shows an error and never an accepted deletion', async () => {
    sessionMock = accountSession('acc-1');
    const { ApiError } = await import('@/lib/client/api');
    request.mockImplementation(async (name: string) => {
      if (name === 'requestMyAccountDeletion')
        throw new ApiError(503, {
          code: 'service_unavailable',
          message: 'The request did not go through.',
          retryable: true,
          request_id: 't1',
        });
      if (name === 'getMyAccountDeletion') return { requested: false, state: 'none', status: null, disclosure: DISCLOSURE };
      throw new Error(`unexpected api call ${name}`);
    });
    render(<AccountDeletionView />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/unchanged/i);
    expect(screen.queryByRole('heading', { name: 'Your account is being deleted' })).toBeNull();
    expect(readStoredAccountDeletion()).toBeNull();
    expect(refreshSession).not.toHaveBeenCalled();
    // The entry stays usable: a retry that succeeds accepts.
    request.mockImplementation(async (name, options) => {
      if (name === 'getMyAccountDeletion') return { requested: false, state: 'none', status: null, disclosure: DISCLOSURE };
      if (name === 'requestMyAccountDeletion') {
        const body = options?.body as { status_token?: string } | undefined;
        return { status: status({ state: 'pending' }), status_token: body?.status_token ?? null, disclosure: DISCLOSURE };
      }
      throw new Error(`unexpected api call ${name}`);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    await screen.findByRole('heading', { name: 'Your account is being deleted' });
  });

  it('polls the token status route and claims completion only when the server does', async () => {
    sessionMock = accountSession('acc-1');
    render(<AccountDeletionView pollMs={POLL_MS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete my account' }));
    await screen.findByRole('heading', { name: 'Your account is being deleted' });
    const token = readStoredAccountDeletion()!.status_token;

    // Partial progress is shown exactly as the server reports it.
    request.mockImplementation(async (name: string, options?: { headers?: Record<string, string> }) => {
      if (name === 'getAccountDeletionStatus') {
        expect(options?.headers?.['x-atlas-deletion-token']).toBe(token);
        return {
          status: status({ state: 'purging', completed_steps: ['media_objects'] }),
          disclosure: DISCLOSURE,
        };
      }
      throw new Error(`unexpected api call ${name}`);
    });
    await screen.findByText('Cleanup is in progress.');
    expect(screen.getByText('Deleted')).toBeTruthy();
    expect(screen.getByText('Removing…')).toBeTruthy();

    // Complete only when the server says complete — and then polling stops.
    request.mockImplementation(async () => ({
      status: status({ state: 'complete', completed_steps: accountDeletion.ACCOUNT_PURGE_STEPS }),
      disclosure: DISCLOSURE,
    }));
    await screen.findByRole('heading', { name: 'Your account is deleted' });
    expect(screen.getByText(/All of your private data has been removed/)).toBeTruthy();
    await waitFor(() =>
      expect(request.mock.calls.filter(([name]) => name === 'getAccountDeletionStatus').length).toBeGreaterThan(0),
    );
    await wait(80);
    const calls = request.mock.calls.filter(([name]) => name === 'getAccountDeletionStatus').length;
    await wait(80);
    expect(request.mock.calls.filter(([name]) => name === 'getAccountDeletionStatus').length).toBe(calls);
    // Forgetting the record drops only this browser's convenience view; the
    // server keeps its own durable record either way.
    fireEvent.click(screen.getByRole('button', { name: 'Forget this record on this browser' }));
    expect(readStoredAccountDeletion()).toBeNull();
    expect(await screen.findByText('You need to be signed in to delete your account.')).toBeTruthy();
  });

  it('reports a failed cleanup truthfully, never as completion', async () => {
    storeAccountDeletion({
      account_id: 'acc-1',
      status_token: 't'.repeat(43),
      requested_at: '2026-10-30T00:00:00.000Z',
    });
    sessionMock = anonymousSession;
    request.mockImplementation(async () => ({
      status: status({ state: 'failed', last_error_code: 'storage_unavailable' }),
      disclosure: DISCLOSURE,
    }));
    render(<AccountDeletionView pollMs={POLL_MS} />);
    await screen.findByRole('heading', { name: 'Your account is being deleted' });
    expect(await screen.findByText(/cleanup hit a problem and will keep retrying automatically/i)).toBeTruthy();
    expect(screen.getByText(/Your account stays deleted and your access stays revoked/i)).toBeTruthy();
    expect(screen.queryByText(/All of your private data has been removed/)).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Your account is deleted' })).toBeNull();
  });

  it('a stored record keeps answering for an anonymous browser; a signed-in account never inherits it', async () => {
    storeAccountDeletion({
      account_id: 'acc-1',
      status_token: 't'.repeat(43),
      requested_at: '2026-10-30T00:00:00.000Z',
    });
    sessionMock = anonymousSession;
    const { unmount } = render(<AccountDeletionView pollMs={POLL_MS} />);
    await screen.findByRole('heading', { name: 'Your account is being deleted' });
    // The first status read happens right away (a tick after mount).
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('getAccountDeletionStatus', {
        headers: { 'x-atlas-deletion-token': 't'.repeat(43) },
      }),
    );
    expect(request).not.toHaveBeenCalledWith('getMyAccountDeletion', expect.anything());
    unmount();

    // A different, live account sees its own confirmation entry instead.
    sessionMock = accountSession('acc-2');
    render(<AccountDeletionView pollMs={POLL_MS} />);
    expect(await screen.findByRole('button', { name: 'Delete my account' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your account is being deleted' })).toBeNull();
    expect(readStoredAccountDeletion()?.account_id).toBe('acc-1');
  });

  it('asks an anonymous browser without a record to sign in first', async () => {
    sessionMock = anonymousSession;
    render(<AccountDeletionView />);
    expect(await screen.findByText('You need to be signed in to delete your account.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in with email' }).closest('a')?.getAttribute('href')).toBe('/identity');
    expect(request).not.toHaveBeenCalled();
  });

  it('shows the accepted state from the overview when the server already holds a deletion', async () => {
    sessionMock = accountSession('acc-1');
    request.mockImplementation(async (name) => {
      if (name === 'getMyAccountDeletion')
        return { requested: true, state: 'pending', status: status({ state: 'pending' }), disclosure: DISCLOSURE };
      throw new Error(`unexpected api call ${name}`);
    });
    render(<AccountDeletionView pollMs={POLL_MS} />);
    await screen.findByRole('heading', { name: 'Your account is being deleted' });
    expect(screen.getByText(/still removing your private data/i)).toBeTruthy();
    await waitFor(() =>
      expect(request.mock.calls.filter(([name]) => name === 'getMyAccountDeletion').length).toBeGreaterThan(1),
    );
  });
});
