'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSession } from '@/lib/client/session';
import { Icon } from '../Icon';
import { COPY, CORRECTIONS } from './copy';
import {
  CAMERA_PROBLEM_TEXT,
  cameraProblem,
  captureFileName,
  limitText,
  pickRecorderType,
  type CameraProblem,
} from './camera-logic';
import { mediaErrorMessage, type Capabilities } from './media-api';
import { ACCEPT_MEDIA, DEFAULT_LIMITS, deviceNoun, formatDuration, percent } from './media-format';
import { loadCapabilities, limitsFrom, useUploads } from './uploads-client';
import { V2Icon } from './V2Icon';

type Phase = 'idle' | 'starting' | 'live' | 'recording' | 'finalizing' | 'review' | 'problem';
type Mic = 'off' | 'requesting' | 'on' | 'denied' | 'unavailable' | 'timed-out';

// Browsers can leave getUserMedia pending forever when a prompt is ignored.
const MIC_PERMISSION_WAIT_MS = 8000;

interface Draft {
  blob: Blob;
  url: string;
  kind: 'photo' | 'video';
  extension: string;
  interrupted: boolean;
}

const coarseQuery = '(pointer: coarse)';
function useCoarsePointer() {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(coarseQuery);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(coarseQuery).matches,
    () => true,
  );
}

/**
 * Browser camera (reference 03): live preview, Photo/Video switch, visible
 * microphone state (off by default; asked only when turned on), elapsed and
 * limit countdown, Stop. Photos get Retake/Keep and videos Keep/Delete before
 * anything uploads; Keep stores the file on this device first, then uploads.
 * Without camera APIs the screen falls back to a file picker.
 */
