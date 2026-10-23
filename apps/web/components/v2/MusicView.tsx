'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACCEPT_AUDIO,
  assertAudioOnlyStream,
  BROWSER_MICROPHONE_LABEL,
  concatPcm,
  encodePcmWav,
  exploreNotice,
  glassesMicrophoneAvailability,
  isAudioOnlyGetUserMedia,
  isQualifiedWavFile,
  MIC_PROBLEM_TEXT,
  micProblem,
  MUSIC_CAPTURE_LIMIT_MS,
  MUSIC_GET_USER_MEDIA_CONSTRAINTS,
  MUSIC_SAMPLE_RATE_HZ,
  MUSIC_SERVER,
  musicFileName,
  musicLimitText,
  type MicProblem,
} from './music-mode';
import { formatDuration } from './media-format';
import { isSignedOutError, mediaApi, mediaErrorMessage } from './media-api';
import { V2Icon } from './V2Icon';
import { newIdempotencyKey } from '@/lib/client/api';

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
  durationMs: number;
  interrupted: boolean;
}

interface Kept {
  asset_id: string;
  generation: number;
  duration_ms: number;
}

/**
 * Browser Music Mode (reference 19): camera off, microphone only.
 * Record → Stop → Keep → Explore. Keep writes WAV/PCM through POST /v2/media/audio.
 * Explore is music_match only. File-upload fallback is WAV.
 */
