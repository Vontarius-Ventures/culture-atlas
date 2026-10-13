'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { Exploration } from '@culture-atlas/domain';
import type { CollectionMember, CollectionSummary } from '@culture-atlas/domain/schemas';
import { api, ApiError, isApiError, newIdempotencyKey } from '@/lib/client/api';
import { KIND_LABELS } from '@/lib/client/format';
import { UI_LIMITS } from '@/lib/client/limits';
import { TextArt } from '../DiscoveryCard';
import { Icon } from '../Icon';
import { BackLink, Notice, PageError } from '../ui';

export const EXPLORATION_OPTIONS: Array<{ value: Exploration; label: string; hint: string }> = [
  { value: 'familiar', label: 'Familiar', hint: 'Closest to what you picked' },
  { value: 'balanced', label: 'Balanced', hint: 'A little of both' },
  { value: 'adventurous', label: 'Adventurous', hint: 'Wider, still connected' },
];

/** Adds exclusions from free text ("peanuts, shellfish"), deduplicated and bounded. */
export function addExclusions(current: readonly string[], text: string): string[] {
  const next = [...current];
  for (const raw of text.split(',')) {
    const value = raw.trim().slice(0, UI_LIMITS.dietaryExclusionMaxChars);
    if (!value) continue;
    if (next.some((x) => x.toLowerCase() === value.toLowerCase())) continue;
    if (next.length >= UI_LIMITS.dietaryExclusionsMax) break;
    next.push(value);
  }
  return next;
}

/**
 * Plan form for "Movie night": two to five selected collection items, an
 * optional short instruction, dietary exclusions, Familiar / Balanced /
 * Adventurous (default Balanced) and an optional "Use this movie" for one film.
 */
