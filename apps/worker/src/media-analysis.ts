import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import sharp from 'sharp';
import {
  AppError,
  MAX_FRAME_ROUNDS,
  MEDIA_ANALYSIS_DEADLINES,
  MediaAnalysisRun,
  VIDEO_ANALYSIS_NOTE,
  aggregateFrameReadings,
  captures,
  createCaptureV2Context,
  type AnalysisAssetKind,
  type CaptureLease,
  type CaptureV2Context,
  type Db,
  type DomainConfig,
  type FrameCheckpoint,
  type FrameReading,
} from '@culture-atlas/domain';
import {
  FallbackVlm,
  ProviderError,
  boundJpegForProfile,
  identityFromCaptureLease,
  type ModelGateway,
  type MultipartStorage,
  type ObjectStorage,
  type VlmProvider,
} from '@culture-atlas/providers';

/** Image bounds for the fallback model when no qualified gateway profile applies. */
const FALLBACK_IMAGE_BOUNDS = { maxBytes: 700_000, maxPixels: 4_194_304, maxDimension: 2048, maxCount: 1 };

/**
 * v2 media analysis worker (asset-analysis orchestration). Claims
 * `analyze_media` work with separate photo/video slots, sends each bounded
 * JPEG (normalized photo derivative or extracted frame) to the qualified
 * Concentrate vision role, checkpoints every validated frame reading, then
 * aggregates and hands the reading to the existing cultural compiler.
 * AI outages (402 credits, 429 throttling) return work to the queue without
 * consuming attempts; capture, library and uploads never depend on it.
 */
