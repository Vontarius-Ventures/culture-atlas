'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { AestheticChip } from './AestheticChip';
import { ExperimentalNote } from './ExperimentalNote';
import { PaletteSkeleton, PaletteSwatches } from './PaletteSwatches';
import type { ActiveRegion } from './RegionHighlight';
import {
  claimText,
  detailRows,
  isRetracted,
  moodLine,
  paletteWithShare,
  qlooLinksLine,
  STYLE_COPY,
  visibleSubjects,
  type ExperimentalLabel,
  type StyleCardState,
  type StyleReading,
  type StyleRegion,
} from '@/lib/client/style';

const FIRST_DETAIL_ROWS = 3;

/**
 * "Style reading" card (F.1 §2), directly under the title and interpretation.
 * Renders server strings verbatim; never phrases a claim itself.
 */
export function StyleReadingCard({
  state,
  experimental,
  active,
  onHighlight,
  onFlashSubject,
  onMoreLikeThis,
  railSubjects,
  onRetry,
  retrying,
  retryUsed,
  onAnnounce,
}: {
  state: StyleCardState;
  experimental: ExperimentalLabel | null;
  active: ActiveRegion | null;
  onHighlight: (next: ActiveRegion | null) => void;
  onFlashSubject: (region: StyleRegion, label: string) => void;
  onMoreLikeThis: (subjectId: string) => void;
  /** Subject ids that have a More-like-this rail on the page. */
  railSubjects: ReadonlySet<string>;
  onRetry: () => void;
  retrying: boolean;
  retryUsed: boolean;
  onAnnounce: (message: string) => void;
}) {
  const headingId = useId();
  if (state.kind === 'none') return null;
  const header = (
    <div className="style-card__head">
      <h2 id={headingId} className="style-card__title">
        {STYLE_COPY['style.title']}
      </h2>
      {experimental && <ExperimentalNote label={experimental.label} note={experimental.note} />}
    </div>
  );

  if (state.kind === 'loading')
    return (
      <section className="style-card" aria-labelledby={headingId} aria-busy="true">
        {header}
        <div className="style-card__skeleton" aria-hidden="true">
          <span className="style-skeleton-pill" />
          <span className="style-skeleton-pill" />
          <span className="style-skeleton-pill" />
        </div>
        <PaletteSkeleton />
        <p className="style-card__caption" role="status">
          {STYLE_COPY['style.reading']}
        </p>
      </section>
    );

  if (state.kind !== 'ready') {
    const message =
      state.kind === 'empty'
        ? STYLE_COPY['style.empty']
        : state.kind === 'failed'
          ? STYLE_COPY['style.failed']
          : state.kind === 'paused'
            ? STYLE_COPY['style.paused']
            : STYLE_COPY['style.limit'];
    return (
      <section className="style-card style-card--quiet" aria-labelledby={headingId}>
        {header}
        <div className="style-card__message" role="status">
          <p>{message}</p>
          {state.kind === 'failed' && !retryUsed && (
            <button
              type="button"
              className="button button--outline button--small"
              onClick={onRetry}
              disabled={retrying}
            >
              <Icon name="refresh" size={16} />
              <span>{STYLE_COPY['style.try_again']}</span>
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="style-card" aria-labelledby={headingId} data-testid="style-reading">
      {header}
      <ReadingBody
        reading={state.reading}
        active={active}
        onHighlight={onHighlight}
        onFlashSubject={onFlashSubject}
        onMoreLikeThis={onMoreLikeThis}
        railSubjects={railSubjects}
        onAnnounce={onAnnounce}
      />
    </section>
  );
}

function ReadingBody({
  reading,
  active,
  onHighlight,
  onFlashSubject,
  onMoreLikeThis,
  railSubjects,
  onAnnounce,
}: {
  reading: StyleReading;
  active: ActiveRegion | null;
  onHighlight: (next: ActiveRegion | null) => void;
  onFlashSubject: (region: StyleRegion, label: string) => void;
  onMoreLikeThis: (subjectId: string) => void;
  railSubjects: ReadonlySet<string>;
  onAnnounce: (message: string) => void;
}) {
  const subjects = visibleSubjects(reading);
  const [selected, setSelected] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const subjectIndex = Math.min(selected, Math.max(0, subjects.length - 1));
  const subject = subjects[subjectIndex];
  const readingIndex = subject ? reading.subjects.indexOf(subject) : 0;

  // Retracted claims fade out over 200 ms, then leave the layout; the change is announced once.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const announced = useRef(0);
  const retractedKeys = collectRetracted(reading);
  const retractedSig = retractedKeys.join('|');
  useEffect(() => {
    if (retractedKeys.length === 0) return;
    if (retractedKeys.length > announced.current) {
      announced.current = retractedKeys.length;
      onAnnounce(STYLE_COPY['style.updated']);
    }
    const t = window.setTimeout(() => setGone(new Set(retractedKeys)), 220);
    return () => window.clearTimeout(t);
    // retractedSig captures the key list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retractedSig, onAnnounce]);

  if (!subject) return null;

  const toggle = (key: string, region: StyleRegion | null, label: string) => {
    if (!region) return;
    onHighlight(active?.key === key ? null : { key, region, label });
  };

  const chips = subject.aesthetics
    .map((a, i) => ({ claim: a, i, text: claimText(a) }))
    .filter((c): c is typeof c & { text: string } => Boolean(c.text))
    .filter((c) => !gone.has(`subjects[${readingIndex}].aesthetics[${c.i}]`));
  const rows = detailRows(reading, readingIndex).filter(
    (r) => !(r.retracted && gone.has(rowRetractKey(readingIndex, r.key))),
  );
  const shownRows = showAll ? rows : rows.slice(0, FIRST_DETAIL_ROWS);
  const swatches = paletteWithShare(reading, subject).map((p) => ({
    key: `${p.swatch}:${p.name}`,
    hex: p.hex,
    text: p.text,
    share: p.share,
  }));
  const mood = moodLine(subject.mood);
  const links = qlooLinksLine(subject.qloo_links);
  const hasRail = railSubjects.has(subject.id);

  return (
    <>
      {reading.summary && <p className="style-card__summary">{reading.summary}</p>}
      {subjects.length > 1 && (
        <div className="style-card__subjects" role="group" aria-label="Things in your photo">
          {subjects.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className="pill"
              aria-pressed={i === subjectIndex}
              onClick={() => {
                setSelected(i);
                setShowAll(false);
                if (s.region) onFlashSubject(s.region, s.label);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      {subjects.length === 1 && <p className="style-card__subject">{subject.label}</p>}
      {chips.length > 0 && (
        <ul className="style-chips" aria-label="Style">
          {chips.map(({ claim, i, text }, order) => {
            const key = `${subject.id}:aesthetic:${i}`;
            return (
              <AestheticChip
                key={key}
                claim={claim}
                text={text}
                index={order}
                active={active?.key === key}
                retracted={isRetracted(reading, readingIndex, 'aesthetics', i, claim.retracted)}
                onSelect={() => toggle(key, claim.region, text)}
                onMoreLikeThis={hasRail ? () => onMoreLikeThis(subject.id) : undefined}
              />
            );
          })}
        </ul>
      )}
      <PaletteSwatches swatches={swatches} onCopied={(name) => onAnnounce(`Copied ${name}`)} />
      {subject.brand && (
        <p className="style-card__brand">
          {subject.brand.name}
          {subject.brand.read_text && (
            <span className="reference-source">Read in the photo: “{subject.brand.read_text}”</span>
          )}
        </p>
      )}
      {shownRows.length > 0 && (
        <dl className="style-details">
          {shownRows.map((row, i) => {
            const key = `${subject.id}:${row.key}`;
            const firstOfGroup = i === 0 || shownRows[i - 1]!.group !== row.group;
            return (
              <div
                key={key}
                className={`style-details__row${row.retracted ? ' is-retracted' : ''}`}
              >
                {firstOfGroup ? (
                  <dt className="style-details__group">{row.group}</dt>
                ) : (
                  <dt className="visually-hidden">{row.group}</dt>
                )}
                <dd
                  className={`style-details__text${row.resembles ? ' style-details__text--resembles' : ''}`}
                >
                  <span>{row.text}</span>
                  {row.region && (
                    <button
                      type="button"
                      className="style-locate"
                      aria-label={`Show where: ${row.text}`}
                      aria-pressed={active?.key === key}
                      onClick={() => toggle(key, row.region, row.text)}
                    >
                      <Icon name="locate" size={20} />
                    </button>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {!showAll && rows.length > FIRST_DETAIL_ROWS && (
        <button type="button" className="button button--text" onClick={() => setShowAll(true)}>
          {STYLE_COPY['style.show_details']}
        </button>
      )}
      {mood && <p className="style-card__mood">{mood}</p>}
      {links && <p className="style-card__links">{links}</p>}
    </>
  );
}

function rowRetractKey(subjectIndex: number, rowKey: string): string {
  const [slot, index] = rowKey.split(':');
  return slot === 'era'
    ? `subjects[${subjectIndex}].era`
    : `subjects[${subjectIndex}].${slot}[${index}]`;
}

/** Paths of every retracted claim (flagged on the claim or listed in `retracted[]`). */
function collectRetracted(reading: StyleReading): string[] {
  const out = new Set(reading.retracted);
  reading.subjects.forEach((s, si) => {
    const add = (slot: string, list: Array<{ retracted?: boolean }>) =>
      list.forEach((c, i) => c.retracted && out.add(`subjects[${si}].${slot}[${i}]`));
    add('aesthetics', s.aesthetics);
    add('lineage', s.lineage);
    add('materials', s.materials);
    add('construction', s.construction);
    add('details', s.details);
    if (s.era?.retracted) out.add(`subjects[${si}].era`);
  });
  return [...out].sort();
}
