'use client';

import { useEffect, useRef, useState } from 'react';
import { iosHandoffLink } from './native-link';
import styles from './page.module.css';

export default function IdentityCallback() {
  const started = useRef(false);
  const [message, setMessage] = useState('Verifying email…');
  const [native, setNative] = useState(false);
  const [appLink, setAppLink] = useState<string>();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const destination = new URLSearchParams(window.location.search).get('destination');
    window.history.replaceState(null, '', '/identity/callback');
    if (destination === 'ios') {
      const link = iosHandoffLink(fragment);
      queueMicrotask(() => {
        setNative(true);
        setAppLink(link);
        setMessage(link
          ? 'Open culture atlas on the iPhone where you requested this link to finish signing in.'
          : 'This link is incomplete. Return to the app and request a new sign-in email.');
      });
      // Never exchange a phone proof in the browser. The app holds its PKCE verifier.
      return;
    }
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
      // Only fixed in-app destinations; never an arbitrary redirect.
      const back = sessionStorage.getItem('ca_identity_return');
      sessionStorage.removeItem('ca_identity_return');
      window.location.replace(back === '/identity/sessions' ? back : '/library');
    }
    void complete().catch((error: Error) => setMessage(error.message));
  }, []);
  return (
    <main className={styles.page}>
      <p className={styles.brand}>culture atlas</p>
      <h1 className={styles.title}>{native ? 'Finish signing in' : 'Account verification'}</h1>
      <p role="status">{message}</p>
      {appLink && <a className={styles.open} href={appLink}>Open culture atlas</a>}
      {appLink && (
        <p className={styles.help}>
          If your email app blocks opening the app, open this email link in Safari on the same iPhone,
          then tap the button. Links expire after 15 minutes and work once.
        </p>
      )}
      <a className={styles.retry} href={native ? 'cultureatlas://identity' : '/identity'}>
        {native ? 'Return to the app to request a new link' : 'Start again'}
      </a>
    </main>
  );
}
