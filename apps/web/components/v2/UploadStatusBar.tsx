'use client';

import Link from 'next/link';
import { Icon } from '../Icon';
import { percent } from './media-format';
import { useUploads } from './uploads-client';
import { V2Icon } from './V2Icon';

const ACTIVE = new Set(['queued', 'hashing', 'uploading', 'verifying', 'processing']);

/**
 * Durable upload status, visible while files are moving or need attention:
 * desktop floating bar on the Library (reference 01) and the mobile recovery
 * strip above Capture (reference 08). Paused/failed uploads offer Retry.
 * Status is text plus an icon, never color alone.
 */
export function UploadStatusBar({ variant }: { variant: 'desktop' | 'mobile' }) {
  const { items, engine } = useUploads();
  const stuck = items.filter(
    (i) => i.phase === 'paused' || (i.phase === 'failed' && (i.blob || i.upload_id)),
  );
  const active = items.filter((i) => ACTIVE.has(i.phase));
  if (!engine || (!stuck.length && !active.length)) return null;

  if (stuck.length) {
    const offline = stuck.every((i) => i.pause_reason === 'offline');
    return (
      <div className={`upload-bar upload-bar--${variant}`} role="status">
        <V2Icon name="cloudUpload" size={24} />
        <p className="upload-bar__text">
          <span className="upload-bar__title">
            {stuck.length === 1 ? '1 upload paused' : `${stuck.length} uploads paused`}
          </span>
          {variant === 'desktop' && (
            <span className="upload-bar__sub">
              <br />
              {offline ? 'Connection lost. Your files are still selected.' : 'Retry to continue.'}
            </span>
          )}
        </p>
        <button
          type="button"
          className="upload-bar__action"
          onClick={() => stuck.forEach((i) => engine.retry(i.client_capture_id))}
        >
          Retry
        </button>
        {variant === 'desktop' && (
          <Link href="/uploads" className="upload-bar__action">
            View uploads
            <Icon name="arrowRight" size={18} />
          </Link>
        )}
      </div>
    );
  }

  const total = active.reduce((n, i) => n + i.byte_size, 0);
  const sent = active.reduce((n, i) => n + i.sent_bytes, 0);
  const allSent = active.every((i) => i.phase === 'verifying' || i.phase === 'processing');
  const sub = allSent ? 'Preparing your files' : `${percent(sent, total)}% sent`;
  return (
    <div className={`upload-bar upload-bar--${variant}`} role="status">
      <span className="ring" aria-hidden="true" />
      <p className="upload-bar__text">
        <span className="upload-bar__title">
          {active.length === 1 ? '1 file uploading' : `${active.length} files uploading`}
        </span>
        <br />
        <span className="upload-bar__sub">{sub}</span>
      </p>
      <Link href="/uploads" className="upload-bar__action">
        View uploads
        {variant === 'desktop' && <Icon name="arrowRight" size={18} />}
      </Link>
    </div>
  );
}
