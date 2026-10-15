'use client';

import { useEffect, useRef, useState } from 'react';

export default function IdentityCallback() {
  const started = useRef(false);
  const [message, setMessage] = useState('Verifying email…');
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, '', '/identity/callback');
    async function complete() {
      const stored = sessionStorage.getItem('ca_identity_pending');
      if (!stored) throw new Error('Return to the browser where you started sign-in.');
      const pending = JSON.parse(stored);
      if (pending.state !== fragment.get('state') || pending.nonce !== fragment.get('nonce')) {
        throw new Error('This sign-in does not match your request. Start again.');
      }
      const session = await fetch('/v1/session', { cache: 'no-store' }).then((r) => r.json());
      const response = await fetch('/v2/identity/email/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token },
        body: JSON.stringify({
          challenge_id: fragment.get('challenge_id'),
          token: fragment.get('token'),
          state: pending.state,
          nonce: pending.nonce,
          code_verifier: pending.verifier,
        }),
      });
      if (!response.ok)
        throw new Error('This link is expired or already used. Start sign-in again.');
      sessionStorage.removeItem('ca_identity_pending');
      window.location.replace('/library');
    }
    void complete().catch((error: Error) => setMessage(error.message));
  }, []);
  return (
    <main>
      <h1>Account verification</h1>
      <p role="status">{message}</p>
      <a href="/identity">Start again</a>
    </main>
  );
}