export function MusicView() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<MicProblem | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [kept, setKept] = useState<Kept | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [exploreNoticeText, setExploreNoticeText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const stream = useRef<MediaStream | null>(null);
  const capturing = useRef(false);
  const chunks = useRef<Float32Array[]>([]);
  const graph = useRef<{
    context: AudioContext;
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    mute: GainNode;
  } | null>(null);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const interrupted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const shutter = useRef<HTMLButtonElement>(null);

  const stopTracks = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const tearDownGraph = useCallback(() => {
    const g = graph.current;
    graph.current = null;
    capturing.current = false;
    if (!g) return;
    try {
      g.source.disconnect();
      g.processor.disconnect();
      g.mute.disconnect();
      void g.context.close();
    } catch {
      // already closed
    }
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
        if (capturing.current) {
          interrupted.current = true;
          finishRecording();
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

  useEffect(
    () => () => {
      tearDownGraph();
      stopTracks();
    },
    [stopTracks, tearDownGraph],
  );

  const finishRecording = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    if (!capturing.current) return;
    capturing.current = false;
    setPhase('finalizing');
    const samples = concatPcm(chunks.current);
    chunks.current = [];
    tearDownGraph();
    if (!samples.length) {
      setNotice('Nothing was recorded. Try again.');
      setPhase(stream.current ? 'live' : 'idle');
      return;
    }
    const blob = encodePcmWav(samples, MUSIC_SAMPLE_RATE_HZ);
    const durationMs = Math.round((samples.length / MUSIC_SAMPLE_RATE_HZ) * 1000);
    setDraft({
      blob,
      url: URL.createObjectURL(blob),
      durationMs: Math.max(durationMs, 1),
      interrupted: interrupted.current,
    });
    setKept(null);
    setExploreNoticeText(null);
    setPhase('review');
  };

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden' && capturing.current) {
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
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) {
      setNotice('This browser cannot record WAV. Choose a WAV file instead.');
      return;
    }
    const audioTracks = s.getAudioTracks();
    if (!audioTracks.length) {
      setNotice('No microphone track is available.');
      return;
    }
    const context = new Ctx({ sampleRate: MUSIC_SAMPLE_RATE_HZ });
    const source = context.createMediaStreamSource(new MediaStream(audioTracks));
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mute = context.createGain();
    mute.gain.value = 0;
    chunks.current = [];
    interrupted.current = false;
    capturing.current = true;
    processor.onaudioprocess = (event) => {
      if (!capturing.current) return;
      chunks.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    graph.current = { context, source, processor, mute };
    void context.resume();
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
    setKept(null);
    setExploreNoticeText(null);
    setPhase(stream.current ? 'live' : 'idle');
    queueMicrotask(() => shutter.current?.focus());
  };

  const keep = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const form = new FormData();
      const filename = musicFileName('wav', new Date());
      form.append('client_capture_id', crypto.randomUUID());
      form.append('source', 'browser_microphone');
      form.append('source_route', 'browser_microphone');
      form.append('filename', filename);
      form.append('content_type', 'audio/wav');
      form.append('recording', draft.blob, filename);
      const saved = await mediaApi.keepAudio(form, newIdempotencyKey());
      setKept({
        asset_id: saved.asset_id,
        generation: saved.generation,
        duration_ms: saved.media.duration_ms,
      });
      setAnnounce('Saved to your library');
      setNotice('Saved to your library. Explore is optional and does not change taste.');
    } catch (err) {
      if (isSignedOutError(err)) {
        setNotice('Sign in to keep this recording in your library. You can still save it on this device.');
      } else {
        setNotice(mediaErrorMessage(err, 'Could not keep this recording.'));
      }
    } finally {
      setBusy(false);
    }
  };

  const explore = async () => {
    if (!kept || busy) return;
    setBusy(true);
    try {
      const end = Math.max(1, Math.min(kept.duration_ms, 15_000));
      const requested = await mediaApi.analyzeAudio(
        kept.asset_id,
        {
          contract_version: 2,
          expected_generation: kept.generation,
          requested_components: ['music_match'],
          selection: { start_ms: 0, end_ms: end },
        },
        newIdempotencyKey(),
      );
      let latest = await mediaApi.audioAnalysis(kept.asset_id, requested.analysis_id);
      for (let i = 0; i < 8 && (latest.state === 'queued' || latest.state === 'running'); i++) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        latest = await mediaApi.audioAnalysis(kept.asset_id, requested.analysis_id);
      }
      setExploreNoticeText(exploreNotice(latest));
      setPhase('explored');
    } catch (err) {
      setExploreNoticeText(mediaErrorMessage(err, MUSIC_SERVER.reason));
      setPhase('explored');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (capturing.current) finishRecording();
    tearDownGraph();
    stopTracks();
    router.push('/capture');
  };

  const recording = phase === 'recording';
  const limit = musicLimitText(elapsed, MUSIC_CAPTURE_LIMIT_MS, recording);
  const glasses = glassesMicrophoneAvailability();

  const onPickedFile = (file: File | undefined) => {
    if (!file) return;
    if (!isQualifiedWavFile(file)) {
      setNotice('Use a WAV file. Other audio containers are not qualified yet.');
      return;
    }
    setDraft({
      blob: file,
      url: URL.createObjectURL(file),
      durationMs: 15_000,
      interrupted: false,
    });
    setKept(null);
    setExploreNoticeText(null);
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
                  Choose a WAV file
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
              <button
                type="button"
                className="button button--primary v2-button"
                onClick={() => void keep()}
                disabled={busy}
              >
                Keep
              </button>
            </div>
          ) : (
            <>
              <p className="camera__status" role="status">
                Saved to your library.
              </p>
              {exploreNoticeText && (
                <p className="camera__status" role="status">
                  {exploreNoticeText}
                </p>
              )}
              <div className="camera__review-actions">
                <button type="button" className="button button--outline v2-button" onClick={discard}>
                  Record another
                </button>
                <button
                  type="button"
                  className="button button--primary v2-button"
                  onClick={() => void explore()}
                  disabled={phase === 'explored' || busy}
                >
                  Explore music
                </button>
              </div>
            </>
          )}
          <a
            className="text-button"
            href={draft.url}
            download={musicFileName('wav', new Date())}
          >
            Save to this device
          </a>
        </div>
      )}

      {phase !== 'review' && phase !== 'explored' && (
        <p className="music__fallback">
          <button type="button" className="text-button" onClick={() => fileInput.current?.click()}>
            Choose a WAV file instead
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
