'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import type { PlansListResponse } from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { formatDate } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import { AccountPrompt } from '../AccountPrompt';
import { SkeletonGrid } from '../DiscoveryCard';
import { EmptyState, PageError } from '../ui';

const STATUS_TEXT: Partial<Record<PlansListResponse['plans'][number]['status'], string>> = {
  queued: 'Being put together',
  running: 'Being put together',
  partial: 'Partly ready',
  failed: 'Didn’t finish',
};

/** Plans destination: saved movie nights, newest first. */
export function PlansView() {
  const { session, isAccount } = useSession();
  const [plans, setPlans] = useState<PlansListResponse['plans'] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (after?: string) => {
    try {
      const res = await api.request('listPlans', { query: { cursor: after, limit: 24 } });
      setPlans((prev) => (after && prev ? [...prev, ...res.plans] : res.plans));
      setCursor(res.next_cursor);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Plans could not be loaded.');
    }
  }, []);

  useAsyncEffect(() => (isAccount ? load() : undefined), [isAccount, load]);

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="display">Your plans</h1>
      </div>
      {session && !isAccount && (
        <div className="callout">
          <AccountPrompt
            lead="Create an account to make and keep plans from your collections."
            onCreated={() => undefined}
          />
        </div>
      )}
      {isAccount && error && <PageError message={error} onRetry={() => void load()} />}
      {isAccount && !plans && !error && <SkeletonGrid count={4} />}
      {plans && plans.length === 0 && (
        <EmptyState
          title="No plans yet"
          actions={
            <Link href="/collections" className="button button--primary">
              Open your collections
            </Link>
          }
        >
          <p>Open a collection, select a few things you love and choose Make something.</p>
        </EmptyState>
      )}
      {plans && plans.length > 0 && (
        <ul className="grid grid--covers" aria-label="Plans">
          {plans.map((p) => (
            <li key={p.id}>
              <article className="cover">
                <div className="mosaic mosaic--n1" aria-hidden="true">
                  {p.cover ? (
                    <img src={p.cover.url} alt="" className="mosaic__tile" />
                  ) : (
                    <div className="mosaic__empty mosaic__empty--plan" />
                  )}
                </div>
                <h2 className="cover__name">
                  <Link href={`/plans/${p.id}`} className="cover__link">
                    {p.title ?? 'Movie night'}
                  </Link>
                </h2>
                <p className="cover__count">
                  {STATUS_TEXT[p.status] ? `${STATUS_TEXT[p.status]} · ` : ''}
                  {formatDate(p.created_at)}
                </p>
              </article>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <div className="load-more">
          <button
            type="button"
            className="button button--outline"
            onClick={() => void load(cursor)}
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
