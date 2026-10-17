'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import type { CollectionsListResponse, SavedEntry } from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { UI_LIMITS } from '@/lib/client/limits';
import { cardToTarget, useSave } from '@/lib/client/save';
import { useSession } from '@/lib/client/session';
import { applyOverrides, useItemOverrides } from '@/lib/client/store';
import { AccountPrompt } from '../AccountPrompt';
import { CaptureStart } from '../CaptureStart';
import { CollectionCover } from '../CollectionCover';
import { Dialog } from '../Dialog';
import { CardGrid, DiscoveryCard, SkeletonGrid } from '../DiscoveryCard';
import { Icon } from '../Icon';
import { EmptyState, PageError } from '../ui';

/** Create-collection form used by the index ("New collection") and empty states. */
export function NewCollectionDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const nameId = useId();
  const descId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="New collection" variant="sheet" size="small">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          setBusy(true);
          setError(null);
          try {
            const created = await api.request('createCollection', {
              body: { name: name.trim(), description: description.trim() || undefined },
              idempotencyKey: newIdempotencyKey(),
            });
            setName('');
            setDescription('');
            onCreated(created.id);
          } catch (err) {
            setError(
              err instanceof ApiError ? err.message : 'The collection could not be created.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor={nameId} className="field-label">
          Name
        </label>
        <input
          id={nameId}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={UI_LIMITS.collectionNameMax}
          required
          data-autofocus
        />
        <label htmlFor={descId} className="field-label">
          Description <span className="field-optional">(optional)</span>
        </label>
        <textarea
          id={descId}
          className="input textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={UI_LIMITS.collectionDescriptionMax}
          rows={3}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="button button--primary button--block"
          disabled={busy || !name.trim()}
        >
          {busy ? 'Creating…' : 'Create collection'}
        </button>
      </form>
    </Dialog>
  );
}

/**
 * Collections index: cover mosaics, names and private item counts, plus the
 * virtual "Saved for later" for unfiled saves. Anonymous visitors are invited
 * to create an account; their temporary saves are listed meanwhile.
 */
export function CollectionsView() {
  const router = useRouter();
  const { session, isAccount } = useSession();
  const [data, setData] = useState<CollectionsListResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.request('listCollections', {}));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    }
  }, []);

  useAsyncEffect(() => (isAccount ? load() : undefined), [isAccount, load]);

  const header = (
    <div className="page-head">
      <h1 className="display">Your collections</h1>
      {isAccount && (
        <button type="button" className="button button--outline" onClick={() => setCreating(true)}>
          <Icon name="plus" />
          <span>New collection</span>
        </button>
      )}
    </div>
  );

  if (!session) {
    return (
      <div className="page">
        {header}
        <SkeletonGrid count={4} />
      </div>
    );
  }

  if (!isAccount) {
    return (
      <div className="page">
        {header}
        <AnonymousSaves />
      </div>
    );
  }

  const unfiledCount = data?.unfiled?.item_count ?? 0;
  return (
    <div className="page page--collections">
      {header}
      {error && !data && <PageError message={error.message} onRetry={() => void load()} />}
      {!data && !error && <SkeletonGrid count={4} />}
      {data && data.collections.length === 0 ? (
        <>
          {unfiledCount > 0 && (
            <ul className="grid grid--covers">
              <li>
                <CollectionCover
                  href="/collections/later"
                  name="Saved for later"
                  count={unfiledCount}
                  images={data.unfiled?.cover ?? []}
                />
              </li>
            </ul>
          )}
          <EmptyState
            title="No collections yet"
            actions={
              <>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => setCreating(true)}
                >
                  <Icon name="plus" />
                  <span>Create a collection</span>
                </button>
                <Link href="/capture" className="button button--outline">
                  <Icon name="camera" />
                  <span>Capture</span>
                </Link>
              </>
            }
          >
            <p>Gather photos, films, music and food ideas you love in one place.</p>
            <CaptureStart layout="examples-only" />
          </EmptyState>
        </>
      ) : (
        data && (
          <ul className="grid grid--covers" aria-label="Collections">
            {data.collections.map((c) => (
              <li key={c.id}>
                <CollectionCover
                  href={`/collections/${c.id}`}
                  name={c.name}
                  count={c.item_count}
                  images={c.cover}
                />
              </li>
            ))}
            {data.unfiled && (
              <li>
                <CollectionCover
                  href="/collections/later"
                  name="Saved for later"
                  count={data.unfiled.item_count}
                  images={data.unfiled.cover}
                />
              </li>
            )}
          </ul>
        )
      )}
      <NewCollectionDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          router.push(`/collections/${id}`);
        }}
      />
    </div>
  );
}