export interface MediaAnalysisWorkerOptions {
  db: Db;
  /** Private v2 media (derivatives/frames). */
  storage: MultipartStorage;
  /** v1 capture storage for the analysis display image. */
  displayStorage: ObjectStorage;
  gateway: ModelGateway | undefined;
  /**
   * Operator-chosen fallback vision model (MODEL_FALLBACK=elorian). Used when the
   * gateway has no qualified/available runner for the role, and as a second try
   * after a provider-side failure of the gateway.
   */
  fallbackVlm?: VlmProvider;
  config: DomainConfig;
  workerId?: string;
  photoConcurrency?: number;
  videoConcurrency?: number;
  pollMs?: number;
  leaseSeconds?: number;
  heartbeatMs?: number;
  deadlines?: { photoMs?: number; videoMs?: number };
  accountId?: string;
  agentAuthorization?: CaptureV2Context['agentAuthorization'];
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

const MAX_DERIVATIVE_BYTES = 16 * 1024 * 1024;

async function readBounded(storage: MultipartStorage, key: string): Promise<Buffer> {
  const object = await storage.read(key);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of object.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_DERIVATIVE_BYTES) throw new AppError('payload_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

type FrameInput = {
  frameKey: string;
  derivativeId: string | null;
  timestampMs: number | null;
  objectKey: string;
};

/** Safe, classified frame failure codes (never provider payloads). */
export function classifyFrameError(error: unknown): { code: string; retryable: boolean } {
  if (!(error instanceof ProviderError)) return { code: 'media_unreadable', retryable: true };
  switch (error.kind) {
    case 'timeout':
      return { code: 'model_timeout', retryable: true };
    case 'server':
      return { code: 'model_unavailable', retryable: true };
    case 'content_rejected':
      return { code: 'model_declined', retryable: false };
    case 'incomplete_response':
      return { code: 'model_incomplete', retryable: false };
    case 'invalid_response':
      return { code: 'model_invalid_output', retryable: false };
    case 'bad_request':
      return { code: 'model_input_rejected', retryable: false };
    default:
      return { code: 'analysis_failed', retryable: false };
  }
}

export class MediaAnalysisWorker {
  readonly workerId: string;
  private readonly running = new Map<string, { kind: AnalysisAssetKind; done: Promise<void> }>();
  private stopped = false;
  private loop?: Promise<void>;
  private lastReconcile = 0;
  private pausedUntil = 0;

  constructor(private readonly opts: MediaAnalysisWorkerOptions) {
    this.workerId =
      opts.workerId ?? `analysis:${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  }
  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
  private log(message: string, data?: Record<string, unknown>) {
    (this.opts.log ?? ((m, d) => console.log(`[media-analysis ${this.workerId}] ${m}`, d ?? '')))(
      message,
      data,
    );
  }
  private run(lease: { account_id: string }): MediaAnalysisRun {
    return new MediaAnalysisRun(
      createCaptureV2Context({
        db: this.opts.db,
        authority: { kind: 'account', accountId: lease.account_id, sessionId: null },
        storage: this.opts.storage,
        agentAuthorization: this.opts.agentAuthorization,
        now: this.opts.now,
      }),
    );
  }

  /** Claims up to free photo/video capacity. Claims nothing while AI dispatch is paused. */
  async tick(): Promise<number> {
    if (Date.now() - this.lastReconcile > 60_000) {
      this.lastReconcile = Date.now();
      await this.run({ account_id: '00000000-0000-0000-0000-000000000000' })
        .reconcileAbandoned()
        .catch(() => this.log('reconcile failed'));
    }
    if (this.stopped) return 0;
    if (Date.now() < this.pausedUntil) return 0;
    const pause = await this.opts.gateway?.ledger?.status();
    if (pause) {
      // Read-only check: no paid probe. Credits wait for an explicit operator resume.
      this.pausedUntil =
        Date.now() +
        Math.min(Math.max((pause.until ?? Date.now() + 30_000) - Date.now(), 1000), 30_000);
      return 0;
    }
    let started = 0;
    for (const kind of ['photo', 'video'] as const) {
      const limit =
        kind === 'photo' ? (this.opts.photoConcurrency ?? 2) : (this.opts.videoConcurrency ?? 1);
      let free = limit - [...this.running.values()].filter((r) => r.kind === kind).length;
      while (free-- > 0 && !this.stopped) {
        const lease = await this.run({ account_id: '00000000-0000-0000-0000-000000000000' }).claim(
          kind,
          this.opts.leaseSeconds ?? 60,
          this.opts.accountId,
        );
        if (!lease) break;
        const done = this.execute(lease, kind).finally(() => this.running.delete(lease.job_id));
        this.running.set(lease.job_id, { kind, done });
        started++;
      }
    }
    return started;
  }

  async drain(): Promise<void> {
    for (;;) {
      const started = await this.tick();
      if (started === 0 && this.running.size === 0) return;
      await Promise.race([
        ...[...this.running.values()].map((r) => r.done),
        new Promise((r) => setTimeout(r, 10)),
      ]);
    }
  }

  start(): void {
    this.loop = (async () => {
      while (!this.stopped) {
        try {
          if ((await this.tick()) === 0)
            await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1000));
        } catch (error) {
          this.log('tick failed', { code: error instanceof AppError ? error.code : 'internal' });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await Promise.allSettled([...this.running.values()].map((r) => r.done));
  }

  async execute(lease: CaptureLease, kind: AnalysisAssetKind): Promise<void> {
    const run = this.run(lease);
    const leaseLost = new AbortController();
    const deadlineMs =
      kind === 'photo'
        ? (this.opts.deadlines?.photoMs ?? MEDIA_ANALYSIS_DEADLINES.photoMs)
        : (this.opts.deadlines?.videoMs ?? MEDIA_ANALYSIS_DEADLINES.videoMs);
    const deadline = AbortSignal.timeout(deadlineMs);
    const signal = AbortSignal.any([leaseLost.signal, deadline]);
    const heartbeat = setInterval(() => {
      run
        .heartbeat(lease, this.opts.leaseSeconds ?? 60)
        .then((ok) => {
          if (!ok) leaseLost.abort();
        })
        .catch(() => leaseLost.abort());
    }, this.opts.heartbeatMs ?? 10_000);
    const started = Date.now();
    try {
      const outcome = await this.process(run, lease, kind, signal, Date.now() + deadlineMs);
      this.log('analysis', { job: lease.job_id, kind, outcome, ms: Date.now() - started });
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code === 'conflict'
            ? 'lease_conflict'
            : error.code
          : 'worker_error';
      this.log('analysis failed', { job: lease.job_id, kind, code });
      if (!leaseLost.signal.aborted)
        await run.retryLater(lease, code.slice(0, 64)).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async process(
    run: MediaAnalysisRun,
    lease: CaptureLease,
    kind: AnalysisAssetKind,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<string> {
    const work = await run.loadWork(lease);
    const role = kind === 'photo' ? 'vision_photo' : 'vision_video_frame';
    const gateway = this.opts.gateway;
    const fallbackVlm = this.opts.fallbackVlm;
    let runner = gateway?.runners[role];
    const primaryVlm: VlmProvider | undefined =
      role === 'vision_photo' ? gateway?.vlm : gateway?.videoFrames;
    let vlm: VlmProvider | undefined =
      primaryVlm && fallbackVlm ? new FallbackVlm(primaryVlm, fallbackVlm) : primaryVlm;
    const result = (
      frames: Array<{ frame_id: string | null; timestamp_ms: number | null; state: string }>,
      candidates: unknown[] = [],
    ) => ({
      mode: work.mode,
      note: kind === 'video' ? VIDEO_ANALYSIS_NOTE : null,
      frames,
      candidates,
    });
    const fail = async (code: string, frames: Parameters<typeof result>[0] = []) => {
      await run.publishVision(lease, { state: 'failed', errorCode: code, result: result(frames) });
      return `failed:${code}`;
    };
    const readiness = runner ? await runner.readinessDetail() : null;
    if ((!runner || !vlm || readiness?.state === 'unavailable') && fallbackVlm) {
      // Gateway cannot serve this role at all: use only the operator-chosen fallback.
      runner = undefined;
      vlm = fallbackVlm;
    } else if (!runner || !vlm || !readiness) return fail('analysis_unavailable');
    if (runner && readiness && readiness.state === 'degraded' && readiness.reason === 'rate_limited') {
      await run.defer(lease, {
        reason: 'rate_limited',
        until: new Date(Date.now() + Math.max(readiness.retryAfterMs ?? 30_000, 1000)),
      });
      return 'deferred:rate_limited';
    }
    if (runner && readiness && readiness.state === 'unavailable') {
      if (readiness.reason === 'credits' || readiness.reason === 'cost_overrun') {
        await run.defer(lease, { reason: 'ai_paused', until: new Date(Date.now() + 60_000) });
        return 'deferred:ai_paused';
      }
      return fail('analysis_unavailable');
    }
    const inputs: FrameInput[] =
      kind === 'photo'
        ? work.normalized
          ? [
              {
                frameKey: 'photo',
                derivativeId: work.normalized.id,
                timestampMs: null,
                objectKey: work.normalized.objectKey,
              },
            ]
          : []
        : work.frames.map((f) => ({
            frameKey: f.id,
            derivativeId: f.id,
            timestampMs: f.timestamp_ms,
            objectKey: f.objectKey,
          }));
    if (!inputs.length) return fail('media_not_ready');
    let checkpoints = await run.checkpoints(lease);
    let stop: string | null = null;
    for (const input of inputs) {
      const cp = checkpoints.get(input.frameKey);
      if (cp && (cp.state !== 'failed' || !cp.retryable || cp.rounds >= MAX_FRAME_ROUNDS)) continue;
      if (signal.aborted || Date.now() >= deadlineAt) break;
      const round = cp?.rounds ?? 0;
      const deferrals = cp?.deferrals ?? 0;
      try {
        const image = await boundJpegForProfile(
          await readBounded(this.opts.storage, input.objectKey),
          runner?.profile.image ?? FALLBACK_IMAGE_BOUNDS,
        );
        const reading = await vlm!.analyzeImage(
          {
            image: { bytes: image.bytes, mediaType: 'image/jpeg' },
            focus: work.focus ? { label: String(work.focus).slice(0, 120) } : undefined,
            maxCandidates: 8,
          },
          {
            signal,
            timeoutMs: Math.max(
              1,
              Math.min(MEDIA_ANALYSIS_DEADLINES.frameAttemptMs, deadlineAt - Date.now()),
            ),
            // Round 0 may use the runner's single transient retry; round 1 may not (<=3 per frame).
            maxRetries: round === 0 ? 1 : 0,
            modelIdentity: identityFromCaptureLease(
              lease,
              `media:${work.analysisId}:${input.frameKey}:r${round}${deferrals ? `d${deferrals}` : ''}`,
            ),
          },
        );
        await run.recordFrame(lease, {
          ...input,
          state: 'complete',
          reading: reading.analysis,
          model: reading.model,
        });
      } catch (error) {
        if (error instanceof AppError && error.code === 'conflict') throw error;
        if (signal.aborted && !(error instanceof ProviderError && error.kind !== 'aborted')) {
          // Deadline or lease loss: the dispatch may have run upstream; never re-send it.
          if (Date.now() >= deadlineAt - 5) {
            await run.recordFrame(lease, {
              ...input,
              state: 'failed',
              errorCode: 'analysis_deadline',
              retryable: false,
            });
            break;
          }
          throw new AppError('conflict', { message: 'Worker lease is no longer valid.' });
        }
        if (
          error instanceof ProviderError &&
          (error.kind === 'budget_exhausted' || error.kind === 'rate_limited')
        ) {
          const pause = await gateway?.ledger?.status();
          if (pause || error.kind === 'rate_limited') {
            // Only an attempt the gateway refused (402/429 response) is a deferral; a local
            // pause check refused before any HTTP request and reserved nothing.
            if (error.status === 402 || error.status === 429)
              await run.recordFrame(lease, {
                ...input,
                state: 'failed',
                errorCode: pause?.reason === 'credits' ? 'ai_paused' : 'rate_limited',
                retryable: true,
                deferral: true,
              });
            await run.defer(lease, {
              reason:
                pause?.reason === 'rate_limited' || error.kind === 'rate_limited'
                  ? 'rate_limited'
                  : 'ai_paused',
              until: new Date(
                Date.now() +
                  Math.max(
                    error.retryAfterMs ?? (pause?.until ? pause.until - Date.now() : 60_000),
                    1000,
                  ),
              ),
            });
            return `deferred:${pause?.reason ?? error.kind}`;
          }
          // Account/global daily allowance: not a pause, stop dispatching for this request.
          await run.recordFrame(lease, {
            ...input,
            state: 'failed',
            errorCode: 'analysis_allowance_exhausted',
            retryable: false,
          });
          stop = 'analysis_allowance_exhausted';
          break;
        }
        if (error instanceof ProviderError && error.kind === 'unavailable') {
          if (/already reserved/.test(error.message)) {
            // A previous attempt dispatched this frame and its outcome was lost: never send twice.
            await run.recordFrame(lease, {
              ...input,
              state: 'unknown',
              errorCode: 'outcome_unknown',
              retryable: false,
            });
            continue;
          }
          stop = 'analysis_unavailable';
          break;
        }
        const classified = classifyFrameError(error);
        await run.recordFrame(lease, {
          ...input,
          state: 'failed',
          errorCode: classified.code,
          retryable: classified.retryable,
        });
      }
    }
    checkpoints = await run.checkpoints(lease);
    const pendingRetry = inputs.some((i) => {
      const cp = checkpoints.get(i.frameKey);
      return (
        !stop &&
        Date.now() < deadlineAt &&
        cp?.state === 'failed' &&
        cp.retryable &&
        cp.rounds < MAX_FRAME_ROUNDS
      );
    });
    if (pendingRetry && lease.attempts < 5) {
      await run.retryLater(lease, 'frames_retry');
      return 'retry:frames';
    }
    const frames = inputs.map((i) => {
      const cp = checkpoints.get(i.frameKey);
      return {
        frame_id: i.derivativeId,
        timestamp_ms: i.timestampMs,
        state: cp?.state ?? 'skipped',
        error_code: cp?.errorCode ?? null,
      };
    });
    const readings: FrameReading[] = inputs.flatMap((i) => {
      const cp: FrameCheckpoint | undefined = checkpoints.get(i.frameKey);
      return cp?.state === 'complete' && cp.reading
        ? [
            {
              frameKey: i.frameKey,
              derivativeId: i.derivativeId,
              timestampMs: i.timestampMs,
              analysis: cp.reading,
              model: cp.model ?? 'unknown',
            },
          ]
        : [];
    });
    if (!readings.length) {
      const codes = frames.map((f) => f.error_code).filter((c): c is string => !!c);
      return fail(stop ?? codes[0] ?? 'analysis_failed', frames);
    }
    const aggregate = aggregateFrameReadings(readings, { maxCandidates: 8 });
    const display = inputs.find((i) => i.frameKey === aggregate.displayFrameKey)!;
    const captureId = randomUUID();
    const displayBytes = await readBounded(this.opts.storage, display.objectKey);
    const meta = await sharp(displayBytes).metadata();
    const objectKey = `${captures.captureObjectPrefix({ kind: 'account', accountId: lease.account_id }, captureId)}/derivative.jpg`;
    await this.opts.displayStorage.put(objectKey, displayBytes, { contentType: 'image/jpeg' });
    const state = readings.length === inputs.length ? 'complete' : 'partial';
    const config = this.opts.config;
    try {
      await run.publishVision(lease, {
        state,
        observation: aggregate.observation,
        model: aggregate.model,
        captureId,
        display: {
          objectKey,
          sha256: createHash('sha256').update(displayBytes).digest('hex'),
          width: meta.width ?? 1,
          height: meta.height ?? 1,
        },
        result: result(frames, aggregate.citations),
        compile: {
          compilerVersion: config.COMPILER_VERSION,
          maxAttempts: config.JOB_MAX_ATTEMPTS,
          budget: {
            qloo_requests: config.JOB_MAX_QLOO_REQUESTS,
            research_refs: config.JOB_MAX_RESEARCH_REFS,
            provider_retries: config.JOB_MAX_PROVIDER_RETRIES,
            deadline_ms: config.ANALYSIS_DEADLINE_MS,
          },
        },
      });
    } catch (error) {
      // Publication fenced (deleted, lease lost): never leave an orphan display image.
      await this.opts.displayStorage.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return state;
  }
}
