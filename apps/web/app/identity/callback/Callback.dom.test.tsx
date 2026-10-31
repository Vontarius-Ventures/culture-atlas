import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Callback from './page';
import { iosHandoffLink } from './native-link';

const proof = {
  challenge_id: '00000000-0000-4000-8000-000000000001',
  token: 't'.repeat(43),
  state: 's'.repeat(43),
  nonce: 'n'.repeat(43),
};
const fragment = () => new URLSearchParams(proof);

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/identity/callback');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('iOS email handoff', () => {
  it('offers an explicit app button without exchanging, consuming, or leaking the proof', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', `/identity/callback?destination=ios#${fragment()}`);
    render(<Callback />);
    const link = await screen.findByRole('link', { name: 'Open culture atlas' });
    expect(link.getAttribute('href')).toBe(`cultureatlas://identity/callback#${fragment()}`);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('iPhone where you requested');
    expect(document.body.textContent).not.toContain(proof.token);
    expect(screen.getByRole('link', { name: /request a new link/ }).getAttribute('href'))
      .toBe('cultureatlas://identity');
  });

  it('does not show a broken app button for missing or invalid proof', async () => {
    vi.stubGlobal('fetch', vi.fn());
    window.history.replaceState(null, '', '/identity/callback?destination=ios#token=short');
    render(<Callback />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('incomplete'));
    expect(screen.queryByRole('link', { name: 'Open culture atlas' })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses only the fixed app destination and discards caller redirect fields', () => {
    const params = fragment();
    params.set('redirect_uri', 'https://attacker.example/');
    const link = new URL(iosHandoffLink(params)!);
    expect(link.protocol).toBe('cultureatlas:');
    expect(link.host).toBe('identity');
    expect(link.pathname).toBe('/callback');
    expect(link.toString()).not.toContain('attacker');
  });

  it('rejects ambiguous duplicate proof fields', () => {
    const params = fragment();
    params.append('state', 'x'.repeat(43));
    expect(iosHandoffLink(params)).toBeUndefined();
  });
});

describe('existing web callback', () => {
  it('still requires the initiating browser session', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', `/identity/callback#${fragment()}`);
    render(<Callback />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('browser where you started'));
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Open culture atlas' })).toBeNull();
  });

  it('retains CSRF and PKCE on web exchanges and shows expired-link failure', async () => {
    sessionStorage.setItem('ca_identity_pending', JSON.stringify({ state: proof.state, nonce: proof.nonce, verifier: 'v'.repeat(43) }));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ csrf_token: 'csrf-fixture' })))
      .mockResolvedValueOnce(new Response('{}', { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    window.history.replaceState(null, '', `/identity/callback#${fragment()}`);
    render(<Callback />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('expired or already used'));
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('/v2/identity/email/complete');
    expect(init.headers['x-csrf-token']).toBe('csrf-fixture');
    expect(JSON.parse(init.body).code_verifier).toBe('v'.repeat(43));
    expect(sessionStorage.getItem('ca_identity_pending')).not.toBeNull();
  });
});
