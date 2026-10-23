'use client';

import { useCallback, useEffect, useState } from 'react';

export interface IdentitySession {
  id: string;
  installation_id: string | null;
  kind: 'native' | 'browser';
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Where /identity/callback may send the user back to; nothing else is accepted. */
export const REAUTH_RETURN = '/identity/sessions';
export const REAUTH_MESSAGE =
  'For your security, verify your email again, then repeat this action within 5 minutes.';

export function sessionLabel(session: IdentitySession, phoneIndex: number): string {
  return session.kind === 'native' ? `Phone app session ${phoneIndex}` : 'Browser session';
}

async function csrfToken(fetcher: Fetcher): Promise<string> {
  const session = await fetcher('/v1/session', { cache: 'no-store' }).then((r) => r.json());
  return session.csrf_token as string;
}

/** Account security: list sessions, revoke one, or sign out everywhere (recent reauth required). */
export function SessionsView({ fetcher = fetch }: { fetcher?: Fetcher }) {
  const [sessions, setSessions] = useState<IdentitySession[] | null>(null);
  const [status, setStatus] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetcher('/v2/identity/sessions', { cache: 'no-store' });
    if (response.status === 401) {
      setStatus('Sign in to manage your sessions.');
      setSessions([]);
      return;
    }
    if (!response.ok) {
      setStatus('Sessions could not be loaded. Try again.');
      setSessions([]);
      return;
    }
    setSessions(((await response.json()) as { items: IdentitySession[] }).items);
  }, [fetcher]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => (cancelled ? undefined : load()));
    return () => {
      cancelled = true;
    };
  }, [load]);

  async function mutate(path: string, success: string) {
    setBusy(true);
    setNeedsReauth(false);
    try {
      const response = await fetcher(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': await csrfToken(fetcher) },
        body: '{}',
      });
      if (response.status === 401) {
        setNeedsReauth(true);
        setStatus(REAUTH_MESSAGE);
        return;
      }
      if (!response.ok) {
        setStatus('That did not work. Try again.');
        return;
      }
      setStatus(success);
      await load();
    } finally {
      setBusy(false);
    }
  }

  const active = (sessions ?? []).filter((s) => !s.revoked_at);
  let phone = 0;
  return (
    <main>
      <h1>Sessions and devices</h1>
      <p>
        Removing a phone stops its uploads and remote capture. Media already in your library stays.
      </p>
      {sessions === null ? (
        <p>Loading sessions…</p>
      ) : (
        <ul aria-label="Active sessions">
          {active.map((session) => {
            const label = sessionLabel(session, session.kind === 'native' ? ++phone : 0);
            return (
              <li key={session.id}>
                <span>{label}</span>{' '}
                <span>Started {new Date(session.created_at).toLocaleDateString()}</span>{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      `/v2/identity/sessions/${session.id}/revoke`,
                      `${label} signed out.`,
                    )
                  }
                >
                  Sign out {label}
                </button>
              </li>
            );
          })}
          {active.length === 0 ? <li>No active sessions.</li> : null}
        </ul>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void mutate('/v2/identity/sign-out-all', 'Signed out of every browser and phone.')
        }
      >
        Sign out of all devices
      </button>
      <p role="status" aria-live="polite">
        {status}
      </p>
      {needsReauth ? (
        <a
          href="/identity"
          onClick={() => {
            try {
              sessionStorage.setItem('ca_identity_return', REAUTH_RETURN);
            } catch {
              /* Storage unavailable: the callback falls back to the library. */
            }
          }}
        >
          Verify email again
        </a>
      ) : null}
    </main>
  );
}
