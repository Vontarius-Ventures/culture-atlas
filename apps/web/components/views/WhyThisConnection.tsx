'use client';

import { useCallback, useState } from 'react';
import type {
  ConnectionEdge,
  ConnectionSupportRoot,
  RecommendationConnectionResponse,
} from '@culture-atlas/domain/schemas';
import { api, ApiError } from '@/lib/client/api';
import { hostOf } from '@/lib/client/format';
import { useSession } from '@/lib/client/session';
import { Disclosure } from '../ui';

/** Minimal, mechanical phrasing for each shared edge of the cultural path. */
function predicateText(edge: ConnectionEdge): string {
  switch (edge.predicate) {
    case 'CREATED_BY':
      return 'created by';
    case 'ABOUT':
      return 'about';
    case 'USES_TECHNIQUE':
      return 'uses technique';
    case 'HAS_ATTRIBUTE':
      return 'has attribute';
    case 'AUDIENCE_AFFINITY':
      return 'liked by people who like';
    case 'DOCUMENTED_ASSOCIATION':
      return (edge.association_subtype ?? 'documented association').replace(/_/g, ' ');
  }
}

/** The owner's own support behind a suggestion, phrased by how it was earned. */
function rootPhrase(root: ConnectionSupportRoot): string {
  switch (root.origin) {
    case 'explicit_save':
      return `Because you saved ${root.label}.`;
    case 'pick_group':
      return `Because you picked ${root.label}.`;
    case 'capture_reference':
      return `Because your photo shows ${root.label}.`;
    case 'analysis':
      return `Because your photo’s reading includes ${root.label}.`;
  }
}

const UNAVAILABLE_LINES: Record<string, string> = {
  support_withdrawn: 'What it was based on has changed.',
  proof_missing: 'It never recorded an explanation.',
  rights_expired: 'The source link’s permission ended.',
};

/**
 * VAL-FEED-003 · "Why this?" for a recommendation the owner already saw. The
 * disclosure opens the pinned proof exactly: the owner's support roots, the
 * shared cultural path, and the permitted source links — no raw scores, no
 * provider identifiers. An unavailable proof is shown as unavailable (with
 * its own honest reason), never substituted by another reason; a legacy
 * recommendation serves its actual pre-graph record as-is.
 */
export function WhyThisConnection({ recommendationId }: { recommendationId: string }) {
  const { isAccount } = useSession();
  const [conn, setConn] = useState<RecommendationConnectionResponse | null>(null);
  /** idle → the closed disclosure; quiet → nothing to disclose (not ours); failed → retry. */
  const [phase, setPhase] = useState<'idle' | 'loading' | 'shown' | 'failed' | 'quiet'>('idle');

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const res = await api.request('getMyRecommendationConnection', {
        params: { id: recommendationId },
      });
      setConn(res);
      setPhase('shown');
    } catch (err) {
      // Not the owner's (or gone): the link context isn't ours to disclose.
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setPhase('quiet');
      else setPhase('failed');
    }
  }, [recommendationId]);

  if (!isAccount || phase === 'quiet') return null;

  if (phase === 'failed') {
    return (
      <div className="connection">
        <p className="connection__error">This suggestion’s background could not load.</p>
        <button type="button" className="connection__retry" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <Disclosure label="Why this?" onOpen={() => void load()}>
      {phase === 'loading' && <p className="connection__loading">Checking the record behind this…</p>}
      {conn && conn.state === 'connected' && (
        <div className="connection__body">
          {conn.reason.text && <p className="connection__reason">{conn.reason.text}</p>}
          {conn.support && conn.support.roots.length > 0 && (
            <>
              <p className="connection__lead">What this builds on:</p>
              <ul className="connection__roots">
                {conn.support.roots.map((root) => (
                  <li key={root.edge_id}>{rootPhrase(root)}</li>
                ))}
              </ul>
            </>
          )}
          {conn.path && conn.path.length > 0 && (
            <>
              <p className="connection__lead">The cultural connection:</p>
              <ol className="connection__path">
                {conn.path.map((edge, i) => (
                  <li key={`${edge.subject.node_id}-${i}`} className="connection__edge">
                    {edge.subject.name} — {predicateText(edge)} — {edge.object.name}
                  </li>
                ))}
              </ol>
            </>
          )}
          {conn.sources.length > 0 && (
            <>
              <p className="connection__lead">Sources:</p>
              <ul className="source-list">
                {conn.sources.map((s) => (
                  <li key={s.id}>
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-link">
                      {s.title ?? hostOf(s.url)}
                    </a>
                    {(s.publisher || s.locator) && (
                      <span className="muted">{` · ${[s.publisher, s.locator].filter(Boolean).join(' · ')}`}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {conn && conn.state === 'unavailable' && (
        <div className="connection__body">
          <p className="connection__reason">The background for this suggestion is no longer available.</p>
          <p className="connection__unavailable">
            {UNAVAILABLE_LINES[conn.unavailable_reason ?? ''] ?? 'It is no longer reliably explainable.'}
          </p>
        </div>
      )}
    </Disclosure>
  );
}
