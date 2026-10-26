'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '@/lib/client/session';
import { useToast } from '../Toast';
import { Icon } from '../Icon';
import { CORRECTIONS } from './copy';
import { isSignedOutError, mediaApi, mediaErrorMessage, type MediaDetail } from './media-api';
import {
  ACCEPT_MEDIA,
  formatDuration,
  groupByDay,
  mediaMeta,
  mediaTitle,
  SOURCE_LABELS,
  statusLabel,
} from './media-format';
import { CollectionPicker, ConfirmDelete, SignInPanel, V2Notice } from './parts';
import { UploadStatusBar } from './UploadStatusBar';
import { useUploads } from './uploads-client';
import { V2Icon } from './V2Icon';

type Filter = 'all' | 'photo' | 'video' | 'audio' | 'uploading';
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: CORRECTIONS.allFilter },
  { value: 'photo', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Audio' },
  { value: 'uploading', label: 'Uploading' },
];
const IN_FLIGHT = ['pending_upload', 'verifying', 'processing'] as const;

export function thumbFor(m: MediaDetail): string | null {
  if (m.links.poster) return m.links.poster;
  if (m.media.kind === 'photo') return m.links.playback ?? m.links.original;
  return null;
}

/** Library (references 01 desktop, 08 mobile): owned photos and videos, independent of analysis. */
export function LibraryView() {
  const router = useRouter();
  const toast = useToast();
  const { session, isAccount } = useSession();
  const { engine } = useUploads();
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<MediaDetail[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'signed-out'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async (f: Filter, after: string | null = null) => {
    const seq = ++loadSeq.current;
    if (!after) setState((s) => (s === 'ready' ? s : 'loading'));
    try {
      let page: { items: MediaDetail[]; next_cursor: string | null };
      if (f === 'uploading') {
        const pages = await Promise.all(
          IN_FLIGHT.map((status) => mediaApi.library({ status, limit: 60 })),
        );
        page = {
          items: pages
            .flatMap((p) => p.items)
            .sort((a, b) => b.media.created_at.localeCompare(a.media.created_at)),
          next_cursor: null,
        };
      } else {
        page = await mediaApi.library({
          kind: f === 'all' ? undefined : f,
          cursor: after,
          limit: 30,
        });
      }
      if (seq !== loadSeq.current) return;
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setState('ready');
      setError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      if (isSignedOutError(err)) setState('signed-out');
      else {
        setError(mediaErrorMessage(err, 'Your library could not load.'));
        setState(after ? 'ready' : 'error');
      }
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    if (!isAccount) {
      void Promise.resolve().then(() => setState('signed-out'));
      return;
    }
    void Promise.resolve().then(() => load(filter));
  }, [session, isAccount, filter, load]);

  // Refresh when an upload finishes preparing so new media appears.
  const { items: uploads } = useUploads();
  const readyCount = uploads.filter((u) => u.phase === 'ready').length;
  const lastReady = useRef(readyCount);
  useEffect(() => {
    if (readyCount > lastReady.current && state === 'ready')
      void Promise.resolve().then(() => load(filter));
    lastReady.current = readyCount;
  }, [readyCount, state, filter, load]);

  const groups = useMemo(
    () => groupByDay(items.map((i) => ({ ...i, created_at: i.media.created_at }))),
    [items],
  );

  const onFiles = async (list: FileList | null) => {
    if (!list?.length || !engine) return;
    try {
      await engine.add([...list], 'upload');
      router.push('/uploads');
    } catch (err) {
      toast.show({ message: mediaErrorMessage(err, 'Those files could not be added.') });
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelecting(true);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setSelecting(false);
  };

  const deleteSelected = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await mediaApi.batchDelete(
        items
          .filter((i) => selected.has(i.media.id))
          .map((i) => ({ id: i.media.id, expected_generation: i.generation })),
      );
      const gone = new Set(res.items.filter((r) => r.deleted).map((r) => r.id));
      const failed = res.items.length - gone.size;
      setItems((prev) => prev.filter((i) => !gone.has(i.media.id)));
      setSelected(new Set([...selected].filter((id) => !gone.has(id))));
      if (failed)
        setDeleteError(
          `${failed} could not be deleted. They changed since you loaded them; reload and try again.`,
        );
      else {
        setConfirming(false);
        clearSelection();
        toast.show({ message: gone.size === 1 ? 'Deleted 1 item' : `Deleted ${gone.size} items` });
      }
    } catch (err) {
      setDeleteError(mediaErrorMessage(err, 'Nothing was deleted. Try again.'));
    } finally {
      setDeleting(false);
    }
  };

  const uploadButton = (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_MEDIA}
        className="library__upload-input"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="library-upload-input"
        onChange={(e) => {
          void onFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <button
        type="button"
        className="button button--primary v2-button desktop-only"
        onClick={() => fileInput.current?.click()}
      >
        <Icon name="upload" size={22} />
        Upload files
      </button>
    </>
  );

  return (
    <div className={`v2-page library${selecting ? ' library__selecting' : ''}`}>
      <div className="v2-head">
        <div>
          <h1 className="v2-title">Your library</h1>
          <p className="v2-subtitle">Photos, videos and audio you have kept.</p>
        </div>
        {state !== 'signed-out' && uploadButton}
      </div>

      {state === 'signed-out' && <SignInPanel title="Your library is private." />}

      {state !== 'signed-out' && (
        <>
          <div className="library__bar">
            <div className="library__filters" role="group" aria-label="Show">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className="chip"
                  aria-pressed={filter === f.value}
                  onClick={() => {
                    clearSelection();
                    setFilter(f.value);
                  }}
                >
                  {f.label}
                </button>
              ))}
              {items.length > 0 && (
                <button
                  type="button"
                  className="button button--text mobile-only library__select-mobile"
                  onClick={() => (selecting ? clearSelection() : setSelecting(true))}
                >
                  {selecting ? 'Cancel' : 'Select'}
                </button>
              )}
            </div>
            {items.length > 0 && (
              <label className="select-toggle library__select-desktop">
                <input
                  type="checkbox"
                  className="v2-check"
                  checked={selecting}
                  onChange={(e) => (e.target.checked ? setSelecting(true) : clearSelection())}
                />
                Select
              </label>
            )}
          </div>

          {state === 'loading' && (
            <div aria-busy="true">
              <p className="visually-hidden" role="status">
                Loading your library…
              </p>
              <ul className="media-grid library__days" aria-hidden="true" style={{ marginTop: 52 }}>
                {Array.from({ length: 8 }, (_, i) => (
                  <li key={i}>
                    <div className="skeleton-tile" />
                    <div className="skeleton-line" />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {state === 'error' && (
            <div style={{ marginTop: 32 }}>
              <V2Notice
                tone="error"
                actions={
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => void load(filter)}
                  >
                    <Icon name="refresh" size={16} /> Try again
                  </button>
                }
              >
                {error}
              </V2Notice>
            </div>
          )}

          {state === 'ready' && items.length === 0 && (
            <section className="v2-empty" aria-labelledby="library-empty">
              <h2 id="library-empty" className="v2-empty__title">
                {filter === 'all'
                  ? 'Nothing kept yet.'
                  : filter === 'uploading'
                    ? 'Nothing is uploading.'
                    : `No ${
                        filter === 'photo' ? 'photos' : filter === 'audio' ? 'audio' : 'videos'
                      } yet.`}
              </h2>
              <p className="v2-empty__body">
                {filter === 'uploading'
                  ? 'Files you add appear here until they are ready.'
                  : 'Take a photo, record a moment, or upload something you already have.'}
              </p>
              <div className="v2-empty__actions">
                <Link href="/capture/camera?start=1" className="button button--primary v2-button">
                  <Icon name="camera" size={22} /> Open camera
                </Link>
                <button
                  type="button"
                  className="button button--outline v2-button"
                  onClick={() => fileInput.current?.click()}
                >
                  <Icon name="upload" size={22} /> Upload files
                </button>
              </div>
            </section>
          )}

          {state === 'ready' && items.length > 0 && (
            <div className="library__days">
              {error && <V2Notice tone="error">{error}</V2Notice>}
              {groups.map((g) => (
                <section key={g.label} aria-label={g.label}>
                  <h2 className="library__day">{g.label}</h2>
                  <ul className="media-grid">
                    {g.items.map((m) => (
                      <MediaCard
                        key={m.media.id}
                        item={m}
                        selecting={selecting}
                        selected={selected.has(m.media.id)}
                        onToggle={() => toggle(m.media.id)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              {cursor && (
                <div className="library__more">
                  <button
                    type="button"
                    className="button button--outline"
                    disabled={loadingMore}
                    onClick={async () => {
                      setLoadingMore(true);
                      await load(filter, cursor);
                      setLoadingMore(false);
                    }}
                  >
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </button>
                </div>
              )}
            </div>
          )}

          {selected.size > 0 && (
            <div className="library__selection" role="region" aria-label="Selection">
              <p className="library__selection-count" aria-live="polite">
                {selected.size} selected
              </p>
              <button type="button" className="button button--text" onClick={clearSelection}>
                Clear
              </button>
              <button
                type="button"
                className="button button--outline"
                onClick={() => setPicking(true)}
              >
                Save to collection
              </button>
              <button
                type="button"
                className="button button--danger"
                onClick={() => {
                  setDeleteError(null);
                  setConfirming(true);
                }}
              >
                Delete
              </button>
            </div>
          )}
          {selected.size === 0 && <UploadStatusBar variant="desktop" />}
        </>
      )}

      <ConfirmDelete
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => void deleteSelected()}
        title={selected.size === 1 ? 'Delete this item?' : `Delete ${selected.size} items?`}
        body="They are removed from your library and collections on every device. Copies on your phone or computer are not touched."
        confirmLabel="Delete"
        busy={deleting}
        error={deleteError}
      />
      <CollectionPicker
        open={picking}
        onClose={() => setPicking(false)}
        assetIds={[...selected]}
        onSaved={(name, count) => {
          toast.show({ message: `Saved ${count === 1 ? '1 item' : `${count} items`} to ${name}` });
          clearSelection();
        }}
      />
    </div>
  );
}

function MediaCard({
  item,
  selecting,
  selected,
  onToggle,
}: {
  item: MediaDetail;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const m = item.media;
  const title = mediaTitle(m);
  const thumb = thumbFor(item);
  const [broken, setBroken] = useState(false);
  const href = `/library/media/${m.id}`;
  return (
    <li className={`media-card${selected ? ' media-card--selected' : ''}`}>
      <label className="media-card__select">
        <input
          type="checkbox"
          className="v2-check"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${title}`}
        />
      </label>
      <div className="media-card__frame">
        {thumb && !broken ? (
          <img
            className="media-card__img"
            src={thumb}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="media-card__placeholder">
            {m.status === 'ready'
              ? m.kind === 'video'
                ? 'Video'
                : m.kind === 'audio'
                  ? 'Recording'
                  : 'Photo'
              : statusLabel(m.status, m.kind)}
          </span>
        )}
        {(m.kind === 'video' || m.kind === 'audio') && m.status === 'ready' && (
          <>
            <span className="media-card__play" aria-hidden="true">
              <V2Icon name={m.kind === 'video' ? 'play' : 'volume'} size={16} />
            </span>
            {m.duration_ms && (
              <span className="media-card__duration">{formatDuration(m.duration_ms)}</span>
            )}
          </>
        )}
        {m.status !== 'ready' && thumb && !broken && (
          <span className="media-card__state">
            {m.status === 'failed' ? (
              <V2Icon name="alert" size={14} />
            ) : (
              <span className="ring" style={{ width: 12, height: 12, borderWidth: 2 }} />
            )}
            {statusLabel(m.status, m.kind)}
          </span>
        )}
      </div>
      <h3 className="media-card__title">
        {selecting ? (
          <button
            type="button"
            className="media-card__link"
            onClick={onToggle}
            aria-pressed={selected}
            style={{
              border: 0,
              background: 'none',
              padding: 0,
              font: 'inherit',
              cursor: 'pointer',
            }}
          >
            {title}
          </button>
        ) : m.kind === 'audio' ? (
          // The web media detail is photo/video only for now; a recording lists
          // and deletes here, but does not open yet.
          <span>{title}</span>
        ) : (
          <Link className="media-card__link" href={href}>
            {title}
          </Link>
        )}
      </h3>
      <p className="media-card__meta">{mediaMeta(m)}</p>
      <p className="media-card__meta media-card__meta--mobile">
        {m.status === 'ready'
          ? SOURCE_LABELS[m.source]
          : `${SOURCE_LABELS[m.source]} · ${statusLabel(m.status, m.kind)}`}
      </p>
    </li>
  );
}
