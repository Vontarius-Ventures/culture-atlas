'use client';

import Link from 'next/link';
import { useCallback, useState, type ReactNode } from 'react';
import type { DiscoveryCard as Card } from '@culture-atlas/domain/schemas';
import { KIND_LABELS } from '@/lib/client/format';
import { Icon } from './Icon';

export interface DiscoveryCardProps {
  card: Card;
  href: string;
  /** Save button over the photo (feed, results, related). */
  onSave?: (card: Card, trigger: HTMLButtonElement) => void;
  /** Explicit selection control (collection detail) instead of Save. */
  selection?: { selected: boolean; disabled?: boolean; onToggle: (card: Card) => void };
  /** Item menu shown beside the title (e.g. Move / Remove in a collection). */
  menu?: ReactNode;
  aspect?: 'square' | 'portrait';
  /** Eager-load images above the fold. */
  priority?: boolean;
  /** Title overlay styles are never used; titles always sit beneath the image. */
  headingLevel?: 'h2' | 'h3';
  /** Optional quiet line under the title (e.g. the category in the "While we look" strip). */
  meta?: string;
}

/** Attractive text treatment when no licensed image is available. */
export function TextArt({
  card,
  inCard,
}: {
  card: Pick<Card, 'title' | 'kind' | 'subtitle'>;
  /** Inside a DiscoveryCard the kind is already printed under the tile: never say it twice. */
  inCard?: boolean;
}) {
  const kind = KIND_LABELS[card.kind];
  const norm = (v: string) => v.trim().toLowerCase();
  const subtitle =
    card.subtitle && norm(card.subtitle) !== norm(card.title) && norm(card.subtitle) !== norm(kind)
      ? card.subtitle
      : null;
  return (
    <div className={`text-art text-art--${card.kind}`} aria-hidden="true">
      {!inCard && <span className="text-art__kind">{kind}</span>}
      <span className="text-art__title">{card.title}</span>
      {subtitle && <span className="text-art__subtitle">{subtitle}</span>}
    </div>
  );
}

/**
 * A card picture that never sits blank: a category-tinted poster (kind and a
 * soft sheen) holds the space while the image downloads, then the image fades
 * in. A failed image falls back to the text treatment. Brand pictures are
 * mostly logos and wordmarks, so they sit padded on a light tile instead of
 * being cropped edge to edge. Reduce Motion: no sheen, no fade.
 */
export function CardImage({
  card,
  priority,
}: {
  card: Pick<Card, 'title' | 'kind' | 'subtitle' | 'image'>;
  priority?: boolean;
}) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  // An image served from cache can finish before React attaches onLoad.
  const ref = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setState('loaded');
  }, []);
  if (!card.image || state === 'failed') return <TextArt card={card} inCard />;
  const logo = card.kind === 'brand';
  return (
    <>
      {state !== 'loaded' && (
        <div className={`card-poster card-poster--${card.kind}`} aria-hidden="true">
          <span className="card-poster__kind">{KIND_LABELS[card.kind]}</span>
        </div>
      )}
      <img
        ref={ref}
        src={card.image.url}
        alt=""
        width={card.image.width ?? undefined}
        height={card.image.height ?? undefined}
        loading={priority ? 'eager' : 'lazy'}
        decoding="async"
        className={`card-img${logo ? ' card-img--logo' : ''}${state === 'loaded' ? ' is-loaded' : ''}`}
        onLoad={() => setState('loaded')}
        onError={() => setState('failed')}
      />
    </>
  );
}

/**
 * DiscoveryCard: image with the title immediately below and no card shell.
 * Save sits at the upper right on a solid ivory surface (contrast independent
 * of the photo). Titles clamp to two lines. Sample/replayed results carry the
 * "Example result" label.
 */
export function DiscoveryCard({
  card,
  href,
  onSave,
  selection,
  menu,
  aspect = 'square',
  priority,
  headingLevel = 'h3',
  meta,
}: DiscoveryCardProps) {
  const Heading = headingLevel;
  const selected = selection?.selected ?? false;
  return (
    <article className={`card${selected ? ' card--selected' : ''}`}>
      <div className={`card__media card__media--${aspect}`}>
        <CardImage card={card} priority={priority} />
        {selected && <span className="card__selected-ring" aria-hidden="true" />}
      </div>
      <div className="card__meta">
        <Heading className="card__title">
          <Link href={href} className="card__link">
            {card.title}
          </Link>
        </Heading>
        {menu && <div className="card__menu">{menu}</div>}
      </div>
      {/* Every card names its type, so photos, posters and logos read as one feed. */}
      <p className="card__sub">
        <span>{meta ?? KIND_LABELS[card.kind]}</span>
        {card.is_example && <span className="card__example">Example result</span>}
      </p>
      {onSave && (
        <button
          type="button"
          className={`save-chip${card.saved ? ' save-chip--saved' : ''}`}
          aria-label={`${card.saved ? 'Saved' : 'Save'} ${card.title}`}
          onClick={(e) => onSave(card, e.currentTarget)}
        >
          <span className="save-chip__surface">
            <Icon name={card.saved ? 'bookmarkFilled' : 'bookmark'} size={16} />
            <span>{card.saved ? 'Saved' : 'Save'}</span>
          </span>
        </button>
      )}
      {selection && (
        <label className={`select-control${selected ? ' select-control--on' : ''}`}>
          <input
            type="checkbox"
            className="overlay-input"
            checked={selected}
            disabled={selection.disabled && !selected}
            onChange={() => selection.onToggle(card)}
            aria-label={`Select ${card.title}`}
          />
          <span className="select-control__dot" aria-hidden="true">
            {selected && <Icon name="check" size={16} />}
          </span>
        </label>
      )}
    </article>
  );
}

export function CardGrid({
  children,
  columns = 'feed',
  label,
}: {
  children: ReactNode;
  columns?: 'feed' | 'three' | 'related';
  label?: string;
}) {
  return (
    <ul className={`grid grid--${columns}`} aria-label={label}>
      {children}
    </ul>
  );
}

export function SkeletonGrid({
  count = 6,
  columns = 'feed',
}: {
  count?: number;
  columns?: 'feed' | 'three' | 'related';
}) {
  return (
    <ul className={`grid grid--${columns}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="skeleton-card">
          <div className="skeleton skeleton--media" />
          <div className="skeleton skeleton--line" />
        </li>
      ))}
    </ul>
  );
}
