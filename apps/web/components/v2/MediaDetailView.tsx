'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { ApiError } from '@/lib/client/api';
import { setViewingResult, watchAnalysis } from '@/lib/client/ready';
import { useSession } from '@/lib/client/session';
import { Icon } from '../Icon';
import { WhileWeLook } from '../onboarding/WhileWeLook';
import { useToast } from '../Toast';
import { COPY } from './copy';
import {
  isSignedOutError,
  mediaApi,
  mediaErrorMessage,
  type AnalysisResponse,
  type MediaDetail,
} from './media-api';
import {
  formatDuration,
  formatDurationWords,
  mediaTitle,
  SOURCE_LABELS,
  statusLabel,
} from './media-format';
import {
  CollectionPicker,
  ConfirmDelete,
  ExperimentalBadge,
  FlowHeader,
  SignInPanel,
  V2Notice,
} from './parts';
import { analysisExperimental, type ExperimentalLabel } from '@/lib/client/style';
import { EXPLORE_WAITING, exploreFailureMessage, exploreState } from './explore-state';
import { loadCapabilities } from './uploads-client';
import { V2Icon } from './V2Icon';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; item: MediaDetail }
  | { state: 'error'; message: string; missing?: boolean }
  | { state: 'signed-out' };

/** Video/photo detail (reference 07). */
export function MediaDetailView({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const { session, isAccount } = useSession();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [moment, setMoment] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [analysisReady, setAnalysisReady] = useState<boolean | null>(null);
  // D.3/D.4: photo and video readings run unqualified in production and say so.
  const [experimental, setExperimental] = useState<ExperimentalLabel | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const player = useRef<PlayerHandle | null>(null);
  const momentsRef = useRef<HTMLUListElement>(null);
  const detailsId = useId();
  const moreId = useId();

  // Screen 17: this page is "viewing" its own exploration; leaving it lets the
  // ready notice announce the result.
  useEffect(() => {
    setViewingResult(`media:${id}`);
    return () => setViewingResult(null);
  }, [id]);

  const fetchItem = useCallback(async () => {
    try {
      const item = await mediaApi.media(id);
      setLoad({ state: 'ready', item });
      return item;
    } catch (err) {
      if (isSignedOutError(err)) setLoad({ state: 'signed-out' });
      else
        setLoad({
          state: 'error',
          missing: err instanceof ApiError && err.code === 'not_found',
          message: mediaErrorMessage(err, 'This item could not load.'),
        });
      return null;
    }
  }, [id]);

  useEffect(() => {
    if (!session) return;
    if (!isAccount) {
      void Promise.resolve().then(() => setLoad({ state: 'signed-out' }));
      return;
    }
    void Promise.resolve().then(fetchItem);
    loadCapabilities()
      .then((c) => {
        setAnalysisReady(c.availability.analysis?.available ?? false);
        setExperimental(analysisExperimental(c.availability.analysis));
      })
      .catch(() => setAnalysisReady(null));
  }, [session, isAccount, fetchItem]);

  // Preparation is server work: poll its status, never show a fake percent.
  const status = load.state === 'ready' ? load.item.media.status : null;
  useEffect(() => {
    if (status !== 'verifying' && status !== 'processing' && status !== 'pending_upload') return;
    const t = setInterval(() => void fetchItem(), 3000);
    return () => clearInterval(t);
  }, [status, fetchItem]);

  // Analysis polling until a terminal state (complete, partial, failed, cancelled).
  const mediaKind = load.state === 'ready' ? load.item.media.kind : 'photo';
  const explored = analysis ? exploreState(analysis, { kind: mediaKind }) : null;
  useEffect(() => {
    if (!exploring || !analysis) return;
    const next = exploreState(analysis, { kind: mediaKind });
    if (next.kind === 'result') {
      router.push(next.url);
      return;
    }
    if (next.kind === 'failed' || next.kind === 'cancelled') {
      void Promise.resolve().then(() => {
        setExploring(false);
        if (next.kind === 'failed') setAnalysisError(next.message);
      });
      return;
    }
    const t = setTimeout(async () => {
      try {
        setAnalysis(await mediaApi.analysis(id, analysis.analysis_id));
      } catch (err) {
        setAnalysisError(mediaErrorMessage(err));
        setExploring(false);
      }
    }, 2500);
    return () => clearTimeout(t);
  }, [exploring, analysis, id, router, mediaKind]);

  if (load.state === 'signed-out')
    return (
      <div className="v2-page">
        <SignInPanel title="Sign in to see this item." />
      </div>
    );

  const back = (
    <>
      <FlowHeader href="/library" label="Library" arrow="arrow" />
      <Link href="/library" className="v2-back desktop-only">
        <Icon name="arrowLeft" size={22} />
        Back to library
      </Link>
    </>
  );

  if (load.state === 'loading')
    return (
      <div className="v2-page">
        {back}
        <div className="detail" aria-busy="true">
          <div className="skeleton-tile" style={{ aspectRatio: '16 / 9', borderRadius: 10 }} />
          <div>
            <div className="skeleton-line" style={{ height: 40, width: '80%' }} />
            <div className="skeleton-line" />
          </div>
        </div>
        <p className="visually-hidden" role="status">
          Loading…
        </p>
      </div>
    );

  if (load.state === 'error')
    return (
      <div className="v2-page">
        {back}
        <section className="v2-empty">
          <h1 className="v2-empty__title">
            {load.missing ? 'Not in your library' : 'This could not load'}
          </h1>
          <p className="v2-empty__body">{load.message}</p>
          <div className="v2-empty__actions">
            {!load.missing && (
              <button
                type="button"
                className="button button--primary"
                onClick={() => void fetchItem()}
              >
                <Icon name="refresh" size={16} /> Try again
              </button>
            )}
            <Link href="/library" className="button button--outline">
              Back to library
            </Link>
          </div>
        </section>
      </div>
    );

  const item = load.item;
  const m = item.media;
  const isVideo = m.kind === 'video';
  const title = mediaTitle(m);
  const selectedFrame = item.frames.find((f) => f.id === moment) ?? null;
  const captured = new Date(m.created_at);
  const metaLine = [
    SOURCE_LABELS[m.source],
    isVideo && m.duration_ms ? formatDurationWords(m.duration_ms) : null,
    isVideo ? (m.audio_present ? 'Audio on' : 'Audio off') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const canExplore = m.status === 'ready' && analysisReady !== false;
  const exploreLabel = selectedFrame
    ? 'Explore this moment'
    : isVideo
      ? 'Explore this video'
      : 'Explore this photo';

  const explore = async () => {
    setAnalysisError(null);
    // Forget the previous (cancelled or failed) request before polling restarts.
    setAnalysis(null);
    setExploring(true);
    try {
      const res = await mediaApi.analyze(id, {
        mode: !isVideo ? 'photo' : selectedFrame ? 'selected_frame' : 'sampled_video',
        ...(selectedFrame
          ? { frame_id: selectedFrame.id, timestamp_ms: selectedFrame.timestamp_ms }
          : {}),
        expected_generation: item.generation,
      });
      setAnalysis(res);
      watchAnalysis({
        key: `media:${id}`,
        url: `/library/media/${id}`,
        thumbnail: item.links.poster ?? (m.kind === 'photo' ? item.links.original : null),
        poll: async () => {
          const next = exploreState(await mediaApi.analysis(id, res.analysis_id), { kind: m.kind });
          if (next.kind === 'result') return { state: 'ready', url: next.url };
          return next.kind === 'working' || next.kind === 'waiting' ? 'active' : 'gone';
        },
      });
    } catch (err) {
      setExploring(false);
      setAnalysisError(
        err instanceof ApiError &&
          (err.code === 'provider_unavailable' || err.code === 'service_unavailable')
          ? exploreFailureMessage(err.code, { kind: m.kind })
          : mediaErrorMessage(err),
      );
    }
  };

  // Cancels the request on the server (waiting or running); publication is fenced.
  const cancelExplore = async () => {
    if (!analysis) {
      setExploring(false);
      return;
    }
    setCancelling(true);
    try {
      setAnalysis(await mediaApi.cancelAnalysis(id, analysis.analysis_id));
      setExploring(false);
    } catch (err) {
      setAnalysisError(mediaErrorMessage(err, 'It could not be cancelled. Try again.'));
    } finally {
      setCancelling(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await mediaApi.deleteMedia(id, item.generation);
      toast.show({ message: `Deleted ${title}` });
      router.push('/library');
    } catch (err) {
      setDeleteError(
        err instanceof ApiError && err.code === 'conflict'
          ? 'This item changed. Reload the page and try again.'
          : mediaErrorMessage(err, 'It could not be deleted. Try again.'),
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="v2-page media-detail">
      {back}
      <div className="detail">
        <div>
          <MediaStage item={item} seekRef={player} moment={selectedFrame?.thumbnail_url ?? null} />
          <p className="detail__meta">{metaLine}</p>
          {isVideo && item.frames.length > 0 && (
            <section className="moments" aria-labelledby="moments-title">
              <h2 id="moments-title" className="moments__title">
                Moments in this video
              </h2>
              <ul className="moments__list" ref={momentsRef}>
                {item.frames.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className="moment"
                      aria-pressed={moment === f.id}
                      onClick={() => {
                        setMoment((cur) => (cur === f.id ? null : f.id));
                        player.current?.seek(f.timestamp_ms);
                      }}
                    >
                      <img
                        className="moment__img"
                        src={f.thumbnail_url}
                        alt={`Moment at ${formatDuration(f.timestamp_ms)}`}
                        loading="lazy"
                      />
                      <span className="moment__time">{formatDuration(f.timestamp_ms)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside aria-label="About this item">
          <h1 className="detail__title">{title}</h1>
          <p className="detail__subtitle">
            Captured{' '}
            {captured.toLocaleDateString('en-US', {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </p>
          <div className="detail__actions">
            <button
              type="button"
              className="button button--primary detail__primary"
              disabled={!canExplore || exploring}
              aria-describedby="explore-why"
              onClick={() => void explore()}
            >
              {exploring ? 'Exploring…' : exploreLabel}
            </button>
            <button
              type="button"
              className="button detail__secondary"
              onClick={() => setPicking(true)}
              disabled={m.status === 'pending_upload'}
            >
              Save to collection
            </button>
          </div>
          {(analysis?.experimental ?? experimental) && (
            <div className="detail__experimental">
              <ExperimentalBadge
                label={(analysis?.experimental ?? experimental)!.label}
                note={(analysis?.experimental ?? experimental)!.note}
              />
            </div>
          )}
          <div id="explore-why" className="detail-status" aria-live="polite">
            {m.status !== 'ready' && (
              <p className="muted">Exploring is available once this {m.kind} is ready.</p>
            )}
            {m.status === 'ready' && analysisReady === false && (
              <p className="muted">{exploreFailureMessage('analysis_unavailable', { kind: m.kind })}</p>
            )}
            {exploring && (
              <p>
                {explored?.kind === 'waiting' ? (
                  <>{EXPLORE_WAITING}… </>
                ) : (
                  <>
                    Exploring{' '}
                    {selectedFrame ? 'this moment' : isVideo ? 'selected moments' : 'your photo'}
                    …{' '}
                  </>
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={cancelling}
                  onClick={() => void cancelExplore()}
                >
                  Cancel
                </button>
              </p>
            )}
            {analysisError && <V2Notice tone="error">{analysisError}</V2Notice>}
            {exploring && <WhileWeLook collapsed={false} from="discover" />}
            {item.links.analysis && !exploring && (
              <Link href={item.links.analysis} className="text-button">
                See what we found earlier
              </Link>
            )}
          </div>
          {isVideo && (
            <div className="detail__explain">
              <p>{COPY['video.analysis']}</p>
              <button
                type="button"
                className="detail__choose"
                disabled={!item.frames.length}
                onClick={() =>
                  momentsRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
                }
              >
                Choose a moment
              </button>
              {!item.frames.length && m.status === 'ready' && (
                <p className="muted" style={{ fontSize: 14 }}>
                  Moments appear when this video has been prepared.
                </p>
              )}
            </div>
          )}
          <div className="detail__rows">
            <div className="detail-row">
              <h2 style={{ margin: 0, fontSize: 'inherit', fontWeight: 'inherit' }}>
                <button
                  type="button"
                  className="detail-row__button"
                  aria-expanded={detailsOpen}
                  aria-controls={detailsId}
                  onClick={() => setDetailsOpen((o) => !o)}
                >
                  Details
                  <Icon name="chevronDown" size={22} className="detail-row__chevron" />
                </button>
              </h2>
              <div id={detailsId} className="detail-row__panel" hidden={!detailsOpen}>
                <dl className="detail-row__list">
                  <dt>Source</dt>
                  <dd>{SOURCE_LABELS[m.source]}</dd>
                  <dt>Added</dt>
                  <dd>
                    {captured.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                  </dd>
                  <dt>Status</dt>
                  <dd>{statusLabel(m.status, m.kind)}</dd>
                  {m.duration_ms && (
                    <>
                      <dt>Length</dt>
                      <dd>{formatDurationWords(m.duration_ms)}</dd>
                    </>
                  )}
                  {m.width && m.height && (
                    <>
                      <dt>Size</dt>
                      <dd>
                        {m.width} × {m.height}
                      </dd>
                    </>
                  )}
                  {isVideo && (
                    <>
                      <dt>Audio</dt>
                      <dd>{m.audio_present ? 'Recorded with audio' : 'No audio'}</dd>
                    </>
                  )}
                </dl>
              </div>
            </div>
            <div className="detail-row">
              <h2 style={{ margin: 0, fontSize: 'inherit', fontWeight: 'inherit' }}>
                <button
                  type="button"
                  className="detail-row__button"
                  aria-expanded={moreOpen}
                  aria-controls={moreId}
                  onClick={() => setMoreOpen((o) => !o)}
                >
                  More
                  <Icon name="more" size={22} />
                </button>
              </h2>
              <div id={moreId} className="detail-row__panel detail-row__menu" hidden={!moreOpen}>
                {item.links.original ? (
                  <a className="text-button" href={item.links.original} download>
                    Download original
                  </a>
                ) : (
                  <p className="muted">The original can be downloaded once it is stored.</p>
                )}
                <button
                  type="button"
                  className="text-button"
                  style={{ color: 'var(--danger)' }}
                  onClick={() => {
                    setDeleteError(null);
                    setConfirming(true);
                  }}
                >
                  Delete from library
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <CollectionPicker
        open={picking}
        onClose={() => setPicking(false)}
        assetIds={[id]}
        onSaved={(name) => toast.show({ message: `Saved to ${name}` })}
      />
      <ConfirmDelete
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void remove()}
        title={`Delete ${title}?`}
        body={`It is removed from your library and collections on every device. A copy saved on your ${isVideo ? 'phone or computer' : 'device'} is not touched.`}
        confirmLabel="Delete"
        busy={deleting}
        error={deleteError}
      />
    </div>
  );
}

interface PlayerHandle {
  seek(ms: number): void;
}

function MediaStage({
  item,
  seekRef,
  moment,
}: {
  item: MediaDetail;
  seekRef: RefObject<PlayerHandle | null>;
  /** The chosen moment's frame: shown as the still until playback starts. */
  moment: string | null;
}) {
  const m = item.media;
  if (m.kind === 'photo') {
    const src = item.links.playback ?? item.links.original;
    if (m.status === 'ready' && src)
      return (
        <div className="player player--photo">
          <img className="player__photo" src={src} alt={mediaTitle(m)} />
        </div>
      );
  }
  if (m.kind === 'video' && m.status === 'ready' && item.links.playback)
    return (
      <VideoPlayer
        src={item.links.playback}
        poster={moment ?? item.links.poster}
        title={mediaTitle(m)}
        seekRef={seekRef}
        durationMs={m.duration_ms ?? 0}
      />
    );

  const failed = m.status === 'failed';
  return (
    <div className="player">
      <div className="player__status" role="status">
        {item.links.poster && <img src={item.links.poster} alt="" />}
        <div className="player__status-body">
          {failed ? (
            <V2Icon name="alert" size={32} />
          ) : (
            <span className="ring ring--dashed" aria-hidden="true" />
          )}
          <p style={{ fontFamily: 'var(--font-display)', fontSize: 24 }}>
            {statusLabel(m.status, m.kind)}
          </p>
          <p className="muted">
            {failed
              ? item.links.original
                ? 'The original is kept. You can download it or delete it.'
                : 'Delete it and try uploading again.'
              : m.kind === 'video'
                ? 'It will play here when it is ready. You can leave this page.'
                : 'It will appear here when it is ready.'}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Accessible video player: muted by default, real buttons and a labelled seek slider. */
function VideoPlayer({
  src,
  poster,
  title,
  seekRef,
  durationMs,
}: {
  src: string;
  poster: string | null;
  title: string;
  seekRef: RefObject<PlayerHandle | null>;
  durationMs: number;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationMs / 1000);
  const [error, setError] = useState(false);

  useEffect(() => {
    seekRef.current = {
      seek(ms) {
        if (video.current) {
          video.current.currentTime = ms / 1000;
          setTime(ms / 1000);
        }
      },
    };
    return () => {
      seekRef.current = null;
    };
  }, [seekRef]);

  const played = duration ? Math.min(100, (time / duration) * 100) : 0;
  return (
    <div className="player" ref={wrap}>
      <video
        ref={video}
        className="player__video"
        src={src}
        poster={poster ?? undefined}
        muted={muted}
        playsInline
        preload="metadata"
        aria-label={title}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration);
        }}
        onError={() => setError(true)}
        onClick={() => (video.current?.paused ? void video.current.play() : video.current?.pause())}
      />
      {error && (
        <p className="player__error" role="alert">
          This video cannot play in this browser. Download the original from More.
        </p>
      )}
      <div className="player__controls">
        <button
          type="button"
          className="player__button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() =>
            video.current?.paused
              ? void video.current.play().catch(() => setError(true))
              : video.current?.pause()
          }
        >
          <V2Icon name={playing ? 'pause' : 'play'} size={22} />
        </button>
        <input
          type="range"
          className="player__scrub"
          min={0}
          max={Math.max(0.1, duration)}
          step={0.1}
          value={Math.min(time, duration || 0)}
          aria-label="Seek"
          aria-valuetext={`${formatDuration(time * 1000)} of ${formatDuration(duration * 1000)}`}
          style={{ '--played': `${played}%` } as CSSProperties}
          onChange={(e) => {
            const t = Number(e.target.value);
            if (video.current) video.current.currentTime = t;
            setTime(t);
          }}
        />
        <span className="player__time">
          {formatDuration(time * 1000)} / {formatDuration(duration * 1000)}
        </span>
        <button
          type="button"
          className="player__button"
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={!muted}
          onClick={() => setMuted((v) => !v)}
        >
          <V2Icon name={muted ? 'volumeOff' : 'volume'} size={24} />
        </button>
        <button
          type="button"
          className="player__button"
          aria-label="Full screen"
          onClick={() => {
            const el = wrap.current;
            if (!el) return;
            if (document.fullscreenElement) void document.exitFullscreen();
            else void el.requestFullscreen?.().catch(() => undefined);
          }}
        >
          <V2Icon name="fullscreen" size={22} />
        </button>
      </div>
    </div>
  );
}
