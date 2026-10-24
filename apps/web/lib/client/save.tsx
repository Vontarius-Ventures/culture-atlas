'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { DiscoveryCard } from '@culture-atlas/domain/schemas';
import { AccountPrompt } from '@/components/AccountPrompt';
import { Dialog } from '@/components/Dialog';
import { SavePicker, type Destination, type SaveTarget } from '@/components/SavePicker';
import { useToast } from '@/components/Toast';
import { api, newIdempotencyKey } from './api';
import { useSession } from './session';
import { setItemOverride, setLastDestination } from './store';

interface SaveContextValue {
  /** Opens the save picker (or the account prompt for anonymous visitors). */
  openSave: (target: SaveTarget, trigger: HTMLElement | null) => void;
  /** Opens a standalone account prompt; resolves true when an account was created. */
  requireAccount: (lead?: string) => Promise<boolean>;
  /** Hide an item from the feed and related results, with Undo. */
  hide: (itemId: string, title: string) => Promise<void>;
}

const SaveContext = createContext<SaveContextValue | null>(null);

export function cardToTarget(card: DiscoveryCard): SaveTarget {
  return { itemId: card.id, title: card.title, image: card.image, saved: card.saved };
}

/**
 * Save orchestration shared by every surface:
 *  - collection: PUT /v1/collections/{id}/items/{item_id} (saves the item if needed);
 *  - Save for later: POST /v1/preferences {action: save} (unfiled);
 *  - New collection: POST /v1/collections, then add;
 *  - Undo reverses exactly what this save did (membership, and the SavedItem if it was created);
 *  - anonymous visitors are offered account creation, which claims the session and the
 *    intended save (the service refuses anonymous saves with 403 account_required).
 */
export function SaveProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const { isAccount } = useSession();
  const [target, setTarget] = useState<SaveTarget | null>(null);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const [accountAsk, setAccountAsk] = useState<{
    lead?: string;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const close = useCallback(() => setTarget(null), []);

  const preference = useCallback(
    (action: 'save' | 'remove' | 'hide' | 'unhide', t: { itemId: string; captureId?: string }) =>
      api.request('recordPreference', {
        body: {
          action,
          target_type: t.captureId ? 'capture' : 'discovery_item',
          target_id: t.captureId ?? t.itemId,
        },
        idempotencyKey: newIdempotencyKey(),
      }),
    [],
  );

  const onSave = useCallback(
    async (destination: Destination) => {
      const t = target;
      if (!t) return;
      if (destination.kind === 'later') {
        const res = await preference('save', t);
        setItemOverride(t.itemId, { saved: true, saved_item_id: res.saved_item?.id ?? null });
        setLastDestination('later');
        setTarget(null);
        toast.show({
          message: 'Saved for later',
          link: { href: '/collections/later', label: 'View' },
          action: {
            label: 'Undo',
            onAction: async () => {
              if (res.undo) {
                await api.request('recordPreference', {
                  body: res.undo,
                  idempotencyKey: newIdempotencyKey(),
                });
                setItemOverride(t.itemId, { saved: t.saved });
              }
              toast.announce('Save undone');
            },
          },
        });
        return;
      }
      let collection = destination.kind === 'collection' ? destination.collection : null;
      if (destination.kind === 'new') {
        const created = await api.request('createCollection', {
          body: { name: destination.name },
          idempotencyKey: newIdempotencyKey(),
        });
        collection = { id: created.id, name: created.name };
      }
      if (!collection) return;
      const res = await api.request('addCollectionItem', {
        params: { id: collection.id, item_id: t.itemId },
        body: {},
        idempotencyKey: newIdempotencyKey(),
      });
      setItemOverride(t.itemId, { saved: true, saved_item_id: res.saved_item_id });
      setLastDestination(collection.id);
      setTarget(null);
      const name = collection.name;
      const collectionId = collection.id;
      toast.show({
        message: res.created ? `Saved to ${name}` : `Already in ${name}`,
        link: { href: `/collections/${collectionId}`, label: 'View' },
        action: res.created
          ? {
              label: 'Undo',
              onAction: async () => {
                await api.request('removeCollectionItem', {
                  params: { id: collectionId, item_id: t.itemId },
                  idempotencyKey: newIdempotencyKey(),
                });
                if (res.saved) {
                  await preference('remove', t);
                  setItemOverride(t.itemId, { saved: false, saved_item_id: null });
                }
                toast.announce(`Removed from ${name}`);
              },
            }
          : undefined,
      });
    },
    [target, preference, toast],
  );

  const onUnsave = useCallback(async () => {
    const t = target;
    if (!t) return;
    const res = await preference('remove', t);
    setItemOverride(t.itemId, { saved: false, saved_item_id: null });
    setTarget(null);
    toast.show({
      message: 'Removed from your saves',
      action: res.undo
        ? {
            label: 'Undo',
            onAction: async () => {
              const again = await api.request('recordPreference', {
                body: res.undo!,
                idempotencyKey: newIdempotencyKey(),
              });
              setItemOverride(t.itemId, {
                saved: true,
                saved_item_id: again.saved_item?.id ?? null,
              });
              toast.announce('Saved again');
            },
          }
        : undefined,
    });
  }, [target, preference, toast]);

  const onAccountCreated = useCallback(() => {
    const t = target;
    if (t) {
      // The pending save was claimed with the account (unfiled); keep the picker open to file it.
      setItemOverride(t.itemId, { saved: true });
      setTarget({ ...t, saved: true });
    }
    toast.show({
      message: 'Account created. Saved for later — you can add it to a collection now.',
    });
  }, [target, toast]);

  const openSave = useCallback((t: SaveTarget, el: HTMLElement | null) => {
    setTrigger(el);
    setTarget(t);
  }, []);

  const requireAccount = useCallback(
    (lead?: string) => new Promise<boolean>((resolve) => setAccountAsk({ lead, resolve })),
    [],
  );

  const hide = useCallback(
    async (itemId: string, title: string) => {
      const res = await preference('hide', { itemId });
      setItemOverride(itemId, { hidden: true });
      toast.show({
        message: `Hidden “${title}”`,
        action: res.undo
          ? {
              label: 'Undo',
              onAction: async () => {
                await api.request('recordPreference', {
                  body: res.undo!,
                  idempotencyKey: newIdempotencyKey(),
                });
                setItemOverride(itemId, { hidden: false });
                toast.announce('Shown again');
              },
            }
          : undefined,
      });
    },
    [preference, toast],
  );

  const value = useMemo(
    () => ({ openSave, requireAccount, hide }),
    [openSave, requireAccount, hide],
  );

  return (
    <SaveContext.Provider value={value}>
      {children}
      <SavePicker
        open={target !== null}
        target={target}
        isAccount={isAccount}
        returnFocus={trigger}
        onClose={close}
        onSave={onSave}
        onUnsave={onUnsave}
        onAccountCreated={onAccountCreated}
      />
      <Dialog
        open={accountAsk !== null}
        title="Create an account"
        variant="sheet"
        onClose={() => {
          accountAsk?.resolve(false);
          setAccountAsk(null);
        }}
      >
        {accountAsk && (
          <AccountPrompt
            lead={accountAsk.lead}
            onCreated={() => {
              accountAsk.resolve(true);
              setAccountAsk(null);
              toast.show({ message: 'Account created' });
            }}
          />
        )}
      </Dialog>
    </SaveContext.Provider>
  );
}

export function useSave(): SaveContextValue {
  const ctx = useContext(SaveContext);
  if (!ctx) throw new Error('useSave must be used inside SaveProvider');
  return ctx;
}
