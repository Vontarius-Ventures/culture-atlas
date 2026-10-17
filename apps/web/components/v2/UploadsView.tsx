'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSession } from '@/lib/client/session';
import { Icon } from '../Icon';
import { COPY } from './copy';
import { mediaErrorMessage } from './media-api';
import { ACCEPT_MEDIA, formatBytes, formatDurationWords, percent } from './media-format';
import { SignInPanel, V2Notice } from './parts';
import { loadCapabilities, limitsFrom, useUploads } from './uploads-client';
import type { UploadEngine, UploadView } from './upload-engine';
import { V2Icon } from './V2Icon';

/**
 * Uploads (reference 06): one row per file with separate byte-transfer and
 * server-preparation states; pause, retry and cancel per file. Rows come from
 * this device's durable queue (IndexedDB), so they survive reloads and resume
 * without duplicates.
 */
export function UploadsView() {
  const { session, isAccount } = useSession();
  const [limits, setLimits] = useState<ReturnType<typeof limitsFrom> | undefined>(undefined);
  const { items, engine, lockedCount, storageError, ready } = useUploads(limits);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isAccount) return;
    loadCapabilities()
      .then((c) => setLimits(limitsFrom(c)))
      .catch(() => undefined);
  }, [isAccount]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    void Promise.resolve().then(update);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const add = async (files: File[]) => {
    if (!files.length || !engine) return;
    setMessage(null);
    try {
      const ids = await engine.add(files, 'upload');
      const rejected = engine
        .getSnapshot()
        .items.filter((i) => ids.includes(i.client_capture_id) && i.phase === 'rejected').length;
      setMessage(
        rejected
          ? `${ids.length - rejected} added. ${rejected} could not be added; see the reason next to each file.`
          : `${ids.length === 1 ? '1 file' : `${ids.length} files`} added.`,
      );
    } catch (err) {
      setMessage(mediaErrorMessage(err, 'Those files could not be added.'));
    }
  };

  const signedOut = session && !isAccount;
  return (
    <div className="v2-page uploads">
      <div className="v2-head">
        <div>
          <h1 className="v2-title">Uploads</h1>
          <p className="v2-subtitle v2-subtitle--ui">
            Files stay yours. Explore them when you are ready.
          </p>
        </div>
        {!signedOut && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT_MEDIA}
              className="library__upload-input"
              tabIndex={-1}
              aria-hidden="true"
              data-testid="uploads-input"
              onChange={(e) => {
                void add([...(e.target.files ?? [])]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="button button--outline v2-button"
              onClick={() => input.current?.click()}
              style={{ minHeight: 56, borderRadius: 8, borderColor: 'var(--ink)' }}
            >
              <Icon name="plus" size={22} />
              Add files
            </button>
          </>
        )}
      </div>

      {signedOut && <SignInPanel title="Sign in to upload." />}

      <p className="visually-hidden" role="status" aria-live="polite">
        {message}
      </p>

      {!signedOut && (
        <>
          {!online && (
            <div style={{ marginTop: 24 }}>
              <V2Notice>
                You are offline. Files waiting on this device will continue when you reconnect.
              </V2Notice>
            </div>
          )}
          {storageError && (
            <div style={{ marginTop: 24 }}>
              <V2Notice tone="error">
                {storageError} Keep this tab open until uploads finish.
              </V2Notice>
            </div>
          )}
          {lockedCount > 0 && (
            <div style={{ marginTop: 24 }}>
              <V2Notice
                actions={
                  <button
                    type="button"
                    className="button button--outline button--small"
                    onClick={() => void engine?.discardLocked()}
                  >
                    Delete local drafts
                  </button>
                }
              >
                {lockedCount === 1 ? '1 file' : `${lockedCount} files`} from another account{' '}
                {lockedCount === 1 ? 'is' : 'are'} kept on this device.{' '}
                {lockedCount === 1 ? 'It uploads' : 'They upload'} only after that account signs in
                again.
              </V2Notice>
            </div>
          )}

          {ready && items.length === 0 && (
            <div
              className={`uploads__drop${dragging ? ' uploads__drop--active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void add([...e.dataTransfer.files]);
              }}
            >
              <p className="v2-empty__title" style={{ color: 'var(--ink)' }}>
                No uploads in progress.
              </p>
              <p style={{ marginTop: 8 }}>
                Drop photos and videos here, or choose Add files. JPEG, PNG, WebP, MP4, MOV and
                WebM.
              </p>
            </div>
          )}

          {items.length > 0 && (
            <ul
              className="uploads__list"
              aria-label="Uploads"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void add([...e.dataTransfer.files]);
              }}
            >
              {items.map((item) => (
                <UploadRow key={item.client_capture_id} item={item} engine={engine} />
              ))}
            </ul>
          )}

          <div className="uploads__footer">
            <p className="uploads__notice">{COPY['upload.notice']}</p>
            <Link href="/library" className="v2-back desktop-only" style={{ fontSize: 18 }}>
              <Icon name="arrowLeft" size={22} />
              Back to library
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    void Promise.resolve().then(() => setUrl(u));
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [blob]);
  return url;
}

function UploadRow({ item, engine }: { item: UploadView; engine: UploadEngine | null }) {
  const thumb = useObjectUrl(item.thumb ?? (item.kind === 'photo' ? item.blob : null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = item.client_capture_id;
  const meta = [
    item.kind === 'video' ? 'Video' : 'Photo',
    item.kind === 'video' && item.duration_ms
      ? formatDurationWords(item.duration_ms)
      : formatBytes(item.byte_size),
  ].join(' · ');
  const pct = percent(item.sent_bytes, item.byte_size);
  const statusId = `upload-status-${id}`;

  let status: ReactNode;
  let action: ReactNode = null;
  let secondary: ReactNode = null;
  switch (item.phase) {
    case 'ready':
      status = (
        <div className="upload-row__status upload-row__status--ready">
          <V2Icon name="checkCircle" size={30} />
          <span>Ready</span>
        </div>
      );
      action = item.asset_id ? (
        <Link
          href={`/library/media/${item.asset_id}`}
          className="button button--primary v2-button--compact"
          aria-describedby={statusId}
        >
          Open
        </Link>
      ) : null;
      secondary = (
        <button
          type="button"
          className="upload-row__secondary"
          onClick={() => void engine?.dismiss(id)}
        >
          Clear
        </button>
      );
      break;
    case 'queued':
    case 'hashing':
    case 'uploading':
      status = (
        <div className="upload-row__status">
          <div className="progress">
            <div
              className="progress__track"
              role="progressbar"
              aria-label={`Upload progress for ${item.filename}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="progress__fill" style={{ width: `${pct}%` }} />
            </div>
            <p className="progress__label">
              {item.phase === 'queued'
                ? 'Waiting to upload'
                : item.phase === 'hashing'
                  ? 'Getting ready to upload'
                  : `Uploading ${pct}%`}
            </p>
          </div>
        </div>
      );
      action = (
        <button
          type="button"
          className="button button--outline v2-button--compact"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await engine?.cancel(id);
            } catch {
              setError('Could not cancel right now.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Cancel
        </button>
      );
      secondary = (
        <button type="button" className="upload-row__secondary" onClick={() => engine?.pause(id)}>
          Pause
        </button>
      );
      break;
    case 'verifying':
    case 'processing':
      status = (
        <div className="upload-row__status">
          <span className="ring ring--dashed" aria-hidden="true" />
          <span>
            {item.phase === 'verifying'
              ? 'Checking file'
              : item.kind === 'video'
                ? 'Preparing video'
                : 'Preparing photo'}
          </span>
        </div>
      );
      break;
    case 'paused':
      status = (
        <div className="upload-row__status upload-row__status--paused">
          <V2Icon name="alert" size={30} />
          <span className="upload-row__status-text">
            Upload paused
            <span className="upload-row__reason">
              {item.pause_reason === 'user' ? 'Paused. Your file is still selected.' : item.error}
            </span>
          </span>
        </div>
      );
      action = (
        <button
          type="button"
          className="button button--outline v2-button--compact"
          onClick={() => engine?.retry(id)}
          aria-describedby={statusId}
        >
          {item.pause_reason === 'user' ? 'Resume' : 'Retry'}
        </button>
      );
      secondary = (
        <button
          type="button"
          className="upload-row__secondary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await engine?.cancel(id);
            } catch {
              setError('Could not cancel right now.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Cancel
        </button>
      );
      break;
    case 'failed':
    case 'rejected':
      status = (
        <div className={`upload-row__status upload-row__status--${item.phase}`}>
          <V2Icon name="alert" size={30} />
          <span className="upload-row__status-text">
            {item.phase === 'rejected'
              ? 'Not added'
              : item.media_status === 'failed'
                ? 'Could not prepare'
                : 'Upload stopped'}
            <span className="upload-row__reason">{item.error}</span>
          </span>
        </div>
      );
      if (item.phase === 'failed' && item.media_status === 'failed' && item.asset_id)
        action = (
          <Link
            href={`/library/media/${item.asset_id}`}
            className="button button--outline v2-button--compact"
          >
            Open
          </Link>
        );
      else if (item.blob || (item.upload_id && item.phase === 'failed'))
        action = (
          <button
            type="button"
            className="button button--outline v2-button--compact"
            onClick={() => engine?.retry(id)}
          >
            Retry
          </button>
        );
      secondary = (
        <button
          type="button"
          className="upload-row__secondary"
          onClick={() => void engine?.dismiss(id)}
        >
          Remove
        </button>
      );
      break;
  }

  return (
    <li className="upload-row" aria-describedby={statusId}>
      <div className="upload-row__thumb">
        {thumb ? (
          <img src={thumb} alt="" />
        ) : (
          <V2Icon name={item.kind === 'video' ? 'play' : 'library'} size={26} />
        )}
      </div>
      <div className="upload-row__file">
        <p className="upload-row__name">{item.filename}</p>
        <p className="upload-row__meta">{meta}</p>
      </div>
      <div id={statusId} className="upload-row__state">
        {status}
      </div>
      <div className="upload-row__actions">
        {action}
        {secondary}
        {error && (
          <span role="alert" className="upload-row__reason">
            {error}
          </span>
        )}
      </div>
    </li>
  );
}
