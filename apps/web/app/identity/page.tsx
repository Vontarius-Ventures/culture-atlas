'use client';

import { useState } from 'react';
import styles from './page.module.css';

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
        'Check your email for a sign-in link, then open it in this browser. It works once and expires in 15 minutes.',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to start sign-in.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Sign in</h1>
      <p className={styles.intro}>We&rsquo;ll email you a link. No password needed.</p>
      <form action={submit} className={styles.form}>
        <label htmlFor="identity-email">Email</label>
        <input
          id="identity-email"
          className={styles.input}
          type="email"
          name="email"
          autoComplete="email"
          required
          maxLength={254}
        />
        <button className={styles.submit} disabled={busy} type="submit">
          {busy ? 'Sending…' : 'Email me a sign-in link'}
        </button>
        <details className={styles.more}>
          <summary>More options</summary>
          <label className={styles.option}>
            Action
            <select className={styles.input} name="purpose" defaultValue="sign_in">
              <option value="sign_in">Sign in or create an account</option>
              <option value="verify">Verify this signed-in account</option>
              <option value="recover">Recover account and sign out other sessions</option>
            </select>
          </label>
          <label className={styles.option}>
            <input type="checkbox" name="claim" /> Keep this preview in my account
          </label>
        </details>
      </form>
      <p role="status">{message}</p>
    </main>
  );
}