export function CameraView() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, isAccount } = useSession();
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const limits = caps ? limitsFrom(caps) : DEFAULT_LIMITS;
  const { engine, items } = useUploads(caps ? limits : undefined);
  const noun = deviceNoun(useCoarsePointer());

  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [mode, setMode] = useState<'photo' | 'video'>('photo');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [canFlip, setCanFlip] = useState(false);
  const [mic, setMic] = useState<Mic>('off');
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kept, setKept] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [announce, setAnnounce] = useState('');

  const videoEl = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const cameraRequest = useRef(0);
  const micRequest = useRef(0);
  const micDeadline = useRef<number | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const interrupted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const shutter = useRef<HTMLButtonElement>(null);

  const limitMs = limits.capture_video_max_duration_ms;
  const videoAllowed = caps ? caps.flags.camera_video !== false : true;

  useEffect(() => {
    if (!isAccount) return;
    loadCapabilities()
      .then(setCaps)
      .catch(() => setCaps(null));
  }, [isAccount]);

  const cancelMicRequest = useCallback(() => {
    micRequest.current += 1;
    if (micDeadline.current !== null) window.clearTimeout(micDeadline.current);
    micDeadline.current = null;
  }, []);

  const stopMicrophone = useCallback(() => {
    cancelMicRequest();
    audio.current?.getTracks().forEach((t) => t.stop());
    audio.current = null;
  }, [cancelMicRequest]);

  const stopTracks = useCallback(() => {
    cameraRequest.current += 1;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    stopMicrophone();
  }, [stopMicrophone]);

  const start = async (which: 'environment' | 'user' = facing) => {
    if (!mounted.current) return;
    const request = ++cameraRequest.current;
    setNotice(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setProblem(window.isSecureContext === false ? 'insecure' : 'unavailable');
      setPhase('problem');
      return;
    }
    setPhase('starting');
    stream.current?.getVideoTracks().forEach((t) => t.stop());
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: which }, width: { ideal: 1920 }, height: { ideal: 1440 } },
        audio: false,
      });
      if (request !== cameraRequest.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      if (videoEl.current) {
        videoEl.current.srcObject = s;
        await videoEl.current.play().catch(() => undefined);
      }
      if (request !== cameraRequest.current) return;
      s.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (request !== cameraRequest.current) return;
        if (recorder.current?.state === 'recording') {
          interrupted.current = true;
          recorder.current.stop();
        }
        setNotice('The camera stopped. Any recording so far is kept for review.');
      });
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      if (request !== cameraRequest.current) return;
      setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1);
      setProblem(null);
      setPhase('live');
    } catch (err) {
      if (request !== cameraRequest.current) return;
      setProblem(cameraProblem(err));
      setPhase('problem');
    }
  };

  // Permission is requested on action: arriving from "This camera" counts; a direct visit asks first.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || params.get('start') !== '1') return;
    autoStarted.current = true;
    void Promise.resolve().then(() => start());
    // start() reads only refs and setters; run once per arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTracks();
    };
  }, [stopTracks]);

  const finishRecording = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    if (recorder.current && recorder.current.state !== 'inactive') {
      setPhase('finalizing');
      recorder.current.stop();
    }
  };

  // Interruptions stop safely and keep what was recorded.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && recorder.current?.state === 'recording') {
        interrupted.current = true;
        finishRecording();
      }
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  const toggleMic = async () => {
    if (mic === 'on') {
      stopMicrophone();
      setMic('off');
      return;
    }
    if (mic === 'requesting') return;
    if (!navigator.mediaDevices?.getUserMedia) {
      setMic('unavailable');
      return;
    }
    cancelMicRequest();
    const request = micRequest.current;
    setMic('requesting');
    micDeadline.current = window.setTimeout(() => {
      cancelMicRequest();
      setMic('timed-out');
    }, MIC_PERMISSION_WAIT_MS);
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // getUserMedia cannot be aborted. Dispose grants arriving after timeout,
      // navigation, a mode change or a silent recording; never attach them later.
      if (request !== micRequest.current) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      cancelMicRequest();
      audio.current = acquired;
      setMic('on');
    } catch (err) {
      if (request !== micRequest.current) return;
      cancelMicRequest();
      setMic(cameraProblem(err) === 'denied' ? 'denied' : 'unavailable');
    }
  };

  const takePhoto = async () => {
    const v = videoEl.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) {
      setNotice('The photo could not be taken. Try again.');
      return;
    }
    setDraft({
      blob,
      url: URL.createObjectURL(blob),
      kind: 'photo',
      extension: 'jpg',
      interrupted: false,
    });
    setPhase('review');
  };

  const startRecording = () => {
    const s = stream.current;
    if (!s) return;
    const type =
      typeof MediaRecorder !== 'undefined'
        ? pickRecorderType((t) => MediaRecorder.isTypeSupported(t))
        : null;
    if (!type) {
      setNotice('This browser cannot record video. Take a photo or upload a video file instead.');
      return;
    }
    if (mic === 'requesting') {
      cancelMicRequest();
      setMic('off');
    }
    const tracks = [
      ...s.getVideoTracks(),
      ...(mic === 'on' && audio.current ? audio.current.getAudioTracks() : []),
    ];
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: type.mimeType });
    chunks.current = [];
    interrupted.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: type.contentType });
      recorder.current = null;
      if (!blob.size) {
        setNotice('Nothing was recorded. Try again.');
        setPhase(stream.current ? 'live' : 'idle');
        return;
      }
      setDraft({
        blob,
        url: URL.createObjectURL(blob),
        kind: 'video',
        extension: type.extension,
        interrupted: interrupted.current,
      });
      setPhase('review');
    };
    rec.start(1000);
    recorder.current = rec;
    startedAt.current = performance.now();
    setElapsed(0);
    setPhase('recording');
    setAnnounce('Recording started');
    timer.current = window.setInterval(() => {
      const ms = performance.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= limitMs) {
        setAnnounce('Time limit reached. Recording stopped.');
        finishRecording();
      }
    }, 250);
  };

  const discard = () => {
    if (draft) URL.revokeObjectURL(draft.url);
    setDraft(null);
    setKept(null);
    setPhase(stream.current ? 'live' : 'idle');
    queueMicrotask(() => shutter.current?.focus());
  };

  const keep = async () => {
    if (!draft) return;
    if (!engine || !isAccount) {
      setNotice(
        'Sign in to keep this in your library. Until then, you can save it to this device.',
      );
      return;
    }
    try {
      const at = new Date();
      const file = new File([draft.blob], captureFileName(draft.kind, draft.extension, at), {
        type: draft.blob.type,
        lastModified: at.getTime(),
      });
      const [id] = await engine.add([file], 'browser_camera');
      setKept(id ?? null);
      setAnnounce(`Saved on this ${noun}`);
    } catch (err) {
      setNotice(mediaErrorMessage(err, 'This could not be saved. Try again.'));
    }
  };

  const keptItem = kept ? items.find((i) => i.client_capture_id === kept) : null;
  const keptStatus = keptItem
    ? keptItem.phase === 'rejected' || keptItem.phase === 'failed'
      ? (keptItem.error ?? 'This could not be uploaded.')
      : keptItem.phase === 'paused'
        ? `Saved on this ${noun}. Upload paused: ${keptItem.error ?? 'retry from Uploads.'}`
        : keptItem.phase === 'queued' || keptItem.phase === 'hashing'
          ? `Saved on this ${noun}`
          : keptItem.phase === 'uploading'
            ? `Uploading ${percent(keptItem.sent_bytes, keptItem.byte_size)}%`
            : keptItem.phase === 'ready'
              ? 'In your library'
              : 'Uploaded. Preparing…'
    : null;

  const close = () => {
    if (recorder.current?.state === 'recording') finishRecording();
    stopTracks();
    router.push('/capture');
  };

  const recording = phase === 'recording';
  const limit = limitText(elapsed, limitMs, recording);
  const micLabel =
    mic === 'on'
      ? 'Microphone on'
      : mic === 'requesting'
        ? 'Asking for microphone…'
        : mic === 'denied'
          ? 'Microphone blocked'
          : mic === 'unavailable'
            ? 'No microphone'
            : 'Microphone off';
  const note =
    phase === 'recording'
      ? CORRECTIONS.recording.replace('phone', noun)
      : phase === 'finalizing'
        ? `Saving on this ${noun}…`
        : `Saved on this ${noun} before upload.`;

  const onPickedFile = (file: File | undefined) => {
    if (!file) return;
    stopMicrophone();
    setMic('off');
    const kind = file.type.startsWith('video/') ? 'video' : 'photo';
    setDraft({
      blob: file,
      url: URL.createObjectURL(file),
      kind,
      extension: /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? (kind === 'photo' ? 'jpg' : 'mp4'),
      interrupted: false,
    });
    setPhase('review');
  };

  return (
    <div className="camera">
      <div className="camera__top">
        <Link
          href="/capture"
          className="camera__close"
          onClick={(e) => {
            e.preventDefault();
            close();
          }}
        >
          Close
        </Link>
        <div className="camera__source">
          <button
            type="button"
            className="camera__source-button"
            aria-expanded={menuOpen}
            aria-haspopup="true"
            aria-controls="camera-source-menu"
            onClick={() => setMenuOpen((o) => !o)}
            disabled={recording}
          >
            {COPY['capture.camera']}
            <Icon name="chevronDown" size={18} />
          </button>
          <ul id="camera-source-menu" className="camera__source-menu" hidden={!menuOpen}>
            <li>
              <button
                type="button"
                className="camera__source-item"
                aria-current="true"
                onClick={() => setMenuOpen(false)}
              >
                <Icon name="camera" /> {COPY['capture.camera']}
              </button>
            </li>
            <li>
              <Link href="/capture/music" className="camera__source-item" onClick={stopTracks}>
                <V2Icon name="mic" /> Music
              </Link>
            </li>
            <li>
              <Link href="/capture/glasses" className="camera__source-item" onClick={stopTracks}>
                <V2Icon name="glasses" /> {COPY['capture.glasses']}
              </Link>
            </li>
            <li>
              <button
                type="button"
                className="camera__source-item"
                onClick={() => {
                  setMenuOpen(false);
                  uploadInput.current?.click();
                }}
              >
                <Icon name="image" /> {COPY['capture.upload']}
              </button>
            </li>
          </ul>
          <input
            ref={uploadInput}
            type="file"
            multiple
            accept={ACCEPT_MEDIA}
            className="library__upload-input"
            tabIndex={-1}
            aria-hidden="true"
            onChange={async (e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              if (!files.length || !engine) return;
              await engine.add(files, 'upload').catch(() => undefined);
              stopTracks();
              router.push('/uploads');
            }}
          />
        </div>
        <span className="camera__flip">
          {canFlip && phase === 'live' && (
            <button
              type="button"
              className="icon-button"
              aria-label={
                facing === 'environment' ? 'Switch to front camera' : 'Switch to back camera'
              }
              onClick={() => {
                const next = facing === 'environment' ? 'user' : 'environment';
                setFacing(next);
                void start(next);
              }}
            >
              <V2Icon name="flip" size={30} />
            </button>
          )}
        </span>
      </div>

      <div className="camera__stage">
        <video
          ref={videoEl}
          className={`camera__video${facing === 'user' ? ' camera__video--mirror' : ''}`}
          muted
          playsInline
          aria-label="Camera preview"
          hidden={phase === 'review'}
        />
        {phase === 'review' &&
          draft &&
          (draft.kind === 'photo' ? (
            <img className="camera__review" src={draft.url} alt="Your photo" />
          ) : (
            <video
              className="camera__review"
              src={draft.url}
              controls
              playsInline
              muted
              aria-label="Your recording"
            />
          ))}
        {recording && (
          <span className="camera__pill" role="timer" aria-live="off">
            <span className="camera__dot" aria-hidden="true" />
            Recording {formatDuration(elapsed)}
          </span>
        )}
        {(phase === 'idle' || phase === 'starting') && (
          <div className="camera__placeholder">
            <div className="camera__placeholder-body">
              <V2Icon name="phone" size={34} />
              <p className="camera__placeholder-title">
                {phase === 'starting' ? 'Starting the camera…' : 'Use this camera'}
              </p>
              <p className="camera__placeholder-text">
                Your browser asks for camera access when you turn it on.
              </p>
              {phase === 'idle' && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void start()}
                >
                  Turn on camera
                </button>
              )}
            </div>
          </div>
        )}
        {phase === 'problem' && problem && (
          <div className="camera__placeholder" role="alert">
            <div className="camera__placeholder-body">
              <p className="camera__placeholder-title">{CAMERA_PROBLEM_TEXT[problem].title}</p>
              <p className="camera__placeholder-text">{CAMERA_PROBLEM_TEXT[problem].body}</p>
              <div className="camera__fallback">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => fileInput.current?.click()}
                >
                  {problem === 'unavailable' || problem === 'insecure'
                    ? 'Choose a photo or video'
                    : 'Upload instead'}
                </button>
                {problem !== 'unavailable' && problem !== 'insecure' && (
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => void start()}
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*,video/*"
          capture="environment"
          className="library__upload-input"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="camera-file-input"
          onChange={(e) => {
            onPickedFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {phase !== 'review' && (
        <>
          <div className="camera__row">
            {mode === 'video' ? (
              <button
                type="button"
                className="camera__mic"
                aria-pressed={mic === 'on'}
                onClick={() => void toggleMic()}
                disabled={recording || mic === 'requesting'}
              >
                <V2Icon name={mic === 'on' ? 'mic' : 'micOff'} size={26} />
                {micLabel}
              </button>
            ) : (
              <span className="camera__mic" aria-hidden="true" />
            )}
            {mode === 'video' && (
              <span className={`camera__limit${limit.soon ? ' camera__limit--soon' : ''}`}>
                {limit.text}
              </span>
            )}
          </div>
          {mode === 'video' && (mic === 'denied' || mic === 'unavailable') && (
            <p className="camera__status muted">Videos record without sound.</p>
          )}
          {mode === 'video' && mic === 'timed-out' && (
            <p className="camera__status muted" role="status">
              Microphone access is taking longer than expected. Try again, or record without sound.
            </p>
          )}
          <div className="camera__modes" role="group" aria-label="Capture mode">
            <button
              type="button"
              className="camera__mode"
              aria-pressed={mode === 'photo'}
              disabled={recording}
              onClick={() => {
                stopMicrophone();
                setMic('off');
                setMode('photo');
              }}
            >
              Photo
            </button>
            <button
              type="button"
              className="camera__mode"
              aria-pressed={mode === 'video'}
              disabled={recording || !videoAllowed}
              aria-describedby={videoAllowed ? undefined : 'video-off'}
              onClick={() => setMode('video')}
            >
              Video
            </button>
          </div>
          {!videoAllowed && (
            <p id="video-off" className="camera__status muted">
              Video capture is not available right now. Photos still work.
            </p>
          )}
          <div className="camera__controls">
            {mode === 'photo' ? (
              <button
                ref={shutter}
                type="button"
                className="shutter"
                aria-label="Take photo"
                disabled={phase !== 'live'}
                onClick={() => void takePhoto()}
              >
                <span className="shutter__inner">
                  <Icon name="camera" size={26} />
                </span>
              </button>
            ) : recording ? (
              <button
                ref={shutter}
                type="button"
                className="shutter shutter--stop"
                aria-label="Stop recording"
                onClick={finishRecording}
              >
                <span className="shutter__inner">
                  <span className="shutter__square" />
                </span>
              </button>
            ) : (
              <button
                ref={shutter}
                type="button"
                className="shutter shutter--record"
                aria-label="Start recording"
                disabled={phase !== 'live'}
                onClick={startRecording}
              >
                <span className="shutter__inner" />
              </button>
            )}
            <span className="camera__action-label" aria-hidden="true">
              {mode === 'photo'
                ? 'Take photo'
                : recording
                  ? 'Stop recording'
                  : phase === 'finalizing'
                    ? 'Saving…'
                    : 'Start recording'}
            </span>
          </div>
        </>
      )}

      {phase === 'review' && draft && (
        <div className="camera__controls">
          {draft.interrupted && (
            <p className="camera__status" role="status">
              Recording stopped early. What was recorded is kept for review.
            </p>
          )}
          {!kept ? (
            <div className="camera__review-actions">
              <button type="button" className="button button--outline v2-button" onClick={discard}>
                {draft.kind === 'photo' ? 'Retake' : 'Delete'}
              </button>
              <button
                type="button"
                className="button button--primary v2-button"
                onClick={() => void keep()}
              >
                Keep
              </button>
            </div>
          ) : (
            <>
              <p className="camera__status" role="status">
                {keptItem && ['uploading', 'verifying', 'processing'].includes(keptItem.phase) && (
                  <span
                    className="ring"
                    style={{ width: 18, height: 18, borderWidth: 2 }}
                    aria-hidden="true"
                  />
                )}
                {keptStatus}
              </p>
              <div className="camera__review-actions">
                <button
                  type="button"
                  className="button button--outline v2-button"
                  onClick={discard}
                >
                  Take another
                </button>
                <Link
                  href={
                    keptItem?.phase === 'ready' && keptItem.asset_id
                      ? `/library/media/${keptItem.asset_id}`
                      : '/uploads'
                  }
                  className="button button--primary v2-button"
                  onClick={stopTracks}
                >
                  {keptItem?.phase === 'ready' ? 'Open' : 'View uploads'}
                </Link>
              </div>
            </>
          )}
          {!isAccount && session && (
            <p className="camera__status">
              <Link href="/identity" className="text-button">
                Sign in
              </Link>
              <a
                className="text-button"
                href={draft.url}
                download={captureFileName(draft.kind, draft.extension, new Date())}
              >
                Save to this device
              </a>
            </p>
          )}
        </div>
      )}

      {notice && (
        <p className="camera__status" role="alert">
          {notice}
        </p>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announce}
        {limit.soon ? ` ${limit.text}` : ''}
      </p>
      <p className="camera__note">{kept ? COPY['upload.notice'] : note}</p>
    </div>
  );
}
