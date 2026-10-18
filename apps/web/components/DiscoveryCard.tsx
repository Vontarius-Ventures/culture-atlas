'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
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
export function TextArt({ card }: { card: Pick<Card, 'title' | 'kind' | 'subtitle'> }) {
  return (
    <div className={`text-art text-art--${card.kind}`} aria-hidden="true">
      <span className="text-art__kind">{KIND_LABELS[card.kind]}</span>
      <span className="text-art__title">{card.title}</span>
      {card.subtitle && <span className="text-art__subtitle">{card.subtitle}</span>}
    </div>
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
        {card.image ? (
          <img
            src={card.image.url}
            alt=""
            width={card.image.width ?? undefined}
            height={card.image.height ?? undefined}
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
          />
        ) : (
          <TextArt card={card} />
        )}
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
      {meta && <p className="card__sub">{meta}</p>}
      {card.is_example && <p className="card__example">Example result</p>}
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
