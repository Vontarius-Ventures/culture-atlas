'use client';

import { useId, useState } from 'react';
import type { DiscoveryCard as Card } from '@culture-atlas/domain/schemas';
import { api } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { CATEGORY_LABELS } from '@/lib/client/format';
import { cardToTarget, useSave } from '@/lib/client/save';
import { useSession } from '@/lib/client/session';
import { applyOverrides, getFeedCache, useItemOverrides } from '@/lib/client/store';
import { loadCapabilities } from '../v2/uploads-client';
import { DiscoveryCard } from '../DiscoveryCard';
import { Icon } from '../Icon';
import { COPY } from '../v2/copy';

export const WHILE_WE_LOOK_COUNT = 6;

interface Strip {
  cards: Card[];
  isExample: boolean;
}

/**
 * Reads the current FeedSnapshot only (GET /v1/discoveries consumes the
 * snapshot and never starts generation, FAST-04): the cached Discover page
 * when there is one, otherwise one small page. Never invents cards.
 */
async function loadStrip(readFlags: boolean): Promise<Strip> {
  // Kill switch (while_we_look_enabled): server evaluation is authoritative when it is
  // readable (signed-in accounts). Bounded: a slow read never holds the strip back.
  const caps = !readFlags
    ? null
    : await Promise.race([
        loadCapabilities().catch(() => null),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 4000)),
      ]);
  if (caps && caps.flags.while_we_look_enabled === false) return { cards: [], isExample: false };
  const cached = getFeedCache('all');
  if (cached && cached.items.length >= WHILE_WE_LOOK_COUNT)
    return { cards: cached.items.slice(0, WHILE_WE_LOOK_COUNT), isExample: cached.isExampleFeed };
  const res = await api.request('getDiscoveries', { query: { limit: WHILE_WE_LOOK_COUNT } });
  return { cards: res.items.slice(0, WHILE_WE_LOOK_COUNT), isExample: res.is_example_feed };
}

/**
 * Screen 16 · "While we look": 4-6 cards from the feed under the photo while
 * the reading runs. When the first result section lands (`collapsed`), it
 * collapses in place into a closed "More to explore" disclosure, so results
 * below do not jump. Cards keep the usual Save and detail behavior; anonymous
 * visitors see the labeled example feed ("Example result" on each card).
 */
export function WhileWeLook({ collapsed, from }: { collapsed: boolean; from: string }) {
  const [strip, setStrip] = useState<Strip | null>(null);
  const [open, setOpen] = useState(false);
  const overrides = useItemOverrides();
  const { openSave } = useSave();
  const { session, isAccount } = useSession();
  const sessionReady = session !== null;
  const titleId = useId();
  const stripId = useId();

  useAsyncEffect(async () => {
    if (!sessionReady) return;
    // If the kill switch is read only after the strip appeared, it still wins.
    if (isAccount)
      void loadCapabilities()
        .then((c) => {
          if (c.flags.while_we_look_enabled === false) setStrip({ cards: [], isExample: false });
        })
        .catch(() => undefined);
    try {
      setStrip(await loadStrip(isAccount));
    } catch {
      // The strip is a convenience: without it the processing state stays as before.
      setStrip({ cards: [], isExample: false });
    }
  }, [sessionReady, isAccount]);

  const cards = strip ? applyOverrides(strip.cards, overrides) : [];
  if (cards.length === 0) return null;
  const source = strip?.isExample ? null : COPY['while_we_look.source'];
  const list = (
    <ul
      className="while-strip"
      id={stripId}
      aria-label={source ?? COPY['while_we_look.title']}
      hidden={collapsed && !open}
    >
      {cards.map((card) => (
        <li key={card.id}>
          <DiscoveryCard
            card={card}
            href={`/items/${card.id}?from=${from}`}
            meta={card.category ? CATEGORY_LABELS[card.category] : undefined}
            onSave={(c, el) => openSave(cardToTarget(c), el)}
          />
        </li>
      ))}
    </ul>
  );

  return (
    <section
      className={`while${collapsed ? ' while--collapsed' : ''}`}
      aria-labelledby={collapsed ? undefined : titleId}
      aria-label={collapsed ? COPY['while_we_look.collapsed'] : undefined}
    >
      {collapsed ? (
        <button
          type="button"
          className="while-more"
          aria-expanded={open}
          aria-controls={stripId}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="while-more__thumbs" aria-hidden="true">
            {cards
              .slice(0, 4)
              .map((c) =>
                c.image ? (
                  <img key={c.id} src={c.image.url} alt="" />
                ) : (
                  <span key={c.id} className="while-more__blank" />
                ),
              )}
          </span>
          <span>
            <span className="while-more__label">{COPY['while_we_look.collapsed']}</span>{' '}
            {source && (
              <span className="while-more__count">
                <span className="while-more__dot">· </span>
                {cards.length} {source.toLowerCase()}
              </span>
            )}
          </span>
          <Icon name="chevronDown" />
        </button>
      ) : (
        <div className="while__head">
          <h2 className="while__title" id={titleId}>
            {COPY['while_we_look.title']}
          </h2>
          {source && <span className="while__source">{source}</span>}
        </div>
      )}
      {list}
    </section>
  );
}