function AnonymousSaves() {
  const { openSave } = useSave();
  const overrides = useItemOverrides();
  const [saved, setSaved] = useState<SavedEntry[] | null>(null);
  useEffect(() => {
    api
      .request('listSaved', { query: { limit: 24 } })
      .then((res) => setSaved(res.items))
      .catch(() => setSaved([]));
  }, []);
  const cards = applyOverrides(
    (saved ?? []).map((s) => s.item),
    overrides,
  );
  return (
    <>
      <div className="callout">
        <AccountPrompt lead="Create an account to keep collections." onCreated={() => undefined} />
      </div>
      {cards.length > 0 && (
        <section aria-labelledby="visit-saves">
          <h2 id="visit-saves" className="section-title section-title--display">
            Saved for this visit
          </h2>
          <CardGrid>
            {cards.map((card) => (
              <li key={card.id}>
                <DiscoveryCard
                  card={card}
                  href={`/items/${card.id}?from=later`}
                  onSave={(c, el) => openSave(cardToTarget(c), el)}
                />
              </li>
            ))}
          </CardGrid>
        </section>
      )}
    </>
  );
}

/** "Saved for later": unfiled saves (virtual; cannot be renamed or deleted). */
export function SavedForLaterView() {
  const { openSave } = useSave();
  const { isAccount, session } = useSession();
  const overrides = useItemOverrides();
  const [items, setItems] = useState<SavedEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (after?: string) => {
    try {
      const res = await api.request('listSaved', {
        query: { filter: 'unfiled', limit: 24, cursor: after },
      });
      setItems((prev) => (after && prev ? [...prev, ...res.items] : res.items));
      setCursor(res.next_cursor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your saves could not be loaded.');
    }
  }, []);

  useAsyncEffect(() => (session ? load() : undefined), [session, load]);

  const cards = applyOverrides(
    (items ?? []).map((s) => s.item),
    overrides,
  );
  return (
    <div className="page">
      <Link href="/collections" className="back-link">
        <Icon name="arrowLeft" />
        <span>Collections</span>
      </Link>
      <div className="page-head">
        <h1 className="display">Saved for later</h1>
      </div>
      {!isAccount && session && (
        <p className="muted">These saves last 24 hours unless you create an account.</p>
      )}
      {error && <PageError message={error} onRetry={() => void load()} />}
      {!items && !error && <SkeletonGrid count={4} />}
      {items && cards.length === 0 && (
        <EmptyState
          title="Nothing saved for later"
          actions={
            <Link href="/" className="button button--outline">
              Discover
            </Link>
          }
        >
          <p>Items you save without choosing a collection appear here.</p>
        </EmptyState>
      )}
      {cards.length > 0 && (
        <CardGrid label="Saved for later">
          {cards.map((card) => (
            <li key={card.id}>
              <DiscoveryCard
                card={card}
                href={`/items/${card.id}?from=later`}
                onSave={(c, el) => openSave(cardToTarget(c), el)}
              />
            </li>
          ))}
        </CardGrid>
      )}
      {cursor && (
        <div className="load-more">
          <button
            type="button"
            className="button button--outline"
            onClick={() => void load(cursor)}
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
