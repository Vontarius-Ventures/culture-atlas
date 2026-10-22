'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCEPT_AUDIO,
  assertAudioOnlyStream,
  BROWSER_MICROPHONE_LABEL,
  exploreMusic,
  glassesMicrophoneAvailability,
  isAudioOnlyGetUserMedia,
  MIC_PROBLEM_TEXT,
  micProblem,
  MUSIC_CAPTURE_LIMIT_MS,
  MUSIC_GET_USER_MEDIA_CONSTRAINTS,
  MUSIC_SERVER,
  musicFileName,
  musicLimitText,
  pickAudioRecorderType,
  type MicProblem,
} from './music-mode';
import { formatDuration } from './media-format';
import { V2Icon } from './V2Icon';

type Phase =
  | 'idle'
  | 'starting'
  | 'live'
  | 'recording'
  | 'finalizing'
  | 'review'
  | 'problem'
  | 'explored';

interface Draft {
  blob: Blob;
  url: string;
  extension: string;
  interrupted: boolean;
}

/**
 * Browser Music Mode (reference 19): camera off, microphone only.
 * Record → Stop → Keep → Explore. File-upload fallback when getUserMedia
 * is missing or refused. Kept clips stay on this device until the server
 * accepts audio uploads.
 */
export function MusicView() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kept, setKept] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [exploreNotice, setExploreNotice] = useState<string | null>(null);

  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const interrupted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const shutter = useRef<HTMLButtonElement>(null);

  const stopTracks = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const startMic = async () => {
    setNotice(null);
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setProblem(window.isSecureContext === false ? 'insecure' : 'unavailable');
      setPhase('problem');
      return;
    }
    setPhase('starting');
    try {
      if (!isAudioOnlyGetUserMedia(MUSIC_GET_USER_MEDIA_CONSTRAINTS)) {
        throw new Error('Music Mode must not open camera tracks.');
      }
      const s = await navigator.mediaDevices.getUserMedia(MUSIC_GET_USER_MEDIA_CONSTRAINTS);
      assertAudioOnlyStream(s);
      stream.current = s;
      s.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (recorder.current?.state === 'recording') {
          interrupted.current = true;
          recorder.current.stop();
        }
        setNotice('The microphone stopped. Any recording so far is kept for review.');
      });
      setProblem(null);
      setPhase('live');
    } catch (err) {
      setProblem(micProblem(err));
      setPhase('problem');
    }
  };

  useEffect(() => () => stopTracks(), [stopTracks]);

  const finishRecording = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    if (recorder.current && recorder.current.state !== 'inactive') {
      setPhase('finalizing');
      recorder.current.stop();
    }
  };

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

  const startRecording = () => {
    const s = stream.current;
    if (!s) return;
    const type =
      typeof MediaRecorder !== 'undefined'
        ? pickAudioRecorderType((t) => MediaRecorder.isTypeSupported(t))
        : null;
    if (!type) {
      setNotice('This browser cannot record audio. Choose an audio file instead.');
      return;
    }
    const audioTracks = s.getAudioTracks();
    if (!audioTracks.length) {
      setNotice('No microphone track is available.');
      return;
    }
    const rec = new MediaRecorder(new MediaStream(audioTracks), { mimeType: type.mimeType });
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
        extension: type.extension,
        interrupted: interrupted.current,
      });
      setKept(false);
      setExploreNotice(null);
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
      if (ms >= MUSIC_CAPTURE_LIMIT_MS) {
        setAnnounce('Time limit reached. Recording stopped.');
        finishRecording();
      }
    }, 250);
  };

  const discard = () => {
    if (draft) URL.revokeObjectURL(draft.url);
    setDraft(null);
    setKept(false);
    setExploreNotice(null);
    setPhase(stream.current ? 'live' : 'idle');
    queueMicrotask(() => shutter.current?.focus());
  };

  const keep = () => {
    if (!draft) return;
    setKept(true);
    setAnnounce('Saved on this device');
    setNotice(MUSIC_SERVER.reason);
  };

  const explore = () => {
    const duration = draft ? Math.round(elapsed) || 15_000 : 15_000;
    const result = exploreMusic({ start_ms: 0, end_ms: Math.min(duration, MUSIC_CAPTURE_LIMIT_MS) });
    setExploreNotice(result.notice);
    setPhase('explored');
  };

  const close = () => {
    if (recorder.current?.state === 'recording') finishRecording();
    stopTracks();
    router.push('/capture');
  };

  const recording = phase === 'recording';
  const limit = musicLimitText(elapsed, MUSIC_CAPTURE_LIMIT_MS, recording);
  const glasses = glassesMicrophoneAvailability();

  const onPickedFile = (file: File | undefined) => {
    if (!file) return;
    setDraft({
      blob: file,
      url: URL.createObjectURL(file),
      extension: /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'm4a',
      interrupted: false,
    });
    setKept(false);
    setExploreNotice(null);
    setPhase('review');
  };

  return (
    <div className="camera music">
      <div className="camera__top">
        <Link
          href="/capture"
          className="camera__close"
          onClick={(e) => {
            e.preventDefault();
            close();
          }}
        >
          Capture
        </Link>
        <div className="camera__source">
          <span className="music__title">Music</span>
        </div>
        <span className="music__badge">Camera off</span>
      </div>

      <p className="music__lede">Keep a little of what you hear.</p>

      <label className="music__route">
        Microphone
        <select disabled={recording} defaultValue="browser" aria-label="Microphone">
          <option value="browser">{BROWSER_MICROPHONE_LABEL}</option>
          <option value="glasses" disabled>
            {glasses.label}
          </option>
        </select>
      </label>

      <div className="camera__stage music__stage">
        <div
          className={`music__wave${recording ? ' music__wave--live' : ''}`}
          role="img"
          aria-label={recording ? 'Microphone levels' : 'Ready to record'}
        />
        {recording && (
          <span className="camera__pill" role="timer" aria-live="off">
            <span className="camera__dot" aria-hidden="true" />
            Recording audio {formatDuration(elapsed)}
          </span>
        )}
        {(phase === 'idle' || phase === 'starting') && (
          <div className="camera__placeholder">
            <div className="camera__placeholder-body">
              <V2Icon name="mic" size={34} />
              <p className="camera__placeholder-title">
                {phase === 'starting' ? 'Starting the microphone…' : 'Record with this browser'}
              </p>
              <p className="camera__placeholder-text">
                Your browser asks for microphone access only. The camera stays off.
              </p>
              {phase === 'idle' && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => void startMic()}
                >
                  Turn on microphone
                </button>
              )}
            </div>
          </div>
        )}
        {phase === 'problem' && problem && (
          <div className="camera__placeholder" role="alert">
            <div className="camera__placeholder-body">
              <p className="camera__placeholder-title">{MIC_PROBLEM_TEXT[problem].title}</p>
              <p className="camera__placeholder-text">{MIC_PROBLEM_TEXT[problem].body}</p>
              <div className="camera__fallback">
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => fileInput.current?.click()}
                >
                  Choose an audio file
                </button>
                {problem !== 'unavailable' && problem !== 'insecure' && (
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => void startMic()}
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        {phase === 'review' && draft && (
          <div className="music__review">
            <audio src={draft.url} controls playsInline aria-label="Your recording" />
          </div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_AUDIO}
          className="library__upload-input"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="music-file-input"
          onChange={(e) => {
            onPickedFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {phase !== 'review' && phase !== 'explored' && (
        <>
          <div className="camera__row">
            <span className="camera__mic">
              <V2Icon name="mic" size={26} />
              {BROWSER_MICROPHONE_LABEL}
            </span>
            <span className={`camera__limit${limit.soon ? ' camera__limit--soon' : ''}`}>
              {limit.text}
            </span>
          </div>
          <div className="camera__controls">
            {recording ? (
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
                aria-label="Record"
                disabled={phase !== 'live'}
                onClick={startRecording}
              >
                <span className="shutter__inner" />
              </button>
            )}
            <span className="camera__action-label" aria-hidden="true">
              {recording ? 'Stop recording' : phase === 'finalizing' ? 'Saving…' : 'Record'}
            </span>
          </div>
        </>
      )}

      {(phase === 'review' || phase === 'explored') && draft && (
        <div className="camera__controls">
          {draft.interrupted && (
            <p className="camera__status" role="status">
              Recording stopped early. What was recorded is kept for review.
            </p>
          )}
          {!kept ? (
            <div className="camera__review-actions">
              <button type="button" className="button button--outline v2-button" onClick={discard}>
                Delete
              </button>
              <button type="button" className="button button--primary v2-button" onClick={keep}>
                Keep
              </button>
            </div>
          ) : (
            <>
              <p className="camera__status" role="status">
                Saved on this device.
              </p>
              {exploreNotice && (
                <p className="camera__status" role="status">
                  {exploreNotice}
                </p>
              )}
              <div className="camera__review-actions">
                <button type="button" className="button button--outline v2-button" onClick={discard}>
                  Record another
                </button>
                <button
                  type="button"
                  className="button button--primary v2-button"
                  onClick={explore}
                  disabled={phase === 'explored'}
                >
                  Explore music
                </button>
              </div>
            </>
          )}
          <a
            className="text-button"
            href={draft.url}
            download={musicFileName(draft.extension, new Date())}
          >
            Save to this device
          </a>
        </div>
      )}

      {phase !== 'review' && phase !== 'explored' && (
        <p className="music__fallback">
          <button type="button" className="text-button" onClick={() => fileInput.current?.click()}>
            Choose an audio file instead
          </button>
        </p>
      )}

      {notice && phase !== 'explored' && (
        <p className="camera__status" role="status">
          {notice}
        </p>
      )}
      <p className="visually-hidden" aria-live="polite">
        {announce}
        {limit.soon ? ` ${limit.text}` : ''}
      </p>
      <p className="camera__note">Speech transcription is off. Review before keeping.</p>
    </div>
  );
}
