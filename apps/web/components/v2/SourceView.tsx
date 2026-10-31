'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '@/lib/client/session';
import { setPendingCapture, takePendingCapture } from '@/lib/client/store';
import { Icon } from '../Icon';
import { COPY } from './copy';
import { mediaErrorMessage, type Capabilities } from './media-api';
import { ACCEPT_MEDIA, glassesEntryLine } from './media-format';
import { ExperimentalBadge, FlowHeader, V2Notice } from './parts';
import { loadCapabilities, limitsFrom, useUploads } from './uploads-client';
import { V2Icon } from './V2Icon';

/** Capture source chooser (reference 02): This camera, Meta glasses (Experimental), Upload files. */
export function SourceView() {
  const router = useRouter();
  const { session, isAccount } = useSession();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const { engine } = useUploads(caps ? limitsFrom(caps) : undefined);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // A photo chosen on Discover still goes to the photo discovery flow.
  useEffect(() => {
    const pending = takePendingCapture();
    if (pending) {
      setPendingCapture(pending.file, pending.source);
      router.replace('/capture/photo');
    }
  }, [router]);

  useEffect(() => {
    if (!isAccount) return;
    loadCapabilities()
      .then(setCaps)
      .catch(() => setCaps(null));
  }, [isAccount]);

  // A browser never captures from glasses itself; it explains setup and hands
  // off to the phone. Only release/account blockers say "not available".
  const glassesLine = glassesEntryLine(caps?.availability.meta_glasses);
  const signedOut = session && !isAccount;

  const onFiles = async (files: File[]) => {
    if (!files.length) return;
    if (!engine || signedOut) {
      setError('Sign in to upload to your library.');
      return;
    }
    try {
      await engine.add(files, 'upload');
      router.push('/uploads');
    } catch (err) {
      setError(mediaErrorMessage(err, 'Those files could not be added.'));
    }
  };

  return (
    <div className="source">
      <FlowHeader href="/" label="Back" />
      <h1 className="source__title">{COPY['capture.title']}</h1>
      <p className="source__lede">
        Take a photo, record a moment, or upload something you already have.
      </p>
      <img className="source__hero" src="/capture/source-hero.jpg" alt="" />

      {signedOut && (
        <div style={{ marginTop: 20 }}>
          <V2Notice
            actions={
              <>
                <Link href="/identity" className="button button--primary button--small">
                  Sign in
                </Link>
              </>
            }
          >
            Sign in to read your photos and keep them in your private library.
          </V2Notice>
        </div>
      )}

      <ul className="source__options" aria-label="Choose how to capture">
        <li>
          <Link href="/capture/camera?start=1" className="source-option">
            <Icon name="camera" size={34} className="source-option__icon" />
            <span>
              <span className="source-option__title">{COPY['capture.camera']}</span>
              <span className="source-option__sub">Take a photo or record a video</span>
            </span>
            <Icon name="chevronRight" size={24} />
          </Link>
        </li>
        <li>
          <Link href="/capture/music" className="source-option">
            <V2Icon name="mic" size={34} className="source-option__icon" />
            <span>
              <span className="source-option__title">Music</span>
              <span className="source-option__sub">Record what you hear, camera off</span>
            </span>
            <Icon name="chevronRight" size={24} />
          </Link>
        </li>
        <li>
          <Link href="/capture/glasses" className="source-option">
            <V2Icon name="glasses" size={38} className="source-option__icon" />
            <span>
              <span className="source-option__title">
                {COPY['capture.glasses']}
                <ExperimentalBadge />
              </span>
              <span className="source-option__sub">
                {glassesLine}
              </span>
            </span>
            <Icon name="chevronRight" size={24} />
          </Link>
        </li>
        <li>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT_MEDIA}
            className="library__upload-input"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="source-upload-input"
            onChange={(e) => {
              void onFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <button type="button" className="source-option" onClick={() => input.current?.click()}>
            <Icon name="image" size={34} className="source-option__icon" />
            <span>
              <span className="source-option__title">{COPY['capture.upload']}</span>
              <span className="source-option__sub">Choose photos and videos</span>
            </span>
            <Icon name="chevronRight" size={24} />
          </button>
        </li>
      </ul>
      {error && (
        <p className="form-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      <p className="source__private">{COPY['capture.private']}</p>
    </div>
  );
}
