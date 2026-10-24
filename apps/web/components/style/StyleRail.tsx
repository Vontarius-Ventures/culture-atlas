'use client';

import { forwardRef } from 'react';
import { DiscoveryCard } from '../DiscoveryCard';
import {
  isActiveStatus,
  needsCity,
  railEmptyMessage,
  STYLE_COPY,
  type Rail,
  type StyledCard,
} from '@/lib/client/style';

/**
 * "More like this" rail (F.1 §3): serif title with the attributes that drove
 * it, up to 8 cards (a grid on desktop, a horizontal scroller on mobile), each
 * with the server's reason under its title. Running: three placeholder cards.
 * Empty: one honest line, never sample cards.
 */
export const StyleRail = forwardRef<
  HTMLElement,
  {
    rail: Rail;
    cards: StyledCard[];
    captureId: string;
    caption: string | null;
    pulse: boolean;
    onSave: (card: StyledCard, el: HTMLButtonElement) => void;
    onAddCity: () => void;
  }
>(function StyleRail({ rail, cards, captureId, caption, pulse, onSave, onAddCity }, ref) {
  const headingId = `rail-${rail.key.replace(/[^a-z0-9_-]/gi, '-')}`;
  const running = isActiveStatus(rail.status);
  const empty = railEmptyMessage({ ...rail, cards });
  return (
    <section
      ref={ref}
      className={`style-rail${pulse ? ' style-rail--pulse' : ''}`}
      aria-labelledby={headingId}
      data-rail={rail.key}
      tabIndex={-1}
    >
      <header className="style-rail__head">
        <h2 id={headingId} className="style-rail__title">
          {rail.title}
        </h2>
        {rail.subtitle && <p className="style-rail__subtitle">{rail.subtitle}</p>}
        {caption && <p className="style-rail__caption">{caption}</p>}
      </header>
      {cards.length > 0 && (
        <ul className="style-rail__cards" aria-label={`${rail.title}: ${rail.subtitle ?? 'suggestions'}`}>
          {cards.slice(0, 8).map((card) => (
            <li key={card.id} className="style-rail__card">
              <DiscoveryCard
                card={card}
                reason={card.reason ?? undefined}
                href={`/items/${card.id}?from=capture&capture=${captureId}${
                  card.recommendation_id ? `&rec=${card.recommendation_id}` : ''
                }`}
                onSave={(c, el) => onSave(c as StyledCard, el)}
              />
            </li>
          ))}
        </ul>
      )}
      {running && (
        <>
          {cards.length === 0 && (
            <ul className="style-rail__cards" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="style-rail__card skeleton-card">
                  <div className="skeleton skeleton--media" />
                  <div className="skeleton skeleton--line" />
                </li>
              ))}
            </ul>
          )}
          <p className="style-rail__status" role="status">
            {STYLE_COPY['style.rail_running']}
          </p>
        </>
      )}
      {empty && (
        <div className="style-rail__empty" role="status">
          <p>{empty}</p>
          {needsCity(empty) && (
            <button type="button" className="button button--outline button--small" onClick={onAddCity}>
              {STYLE_COPY['style.add_city']}
            </button>
          )}
        </div>
      )}
    </section>
  );
});
