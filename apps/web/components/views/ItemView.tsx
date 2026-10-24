'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { DiscoveryCard as Card, ItemDetailResponse } from '@culture-atlas/domain/schemas';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { hostOf } from '@/lib/client/format';
import { useJob } from '@/lib/client/jobs';
import { cardToTarget, useSave } from '@/lib/client/save';
import { applyOverrides, useItemOverrides } from '@/lib/client/store';
import { Conveyor } from '../Conveyor';
import { CardGrid, DiscoveryCard, SkeletonGrid, TextArt } from '../DiscoveryCard';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { BackLink, Disclosure, MoreMenu, Notice, PageError, UnavailableState } from '../ui';
import { referencePhrase } from './CaptureResultView';

function relatedHref(card: Card): string {
  return `/items/${card.id}?from=item${card.recommendation_id ? `&rec=${card.recommendation_id}` : ''}`;
}

/**
 * "Why this?" must add something: when its text only repeats the reason
 * already printed under the title, keep just the sources; with no sources
 * either, there is nothing to disclose.
 */
export function dedupeWhy(
  why: ItemDetailResponse['why_this'],
  reason: string | null,
): { text: string | null; sources: NonNullable<ItemDetailResponse['why_this']>['sources'] } | null {
  if (!why) return null;
  const same = (a: string, b: string) =>
    a.trim().replace(/[.\s]+$/, '').toLowerCase() === b.trim().replace(/[.\s]+$/, '').toLowerCase();
  const repeats = reason !== null && same(why.text, reason);
  if (repeats && why.sources.length === 0) return null;
  return { text: repeats ? null : why.text, sources: why.sources };
}

/** Where "Back" goes, from the `from` query the opener set. */
export function backTarget(params: URLSearchParams): { href: string; label: string } {
  const from = params.get('from');
  if (from === 'capture' && params.get('capture')) {
    // A photo opened from the library keeps that origin on the way back.
    const lib =
      params.get('via') === 'library'
        ? `?from=library${params.get('media') ? `&media=${params.get('media')}` : ''}`
        : '';
    return { href: `/captures/${params.get('capture')}${lib}`, label: 'Back to photo' };
  }
  if (from === 'collection' && params.get('collection'))
    return { href: `/collections/${params.get('collection')}`, label: 'Collection' };
  if (from === 'later') return { href: '/collections/later', label: 'Saved for later' };
  if (from === 'reference' && params.get('reference'))
    return { href: `/references/${params.get('reference')}`, label: 'Back' };
  if (from === 'item') return { href: '/', label: 'Back' };
  return { href: '/', label: 'Discover' };
}

/**
 * Item detail: open two-column layout on desktop (large image left; name,
 * actions and related discoveries right), a dedicated page with Back on mobile.
 * "Explore the references" and "Why this?" are quiet disclosures, closed by default.
 * Opening the page never starts generation; "Discover more" is explicit and bounded.
 */
