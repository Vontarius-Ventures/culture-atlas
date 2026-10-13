'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CollectionSummary,
  CollectionsListResponse,
  Image,
} from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { UI_LIMITS } from '@/lib/client/limits';
import { getLastDestination } from '@/lib/client/store';
import { AccountPrompt } from './AccountPrompt';
import { CoverMosaic } from './CollectionCover';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export interface SaveTarget {
  /** DiscoveryItem id (for a capture: the capture's own discovery item). */
  itemId: string;
  /** Set when saving a whole capture ("Save this inspiration"). */
  captureId?: string;
  title: string;
  image: Image | null;
  saved: boolean;
}

export type Destination =
  | { kind: 'later' }
  | { kind: 'collection'; collection: Pick<CollectionSummary, 'id' | 'name'> }
  | { kind: 'new'; name: string };

export interface SavePickerProps {
  open: boolean;
  target: SaveTarget | null;
  isAccount: boolean;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onSave: (destination: Destination) => Promise<void>;
  onUnsave: () => Promise<void>;
  onAccountCreated: () => void;
}

const LATER = 'later';
const NEW = 'new';

/** Orders collections most-recently-updated first (recent rows at the top). */
export function recentFirst(list: readonly CollectionSummary[]): CollectionSummary[] {
  return [...list].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

/** Initial target: remembered last destination when it still exists, else the most recent collection, else Save for later. */
export function initialDestination(
  collections: readonly CollectionSummary[],
  remembered: string | null,
): string {
  if (remembered === LATER) return LATER;
  if (remembered && collections.some((c) => c.id === remembered)) return remembered;
  return collections[0]?.id ?? LATER;
}

/**
 * SavePicker: focused dialog on desktop, bottom sheet on mobile. Recent
 * collection rows, New collection (name input in the same surface), Save for
 * later and Save. The current target is a checked radio row.
 */
export function SavePicker(props: SavePickerProps) {
  const { open, target, isAccount, returnFocus, onClose } = props;
  return (
    <Dialog
      open={open && target !== null}
      onClose={onClose}
      title="Save to a collection"
      returnFocus={returnFocus}
      variant="sheet"
    >
      {target &&
        (isAccount ? (
          <PickerBody key={target.itemId} {...props} target={target} />
        ) : (
          <AnonymousBody {...props} target={target} />
        ))}
    </Dialog>
  );
}

function TargetThumb({ target }: { target: SaveTarget }) {
  return (
    <div className="picker__item">
      {target.image ? (
        <img src={target.image.url} alt="" className="picker__thumb" />
      ) : (
        <div className="picker__thumb picker__thumb--text" aria-hidden="true" />
      )}
      <p className="picker__item-title">{target.title}</p>
    </div>
  );
}

/**
 * Visitors cannot save without an account (the service answers 403
 * account_required), so the only path is account creation, which claims the
 * session and carries the intended save along.
 */
function AnonymousBody({ target, onAccountCreated }: SavePickerProps & { target: SaveTarget }) {
  return (
    <div className="picker">
      <TargetThumb target={target} />
      <AccountPrompt
        compact
        lead="Create an account to keep this and build private collections."
        pendingSave={{
          target_type: target.captureId ? 'capture' : 'discovery_item',
          target_id: target.captureId ?? target.itemId,
        }}
        onCreated={onAccountCreated}
      />
    </div>
  );
}

function PickerBody({ target, onSave, onUnsave }: SavePickerProps & { target: SaveTarget }) {
  const [data, setData] = useState<CollectionsListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupName = useId();
  const newNameId = useId();
  const options = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .request('listCollections', {})
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setChoice(
          (c) => c ?? initialDestination(recentFirst(res.collections), getLastDestination()),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : 'Collections could not be loaded.');
        setChoice((c) => c ?? LATER);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once rows exist, move focus from Close to the current target (only once, and not if the user moved it).
  const focusedTarget = useRef(false);
  useEffect(() => {
    if (focusedTarget.current || choice === null || (!data && !loadError) || !options.current)
      return;
    focusedTarget.current = true;
    const active = document.activeElement;
    if (active && options.current.contains(active)) return;
    options.current.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, [choice, data, loadError]);

  const collections = useMemo(() => recentFirst(data?.collections ?? []), [data]);
  const trimmed = newName.trim();
  const canSave =
    choice !== null &&
    !busy &&
    (choice !== NEW || (trimmed.length > 0 && trimmed.length <= UI_LIMITS.collectionNameMax));

  const submit = async () => {
    if (!canSave || choice === null) return;
    setBusy(true);
    setError(null);
    try {
      if (choice === LATER) await onSave({ kind: 'later' });
      else if (choice === NEW) await onSave({ kind: 'new', name: trimmed });
      else {
        const c = collections.find((x) => x.id === choice);
        if (c) await onSave({ kind: 'collection', collection: c });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t save. Try again.');
      setBusy(false);
    }
  };

  return (
    <form
      className="picker"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <TargetThumb target={target} />
      <fieldset className="picker__options" ref={options}>
        <legend className="visually-hidden">Destination</legend>
        {!data && !loadError && <p className="picker__loading">Loading your collections…</p>}
        {loadError && <p className="form-error">{loadError}</p>}
        {collections.map((c) => (
          <label key={c.id} className={`picker-row${choice === c.id ? ' picker-row--on' : ''}`}>
            <input
              type="radio"
              name={groupName}
              value={c.id}
              checked={choice === c.id}
              onChange={() => setChoice(c.id)}
              className="visually-hidden"
              data-autofocus={choice === c.id ? true : undefined}
            />
            <CoverMosaic images={c.cover} size="mini" />
            <span className="picker-row__name">{c.name}</span>
            <span className="picker-row__mark" aria-hidden="true">
              {choice === c.id ? (
                <span className="check-dot">
                  <Icon name="check" size={16} />
                </span>
              ) : (
                <Icon name="chevronRight" />
              )}
            </span>
          </label>
        ))}
        <label
          className={`picker-row picker-row--action${choice === NEW ? ' picker-row--on' : ''}`}
        >
          <input
            type="radio"
            name={groupName}
            value={NEW}
            checked={choice === NEW}
            onChange={() => setChoice(NEW)}
            className="visually-hidden"
          />
          <span className="picker-row__icon" aria-hidden="true">
            <Icon name="plus" size={24} />
          </span>
          <span className="picker-row__name picker-row__name--ui">New collection</span>
          <span className="picker-row__mark" aria-hidden="true">
            {choice === NEW ? (
              <span className="check-dot">
                <Icon name="check" size={16} />
              </span>
            ) : (
              <Icon name="chevronRight" />
            )}
          </span>
        </label>
        {choice === NEW && (
          <div className="picker__new">
            <label htmlFor={newNameId} className="field-label">
              Collection name
            </label>
            <input
              id={newNameId}
              className="input"
              value={newName}
              maxLength={UI_LIMITS.collectionNameMax}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Slow Sunday"
              autoFocus
              required
            />
          </div>
        )}
        <label
          className={`picker-row picker-row--action${choice === LATER ? ' picker-row--on' : ''}`}
        >
          <input
            type="radio"
            name={groupName}
            value={LATER}
            checked={choice === LATER}
            onChange={() => setChoice(LATER)}
            className="visually-hidden"
            data-autofocus={choice === LATER ? true : undefined}
          />
          <span className="picker-row__icon" aria-hidden="true">
            <Icon name="bookmark" size={24} />
          </span>
          <span className="picker-row__name picker-row__name--ui">Save for later</span>
          <span className="picker-row__mark" aria-hidden="true">
            {choice === LATER ? (
              <span className="check-dot">
                <Icon name="check" size={16} />
              </span>
            ) : (
              <Icon name="chevronRight" />
            )}
          </span>
        </label>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="button button--primary button--block" disabled={!canSave}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      {target.saved && (
        <button
          type="button"
          className="button button--text picker__unsave"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onUnsave();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'That didn’t work. Try again.');
              setBusy(false);
            }
          }}
        >
          Unsave everywhere
        </button>
      )}
    </form>
  );
}
