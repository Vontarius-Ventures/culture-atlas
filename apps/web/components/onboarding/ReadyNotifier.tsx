'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { readyTitle } from '@/lib/client/onboarding';
import { onAnalysisReady, type ReadyNotice } from '@/lib/client/ready';
import { Icon } from '../Icon';
import { COPY } from '../v2/copy';

/**
 * Screen 17 · global ready notice. For an analysis the person started, after
 * they left its result: "Your photo is ready" with the thumbnail, Open and
 * Dismiss. Announced politely (role=status) and never takes focus. While the
 * tab is hidden, the document title carries "(n) Your photo is ready ·
 * culture atlas", cleared when the tab is visible again.
 */
export function ReadyNotifier() {
  const router = useRouter();
  const [notice, setNotice] = useState<ReadyNotice | null>(null);
  const badge = useRef<{ count: number; original: string } | null>(null);

  useEffect(() => {
    const clearBadge = () => {
      if (document.visibilityState !== 'visible' || !badge.current) return;
      document.title = badge.current.original;
      badge.current = null;
    };
    document.addEventListener('visibilitychange', clearBadge);
    const off = onAnalysisReady((n, ctx) => {
      if (ctx.hidden) {
        const count = (badge.current?.count ?? 0) + 1;
        badge.current = { count, original: badge.current?.original ?? document.title };
        document.title = readyTitle(count);
      }
      // Still looking at that result: it updates in place, no toast.
      if (!ctx.viewing) setNotice(n);
    });
    return () => {
      off();
      document.removeEventListener('visibilitychange', clearBadge);
    };
  }, []);

  return (
    <div className="ready-region" role="status" aria-live="polite">
      {notice && (
        <div className="ready-toast">
          {notice.thumbnail && <img className="ready-toast__thumb" src={notice.thumbnail} alt="" />}
          <span className="ready-toast__message">{COPY['ready.toast']}</span>
          <button
            type="button"
            className="ready-toast__action"
            onClick={() => {
              const url = notice.url;
              setNotice(null);
              router.push(url);
            }}
          >
            {COPY['ready.open']}
          </button>
          <button
            type="button"
            className="ready-toast__dismiss"
            aria-label={COPY['ready.dismiss']}
            onClick={() => setNotice(null)}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  );
}
