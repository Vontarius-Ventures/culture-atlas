'use client';

import { useId, useState } from 'react';
import type { CreateAccountRequest } from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';

export interface AccountPromptProps {
  /** Short lead sentence for the context ("Create an account to keep collections."). */
  lead?: string;
  pendingSave?: CreateAccountRequest['pending_save'];
  onCreated: (result: { claimedSaved: number }) => void;
  compact?: boolean;
}

/**
 * Account creation that claims the current anonymous session (captures and the
 * intended save come along). Shown when saving persistently, creating a
 * collection or connecting an agent; never required for browsing or examples.
 */
export function AccountPrompt({
  lead,
  pendingSave,
  onCreated,
  compact,
}: AccountPromptProps) {
  const nameId = useId();
  const emailId = useId();
  const passwordId = useId();
  const [mode, setMode] = useState<'create' | 'sign-in'>('create');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    const mail = email.trim();
    if (mode === 'sign-in' && (!mail || !password)) {
      setError('Enter your email and password.');
      return;
    }
    if (mode === 'create' && Boolean(mail) !== Boolean(password)) {
      setError('Add a password to go with your email, or leave both empty.');
      return;
    }
    if (mode === 'create' && password && password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    setBusy(true);
    try {
      let claimedSaved: number;
      if (mode === 'sign-in') {
        const res = await api.request('signIn', {
          body: { email: mail, password, claim_session: true, pending_save: pendingSave },
        });
        claimedSaved = res.claimed.saved_items + (res.pending_save ? 1 : 0);
      } else {
        const res = await api.request('createAccount', {
          body: {
            display_name: name.trim() || undefined,
            email: mail || undefined,
            password: password || undefined,
            claim_session: true,
            pending_save: pendingSave,
          },
          idempotencyKey: newIdempotencyKey(),
        });
        claimedSaved = res.claimed.saved_items;
      }
      await api.refreshSession();
      onCreated({ claimedSaved });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const signingIn = mode === 'sign-in';
  return (
    <div className={`account-prompt${compact ? ' account-prompt--compact' : ''}`}>
      <p className="account-prompt__lead">
        {signingIn
          ? 'Sign in to pick up your collections.'
          : (lead ?? 'Create an account to keep your saves and build private collections.')}
      </p>
      <p className="account-prompt__note">
        Photos and saves from this visit come with you. Without an account they expire after 24
        hours.
      </p>
      <form
        className="account-prompt__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!signingIn && (
          <>
            <label htmlFor={nameId} className="field-label">
              Your name <span className="field-optional">(optional)</span>
            </label>
            <input
              id={nameId}
              className="input"
              value={name}
              maxLength={80}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
              data-autofocus
            />
          </>
        )}
        <label htmlFor={emailId} className="field-label">
          Email{' '}
          {!signingIn && <span className="field-optional">(optional, to sign in elsewhere)</span>}
        </label>
        <input
          id={emailId}
          className="input"
          type="email"
          value={email}
          maxLength={254}
          autoComplete={signingIn ? 'username' : 'email'}
          onChange={(e) => setEmail(e.target.value)}
          {...(signingIn ? { 'data-autofocus': true } : {})}
        />
        <label htmlFor={passwordId} className="field-label">
          Password {!signingIn && <span className="field-optional">(with an email)</span>}
        </label>
        <input
          id={passwordId}
          className="input"
          type="password"
          value={password}
          maxLength={200}
          autoComplete={signingIn ? 'current-password' : 'new-password'}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="account-prompt__actions">
          <button type="submit" className="button button--primary button--wide" disabled={busy}>
            {signingIn
              ? busy
                ? 'Signing in…'
                : 'Sign in'
              : busy
                ? 'Creating account…'
                : 'Create account'}
          </button>
        </div>
        <p className="account-prompt__switch">
          {signingIn ? 'New here? ' : 'Already have an account? '}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setMode(signingIn ? 'create' : 'sign-in');
              setError(null);
            }}
          >
            {signingIn ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  );
}
