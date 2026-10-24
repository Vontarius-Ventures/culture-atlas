'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import type { ReferenceResponse } from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { formatDate, hostOf } from '@/lib/client/format';
import { cardToTarget, useSave } from '@/lib/client/save';
import { applyOverrides, useItemOverrides } from '@/lib/client/store';
import { CardGrid, DiscoveryCard } from '../DiscoveryCard';
import { BackLink, Disclosure, LoadingText, PageError } from '../ui';

/**
 * Cultural reference page: name, short overview, up to three sections,
 * related discoveries and expandable sources (closed by default). Same shell
 * and typography with a narrower reading width; no diagrams or evidence dashboards.
 * When research is unavailable, unverified historical text is simply omitted.
 */
export function ReferenceView({ referenceId }: { referenceId: string }) {
  const search = useSearchParams();
  const captureId = search.get('capture') ?? undefined;
  const { openSave } = useSave();
  const overrides = useItemOverrides();
  const [data, setData] = useState<ReferenceResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      setData(
        await api.request('getReference', {
          params: { id: referenceId },
          query: { capture_id: captureId },
        }),
      );
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    }
  }, [referenceId, captureId]);

  useAsyncEffect(load, [load]);

  const back = captureId
    ? { href: `/captures/${captureId}`, label: 'Your photo' }
    : { href: '/', label: 'Discover' };

  if (error && !data) {
    return (
      <div className="page page--reading">
        <BackLink {...back} />
        <PageError
          message={error.status === 404 ? 'This reference isn’t available.' : error.message}
          onRetry={error.status === 404 ? undefined : () => void load()}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page page--reading">
        <BackLink {...back} />
        <LoadingText>Loading…</LoadingText>
      </div>
    );
  }

  const related = applyOverrides(data.related, overrides);
  const hasText = Boolean(data.overview) || data.sections.length > 0;
  return (
    <div className="page reference">
      <div className="page--reading">
        <BackLink {...back} />
        <article className="reference__article">
          <h1 className="display display--medium">{data.name}</h1>
          {data.overview && <p className="lede reference__overview">{data.overview}</p>}
          {data.sections.map((s) => (
            <section key={s.heading} className="reference__section">
              <h2 className="reference__heading">{s.heading}</h2>
              <p>{s.body}</p>
            </section>
          ))}
          {!hasText && data.research_status === 'pending' && (
            <p className="muted">We’re still gathering sources for this page.</p>
          )}
          {!hasText && data.research_status !== 'pending' && (
            <p className="muted">There’s no sourced background for this yet.</p>
          )}
          {data.sources.length > 0 && (
            <Disclosure label="Sources">
              <ol className="source-list">
                {data.sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-link">
                      {s.title ?? hostOf(s.url)}
                    </a>
                    <span className="muted">
                      {s.publisher ? ` · ${s.publisher}` : ''} · retrieved{' '}
                      {formatDate(s.retrieved_at)}
                    </span>
                  </li>
                ))}
              </ol>
            </Disclosure>
          )}
        </article>
      </div>
      {related.length > 0 && (
        <section className="reference__related" aria-labelledby="ref-related">
          <h2 id="ref-related" className="section-title section-title--display">
            Related discoveries
          </h2>
          <CardGrid label="Related discoveries">
            {related.map((card) => (
              <li key={card.id}>
                <DiscoveryCard
                  card={card}
                  href={`/items/${card.id}?from=reference&reference=${data.id}`}
                  onSave={(c, el) => openSave(cardToTarget(c), el)}
                />
              </li>
            ))}
          </CardGrid>
        </section>
      )}
    </div>
  );
}
