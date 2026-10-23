'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import type { CollectionSummary } from '@culture-atlas/domain/schemas';
import { api } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { Dialog } from '../Dialog';
import { Icon } from '../Icon';
import { COPY } from './copy';
import { mediaApi, mediaErrorMessage } from './media-api';

/** Mobile "‹ Back   culture atlas" header for flow screens (the shell hides its own). */
export function FlowHeader({
  href,
  label,
  wordmark = true,
  arrow = 'chevron',
}: {
  href: string;
  label: string;
  wordmark?: boolean;
  arrow?: 'chevron' | 'arrow';
}) {
  return (
    <div className={`flow-header${wordmark && label ? '' : ' flow-header--start'}`}>
      <Link
        href={href}
        className="v2-back flow-header__back"
        aria-label={label ? undefined : 'Back'}
      >
        <Icon name={arrow === 'arrow' ? 'arrowLeft' : 'chevronLeft'} size={24} />
        {label && <span>{label}</span>}
      </Link>
      {wordmark && (
        <Link href="/" className="flow-header__wordmark">
          culture atlas
        </Link>
      )}
    </div>
  );
}

/** "Experimental" label that links to the plain explanation of what it means. */
export function ExperimentalBadge({ quiet }: { quiet?: boolean }) {
  return (
    <span className={`badge-experimental${quiet ? ' badge-experimental--quiet' : ''}`}>
      {COPY['capture.experimental']}
    </span>
  );
}

export function V2Notice({
  children,
  tone = 'quiet',
  actions,
}: {
  children: ReactNode;
  tone?: 'quiet' | 'error';
  actions?: ReactNode;
}) {
  return (
    <div className={`v2-notice v2-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="v2-notice__body">
        <div>{children}</div>
        {actions && <div className="v2-notice__actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Denied state: the library is account-private and needs a recoverable sign-in. */
export function SignInPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="v2-empty" aria-labelledby="signin-title">
      <h2 id="signin-title" className="v2-empty__title">
        {title}
      </h2>
      <p className="v2-empty__body">
        {children ??
          'Sign in with your email to keep photos and videos in your private library and see them on every device.'}
      </p>
      <div className="v2-empty__actions">
        <Link href="/identity" className="button button--primary v2-button">
          Sign in
        </Link>
        <Link href="/" className="button button--outline v2-button">
          Back to Discover
        </Link>
      </div>
    </section>
  );
}

/** Saves owned media to one of the owner's collections (PUT /v2/collections/{id}/media/{asset}). */
export function CollectionPicker({
  open,
  onClose,
  assetIds,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  assetIds: string[];
  onSaved: (collectionName: string, count: number) => void;
}) {
  const [collections, setCollections] = useState<CollectionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useAsyncEffect(() => {
    if (!open) return;
    setError(null);
    api
      .request('listCollections', {})
      .then((r) => setCollections(r.collections))
      .catch((err: unknown) => setError(mediaErrorMessage(err, 'Collections could not load.')));
  }, [open]);

  const save = async (c: CollectionSummary) => {
    setBusy(c.id);
    setError(null);
    let saved = 0;
    try {
      for (const id of assetIds) {
        await mediaApi.addToCollection(c.id, id);
        saved += 1;
      }
      onSaved(c.name, saved);
      onClose();
    } catch (err) {
      setError(
        saved
          ? `Saved ${saved} of ${assetIds.length}. ${mediaErrorMessage(err)}`
          : mediaErrorMessage(err, 'This could not be saved. Try again.'),
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Save to a collection" size="small">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!collections && !error && (
        <p className="loading-text" role="status">
          Loading collections…
        </p>
      )}
      {collections && collections.length === 0 && (
        <p className="muted">
          You have no collections yet.{' '}
          <Link href="/collections" className="text-link">
            Create one
          </Link>{' '}
          first.
        </p>
      )}
      {collections && collections.length > 0 && (
        <ul className="picker" aria-label="Your collections">
          {collections.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="picker-row"
                onClick={() => void save(c)}
                disabled={busy !== null}
                aria-busy={busy === c.id}
              >
                <span className="picker-row__name">{c.name}</span>
                <span className="muted">{busy === c.id ? 'Saving…' : `${c.item_count} items`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/** Two-step confirm for destructive actions; focus stays in context. */
export function ConfirmDelete({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      variant="dialog"
      size="small"
      footer={
        <>
          <button type="button" className="button button--outline" onClick={onClose}>
            Keep it
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
            disabled={busy}
            data-autofocus
          >
            {busy ? 'Deleting…' : confirmLabel}
          </button>
        </>
      }
    >
      <p>{body}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