export function ItemView({ itemId }: { itemId: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const rec = search.get('rec') ?? undefined;
  const collectionCtx = search.get('collection') ?? undefined;
  const back = backTarget(new URLSearchParams(search.toString()));
  const { openSave, hide } = useSave();
  const toast = useToast();
  const overrides = useItemOverrides();
  const [data, setData] = useState<ItemDetailResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [relatedJob, setRelatedJob] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.request('getItem', {
        params: { id: itemId },
        query: {
          recommendation_id: rec,
          collection_id: search.get('from') === 'collection' ? collectionCtx : undefined,
        },
      });
      setData(res);
      setError(null);
      if (res.related_state === 'pending' && res.related_job_id) setRelatedJob(res.related_job_id);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    }
  }, [itemId, rec, collectionCtx, search]);

  useAsyncEffect(load, [load]);

  // The tab names the thing, not just "Discovery".
  const docTitle = data?.item.title;
  useEffect(() => {
    if (docTitle) document.title = `${docTitle} · culture atlas`;
  }, [docTitle]);

  const related = useJob(relatedJob, (job) => {
    if (job.state !== 'queued' && job.state !== 'running') {
      void load().then(() => toast.announce('Related discoveries updated'));
    }
  });

  if (error && !data) {
    if (error.status === 404 || error.code === 'not_found') {
      return (
        <div className="page">
          <UnavailableState
            title="This discovery isn’t here anymore."
            body="It may have been hidden, removed from the catalog, or the link is old. Your feed has plenty more."
            primary={{ href: '/', label: 'Back to Discover' }}
            secondary={back.href !== '/' ? { href: back.href, label: back.label } : undefined}
          />
        </div>
      );
    }
    return (
      <div className="page">
        <BackLink href={back.href} label={back.label} />
        <PageError message={error.message} onRetry={() => void load()} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page item-detail" aria-busy="true">
        <BackLink href={back.href} label={back.label} />
        <div className="item-detail__layout">
          <div className="item-detail__media skeleton" />
          <div className="item-detail__body">
            <div className="skeleton skeleton--title" />
          </div>
        </div>
      </div>
    );
  }

  const item = applyOverrides([data.item], overrides)[0] ?? { ...data.item };
  const whyThis = dedupeWhy(data.why_this, data.reason);
  const relatedCards = applyOverrides(data.related, overrides);
  const pending = related.active || data.related_state === 'pending';

  const discoverMore = async () => {
    setStarting(true);
    try {
      const res = await api.request('discoverRelated', {
        params: { id: itemId },
        body: { collection_id: collectionCtx },
        idempotencyKey: newIdempotencyKey(),
      });
      setRelatedJob(res.job_id);
      toast.announce('Looking for more related discoveries');
    } catch (err) {
      toast.show({
        message: err instanceof ApiError ? err.message : 'That didn’t work. Try again.',
      });
    } finally {
      setStarting(false);
    }
  };

  const menuItems = [
    {
      label: 'Hide this',
      onSelect: async () => {
        try {
          await hide(item.id, item.title);
          router.push(back.href);
        } catch (err) {
          toast.show({ message: err instanceof ApiError ? err.message : 'That didn’t work.' });
        }
      },
    },
  ];

  return (
    <div className="page item-detail">
      <BackLink href={back.href} label={back.label} />
      <div className="item-detail__layout">
        <div className="item-detail__media">
          {item.image ? (
            <img
              src={item.image.url}
              alt={item.image.alt || item.title}
              className="item-detail__img"
            />
          ) : (
            <TextArt card={item} />
          )}
        </div>
        <div className="item-detail__body">
          <h1 className="display display--medium">{item.title}</h1>
          {item.subtitle && <p className="item-detail__subtitle">{item.subtitle}</p>}
          {data.detail && <p className="item-detail__subtitle">{data.detail}</p>}
          {data.reason && <p className="item-detail__reason">{data.reason}</p>}
          <div className="item-detail__actions">
            {/* Mockup 06: a plain "Save" button; the label itself says "Saved" afterwards. */}
            <button
              type="button"
              className={`button button--primary${item.saved ? ' is-saved' : ''}`}
              onClick={(e) => openSave(cardToTarget(item), e.currentTarget)}
            >
              <span>{item.saved ? 'Saved' : 'Save'}</span>
            </button>
            {data.destination_url && (
              <a
                className="button button--quiet"
                href={data.destination_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>Visit {hostOf(data.destination_url)}</span>
                <Icon name="external" size={16} />
              </a>
            )}
            <MoreMenu label={`More options for ${item.title}`} items={menuItems} />
            {item.is_example && <p className="example-label">Example result</p>}
          </div>
          {data.description && (
            <figure className="item-detail__about">
              <p className="lede">{data.description}</p>
              {/* Provenance: this text is the catalog's, not ours. */}
              <figcaption className="item-detail__provenance">Catalog description</figcaption>
            </figure>
          )}
          {data.capture_id && (
            <p>
              <Link href={`/captures/${data.capture_id}`} className="text-link">
                See discoveries from this photo
              </Link>
            </p>
          )}
          <div className="disclosures">
            {data.references.length > 0 && (
              <Disclosure label="Explore the references">
                <ul className="reference-list">
                  {data.references.map((ref) => (
                    <li key={ref.id}>
                      {ref.has_page ? (
                        <Link href={`/references/${ref.id}`} className="reference-link">
                          <span>{referencePhrase(ref)}</span>
                          <Icon name="arrowRight" size={16} />
                        </Link>
                      ) : (
                        <span className="reference-plain">{referencePhrase(ref)}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {whyThis && (
              <Disclosure label="Why this?">
                {whyThis.text ? (
                  <p>{whyThis.text}</p>
                ) : (
                  <p className="muted">Where this comes from:</p>
                )}
                {whyThis.sources.length > 0 && (
                  <ul className="source-list">
                    {whyThis.sources.map((s) => (
                      <li key={s.id}>
                        <a
                          href={s.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-link"
                        >
                          {s.title ?? hostOf(s.url)}
                        </a>
                        {s.publisher && <span className="muted"> · {s.publisher}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </Disclosure>
            )}
          </div>

          <section className="related" aria-labelledby="related-heading">
            <h2 id="related-heading" className="section-title section-title--display">
              You might also like
            </h2>
            {relatedCards.length > 0 && (
              // Similar cards float leftward through the cached related set (static under Reduce Motion
              // or when there are too few to keep the rail full without repeating a card on screen).
              <Conveyor
                key={itemId}
                memoryKey={`related:${itemId}`}
                axis="horizontal"
                label="Related discoveries"
                className="related-rail"
                items={relatedCards}
                renderItem={(card) => (
                  <DiscoveryCard
                    card={card}
                    aspect="portrait"
                    priority
                    href={relatedHref(card)}
                    onSave={(c, el) => openSave(cardToTarget(c), el)}
                  />
                )}
                fallback={() => (
                  <CardGrid columns="related" label="Related discoveries">
                    {relatedCards.map((card) => (
                      <li key={card.id} className="feed-fade">
                        <DiscoveryCard
                          card={card}
                          aspect="portrait"
                          href={relatedHref(card)}
                          onSave={(c, el) => openSave(cardToTarget(c), el)}
                        />
                      </li>
                    ))}
                  </CardGrid>
                )}
              />
            )}
            {pending && <SkeletonGrid count={3} columns="related" />}
            {related.job?.state === 'failed' && (
              <Notice onRetry={() => void discoverMore()}>
                Related discoveries are taking longer.
              </Notice>
            )}
            {!pending && relatedCards.length === 0 && related.job?.state !== 'failed' && (
              <p className="muted">No related discoveries yet.</p>
            )}
            {!pending && (
              <div className="related__more">
                <button
                  type="button"
                  className="button button--outline"
                  onClick={() => void discoverMore()}
                  disabled={starting}
                >
                  {starting ? 'Starting…' : 'Discover more'}
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
