'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AccountDeletionDisclosure,
  AccountDeletionStatus,
} from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import {
  clearStoredAccountDeletion,
  generateStatusToken,
  readStoredAccountDeletion,
  storeAccountDeletion,
  type StoredAccountDeletion,
} from '@/lib/client/account-deletion';
import { useSession } from '@/lib/client/session';
import { BackLink, Notice } from '../ui';

/**
 * /settings/deletion — the first-party account deletion entry
 * (VAL-DELETE-001). The confirmation explains the server's own disclosure
 * (what is revoked immediately, what the durable cleanup removes, and what is
 * retained with its limits); cancel changes nothing; a request error is
 * shown as an error, never as an accepted deletion. After acceptance the
 * status view reports the cleanup exactly as the server does — pending,
 * in progress, failed-and-retrying, or complete — using the one-time
 * capability token, which keeps answering after the session itself is gone.
 */
export function AccountDeletionView({ pollMs = 5_000 }: { pollMs?: number }) {
  const { session, isAccount } = useSession();
  const [mode, setMode] = useState<'deciding' | 'signin' | 'explain' | 'accepted'>('deciding');
  const [disclosure, setDisclosure] = useState<AccountDeletionDisclosure | null>(null);
  const [deletionStatus, setDeletionStatus] = useState<AccountDeletionStatus | null>(null);
  const [stored, setStored] = useState<StoredAccountDeletion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Decide the surface from the live session plus the locally kept capability.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // One microtask yield so every state update below lands outside this
      // effect's synchronous body (no setState cascades within the effect).
      await Promise.resolve();
      if (cancelled) return;
      const record = readStoredAccountDeletion();
      setStored(record);
      if (!session) return;
      if (record && !isAccount) {
        // Anonymous with a kept capability: the status view (and its polling)
        // continues from whatever snapshot this acceptance or overview showed.
        setMode('accepted');
        return;
      }
      if (!isAccount) {
        setMode('signin');
        return;
      }
      // A live owner session: read this account's own deletion state. (A stored
      // record from an earlier, already-deleted account is never inherited.)
      try {
        const overview = await api.request('getMyAccountDeletion', {});
        if (cancelled) return;
        setDisclosure(overview.disclosure);
        if (overview.requested && overview.status) {
          setDeletionStatus(overview.status);
          setMode('accepted');
        } else {
          setMode('explain');
        }
      } catch {
        if (!cancelled) setMode('explain');
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-run when the session identity or an explicit retry changes it.
  }, [session, isAccount, reloadKey]);

  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const token = generateStatusToken();
    const accountId = session?.principal.account_id;
    try {
      const response = await api.request('requestMyAccountDeletion', {
        body: { confirm: true, status_token: token },
      });
      // Accepted: keep the capability locally, then drop the (now revoked)
      // session so no signed-in surface stays behind.
      if (accountId) {
        const record: StoredAccountDeletion = {
          account_id: accountId,
          status_token: response.status_token ?? token,
          requested_at: response.status.requested_at,
        };
        storeAccountDeletion(record);
        setStored(record);
      }
      setDisclosure(response.disclosure);
      setDeletionStatus(response.status);
      setMode('accepted');
      await api.refreshSession().catch(() => undefined);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} Your account is unchanged. Please try again.`
          : 'The request did not go through. Your account is unchanged. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }, [busy, session]);

  const forgetRecord = useCallback(() => {
    clearStoredAccountDeletion();
    setStored(null);
    setDeletionStatus(null);
    setMode('signin');
  }, []);

  if (mode === 'deciding') {
    return (
      <div className="page page--narrow settings" aria-busy="true">
        <h1 className="display">Delete your account</h1>
        <div className="settings-skeleton">
          <div className="skeleton" style={{ height: 120 }} />
          <p className="visually-hidden" role="status">
            Loading your account state…
          </p>
        </div>
      </div>
    );
  }

  if (mode === 'signin') {
    return (
      <div className="page page--narrow settings">
        <BackLink href="/settings" label="Back to settings" />
        <h1 className="display">Delete your account</h1>
        <section className="settings__section">
          <p>You need to be signed in to delete your account.</p>
          <p>
            <Link href="/identity" className="button button--primary">
              Sign in with email
            </Link>
          </p>
        </section>
      </div>
    );
  }

  if (mode === 'accepted') {
    return (
      <DeletionStatusView
        status={deletionStatus}
        disclosure={disclosure}
        token={stored?.status_token ?? null}
        canPollOwnerOverview={isAccount}
        pollMs={pollMs}
        onDisclosure={setDisclosure}
        onForget={forgetRecord}
      />
    );
  }

  // The confirmation entry: disclosure first, then one explicit confirm.
  return (
    <div className="page page--narrow settings">
      <BackLink href="/settings" label="Back to settings" />
      <h1 className="display">Delete your account</h1>
      {disclosure ? (
        <>
          <p className="settings__lead">{disclosure.summary}</p>
          <DeletionDisclosureSections disclosure={disclosure} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="button button--danger" onClick={() => void confirm()} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete my account'}
            </button>
          </div>
          <p className="muted">This cannot be undone.</p>
        </>
      ) : (
        <>
          <Notice tone="error">
            The explanation of what deletion removes could not load. Nothing has changed on your
            account.
          </Notice>
          <p>
            <button type="button" className="button button--outline" onClick={() => setReloadKey((k) => k + 1)}>
              Try again
            </button>
          </p>
        </>
      )}
    </div>
  );
}

/** The immediate/cleanup/retention lists, shared by the confirmation and the status view. */
function DeletionDisclosureSections({ disclosure }: { disclosure: AccountDeletionDisclosure }) {
  return (
    <>
      <section className="settings__section">
        <h2 className="section-title">What happens right away</h2>
        <ul className="disclosure-list">
          {disclosure.immediate.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="settings__section">
        <h2 className="section-title">What is permanently deleted</h2>
        <ul className="disclosure-list">
          {disclosure.cleanup_steps.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="settings__section">
        <h2 className="section-title">What is kept, and why</h2>
        <ul className="disclosure-list">
          {disclosure.retained.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

/**
 * The honest lifecycle view after acceptance. Polls the capability-token
 * status route (or, while a live owner session still exists, the owner
 * overview) and reports exactly what the server says — never more.
 */
function DeletionStatusView({
  status,
  disclosure,
  token,
  canPollOwnerOverview,
  pollMs,
  onDisclosure,
  onForget,
}: {
  status: AccountDeletionStatus | null;
  disclosure: AccountDeletionDisclosure | null;
  token: string | null;
  canPollOwnerOverview: boolean;
  pollMs: number;
  onDisclosure: (d: AccountDeletionDisclosure) => void;
  onForget?: () => void;
}) {
  const [live, setLive] = useState<AccountDeletionStatus | null>(status);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const pollRef = useRef(0);
  const done = live?.state === 'complete';

  // The parent resets the snapshot when the session flips (the acceptance
  // revokes it) — React's adjust-state-during-render pattern, no effect.
  const [prevStatus, setPrevStatus] = useState(status);
  if (status !== prevStatus) {
    setPrevStatus(status);
    setLive(status);
  }

  const refresh = useCallback(async () => {
    const id = ++pollRef.current;
    try {
      if (token) {
        const response = await api.request('getAccountDeletionStatus', {
          headers: { 'x-atlas-deletion-token': token },
        });
        if (id === pollRef.current) {
          setLive(response.status);
          onDisclosure(response.disclosure);
          setRefreshFailed(false);
        }
      } else if (canPollOwnerOverview) {
        const overview = await api.request('getMyAccountDeletion', {});
        if (id === pollRef.current) {
          if (overview.status) setLive(overview.status);
          onDisclosure(overview.disclosure);
          setRefreshFailed(false);
        }
      }
    } catch {
      if (id === pollRef.current) setRefreshFailed(true);
    }
  }, [token, canPollOwnerOverview, onDisclosure]);

  const hasLive = live !== null;
  useEffect(() => {
    if (done) return;
    // Poll immediately when nothing is on screen yet (one tick out, so the
    // effect body itself never sets state), then on the interval.
    const first = window.setTimeout(() => {
      if (!hasLive) void refresh();
    }, 0);
    const id = setInterval(() => void refresh(), pollMs);
    return () => {
      window.clearTimeout(first);
      clearInterval(id);
    };
  }, [refresh, done, pollMs, hasLive]);

  const stateLine =
    live == null
      ? 'Checking the cleanup status…'
      : live.state === 'pending'
        ? 'Cleanup is queued. We are still removing your private data.'
        : live.state === 'purging'
          ? 'Cleanup is in progress.'
          : live.state === 'failed'
            ? 'The cleanup hit a problem and will keep retrying automatically. Your account stays deleted and your access stays revoked.'
            : 'All of your private data has been removed.';

  const completed = live?.completed_steps ?? [];
  const pending = live?.pending_steps ?? [];

  return (
    <div className="page page--narrow settings">
      <h1 className="display">{done ? 'Your account is deleted' : 'Your account is being deleted'}</h1>
      <section className="settings__section">
        <p className="settings__lead" role="status">
          {stateLine}
        </p>
        {refreshFailed && (
          <Notice tone="quiet">
            The latest status check didn’t reach culture atlas. This is the last status we had.
          </Notice>
        )}
      </section>
      {disclosure && (
        <>
          <section className="settings__section">
            <h2 className="section-title">What already happened</h2>
            <ul className="disclosure-list">
              {disclosure.immediate.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
          <section className="settings__section">
            <h2 className="section-title">Cleanup</h2>
            <ul className="deletion-steps">
              {/* The server sends the step ids in run order (completed first,
                  then still owed) and the same steps already labeled as
                  disclosure.cleanup_steps — no step copy is bundled here. */}
              {[...completed, ...pending].map((step, index) => {
                const isDone = completed.includes(step);
                return (
                  <li key={step} className={isDone ? 'deletion-steps__done' : undefined}>
                    <span className="deletion-steps__mark" aria-hidden="true">
                      {isDone ? '✓' : '…'}
                    </span>
                    <span className="deletion-steps__text">
                      {disclosure.cleanup_steps[index] ?? step}
                    </span>
                    <span className="deletion-steps__state">{isDone ? 'Deleted' : 'Removing…'}</span>
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="settings__section">
            <h2 className="section-title">What is kept, and why</h2>
            <ul className="disclosure-list">
              {disclosure.retained.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        </>
      )}
      <section className="settings__section">
        <p>
          <Link href="/" className="button button--outline">
            Back to culture atlas
          </Link>
        </p>
        {done && onForget && (
          <button type="button" className="text-button" onClick={onForget}>
            Forget this record on this browser
          </button>
        )}
      </section>
    </div>
  );
}
