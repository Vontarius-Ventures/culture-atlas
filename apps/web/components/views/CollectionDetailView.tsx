'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useRef, useState } from 'react';
import type { CollectionFilter } from '@culture-atlas/domain';
import type {
  CollectionDetailResponse,
  CollectionMember,
  DiscoveryCard as Card,
  SavedEntry,
} from '@culture-atlas/domain/schemas';
import { api, ApiError, isApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import {
  COLLECTION_FILTER_LABELS,
  COLLECTION_FILTER_ORDER,
  pluralItems,
} from '@/lib/client/format';
import { UI_LIMITS } from '@/lib/client/limits';
import { useSession } from '@/lib/client/session';
import { applyOverrides, useItemOverrides } from '@/lib/client/store';
import { AccountPrompt } from '../AccountPrompt';
import { Dialog } from '../Dialog';
import { CardGrid, DiscoveryCard, SkeletonGrid, TextArt } from '../DiscoveryCard';
import { FilterRow } from '../FilterRow';
import { Icon } from '../Icon';
import { SelectionBar } from '../SelectionBar';
import { useToast } from '../Toast';
import { BackLink, EmptyState, MoreMenu, PageError } from '../ui';

const DIVERSITY_ORDER: Array<Card['kind'][]> = [
  ['capture'],
  ['film'],
  ['artist', 'track'],
  ['food'],
  ['style', 'brand'],
  ['reference'],
];

/** Suggests a diverse default selection (one of each kind first) of up to five items. */
export function defaultSelection(
  cards: readonly Card[],
  max: number = UI_LIMITS.planMaxItems,
): string[] {
  const picked: string[] = [];
  for (const kinds of DIVERSITY_ORDER) {
    const c = cards.find((x) => kinds.includes(x.kind) && !picked.includes(x.id));
    if (c) picked.push(c.id);
    if (picked.length >= max) return picked;
  }
  for (const c of cards) {
    if (picked.length >= max) break;
    if (!picked.includes(c.id)) picked.push(c.id);
  }
  return picked;
}

/** Moves one membership id earlier/later; returns a new full order. */
export function moveMembership(
  order: readonly string[],
  membershipId: string,
  delta: -1 | 1,
): string[] {
  const i = order.indexOf(membershipId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/**
 * Collection detail: mixed grid (three columns on desktop) with optional type
 * filters, explicit selection controls, the selection bar, "Make something",
 * rename/description, reorder, remove membership, add saved items and delete.
 */
export function CollectionDetailView({ collectionId }: { collectionId: string }) {
  const router = useRouter();
  const toast = useToast();
  const { session, isAccount } = useSession();
  const overrides = useItemOverrides();
  const [data, setData] = useState<CollectionDetailResponse | null>(null);
  const [members, setMembers] = useState<CollectionMember[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<CollectionFilter | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const makeButton = useRef<HTMLButtonElement>(null);

  const load = useCallback(
    async (f: CollectionFilter | null, after?: string) => {
      try {
        const res = await api.request('getCollection', {
          params: { id: collectionId },
          query: { filter: f ?? undefined, cursor: after, limit: 24 },
        });
        setData(res);
        setMembers((prev) => (after ? [...prev, ...res.items] : res.items));
        setCursor(res.next_cursor);
        setError(null);
        return res;
      } catch (err) {
        setError(err instanceof ApiError ? err : null);
        return null;
      }
    },
    [collectionId],
  );

  useAsyncEffect(() => (isAccount ? load(filter) : undefined), [isAccount, filter, load]);

  /** Reordering needs every membership exactly once. */
  const allMemberships = async (): Promise<CollectionMember[]> => {
    let list: CollectionMember[] = [];
    let after: string | undefined;
    do {
      const res = await api.request('getCollection', {
        params: { id: collectionId },
        query: { cursor: after, limit: 24 },
      });
      list = [...list, ...res.items];
      after = res.next_cursor ?? undefined;
    } while (after);
    return list;
  };

  if (session && !isAccount) {
    return (
      <div className="page">
        <BackLink href="/collections" label="Collections" />
        <div className="callout">
          <AccountPrompt
            lead="Create an account to keep collections."
            onCreated={() => undefined}
          />
        </div>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="page">
        <BackLink href="/collections" label="Collections" />
        <PageError
          message={error.status === 404 ? 'This collection isn’t available.' : error.message}
          onRetry={error.status === 404 ? undefined : () => void load(filter)}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page">
        <BackLink href="/collections" label="Collections" />
        <div className="skeleton skeleton--title" />
        <SkeletonGrid count={6} columns="three" />
      </div>
    );
  }

  const collection = data.collection;
  const cards = applyOverrides(
    members.map((m) => m.item),
    overrides,
  );
  const membershipFor = new Map(members.map((m) => [m.item.id, m]));
  const toggle = (card: Card) =>
    setSelected((prev) =>
      prev.includes(card.id)
        ? prev.filter((x) => x !== card.id)
        : prev.length >= UI_LIMITS.planMaxItems
          ? prev
          : [...prev, card.id],
    );

  const reorder = async (membershipId: string, delta: -1 | 1) => {
    try {
      const all = await allMemberships();
      const order = moveMembership(
        all.map((m) => m.membership_id),
        membershipId,
        delta,
      );
      await api.request('reorderCollection', {
        params: { id: collectionId },
        body: { expected_revision: collection.revision, membership_ids: order },
        idempotencyKey: newIdempotencyKey(),
      });
      await load(filter);
      toast.announce(delta < 0 ? 'Moved earlier' : 'Moved later');
    } catch (err) {
      if (isApiError(err, 'revision_conflict')) await load(filter);
      toast.show({
        message: err instanceof ApiError ? err.message : 'The order could not be changed.',
      });
    }
  };

  const removeMember = async (card: Card) => {
    try {
      await api.request('removeCollectionItem', {
        params: { id: collectionId, item_id: card.id },
        idempotencyKey: newIdempotencyKey(),
      });
      setSelected((s) => s.filter((x) => x !== card.id));
      await load(filter);
      toast.show({
        message: `Removed from ${collection.name}`,
        action: {
          label: 'Undo',
          onAction: async () => {
            await api.request('addCollectionItem', {
              params: { id: collectionId, item_id: card.id },
              body: {},
              idempotencyKey: newIdempotencyKey(),
            });
            await load(filter);
            toast.announce(`Added back to ${collection.name}`);
          },
        },
      });
    } catch (err) {
      toast.show({ message: err instanceof ApiError ? err.message : 'That didn’t work.' });
    }
  };

  const chooseMovieNight = () => {
    setTemplatesOpen(false);
    if (selected.length < UI_LIMITS.planMinItems) {
      const suggestion = defaultSelection(cards);
      setSelected(suggestion);
      toast.announce(
        `${suggestion.length} items selected for a movie night. Adjust the selection, then choose Make a movie night.`,
      );
    }
    window.setTimeout(() => makeButton.current?.focus(), 50);
  };

  const make = () => {
    router.push(`/collections/${collectionId}/make?items=${selected.join(',')}`);
  };

  const filterOptions = COLLECTION_FILTER_ORDER.filter((f) =>
    data.available_filters.includes(f),
  ).map((f) => ({ value: f, label: COLLECTION_FILTER_LABELS[f] }));
  const empty = collection.item_count === 0;

  return (
    <div className={`page collection-detail${selected.length ? ' has-selection' : ''}`}>
      <BackLink href="/collections" label="Collections" />
      <div className="page-head">
        <div>
          <h1 className="display">{collection.name}</h1>
          {collection.description && (
            <p className="page-head__description">{collection.description}</p>
          )}
        </div>
        <div className="page-head__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => setTemplatesOpen(true)}
            disabled={empty}
          >
            Make something
          </button>
          <MoreMenu
            label={`More options for ${collection.name}`}
            items={[
              { label: 'Rename or edit description', onSelect: () => setEditOpen(true) },
              { label: 'Add saved items', onSelect: () => setAddOpen(true) },
              { label: 'Delete collection', danger: true, onSelect: () => setDeleteOpen(true) },
            ]}
          />
        </div>
      </div>

      {empty ? (
        <EmptyState
          title="Nothing here yet"
          actions={
            <>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setAddOpen(true)}
              >
                Add saved items
              </button>
              <Link href="/" className="button button--outline">
                Discover
              </Link>
            </>
          }
        >
          <p>Add a few things you love. Select two or more to make a movie night.</p>
        </EmptyState>
      ) : (
        <>
          {filterOptions.length > 0 && (
            <FilterRow
              label="Filter this collection"
              options={filterOptions}
              value={filter}
              onChange={setFilter}
            />
          )}
          <CardGrid
            columns="three"
            label={`${collection.name}, ${pluralItems(collection.item_count)}`}
          >
            {cards.map((card, index) => {
              const m = membershipFor.get(card.id);
              return (
                <li key={card.id}>
                  <DiscoveryCard
                    card={card}
                    href={`/items/${card.id}?from=collection&collection=${collectionId}`}
                    selection={{
                      selected: selected.includes(card.id),
                      disabled: selected.length >= UI_LIMITS.planMaxItems,
                      onToggle: toggle,
                    }}
                    menu={
                      m && (
                        <MoreMenu
                          label={`More options for ${card.title}`}
                          items={[
                            ...(filter === null
                              ? [
                                  {
                                    label: 'Move earlier',
                                    disabled: index === 0,
                                    onSelect: () => void reorder(m.membership_id, -1),
                                  },
                                  {
                                    label: 'Move later',
                                    disabled: index === cards.length - 1 && !cursor,
                                    onSelect: () => void reorder(m.membership_id, 1),
                                  },
                                ]
                              : []),
                            {
                              label: 'Remove from collection',
                              danger: true,
                              onSelect: () => void removeMember(card),
                            },
                          ]}
                        />
                      )
                    }
                  />
                </li>
              );
            })}
          </CardGrid>
          {cursor && (
            <div className="load-more">
              <button
                type="button"
                className="button button--outline"
                onClick={() => void load(filter, cursor)}
              >
                Load more
              </button>
            </div>
          )}
        </>
      )}

      <SelectionBar
        ref={makeButton}
        count={selected.length}
        onMake={make}
        onClear={() => setSelected([])}
      />

      <Dialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        title="Make something"
        variant="sheet"
        size="small"
      >
        <ul className="templates">
          <li>
            <button type="button" className="template" onClick={chooseMovieNight} data-autofocus>
              <span className="template__name">Movie night</span>
              <span className="template__desc">
                A film, a few dishes, and music to settle into. Choose two to five items.
              </span>
              <Icon name="chevronRight" />
            </button>
          </li>
        </ul>
      </Dialog>

      <EditCollectionDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        collection={collection}
        onSaved={async () => {
          setEditOpen(false);
          await load(filter);
          toast.show({ message: 'Collection updated' });
        }}
        onConflict={() => void load(filter)}
      />

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete “${collection.name}”?`}
        variant="dialog"
        size="small"
      >
        <p>
          Items stay saved. Anything that isn’t in another collection moves to Saved for later.
          Plans made from it are kept.
        </p>
        <div className="form-actions">
          <button
            type="button"
            className="button button--danger"
            onClick={async () => {
              try {
                await api.request('deleteCollection', {
                  params: { id: collectionId },
                  idempotencyKey: newIdempotencyKey(),
                });
                setDeleteOpen(false);
                toast.show({ message: `Deleted ${collection.name}` });
                router.push('/collections');
              } catch (err) {
                toast.show({
                  message:
                    err instanceof ApiError ? err.message : 'The collection could not be deleted.',
                });
              }
            }}
          >
            Delete collection
          </button>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => setDeleteOpen(false)}
            data-autofocus
          >
            Keep it
          </button>
        </div>
      </Dialog>

      <AddSavedItemsDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        collectionId={collectionId}
        onAdded={async (n) => {
          setAddOpen(false);
          await load(filter);
          toast.show({ message: `Added ${pluralItems(n)} to ${collection.name}` });
        }}
      />
    </div>
  );
}

function EditCollectionDialog({
  open,
  onClose,
  collection,
  onSaved,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  collection: CollectionDetailResponse['collection'];
  onSaved: () => void;
  onConflict: () => void;
}) {
  const nameId = useId();
  const descId = useId();
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAsyncEffect(() => {
    if (open) {
      setName(collection.name);
      setDescription(collection.description ?? '');
      setError(null);
    }
  }, [open, collection.name, collection.description]);
  return (
    <Dialog open={open} onClose={onClose} title="Edit collection" variant="sheet" size="small">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.request('updateCollection', {
              params: { id: collection.id },
              body: {
                expected_revision: collection.revision,
                name: name.trim(),
                description: description.trim() || null,
              },
              idempotencyKey: newIdempotencyKey(),
            });
            onSaved();
          } catch (err) {
            if (isApiError(err, 'revision_conflict') || isApiError(err, 'conflict')) onConflict();
            setError(
              err instanceof ApiError ? err.message : 'The collection could not be updated.',
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
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </Dialog>
  );
}

function AddSavedItemsDialog({
  open,
  onClose,
  collectionId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  collectionId: string;
  onAdded: (n: number) => void;
}) {
  const [entries, setEntries] = useState<SavedEntry[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useAsyncEffect(() => {
    if (!open) return;
    setChosen([]);
    setError(null);
    api
      .request('listSaved', { query: { limit: 24 } })
      .then((res) => setEntries(res.items.filter((e) => !e.collection_ids.includes(collectionId))))
      .catch(() => setEntries([]));
  }, [open, collectionId]);
  return (
    <Dialog open={open} onClose={onClose} title="Add saved items" variant="sheet">
      {!entries && <p className="muted">Loading your saves…</p>}
      {entries && entries.length === 0 && (
        <p className="muted">Everything you’ve saved is already here. Save more from Discover.</p>
      )}
      {entries && entries.length > 0 && (
        <fieldset className="add-saved">
          <legend className="visually-hidden">Saved items</legend>
          {entries.map((e) => (
            <label key={e.saved_item_id} className="add-saved__row">
              <input
                type="checkbox"
                checked={chosen.includes(e.item.id)}
                onChange={(ev) =>
                  setChosen((c) =>
                    ev.target.checked ? [...c, e.item.id] : c.filter((x) => x !== e.item.id),
                  )
                }
              />
              {e.item.image ? (
                <img src={e.item.image.url} alt="" className="add-saved__thumb" />
              ) : (
                <span className="add-saved__thumb">
                  <TextArt card={e.item} />
                </span>
              )}
              <span>{e.item.title}</span>
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button button--primary button--block"
        disabled={busy || chosen.length === 0}
        onClick={async () => {
          setBusy(true);
          try {
            for (const itemId of chosen) {
              await api.request('addCollectionItem', {
                params: { id: collectionId, item_id: itemId },
                body: {},
                idempotencyKey: newIdempotencyKey(),
              });
            }
            onAdded(chosen.length);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Some items could not be added.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Adding…' : chosen.length ? `Add ${pluralItems(chosen.length)}` : 'Add'}
      </button>
    </Dialog>
  );
}
