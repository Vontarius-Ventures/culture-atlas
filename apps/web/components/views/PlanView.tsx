'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { ItemKind, PlanSection } from '@culture-atlas/domain';
import type {
  DishIdea,
  FilmPick,
  Image,
  MusicPick,
  PlanResponse,
} from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { formatDate, KIND_LABELS } from '@/lib/client/format';
import { isTerminal, useJob } from '@/lib/client/jobs';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { BackLink, Disclosure, MoreMenu, Notice, PageError } from '../ui';

const CHANGE_LABEL: Record<PlanSection, string> = {
  film: 'Change film',
  food: 'Change food',
  music: 'Change music',
};
const FINDING: Record<PlanSection, string> = {
  film: 'Finding another film…',
  food: 'Finding other dishes…',
  music: 'Finding other music…',
};

interface InputThumb {
  id: string;
  title: string;
  kind: ItemKind | null;
  image: Image | null;
}

/**
 * Movie-night result: the film gets the largest visual area; food and music sit
 * beside it (stacked on mobile in film, food, music, inputs order). Change film /
 * Change food / Change music replace only their section.
 */
export function PlanView({ planId }: { planId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [jobId, setJobId] = useState<string | null>(search.get('job'));
  const [replacing, setReplacing] = useState<{ section: PlanSection; jobId: string } | null>(null);
  const [collectionName, setCollectionName] = useState<string | null>(null);
  const [inputs, setInputs] = useState<InputThumb[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await api.request('getPlan', { params: { id: planId } });
      setPlan(res);
      setError(null);
      if (res.job_id && (res.status === 'queued' || res.status === 'running'))
        setJobId((j) => j ?? res.job_id);
      return res;
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      return null;
    }
  }, [planId]);

  useAsyncEffect(load, [load]);

  const main = useJob(jobId, (job) => {
    void load();
    if (isTerminal(job))
      toast.announce(
        job.state === 'failed'
          ? 'The movie night could not be finished'
          : 'Your movie night is ready',
      );
  });
  useJob(replacing?.jobId, (job) => {
    if (!isTerminal(job)) return;
    void load().then(() => {
      if (replacing)
        toast.announce(
          job.state === 'failed'
            ? `${CHANGE_LABEL[replacing.section]} didn’t work`
            : `${replacing.section === 'film' ? 'Film' : replacing.section === 'food' ? 'Food' : 'Music'} updated`,
        );
      setReplacing(null);
    });
  });

  // Collection name for Back, and input thumbnails (titles come from the plan snapshot).
  const sourceId = plan?.source_collection_id ?? null;
  const selectedKey = plan?.selected_item_ids.join(',') ?? '';
  useEffect(() => {
    if (!sourceId) return;
    api
      .request('getCollection', { params: { id: sourceId }, query: { limit: 1 } })
      .then((r) => setCollectionName(r.collection.name))
      .catch(() => setCollectionName(null));
  }, [sourceId]);
  useEffect(() => {
    if (!selectedKey) return;
    const ids = selectedKey.split(',');
    Promise.all(
      ids.map((id) =>
        api
          .request('getItem', { params: { id } })
          .then((r): InputThumb => ({ id, title: r.item.title, kind: r.item.kind, image: r.item.image }))
          .catch(() => null),
      ),
    ).then((list) => setInputs(list.filter((x): x is InputThumb => x !== null)));
  }, [selectedKey]);

  const replace = async (section: PlanSection) => {
    try {
      const res = await api.request('replacePlanSection', {
        params: { id: planId },
        body: { section },
        idempotencyKey: newIdempotencyKey(),
      });
      setReplacing({ section, jobId: res.job_id });
      toast.announce(FINDING[section]);
    } catch (err) {
      toast.show({
        message: err instanceof ApiError ? err.message : 'That didn’t work. Try again.',
      });
    }
  };

  const back = sourceId
    ? { href: `/collections/${sourceId}`, label: collectionName ?? 'Collection' }
    : { href: '/plans', label: 'Plans' };

  if (error && !plan) {
    return (
      <div className="page">
        <BackLink href="/plans" label="Plans" />
        <PageError
          message={error.status === 404 ? 'This plan isn’t available.' : error.message}
          onRetry={error.status === 404 ? undefined : () => void load()}
        />
      </div>
    );
  }

  const version = plan?.active_version ?? null;
  const processing =
    !version && (main.active || plan?.status === 'queued' || plan?.status === 'running' || !plan);
  const failed =
    !version && !processing && (plan?.status === 'failed' || plan?.status === 'cancelled');
  const sectionState = (s: PlanSection) => {
    if (replacing?.section === s) return 'replacing' as const;
    const st = version?.sections[s];
    if (st === 'unavailable') return 'unavailable' as const;
    if (st === 'failed') return 'failed' as const;
    if (st === 'pending' || st === 'running') return 'pending' as const;
    return 'ready' as const;
  };
  const inputThumbs: InputThumb[] = inputs.length
    ? inputs
    : (version?.inputs ?? []).map((i) => ({ id: i.item_id, title: i.title, kind: null, image: null }));
  const weak = (version?.inputs ?? []).filter((i) => i.contribution !== 'strong');

  return (
    <div className="page plan">
      <BackLink href={back.href} label={back.label} />
      <div className="page-head">
        <div>
          <h1 className="display">
            {processing
              ? 'Putting your movie night together…'
              : (version?.title ?? 'Your movie night')}
          </h1>
          {version?.summary && <p className="plan__summary">{version.summary}</p>}
        </div>
        {plan && (
          <div className="page-head__actions">
            <MoreMenu
              label="More options for this plan"
              items={[
                ...(sourceId
                  ? [
                      {
                        label: 'Start over with new choices',
                        onSelect: () =>
                          router.push(
                            `/collections/${sourceId}/make?items=${plan.selected_item_ids.join(',')}`,
                          ),
                      },
                    ]
                  : []),
                {
                  label: 'Delete plan',
                  danger: true,
                  onSelect: async () => {
                    if (!window.confirm('Delete this plan?')) return;
                    try {
                      await api.request('deletePlan', {
                        params: { id: planId },
                        idempotencyKey: newIdempotencyKey(),
                      });
                      toast.show({ message: 'Plan deleted' });
                      router.push('/plans');
                    } catch (err) {
                      toast.show({
                        message:
                          err instanceof ApiError ? err.message : 'The plan could not be deleted.',
                      });
                    }
                  },
                },
              ]}
            />
          </div>
        )}
      </div>

      {failed && (
        <Notice
          tone="error"
          onRetry={
            sourceId
              ? () =>
                  router.push(
                    `/collections/${sourceId}/make?items=${plan!.selected_item_ids.join(',')}`,
                  )
              : undefined
          }
          retryLabel="Try again"
        >
          {main.job?.error?.message ?? 'This movie night could not be finished.'}
        </Notice>
      )}

      <div className="plan__layout" aria-busy={processing}>
        <section className="plan__film" aria-labelledby="plan-film">
          <h2 id="plan-film" className="visually-hidden">
            Film
          </h2>
          {processing || sectionState('film') !== 'ready' || !version?.film?.feature ? (
            <SectionPlaceholder
              state={processing ? 'pending' : sectionState('film')}
              section="film"
              onRetry={() => void replace('film')}
              large
            />
          ) : (
            <FilmFeature
              film={version.film.feature}
              onChange={() => void replace('film')}
              disabled={replacing !== null}
            />
          )}
          {version?.film &&
            version.film.alternates.length > 0 &&
            sectionState('film') === 'ready' && (
              <p className="plan__alternates">
                Or try{' '}
                {version.film.alternates.map((f, i) => (
                  <span key={f.item_id}>
                    {i > 0 && ' · '}
                    <Link href={`/items/${f.item_id}?from=item`} className="text-link">
                      {f.title}
                      {f.year ? ` (${f.year})` : ''}
                    </Link>
                  </span>
                ))}
              </p>
            )}
        </section>

        <div className="plan__side">
          <section className="plan__section" aria-labelledby="plan-food">
            <div className="plan__section-head">
              <h2 id="plan-food" className="section-title section-title--display">
                For the table
              </h2>
              {version && (
                <ChangeButton
                  section="food"
                  onClick={() => void replace('food')}
                  disabled={replacing !== null}
                />
              )}
            </div>
            {processing || sectionState('food') !== 'ready' ? (
              <SectionPlaceholder
                state={processing ? 'pending' : sectionState('food')}
                section="food"
                onRetry={() => void replace('food')}
              />
            ) : (
              <ul className="dishes">
                {(version?.food?.dishes ?? []).map((d) => (
                  <Dish key={d.item_id ?? d.title} dish={d} />
                ))}
              </ul>
            )}
          </section>

          <section className="plan__section" aria-labelledby="plan-music">
            <div className="plan__section-head">
              <h2 id="plan-music" className="section-title section-title--display">
                Before the credits
              </h2>
              {version && (
                <ChangeButton
                  section="music"
                  onClick={() => void replace('music')}
                  disabled={replacing !== null}
                />
              )}
            </div>
            {processing || sectionState('music') !== 'ready' ? (
              <SectionPlaceholder
                state={processing ? 'pending' : sectionState('music')}
                section="music"
                onRetry={() => void replace('music')}
              />
            ) : (
              <>
                <ul
                  className={
                    (version?.music?.before ?? []).some((m) => m.image)
                      ? 'music'
                      : 'music music--compact'
                  }
                >
                  {(version?.music?.before ?? []).map((m) => (
                    <Music key={m.item_id ?? m.title} pick={m} />
                  ))}
                </ul>
                {(version?.music?.after.length ?? 0) > 0 && (
                  <>
                    <h3 className="plan__subhead">After the film</h3>
                    <ul className="music music--compact">
                      {version!.music!.after.map((m) => (
                        <Music key={m.item_id ?? m.title} pick={m} />
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      {inputThumbs.length > 0 && (
        <section className="plan__inputs" aria-labelledby="plan-inputs">
          <h2 id="plan-inputs" className="plan__inputs-title">
            Inspired by
          </h2>
          <ul className="inspired">
            {inputThumbs.map((i) => (
              <li key={i.id}>
                <Link href={`/items/${i.id}?from=item`} className="inspired__link">
                  {i.image ? (
                    <img src={i.image.url} alt="" className="inspired__img" />
                  ) : (
                    <span
                      className={`inspired__img inspired__img--text${i.kind ? ` text-art--${i.kind}` : ''}`}
                      aria-hidden="true"
                    >
                      {i.kind && <span className="text-art__kind">{KIND_LABELS[i.kind]}</span>}
                    </span>
                  )}
                  <span className="inspired__title">{i.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {version && (version.rationale || weak.length > 0) && (
        <Disclosure label="Why these?">
          {version.rationale && <p>{version.rationale}</p>}
          {weak.length > 0 && (
            <ul className="plain-list">
              {weak.map((w) => (
                <li key={w.item_id}>
                  {w.title}:{' '}
                  {w.note ??
                    (w.contribution === 'none'
                      ? 'didn’t add much to this plan.'
                      : 'had a lighter influence.')}
                </li>
              ))}
            </ul>
          )}
          {sourceId && (
            <p>
              <Link
                href={`/collections/${sourceId}/make?items=${plan!.selected_item_ids.join(',')}`}
                className="text-link"
              >
                Change the plan
              </Link>
            </p>
          )}
        </Disclosure>
      )}
      {version && plan && plan.versions.length > 1 && (
        <p className="muted plan__version">
          Version {version.version} of {plan.versions.length} · {formatDate(version.created_at)}
        </p>
      )}
    </div>
  );
}

const UNAVAILABLE: Record<PlanSection, string> = {
  film: 'Film picks are taking longer. Try again in a little while.',
  food: 'Food ideas are taking longer.',
  music: 'Music picks are taking longer.',
};

function ChangeButton({
  section,
  onClick,
  disabled,
}: {
  section: PlanSection;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="button button--outline button--small button--pill"
      onClick={onClick}
      disabled={disabled}
    >
      {CHANGE_LABEL[section]}
    </button>
  );
}

function SectionPlaceholder({
  state,
  section,
  onRetry,
  large,
}: {
  state: 'pending' | 'replacing' | 'failed' | 'unavailable' | 'ready';
  section: PlanSection;
  onRetry: () => void;
  large?: boolean;
}) {
  if (state === 'failed' || state === 'unavailable') {
    const notice = (
      <Notice onRetry={onRetry} retryLabel="Try again">
        {state === 'unavailable'
          ? UNAVAILABLE[section]
          : section === 'music'
            ? 'Music isn’t ready yet.'
            : section === 'food'
              ? 'Food ideas aren’t ready yet.'
              : 'The film isn’t ready yet.'}
      </Notice>
    );
    return large ? <div className="plan-placeholder plan-placeholder--large plan-placeholder--notice">{notice}</div> : notice;
  }
  return (
    <div
      className={`plan-placeholder${large ? ' plan-placeholder--large' : ''}`}
      aria-hidden={state === 'pending'}
    >
      {state === 'replacing' && (
        <p className="plan-placeholder__text" role="status">
          {FINDING[section]}
        </p>
      )}
      {!large && (
        <div className="plan-placeholder__row">
          <div className="skeleton skeleton--media" />
          <div className="skeleton skeleton--media" />
        </div>
      )}
    </div>
  );
}

function FilmFeature({
  film,
  onChange,
  disabled,
}: {
  film: FilmPick;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <div className={`film-feature${film.image ? '' : ' film-feature--text'}`}>
      {film.image && (
        <img src={film.image.url} alt={film.image.alt || ''} className="film-feature__img" />
      )}
      <div className="film-feature__overlay">
        <h3 className="film-feature__title">
          <Link href={`/items/${film.item_id}?from=item`} className="film-feature__link">
            {film.title}
          </Link>
        </h3>
        {film.year && <p className="film-feature__meta">{film.year}</p>}
        {film.reason && <p className="film-feature__reason">{film.reason}</p>}
        <div className="film-feature__actions">
          <button
            type="button"
            className="button button--on-image"
            onClick={onChange}
            disabled={disabled}
          >
            Change film
          </button>
          {film.destination_url && (
            <a
              href={film.destination_url}
              className="button button--on-image button--icon-only"
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`About ${film.title}`}
            >
              <Icon name="external" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Dish({ dish }: { dish: DishIdea }) {
  return (
    <li className="dish">
      {dish.image ? (
        <img src={dish.image.url} alt="" className="dish__img" />
      ) : (
        <div className="dish__img dish__img--text" aria-hidden="true">
          <span>{dish.cuisine ?? 'Dish idea'}</span>
        </div>
      )}
      <h3 className="dish__title">
        {dish.item_id ? (
          <Link href={`/items/${dish.item_id}?from=item`} className="card__link">
            {dish.title}
          </Link>
        ) : (
          dish.title
        )}
      </h3>
      <p className="dish__desc">{dish.description}</p>
    </li>
  );
}

function Music({ pick }: { pick: MusicPick }) {
  const title =
    pick.kind === 'track' && pick.artist ? `${pick.title} · ${pick.artist}` : pick.title;
  return (
    <li className="music__item">
      {pick.image ? (
        <img src={pick.image.url} alt="" className="music__img" />
      ) : (
        <div className="music__img music__img--text" aria-hidden="true">
          <span>{pick.title.slice(0, 1)}</span>
        </div>
      )}
      <span className="music__title">
        {pick.item_id ? (
          <Link href={`/items/${pick.item_id}?from=item`} className="card__link">
            {title}
          </Link>
        ) : (
          title
        )}
      </span>
    </li>
  );
}
