'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { SharedCollectionResponse, SharedDiscovery } from '@culture-atlas/domain/schemas';
import { api, isApiError } from '@/lib/client/api';
import { useSession } from '@/lib/client/session';
import { COPY, formatDuration } from './agents-sharing-format';
import './agent-platform.css';

/**
 * Screen 13: Shared collection (/shared). View only, public-safe projection,
 * no private navigation or owner menus. A bearer link's secret arrives in the
 * URL fragment (never sent to the server by the browser), is exchanged once by
 * POST for an HttpOnly session, and is removed from history immediately.
 * Expired or revoked shares show an empty state with no titles or thumbnails,
 * and content is dropped from memory as soon as revocation is observed.
 */

const PENDING_INVITE = 'ca_pending_invite';
const REFRESH_MS = 60_000;

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: SharedCollectionResponse }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function takeFragment(key: string): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  const value = new URLSearchParams(hash).get(key);
  if (hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return value;
}

function Unavailable() {
  return (
    <div className="as-bare"><div className="as-page"><section className="as-card" aria-labelledby="shared-unavailable">
      <small className="as-crumb">culture atlas / Shared collection</small>
      <h1 id="shared-unavailable">{COPY.sharesRevoked}</h1>
      <p className="as-muted">Ask the person who shared it for a new link or invitation.</p>
    </section></div></div>
  );
}

