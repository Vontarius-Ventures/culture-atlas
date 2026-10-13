'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { useAsyncEffect } from '@/lib/client/hooks';
import { cropImageFile, FULL_CROP, isFullCrop, type CropBox } from '@/lib/client/crop';
import { ACCEPT_ATTR, checkImageFile, isHeic, UPLOAD_GUIDANCE } from '@/lib/client/samples';
import { setCapturePreview, takePendingCapture } from '@/lib/client/store';
import { AI_NOTICE, CaptureStart } from '../CaptureStart';
import { CropFrame } from '../CropFrame';
import { Icon } from '../Icon';
import { Notice } from '../ui';

interface Selection {
  file: File;
  source: 'camera' | 'upload';
  url: string | null;
}

/** Messages for server-side intake errors; the selection stays available. */
export function intakeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'unsupported_image')
      return /JPEG/.test(err.message) ? err.message : `${err.message} ${UPLOAD_GUIDANCE}`;
    if (err.code === 'payload_too_large') return `That photo is too large. ${UPLOAD_GUIDANCE}`;
    return err.message;
  }
  return 'That photo could not be sent. Try again.';
}

/**
 * Capture: choose or take a photo, preview it, optionally crop, then Discover.
 * No analysis settings panel. Unsupported/oversized files explain the accepted
 * formats and keep the selection available.
 */
export function CaptureView() {
  const router = useRouter();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [problem, setProblem] = useState<{ message: string; blocking: boolean } | null>(null);
  const [cropping, setCropping] = useState(false);
  const [crop, setCrop] = useState<CropBox>(FULL_CROP);
  const [busy, setBusy] = useState(false);

  const choose = (file: File, source: 'camera' | 'upload') => {
    const check = checkImageFile(file);
    setProblem(check ? { message: check.message, blocking: true } : null);
    setCrop(FULL_CROP);
    setCropping(false);
    setSelection((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return { file, source, url: isHeic(file) ? null : URL.createObjectURL(file) };
    });
  };

  useAsyncEffect(() => {
    const pending = takePendingCapture();
    if (pending) choose(pending.file, pending.source);
  }, []);

  const discover = async () => {
    if (!selection || problem?.blocking) return;
    setBusy(true);
    setProblem(null);
    try {
      const blob = selection.url ? await cropImageFile(selection.file, crop) : selection.file;
      const form = new FormData();
      const name =
        blob === selection.file
          ? selection.file.name
          : selection.file.name.replace(/\.[^.]+$/, '') + '-crop.jpg';
      form.set('image', blob, name);
      form.set('source', selection.source);
      const res = await api.request('createCapture', {
        body: form,
        idempotencyKey: newIdempotencyKey(),
      });
      if (selection.url)
        setCapturePreview(
          res.capture_id,
          blob === selection.file ? selection.url : URL.createObjectURL(blob),
        );
      router.push(`/captures/${res.capture_id}?job=${res.job_id}`);
    } catch (err) {
      setProblem({ message: intakeErrorMessage(err), blocking: false });
      setBusy(false);
    }
  };

  if (!selection) {
    return (
      <div className="page page--narrow capture">
        <h1 className="display display--medium">Capture something you like.</h1>
        <CaptureStart onFile={choose} layout="stack" />
      </div>
    );
  }

  return (
    <div className="page page--narrow capture">
      <h1 className="display display--medium">Ready to discover</h1>
      <div className={`capture__preview${cropping ? ' capture__preview--cropping' : ''}`}>
        {selection.url ? (
          <div className="capture__image-wrap">
            <img src={selection.url} alt="Your selected photo" className="capture__image" />
            {cropping && <CropFrame box={crop} onChange={setCrop} />}
          </div>
        ) : (
          <div className="capture__no-preview">
            <Icon name="image" size={32} />
            <p>{selection.file.name}</p>
            <p className="muted">This photo can’t be previewed here.</p>
          </div>
        )}
      </div>
      {problem && <Notice tone="error">{problem.message}</Notice>}
      <div className="capture__actions">
        {selection.url && (
          <button
            type="button"
            className="button button--quiet"
            aria-pressed={cropping}
            onClick={() => setCropping((c) => !c)}
          >
            <Icon name="crop" />
            <span>{cropping ? (isFullCrop(crop) ? 'Done' : 'Keep crop') : 'Crop'}</span>
          </button>
        )}
        {cropping && !isFullCrop(crop) && (
          <button type="button" className="button button--text" onClick={() => setCrop(FULL_CROP)}>
            Reset crop
          </button>
        )}
        <label
          className="button button--quiet"
          tabIndex={0}
          role="button"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.currentTarget.click();
            }
          }}
        >
          <Icon name="upload" />
          <span>Choose another</span>
          <input
            type="file"
            accept={ACCEPT_ATTR}
            className="visually-hidden file-input"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="replace-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) choose(file, 'upload');
            }}
          />
        </label>
        <button
          type="button"
          className="button button--primary button--large"
          onClick={() => void discover()}
          disabled={busy || Boolean(problem?.blocking)}
        >
          {busy ? 'Sending…' : 'Discover'}
        </button>
      </div>
      <p className="ai-notice">{AI_NOTICE}</p>
    </div>
  );
}
