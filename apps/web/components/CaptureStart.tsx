'use client';

import { useRouter } from 'next/navigation';
import { useId, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { api, ApiError, newIdempotencyKey } from '@/lib/client/api';
import { ACCEPT_ATTR, SAMPLE_EXAMPLES, type SampleExample } from '@/lib/client/samples';
import { setCapturePreview, setPendingCapture } from '@/lib/client/store';
import { Dialog } from './Dialog';
import { Icon } from './Icon';

export const AI_NOTICE =
  'Photos you submit are analyzed by AI services to find related discoveries.';

/** Starts a capture from one of the supplied example photos. */
export async function startExample(sample: SampleExample) {
  const res = await api.request('createCapture', {
    body: { sample_id: sample.id, source: 'sample' },
    idempotencyKey: newIdempotencyKey(),
  });
  setCapturePreview(res.capture_id, sample.image);
  return res;
}

/**
 * "Take a photo", "Upload a photo", "Try an example". File inputs live here so
 * the picker opens from the user's own click; the chosen file is handed to /capture.
 */
export function CaptureStart({
  onFile,
  layout = 'row',
}: {
  onFile?: (file: File, source: 'camera' | 'upload') => void;
  layout?: 'row' | 'stack' | 'examples-only';
}) {
  const router = useRouter();
  const cameraId = useId();
  const uploadId = useId();
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = (source: 'camera' | 'upload') => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (onFile) onFile(file, source);
    else {
      setPendingCapture(file, source);
      router.push('/capture');
    }
  };

  return (
    <div className={`capture-start capture-start--${layout}`}>
      <div className="capture-start__actions">
        {layout !== 'examples-only' && (
          <>
            <input
              id={cameraId}
              type="file"
              accept="image/*"
              capture="environment"
              className="visually-hidden file-input"
              onChange={handle('camera')}
              tabIndex={-1}
              aria-hidden="true"
            />
            <label
              htmlFor={cameraId}
              className="button button--primary"
              tabIndex={0}
              role="button"
              onKeyDown={keyActivate}
            >
              <Icon name="camera" />
              <span>Take a photo</span>
            </label>
            <input
              id={uploadId}
              type="file"
              accept={ACCEPT_ATTR}
              className="visually-hidden file-input"
              onChange={handle('upload')}
              tabIndex={-1}
              aria-hidden="true"
              data-testid="upload-input"
            />
            <label
              htmlFor={uploadId}
              className="button button--outline"
              tabIndex={0}
              role="button"
              onKeyDown={keyActivate}
            >
              <Icon name="upload" />
              <span>Upload a photo</span>
            </label>
          </>
        )}
        <button
          type="button"
          className="button button--outline"
          onClick={() => setExamplesOpen(true)}
        >
          <Icon name="image" />
          <span>Try an example</span>
        </button>
      </div>
      {layout !== 'examples-only' && <p className="ai-notice">{AI_NOTICE}</p>}
      <Dialog
        open={examplesOpen}
        onClose={() => setExamplesOpen(false)}
        title="Try an example"
        variant="sheet"
      >
        <ul className="examples">
          {SAMPLE_EXAMPLES.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="example"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(s.id);
                  setError(null);
                  try {
                    const res = await startExample(s);
                    setExamplesOpen(false);
                    router.push(`/captures/${res.capture_id}?job=${res.job_id}`);
                  } catch (err) {
                    setError(
                      err instanceof ApiError ? err.message : 'That example could not be started.',
                    );
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                <img src={s.image} alt="" className="example__img" />
                <span className="example__label">{busy === s.id ? 'Starting…' : s.label}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </div>
  );
}

/** Labels styled as buttons open their file input with Enter/Space too. */
function keyActivate(e: KeyboardEvent<HTMLLabelElement>) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.currentTarget.click();
  }
}
