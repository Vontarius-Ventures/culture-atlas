'use client';

import { useId, useState, type ReactNode } from 'react';
import type { DiscoveryIntents, VisualReferenceCard } from '@/lib/client/style';
import styles from './DiscoveryModes.module.css';

// Stable codes only; raw service errors are never consumer copy.
const REASONS: Record<string, string> = {
  not_configured: 'Visual comparison is not enabled right now.',
  catalog_unavailable: 'The reference image catalog is not available right now.',
  provider_unavailable: 'Visual comparison is not available right now.',
  asset_unavailable: 'A reference image was not available for comparison.',
  no_supported_subject: 'No clear, supported subject was available for visual comparison.',
  no_compatible_candidates: 'No suitable reference images were found for this subject.',
  no_visual_matches: 'No reference images passed the visual comparison.',
  comparison_failed: 'The visual comparison could not be completed.',
  comparison_timeout: 'The comparison did not finish in time.',
  stale_analysis: 'This comparison no longer belongs to the current photo reading.',
  cancelled: 'This visual comparison was cancelled.',
  comparison_limit: 'The visual comparison limit was reached.',
};

function VisualCard({ card }: { card: VisualReferenceCard }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <article className={styles.card}>
      <figure className={styles.figure}>
        {imageFailed ? (
          <p className={styles.imageFallback}>Reference image unavailable</p>
        ) : (
          <img
            className={styles.image}
            src={card.image.url}
            alt={card.image.alt}
            loading="lazy"
            onError={() => setImageFailed(true)}
          />
        )}
        {card.credit && (
          <figcaption className={styles.credit}>
            <p>{card.credit.attribution}</p>
            <a href={card.credit.license_url} target="_blank" rel="noopener noreferrer">
              {card.credit.license}
              <span className="visually-hidden"> (opens in a new tab)</span>
            </a>
            <p>Changes: {card.credit.changes}</p>
          </figcaption>
        )}
      </figure>
      <h3>{card.title}</h3>
      <p>
        {card.object_type} · {card.institution}
      </p>
      <p className={styles.badge}>Model-suggested · Experimental</p>
      <p>{card.explanation}</p>
      <p className="muted">{card.limitations}</p>
      <a href={card.source_url} target="_blank" rel="noopener noreferrer">
        View at {card.institution} <span className="visually-hidden">(opens in a new tab)</span>
      </a>
    </article>
  );
}

export function VisualReferences({
  visual,
  timedOut = false,
  pollingError = false,
}: {
  visual: DiscoveryIntents['visual'] | null;
  timedOut?: boolean;
  pollingError?: boolean;
}) {
  const status = visual?.status ?? 'unavailable';
  const active = status === 'pending' || status === 'running';
  const cards = status === 'ready' ? (visual?.cards ?? []) : [];
  const reasonCopy =
    visual?.reason && Object.hasOwn(REASONS, visual.reason) ? REASONS[visual.reason] : null;
  const message =
    active && timedOut
      ? 'Visual references are taking longer than expected. We stopped checking; their result is not known yet. Reopen this photo later to check again.'
      : active && pollingError
        ? 'We could not check visual reference progress. Your photo reading is still available.'
        : status === 'pending'
          ? 'Visual references are waiting for comparison.'
          : status === 'running'
            ? 'Comparing reference images…'
            : status === 'failed'
              ? 'We could not complete the visual comparison. Your connections are still available.'
              : status === 'empty'
                ? 'No reference images passed the visual comparison for this photo.'
                : status === 'ready' && cards.length === 0
                  ? 'No displayable reference images are available. A complete image, required credit, and comparison are needed.'
                  : status === 'unavailable'
                    ? 'Visual references are not available for this photo. Connections are still available.'
                    : null;
  return (
    <section aria-label="Visual references">
      <h2 className="section-title">Visual references</h2>
      <p>
        Experimental, model-suggested comparisons to attributed reference images—not authentication,
        maker attribution, or items available to buy.
      </p>
      {message && (
        <div role="status">
          <p>{message}</p>
          {!active && reasonCopy && <p>{reasonCopy}</p>}
        </div>
      )}
      {cards.length > 0 && (
        <ul className={styles.cards} aria-label="Attributed reference images">
          {cards.map((card) => (
            <li key={`${card.subject_id}:${card.catalog_id}:${card.id}`}>
              <VisualCard card={card} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Native buttons support Tab, Space and Enter without inventing tab/list roles.
 * Both modes use the same capture data; selecting a mode never makes a request.
 */
export function DiscoveryModes({
  children,
  visual,
  timedOut,
  pollingError,
  onModeChange,
}: {
  children: ReactNode;
  visual: DiscoveryIntents['visual'] | null;
  timedOut: boolean;
  pollingError: boolean;
  onModeChange?: (mode: 'connections' | 'visual') => void;
}) {
  const [mode, setMode] = useState<'connections' | 'visual'>('connections');
  const select = (next: 'connections' | 'visual') => {
    setMode(next);
    onModeChange?.(next);
  };
  const id = useId();
  return (
    <div className={styles.modes}>
      <div className={styles.controls} role="group" aria-label="Discovery mode">
        <button
          type="button"
          className="button button--outline"
          aria-pressed={mode === 'connections'}
          aria-controls={`${id}-connections`}
          onClick={() => select('connections')}
        >
          Connections
        </button>
        <button
          type="button"
          className="button button--outline"
          aria-pressed={mode === 'visual'}
          aria-controls={`${id}-visual`}
          onClick={() => select('visual')}
        >
          Visual references
        </button>
      </div>
      <div id={`${id}-connections`} hidden={mode !== 'connections'}>
        {children}
      </div>
      <div id={`${id}-visual`} hidden={mode !== 'visual'}>
        <VisualReferences visual={visual} timedOut={timedOut} pollingError={pollingError} />
      </div>
    </div>
  );
}
