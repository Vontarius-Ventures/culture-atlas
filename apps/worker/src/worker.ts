import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  AppError,
  JobCancelledError,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  heartbeatJob,
  isAppError,
  markJobCancelled,
  reapJobs,
  runStageOnce,
  sensorConnections,
  setJobStage,
  stillOwnsJob,
  traces,
  type Db,
  type DomainConfig,
  type JobContext,
  type JobFailure,
  type JobHandlerMap,
  type JobRecord,
  type JobType,
} from '@culture-atlas/domain';
import { isProviderError, type ProviderRegistry } from '@culture-atlas/providers';

/**
 * DB-backed job worker: claims leased jobs (NO KEY UPDATE SKIP LOCKED), runs the handler for
 * the job type with a heartbeat and a per-attempt deadline, then completes,
 * re-queues (retryable, with backoff) or fails the job. Cancellation and lease
 * loss abort the handler's signal; the handler must not publish afterwards.
 */
export interface WorkerOptions {
  db: Db;
  providers: ProviderRegistry;
  config: DomainConfig;
  handlers: JobHandlerMap;
  workerId?: string;
  concurrency?: number;
  pollMs?: number;
  leaseMs?: number;
  heartbeatMs?: number;
  types?: readonly JobType[];
  /** Only claim these job ids (tests / targeted reprocessing). */
  jobIds?: readonly string[];
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Enqueue the purge job periodically (default: on unless jobIds is set). */
  schedulePurge?: boolean;
  purgeEveryMs?: number;
  /** Re-create broken World Sensor poll chains periodically (default: on unless jobIds is set). */
  scheduleSensorPolls?: boolean;
  sensorSweepEveryMs?: number;
}

/** One purge per hour bucket at most: the dedupe key makes concurrent workers agree. */
export function purgeDedupeKey(now: Date): string {
  return `purge_deleted:${now.toISOString().slice(0, 13)}`;
}

export function toFailure(err: unknown): { failure: JobFailure; retryAfterMs?: number } {
  if (isAppError(err)) {
    return { failure: { code: err.code, message: err.message, retryable: err.retryable } };
  }
  if (isProviderError(err)) {
    const code = err.kind === 'rate_limited' ? 'rate_limited' : 'provider_unavailable';
    // Job errors are shown to consumers: never name providers or error kinds
    // (those stay in provider_queries and traces for the inspector).
    const message =
      err.kind === 'rate_limited'
        ? 'We’re a little busy right now. Try again shortly.'
        : err.provider === 'vlm'
          ? 'We can’t look at photos right now. Try again in a little while.'
          : 'Part of this is taking longer than usual. Try again in a little while.';
    return {
      failure: { code, message, retryable: err.retryable },
      retryAfterMs: err.retryAfterMs,
    };
  }
  return { failure: { code: 'internal', message: 'Unexpected worker error', retryable: true } };
}

export class Worker {
  readonly workerId: string;
  private readonly running = new Map<string, Promise<void>>();
  private stopped = false;
  private loop?: Promise<void>;
  private lastReap = 0;
  private lastPurge = 0;
  private lastSensorSweep = 0;

