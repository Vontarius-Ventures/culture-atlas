'use client';

import { useState } from 'react';

const random = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
};

export default function IdentityPage() {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    setBusy(true);
    try {
      const session = await fetch('/v1/session', { cache: 'no-store' }).then((r) => r.json());
      const state = random();
      const nonce = random();
      const verifier = random();
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
      );
      const challenge = btoa(String.fromCharCode(...digest))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
      sessionStorage.setItem('ca_identity_pending', JSON.stringify({ state, nonce, verifier }));
      const response = await fetch('/v2/identity/email/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token },
        body: JSON.stringify({
          email: form.get('email'),
          purpose: form.get('purpose'),
          destination: 'web',
          state,
          nonce,
          code_challenge: challenge,
          claim_session: form.get('claim') === 'on',
        }),
      });
      if (!response.ok) throw new Error('Unable to start email sign-in. Try again later.');
      setMessage(
        'If eligible, your email has a verification link. Open it in this browser. Existing password accounts must sign in with their password before verifying.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to start sign-in.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>Secure account sign-in</h1>
      <p>Verify your email to keep a recoverable account across devices.</p>
      <form action={submit}>
        <label>
          Email <input type="email" name="email" autoComplete="email" required maxLength={254} />
        </label>
        <label>
          Action{' '}
          <select name="purpose">
            <option value="sign_in">Sign in or create verified account</option>
            <option value="verify">Verify this signed-in account</option>
            <option value="recover">Recover account and sign out other sessions</option>
          </select>
        </label>
        <label>
          <input type="checkbox" name="claim" /> Keep this anonymous preview in my account
        </label>
        <button disabled={busy} type="submit">
          {busy ? 'Sending…' : 'Email verification link'}
        </button>
      </form>
      <p role="status">{message}</p>
      <p>
        <a href="/identity/sessions">Manage sessions and devices</a>
      </p>
    </main>
  );
}
