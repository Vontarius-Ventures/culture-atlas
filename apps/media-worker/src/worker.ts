import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import {
  AppError,
  CaptureQueue,
  DEFAULT_CAPTURE_LIMITS,
  MediaPreparation,
  backfillLegacyCaptures,
  createCaptureV2Context,
  heartbeatMediaWorker,
  reconcileCaptureStorage,
  type CaptureLease,
  type CaptureLimits,
  type CaptureV2Context,
  type CaptureWorkKind,
  type Db,
} from '@culture-atlas/domain';
import type { MultipartStorage } from '@culture-atlas/providers';
import { createMediaPreparer } from './preparer';
import { DEFAULT_TOOL_CONFIG, type MediaToolConfig } from './probe';
import { QUALIFIED_MATRIX_VERSION, qualifyWorker, type Qualification } from './qualify';
import { cleanStaleScratch } from './scratch';
import { createMediaVerifier } from './verifier';

export const MEDIA_WORK_KINDS: CaptureWorkKind[] = [
  'verify_upload',
  'prepare_media',
  'purge_media',
  'cleanup_upload',
];

export interface MediaWorkerOptions {
  db: Db;
  storage: MultipartStorage;
  scratchRoot: string;
  limits?: CaptureLimits;
  tools?: MediaToolConfig;
  /** Precomputed qualification (tests); otherwise `qualify()` runs the self-test. */
  qualification?: Qualification;
  workerId?: string;
  concurrency?: number;
  pollMs?: number;
  /** Lease length requested on claim and each heartbeat (max 300s per extension). */
  leaseSeconds?: number;
  heartbeatMs?: number;
  /** Hard ceiling on one attempt, after which the attempt is abandoned and retried. */
  maxAttemptMs?: number;
  /** Legacy World Sensor captures enter the v2 library only when enabled. */
  includeLegacySensor?: boolean;
  /** Set to 0 to disable a periodic task. */
  housekeeping?: {
    reapEveryMs?: number;
    expireEveryMs?: number;
    legacyEveryMs?: number;
    reconcileEveryMs?: number;
    reconcileSafetyWindowMs?: number;
    capabilityEveryMs?: number;
  };
  /** Restrict claims to one account (tests and targeted reprocessing). */
  accountId?: string;
  agentAuthorization?: CaptureV2Context['agentAuthorization'];
  deleteAnalysisCapture?: CaptureV2Context['deleteAnalysisCapture'];
  now?: () => Date;
  log?: (message: string, data?: Record<string, unknown>) => void;
}

/**
 * Resource-bounded media worker. Claims leased capture_work rows and dispatches
 * them to the domain MediaPreparation module; ownership comes only from the
 * persisted lease (never an ambient account). Heartbeats every 10s extend 60s
 * leases; a failed heartbeat aborts the running ffmpeg process and the domain
 * publish fence rejects any late write.
 */
export class MediaWorker {
  readonly workerId: string;
  private qualification: Qualification | undefined;
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;
  private loop?: Promise<void>;
  private readonly last: Record<string, number> = {};
  private readonly limits: CaptureLimits;
  private readonly tools: MediaToolConfig;