  constructor(private readonly opts: WorkerOptions) {
    this.workerId = opts.workerId ?? `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  }

  private get concurrency() {
    return this.opts.concurrency ?? this.opts.config.WORKER_CONCURRENCY;
  }
  private get leaseMs() {
    return this.opts.leaseMs ?? this.opts.config.JOB_LEASE_MS;
  }
  private get heartbeatMs() {
    return this.opts.heartbeatMs ?? this.opts.config.JOB_HEARTBEAT_MS;
  }
  private log(message: string, data?: Record<string, unknown>) {
    (this.opts.log ?? ((m, d) => console.log(`[worker ${this.workerId}] ${m}`, d ?? '')))(message, data);
  }

  /** Claim and start up to the free capacity. Returns the number of jobs started. */
  async tick(): Promise<number> {
    if (Date.now() - this.lastReap > 15_000) {
      this.lastReap = Date.now();
      await reapJobs(this.opts.db).catch((e: Error) => this.log('reap failed', { error: e.message }));
    }
    if ((this.opts.schedulePurge ?? !this.opts.jobIds) && Date.now() - this.lastPurge > (this.opts.purgeEveryMs ?? 600_000)) {
      this.lastPurge = Date.now();
      await enqueueJob(this.opts.db, { type: 'purge_deleted', owner: null, payload: {}, dedupeKey: purgeDedupeKey(new Date()), maxAttempts: 3 }).catch((e: Error) =>
        this.log('purge enqueue failed', { error: e.message }),
      );
    }
    if ((this.opts.scheduleSensorPolls ?? !this.opts.jobIds) && Date.now() - this.lastSensorSweep > (this.opts.sensorSweepEveryMs ?? 60_000)) {
      this.lastSensorSweep = Date.now();
      await sensorConnections.ensureSensorPollJobs(this.opts.db).catch((e: Error) => this.log('sensor sweep failed', { error: e.message }));
    }
    const free = this.concurrency - this.running.size;
    if (free <= 0 || this.stopped) return 0;
    const jobs = await claimJobs(this.opts.db, {
      workerId: this.workerId,
      limit: free,
      leaseMs: this.leaseMs,
      types: this.opts.types,
      ids: this.opts.jobIds,
    });
    for (const job of jobs) {
      const p = this.execute(job).finally(() => this.running.delete(job.id));
      this.running.set(job.id, p);
    }
    return jobs.length;
  }

  /** Process until no more claimable jobs and all running jobs finished (tests). */
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
          const started = await this.tick();
          if (started === 0) await new Promise((r) => setTimeout(r, this.opts.pollMs ?? this.opts.config.WORKER_POLL_MS));
        } catch (err) {
          this.log('tick failed', { error: (err as Error).message });
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
    await Promise.allSettled(this.running.values());
  }

  private async execute(job: JobRecord): Promise<void> {
    const { db, providers, config } = this.opts;
    const controller = new AbortController();
    const deadlineMs = job.budget.deadline_ms ?? config.ANALYSIS_DEADLINE_MS;
    let stopReason: string | null = null;
    const abort = (reason: string) => {
      stopReason ??= reason;
      controller.abort(new JobCancelledError(reason));
    };
    const deadline = setTimeout(() => abort('deadline'), deadlineMs);
    const heartbeat = setInterval(() => {
      heartbeatJob(db, job.id, this.workerId, this.leaseMs)
        .then((ok) => {
          if (!ok) abort('lease lost or cancelled');
        })
        .catch(() => undefined);
    }, this.heartbeatMs);

    const handler = this.opts.handlers[job.type] as (ctx: JobContext) => Promise<{ state: 'complete' | 'partial'; resultType?: string; resultId?: string }>;
    const ctx: JobContext = {
      job,
      payload: job.payload,
      attempt: job.attempt,
      workerId: this.workerId,
      db,
      providers,
      config,
      signal: controller.signal,
      budget: {
        qlooRequests: job.budget.qloo_requests ?? config.JOB_MAX_QLOO_REQUESTS,
        researchRefs: job.budget.research_refs ?? config.JOB_MAX_RESEARCH_REFS,
        providerRetries: job.budget.provider_retries ?? config.JOB_MAX_PROVIDER_RETRIES,
        deadlineMs,
      },
      setStage: async (stage) => {
        if (!(await setJobStage(db, job.id, this.workerId, stage))) abort('lease lost');
      },
      runStage: (stage, fn) => runStageOnce(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
      ensureActive: async () => {
        if (controller.signal.aborted || !(await stillOwnsJob(db, job.id, this.workerId))) {
          abort('cancelled');
          throw new JobCancelledError(stopReason ?? 'cancelled');
        }
      },
      trace: (event) =>
        traces.recordTraceEvent(db, {
          ...event,
          jobId: job.id,
          traceId: event.traceId ?? job.trace_id,
          ownerAccountId: job.owner_account_id,
          ownerSessionId: job.owner_session_id,
        }),
      log: (message, data) => this.log(`${job.type} ${job.id}: ${message}`, data),
    };

    try {
      if (!handler) throw new AppError('internal', { message: `No handler for job type ${job.type}`, retryable: false });
      const outcome = await handler(ctx);
      if (controller.signal.aborted && stopReason !== 'deadline') throw new JobCancelledError(stopReason ?? 'cancelled');
      const ok = await completeJob(db, job.id, this.workerId, outcome);
      if (!ok) this.log('completion rejected (lease lost)', { jobId: job.id });
    } catch (err) {
      if (err instanceof JobCancelledError || (controller.signal.aborted && stopReason !== 'deadline')) {
        await markJobCancelled(db, job.id, this.workerId);
        this.log('stopped', { jobId: job.id, reason: stopReason ?? (err as Error).message });
      } else if (stopReason === 'deadline') {
        await failJob(db, job.id, this.workerId, {
          code: 'service_unavailable',
          message: 'The job did not finish in time.',
          retryable: true,
        });
      } else {
        const { failure, retryAfterMs } = toFailure(err);
        if (failure.code === 'internal') this.log('handler error', { jobId: job.id, error: (err as Error).message });
        await failJob(db, job.id, this.workerId, failure, { retryAfterMs });
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
  }
}
