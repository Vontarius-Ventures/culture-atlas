import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAUTH_MESSAGE, REAUTH_RETURN, SessionsView, type IdentitySession } from './SessionsView';

afterEach(cleanup);

const sessions: IdentitySession[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    installation_id: '00000000-0000-4000-8000-0000000000aa',
    kind: 'native',
    created_at: '2026-10-01T10:00:00.000Z',
    expires_at: '2026-12-30T10:00:00.000Z',
    revoked_at: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    installation_id: null,
    kind: 'browser',
    created_at: '2026-10-02T10:00:00.000Z',
    expires_at: '2026-11-01T10:00:00.000Z',
    revoked_at: null,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    installation_id: null,
    kind: 'browser',
    created_at: '2026-09-02T10:00:00.000Z',
    expires_at: '2026-10-01T10:00:00.000Z',
    revoked_at: '2026-09-03T10:00:00.000Z',
  },
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeServer(mutationStatus: number) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === '/v1/session') return json({ csrf_token: 'csrf-fixture' });
    if (url === '/v2/identity/sessions') return json({ items: sessions });
    return json(
      mutationStatus === 200 ? { revoked: true } : { error: { code: 'unauthenticated' } },
      mutationStatus,
    );
  });
  return { fetcher, calls };
}

describe('SessionsView', () => {
  it('lists only active sessions and revokes one with CSRF', async () => {
    const { fetcher, calls } = fakeServer(200);
    render(<SessionsView fetcher={fetcher} />);
    const list = await screen.findByRole('list', { name: 'Active sessions' });
    expect(list.querySelectorAll('li')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Sign out Phone app session 1' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Phone app session 1 signed out.'),
    );
    const revoke = calls.find((c) => c.url.endsWith('/revoke'))!;
    expect(revoke.url).toBe('/v2/identity/sessions/00000000-0000-4000-8000-000000000001/revoke');
    expect((revoke.init!.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-fixture');
  });

  it('asks for email reauthentication when sign-out-all is not recent enough', async () => {
    const { fetcher } = fakeServer(401);
    render(<SessionsView fetcher={fetcher} />);
    await screen.findByRole('list', { name: 'Active sessions' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out of all devices' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(REAUTH_MESSAGE));
    const link = screen.getByRole('link', { name: 'Verify email again' });
    await userEvent.click(link);
    expect(sessionStorage.getItem('ca_identity_return')).toBe(REAUTH_RETURN);
  });
});