  constructor(private readonly opts: MediaWorkerOptions) {
    this.workerId =
      opts.workerId ?? `media:${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
    this.qualification = opts.qualification;
    this.limits = opts.limits ?? DEFAULT_CAPTURE_LIMITS;
    this.tools = opts.tools ?? DEFAULT_TOOL_CONFIG;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
  private log(message: string, data?: Record<string, unknown>) {
    (this.opts.log ?? ((m, d) => console.log(`[media-worker ${this.workerId}] ${m}`, d ?? '')))(
      message,
      data,
    );
  }

  get qualified(): Qualification | undefined {
    return this.qualification;
  }

  /** Runs the codec/preparation self-test and records the result. */
  async qualify(): Promise<Qualification> {
    this.qualification = await qualifyWorker(this.tools, this.opts.scratchRoot, this.limits);
    this.log('qualification', {
      preparation: this.qualification.preparation,
      video: [...this.qualification.qualified.video],
      audio: [...this.qualification.qualified.audio],
    });
    return this.qualification;
  }

  private context(lease: CaptureLease, signal: AbortSignal): CaptureV2Context {
    const qualified = this.qualification?.qualified ?? { video: new Set(), audio: new Set() };
    return createCaptureV2Context({
      db: this.opts.db,
      authority: { kind: 'account', accountId: lease.account_id, sessionId: null },
      storage: this.opts.storage,
      limits: this.limits,
      now: this.opts.now,
      verifier: createMediaVerifier({
        scratchRoot: this.opts.scratchRoot,
        tools: this.tools,
        qualified,
        signal,
      }),
      agentAuthorization: this.opts.agentAuthorization,
      deleteAnalysisCapture: this.opts.deleteAnalysisCapture,
    });
  }

  private due(name: string, everyMs: number | undefined, fallback: number): boolean {
    const interval = everyMs ?? fallback;
    if (interval <= 0) return false;
    const now = Date.now();
    if (now - (this.last[name] ?? 0) < interval) return false;
    this.last[name] = now;
    return true;
  }

  /** Periodic durable maintenance; each task is independent and failure-isolated. */
  async housekeeping(): Promise<void> {
    const h = this.opts.housekeeping ?? {};
    const db = this.opts.db;
    const prep = new MediaPreparation(
      createCaptureV2Context({
        db,
        authority: {
          kind: 'account',
          accountId: '00000000-0000-0000-0000-000000000000',
          sessionId: null,
        },
        storage: this.opts.storage,
        limits: this.limits,
        now: this.opts.now,
        deleteAnalysisCapture: this.opts.deleteAnalysisCapture,
      }),
    );
    const task = async (name: string, fn: () => Promise<unknown>) => {
      try {
        const result = await fn();
        if (
          result &&
          typeof result === 'object' &&
          Object.values(result).some((v) => typeof v === 'number' && v > 0)
        )
          this.log(name, result as Record<string, unknown>);
      } catch (error) {
        this.log(`${name} failed`, { code: error instanceof AppError ? error.code : 'internal' });
      }
    };
    if (this.due('capability', h.capabilityEveryMs, 30_000)) {
      await task('capability', async () => {
        const q = this.qualification;
        if (q?.preparation && Object.values(q.codecs).some(Boolean))
          await heartbeatMediaWorker(
            db,
            {
              workerId: this.workerId,
              qualifiedMatrixVersion: QUALIFIED_MATRIX_VERSION,
              codecs: q.codecs,
            },
            this.now(),
          );
      });
    }
    if (this.due('reap', h.reapEveryMs, 15_000))
      await task('reap', async () => ({
        reaped: await new CaptureQueue(db, this.opts.now).reap(),
      }));
    if (this.due('expire', h.expireEveryMs, 30_000))
      await task('expire', async () => ({
        expired: await prep.expireUploads(this.opts.accountId),
      }));
    if (this.due('legacy', h.legacyEveryMs, 60_000))
      await task('legacy', () =>
        backfillLegacyCaptures(db, {
          includeSensor: this.opts.includeLegacySensor ?? false,
          accountId: this.opts.accountId,
        }),
      );
    if (this.due('reconcile', h.reconcileEveryMs, 3_600_000))
      await task('reconcile', () =>
        reconcileCaptureStorage(db, this.opts.storage, {
          now: this.now(),
          safetyWindowMs: h.reconcileSafetyWindowMs,
          accountId: this.opts.accountId,
        }),
      );
    if (this.due('scratch', undefined, 600_000))
      await task('scratch', async () => ({
        removed: await cleanStaleScratch(this.opts.scratchRoot, 3_600_000),
      }));
  }

  /** Claims and starts work up to free capacity. Returns the number started. */
  async tick(): Promise<number> {
    await this.housekeeping();
    const free = (this.opts.concurrency ?? 1) - this.running.size;
    if (free <= 0 || this.stopped) return 0;
    const queue = new CaptureQueue(this.opts.db, this.opts.now);
    let started = 0;
    for (let i = 0; i < free; i++) {
      const lease = await queue.claim(
        MEDIA_WORK_KINDS,
        this.opts.leaseSeconds ?? 60,
        this.opts.accountId,
      );
      if (!lease) break;
      const p = this.execute(lease).finally(() => this.running.delete(lease.job_id));
      this.running.set(lease.job_id, p);
      started++;
    }
    return started;
  }

  /** Processes until nothing is claimable and all running work finished (tests, one-shot runs). */
  async drain(): Promise<void> {
    for (;;) {
      const started = await this.tick();
      if (started === 0 && this.running.size === 0) return;
      await Promise.race([...this.running.values(), new Promise((r) => setTimeout(r, 10))]);
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
    await Promise.allSettled(this.running.values());
    // Stop advertising video capability immediately instead of waiting for staleness.
    await this.opts.db
      .query('DELETE FROM media_worker_capabilities WHERE worker_id=$1', [this.workerId])
      .catch(() => undefined);
  }

  async execute(lease: CaptureLease): Promise<void> {
    const queue = new CaptureQueue(this.opts.db, this.opts.now);
    const controller = new AbortController();
    const started = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - started > (this.opts.maxAttemptMs ?? 900_000)) {
        controller.abort();
        return;
      }
      queue
        .heartbeat(lease, this.opts.leaseSeconds ?? 60)
        .then((ok) => {
          if (!ok) controller.abort();
        })
        .catch(() => controller.abort());
    }, this.opts.heartbeatMs ?? 10_000);
    const ctx = this.context(lease, controller.signal);
    const prep = new MediaPreparation(ctx);
    try {
      switch (lease.kind) {
        case 'verify_upload':
          await prep.verifyUpload(lease);
          break;
        case 'prepare_media':
          await prep.prepareMedia(
            lease,
            createMediaPreparer({
              scratchRoot: this.opts.scratchRoot,
              tools: this.tools,
              derivativeAllowanceBytes: this.limits.derivativeAllowanceBytes,
              videoEnabled: !!this.qualification?.preparation,
              signal: controller.signal,
            }),
          );
          break;
        case 'purge_media':
        case 'cleanup_upload':
          await prep.cleanup(lease);
          break;
        default:
          throw new AppError('invalid_input');
      }
      const { rows } = await this.opts.db.query(
        'SELECT state,error_code FROM capture_work WHERE id=$1 AND account_id=$2',
        [lease.job_id, lease.account_id],
      );
      this.log('work', {
        job: lease.job_id,
        kind: lease.kind,
        state: rows[0]?.state,
        code: rows[0]?.error_code ?? null,
        ms: Date.now() - started,
      });
    } catch (error) {
      const code =
        error instanceof AppError
          ? error.code === 'conflict'
            ? 'lease_conflict'
            : error.code
          : 'worker_error';
      this.log('work failed', { job: lease.job_id, kind: lease.kind, code });
      await queue.fail(lease, code.slice(0, 64), true).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  }
}