export function PlanFormView({ collectionId }: { collectionId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const requested = (search.get('items') ?? '').split(',').filter(Boolean);
  const [collection, setCollection] = useState<CollectionSummary | null>(null);
  const [members, setMembers] = useState<CollectionMember[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(requested.slice(0, UI_LIMITS.planMaxItems));
  const [fixedFilm, setFixedFilm] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [exclusions, setExclusions] = useState<string[]>([]);
  const [exclusionText, setExclusionText] = useState('');
  const [exploration, setExploration] = useState<Exploration>('balanced');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; conflict?: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const instructionId = useId();
  const exclusionId = useId();
  const explorationName = useId();
  const filmName = useId();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let all: CollectionMember[] = [];
        let after: string | undefined;
        let summary: CollectionSummary | null = null;
        do {
          const res = await api.request('getCollection', {
            params: { id: collectionId },
            query: { cursor: after, limit: 24 },
          });
          summary = res.collection;
          all = [...all, ...res.items];
          after = res.next_cursor ?? undefined;
        } while (after && !requested.every((id) => all.some((m) => m.item.id === id)));
        if (cancelled) return;
        setCollection(summary);
        setMembers(all);
        setChosen((c) => c.filter((id) => all.some((m) => m.item.id === id)));
      } catch (err) {
        if (!cancelled)
          setLoadError(
            err instanceof ApiError ? err.message : 'This collection could not be loaded.',
          );
      }
    })();
    return () => {
      cancelled = true;
    };
    // requested is derived from the URL once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionId]);

  if (loadError) {
    return (
      <div className="page page--narrow">
        <BackLink href={`/collections/${collectionId}`} label="Collection" />
        <PageError message={loadError} />
      </div>
    );
  }

  const selectedMembers = (members ?? []).filter((m) => chosen.includes(m.item.id));
  const films = selectedMembers.filter((m) => m.item.kind === 'film');
  const count = selectedMembers.length;
  const ready = count >= UI_LIMITS.planMinItems && count <= UI_LIMITS.planMaxItems;

  const commitExclusions = () => {
    if (!exclusionText.trim()) return;
    setExclusions((x) => addExclusions(x, exclusionText));
    setExclusionText('');
  };

  const submit = async () => {
    if (!collection || !ready) return;
    setBusy(true);
    setError(null);
    const pendingExclusions = exclusionText.trim()
      ? addExclusions(exclusions, exclusionText)
      : exclusions;
    try {
      const res = await api.request('createPlan', {
        body: {
          collection_id: collection.id,
          expected_revision: collection.revision,
          item_ids: selectedMembers.map((m) => m.item.id),
          template: 'movie_night',
          fixed_film_item_id: fixedFilm && chosen.includes(fixedFilm) ? fixedFilm : undefined,
          constraints: {
            instruction: instruction.trim() || undefined,
            dietary_exclusions: pendingExclusions.length ? pendingExclusions : undefined,
          },
          exploration,
        },
        idempotencyKey: newIdempotencyKey(),
      });
      router.push(`/plans/${res.plan_id}?job=${res.job_id}`);
    } catch (err) {
      const conflict = isApiError(err, 'revision_conflict') || isApiError(err, 'conflict');
      setError({
        message: err instanceof ApiError ? err.message : 'The movie night could not be started.',
        conflict,
      });
      setBusy(false);
    }
  };

  return (
    <div className="page page--narrow plan-form">
      <BackLink href={`/collections/${collectionId}`} label={collection?.name ?? 'Collection'} />
      <h1 className="display display--medium">Make a movie night</h1>
      <p className="lede">A film, a few dishes, and music to settle into.</p>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="plan-form__inputs">
          <legend className="field-label">Inspired by</legend>
          {!members && <p className="muted">Loading your selection…</p>}
          <ul className="input-thumbs">
            {selectedMembers.map((m) => (
              <li key={m.item.id} className="input-thumb">
                {m.item.image ? (
                  <img src={m.item.image.url} alt="" className="input-thumb__img" />
                ) : (
                  <span className="input-thumb__img">
                    <TextArt card={m.item} />
                  </span>
                )}
                <span className="input-thumb__title">{m.item.title}</span>
                <span className="visually-hidden">{KIND_LABELS[m.item.kind]}</span>
                <button
                  type="button"
                  className="icon-button icon-button--small"
                  aria-label={`Remove ${m.item.title} from this movie night`}
                  onClick={() => setChosen((c) => c.filter((x) => x !== m.item.id))}
                  disabled={count <= UI_LIMITS.planMinItems}
                >
                  <Icon name="close" size={16} />
                </button>
              </li>
            ))}
          </ul>
          {members && !ready && (
            <p className="field-help" role="status">
              Choose {UI_LIMITS.planMinItems} to {UI_LIMITS.planMaxItems} items from the collection.
            </p>
          )}
        </fieldset>

        {films.length > 0 && (
          <fieldset className="radio-list">
            <legend className="field-label">Use this movie?</legend>
            <label className="check-row">
              <input
                type="radio"
                name={filmName}
                checked={fixedFilm === null}
                onChange={() => setFixedFilm(null)}
              />
              <span>Use it as inspiration</span>
            </label>
            {films.map((f) => (
              <label key={f.item.id} className="check-row">
                <input
                  type="radio"
                  name={filmName}
                  checked={fixedFilm === f.item.id}
                  onChange={() => setFixedFilm(f.item.id)}
                />
                <span>Use {f.item.title}</span>
              </label>
            ))}
          </fieldset>
        )}

        <label htmlFor={instructionId} className="field-label">
          Anything in mind? <span className="field-optional">(optional)</span>
        </label>
        <textarea
          id={instructionId}
          className="input textarea"
          rows={2}
          value={instruction}
          maxLength={UI_LIMITS.instructionMaxChars}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="A relaxed evening"
        />

        <label htmlFor={exclusionId} className="field-label">
          Leave out of the food <span className="field-optional">(optional)</span>
        </label>
        <div className="chips-input">
          {exclusions.length > 0 && (
            <ul className="chips" aria-label="Foods to leave out">
              {exclusions.map((x) => (
                <li key={x} className="chip">
                  <span>{x}</span>
                  <button
                    type="button"
                    className="chip__remove"
                    aria-label={`Remove ${x}`}
                    onClick={() => setExclusions((all) => all.filter((y) => y !== x))}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            id={exclusionId}
            className="input"
            value={exclusionText}
            onChange={(e) => setExclusionText(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                commitExclusions();
              }
            }}
            onBlur={commitExclusions}
            placeholder="peanuts, shellfish"
            disabled={exclusions.length >= UI_LIMITS.dietaryExclusionsMax}
          />
        </div>
        <p className="field-help">
          We’ll leave these out of dish ideas. Always check ingredients yourself.
        </p>

        <fieldset className="segmented">
          <legend className="field-label">How adventurous?</legend>
          <div className="segmented__options">
            {EXPLORATION_OPTIONS.map((o) => (
              <label
                key={o.value}
                className={`segmented__option${exploration === o.value ? ' segmented__option--on' : ''}`}
              >
                <input
                  type="radio"
                  name={explorationName}
                  value={o.value}
                  checked={exploration === o.value}
                  onChange={() => setExploration(o.value)}
                  className="visually-hidden"
                />
                <span className="segmented__label">{o.label}</span>
                <span className="segmented__hint">{o.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {error && (
          <Notice
            tone="error"
            onRetry={error.conflict ? () => router.push(`/collections/${collectionId}`) : undefined}
            retryLabel="Review collection"
          >
            {error.message}
          </Notice>
        )}
        <button
          type="submit"
          className="button button--primary button--large button--block"
          disabled={!ready || busy || !collection}
        >
          {busy ? 'Starting…' : 'Create movie night'}
        </button>
      </form>
    </div>
  );
}