function DiscoveryPanel({ item, saveMode, onSave }: { item: SharedDiscovery; saveMode: boolean; onSave(item: SharedDiscovery): void }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <article className="as-panel" aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`}>{item.title}</h2>
      {item.is_example && <span className="as-badge">Example result</span>}
      <p>{item.description ?? item.subtitle ?? 'A shared discovery.'}</p>
      <button type="button" aria-expanded={open} aria-controls={`${id}-d`} onClick={() => setOpen(!open)}>
        {open ? 'Hide details' : 'Open details'}
      </button>
      {saveMode && item.saveable && <>{' '}<button type="button" className="as-primary" onClick={() => onSave(item)}>Save to my library</button></>}
      {saveMode && !item.saveable && <p className="as-muted">This discovery cannot be copied.</p>}
      <div id={`${id}-d`} hidden={!open}>
        {item.image && <img className="as-detail-image" src={item.image.url} alt={item.image.alt} referrerPolicy="no-referrer" />}
        {item.subtitle && item.description && <p>{item.subtitle}</p>}
        {item.detail && <p className="as-muted">{item.detail}</p>}
        {item.destination_url && (
          <p><a href={item.destination_url} target="_blank" rel="noopener noreferrer">Visit the official page</a></p>
        )}
      </div>
    </article>
  );
}

export function SharedCollectionView() {
  const { isAccount } = useSession();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [shareId, setShareId] = useState<string | null>(null);
  const [saveMode, setSaveMode] = useState(false);
  const [status, setStatus] = useState('');
  const started = useRef(false);

  const load = useCallback(async (id: string | null) => {
    try {
      const data = await api.request('getSharedCollection', { query: id ? { share: id } : {} });
      setState({ kind: 'ready', data });
    } catch (err) {
      // Revocation or expiry observed: drop everything previously shown.
      if (isApiError(err, 'not_found') || isApiError(err, 'unauthenticated')) setState({ kind: 'unavailable' });
      else setState((s) => (s.kind === 'ready' ? s : { kind: 'error', message: err instanceof Error ? err.message : 'Could not load this collection.' }));
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const id = new URLSearchParams(window.location.search).get('share');
    const token = takeFragment('share');
    void (async () => {
      setShareId(id);
      if (token) {
        try {
          await api.request('redeemShare', { body: { token } });
        } catch {
          setState({ kind: 'unavailable' });
          return;
        }
      }
      await load(id);
    })();
  }, [load]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const refresh = () => { if (document.visibilityState === 'visible') void load(shareId); };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [state.kind, shareId, load]);

  if (state.kind === 'unavailable') return <Unavailable />;
  if (state.kind === 'loading') {
    return (
      <div className="as-bare"><div className="as-page"><section className="as-card" aria-busy="true">
        <small className="as-crumb">culture atlas / Shared collection</small>
        <p role="status">Opening shared collection…</p>
      </section></div></div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="as-bare"><div className="as-page"><section className="as-card">
        <small className="as-crumb">culture atlas / Shared collection</small>
        <p role="alert" className="as-alert">{state.message}</p>
        <button type="button" onClick={() => { setState({ kind: 'loading' }); void load(shareId); }}>Try again</button>
      </section></div></div>
    );
  }
  const { data } = state;
  const owner = data.collection.owner_display_name;
  const byline = [owner ? `Shared by ${owner}` : 'Shared with you', data.collection.description].filter(Boolean).join(' · ');
  const n = data.discoveries.length;
  const mediaNote = data.share.include_media
    ? `${data.media.length} ${data.media.length === 1 ? 'photo or video' : 'photos and videos'} included.`
    : 'Captured photos and videos are not included.';

  return (
    <div className="as-bare"><div className="as-page">
      <section className="as-card" aria-labelledby="shared-title">
        <small className="as-crumb">culture atlas / Shared collection</small>
        <h1 id="shared-title">{data.collection.title}</h1>
        <span className="as-badge">Shared collection · View only</span>
        <p className="as-muted">{byline}</p>
        {n > 0 ? (
          <div className="as-grid">
            {data.discoveries.map((item) => (
              <DiscoveryPanel key={item.id} item={item} saveMode={saveMode} onSave={async (it) => {
                try {
                  await api.request('saveSharedItem', { params: { id: it.id }, query: shareId ? { share: shareId } : {}, body: {} });
                  setStatus(`Saved “${it.title}” to your library.`);
                } catch (err) {
                  setStatus(err instanceof Error ? err.message : 'Could not save. Try again.');
                }
              }} />
            ))}
          </div>
        ) : data.share.include_media && data.media.length > 0 ? null : (
          <p>Nothing has been shared in this collection yet.</p>
        )}
        {data.share.include_media && data.media.length > 0 && (
          <>
            <h2>Photos and videos</h2>
            <div className="as-media">
              {data.media.map((m) => (
                <figure key={m.id} style={{ margin: 0 }}>
                  {m.kind === 'video' && m.playback_url ? (
                    <video controls muted playsInline preload="none" poster={m.poster_url ?? undefined} src={m.playback_url}
                      aria-label={`Shared video, ${formatDuration(m.duration_ms)}`} />
                  ) : m.playback_url ? (
                    <img src={m.playback_url} alt="Shared photo" loading="lazy" />
                  ) : null}
                  <figcaption className="as-muted">
                    {m.kind === 'video' ? `Video · ${formatDuration(m.duration_ms)}` : 'Photo'}
                    {m.original_url && <> · <a href={m.original_url} download>Download original</a></>}
                  </figcaption>
                </figure>
              ))}
            </div>
          </>
        )}
        <p>{n} shared {n === 1 ? 'discovery' : 'discoveries'} · {mediaNote}</p>
        {data.discoveries.some((d) => d.saveable) && (
          <button type="button" aria-pressed={saveMode} onClick={() => setSaveMode(!saveMode)}>
            {saveMode ? 'Done saving' : 'Save a discovery to my collection'}
          </button>
        )}
        {saveMode && !isAccount && <p className="as-muted">Sign in to your own culture atlas account to save. Only public catalog discoveries are copied; nothing private is shared with you.</p>}
        <p role="status" aria-live="polite" className="as-muted">{status}</p>
      </section>
    </div></div>
  );
}

/** /shared/invite: accept a restricted invitation as the exact verified recipient. */
export function AcceptInvitationView() {
  const { isAccount, session } = useSession();
  const [message, setMessage] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const token = takeFragment('invite');
    try {
      if (token) window.sessionStorage.setItem(PENDING_INVITE, token);
    } catch {
      // Storage unavailable: the token only lives in memory for this page.
    }
    if (!session || !isAccount || started.current) return;
    let stored: string | null = token;
    try {
      stored = stored ?? window.sessionStorage.getItem(PENDING_INVITE);
    } catch {
      // ignore
    }
    if (!stored) return;
    started.current = true;
    void api.request('acceptShareInvitation', { body: { token: stored } }).then((r) => {
      try { window.sessionStorage.removeItem(PENDING_INVITE); } catch { /* ignore */ }
      window.location.replace(`/shared?share=${r.share_id}`);
    }, (err: unknown) => {
      try { window.sessionStorage.removeItem(PENDING_INVITE); } catch { /* ignore */ }
      setMessage(err instanceof Error ? err.message : 'This invitation could not be accepted.');
    });
  }, [session, isAccount]);

  return (
    <div className="as-bare"><div className="as-page"><section className="as-card" aria-labelledby="invite-title">
      <small className="as-crumb">culture atlas / Shared collection</small>
      <h1 id="invite-title">{message ? 'Invitation not accepted' : 'You were invited to view a collection'}</h1>
      {message ? <p role="alert" className="as-alert">{message}</p>
        : session && !isAccount ? (
          <>
            <p>Sign in with the email address this invitation was sent to. That address must be verified.</p>
            <p className="as-muted">Nothing in the collection is shown until you accept.</p>
            <Link className="as-button as-primary" href="/settings">Sign in</Link>
          </>
        ) : <p role="status">Checking your invitation…</p>}
    </section></div></div>
  );
}
