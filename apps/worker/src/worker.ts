import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  AppError,
  JobCancelledError,
  claimJobs,
  completeJob,
  dispatchGraphExpansion,
  dispatchGraphOutbox,
  discoveryEnabledInConfig,
  enqueueJob,
  ensureAccountDeletionPurgeJobs,
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
  type JobOutcome,
  type JobRecord,
  type JobType,
} from '@culture-atlas/domain';
import { bindModelIdentity, identitySequence, isProviderError, type ProviderRegistry } from '@culture-atlas/providers';

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
  /**
   * Hand durable interest-graph projection intents to the queue periodically
   * (default: on unless jobIds is set). One cheap indexed pass per interval;
   * per-account kill/opt-in checks stay inside dispatchGraphOutbox.
   */
  scheduleGraphDispatch?: boolean;
  graphDispatchEveryMs?: number;
  /**
   * Sweep due graph-expansion refreshes into the queue periodically (default:
   * on unless jobIds is set). Accounts whose committed projection published
   * fresh support refresh in the background, clients closed or open — the
   * feed read only enqueues the same deduplicated due work, never inline
   * provider/model work (VAL-DISC-003). Per-account gate/kill/pause checks
   * and the 15-minute periodic bound stay inside dispatchGraphExpansion.
   */
  scheduleGraphExpansion?: boolean;
  graphExpansionEveryMs?: number;
  /**
   * Re-arm durable account-deletion cleanups periodically (default: on unless
   * jobIds is set): every accepted deletion whose cleanup is still owed
   * (pending or last-attempt failed) gets its system-owned purge job back
   * after a crash, restart or terminal queue failure. Authority is never
   * restored by a retry; the acceptance revoked it durably.
   */
  scheduleAccountDeletionPurges?: boolean;
  accountDeletionPurgeEveryMs?: number;
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
        : err.provider === 'vlm' && !err.retryable && err.kind === 'unavailable' && !err.retryAfterMs
          ? // Unconfigured/unqualified vision is a server state: never promise a retry.
            'Photo reading isn’t available on this server yet. Your photo is saved.'
          : err.provider === 'vlm'
          ? 'We can’t look at photos right now. Try again in a little while.'
          : 'Part of this is taking longer than usual. Try again in a little while.';
    // An open circuit (kind unavailable, with the time until its next trial) is transient too.
    const circuitOpen = err.kind === 'unavailable' && (err.retryAfterMs ?? 0) > 0;
    return {
      failure: { code, message, retryable: err.retryable || circuitOpen },
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
  private lastGraphDispatch = 0;
  private lastGraphExpansion = 0;
  private lastAccountDeletionPurge = 0;

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
    // Interest-graph outbox dispatch (PR 8): the durable intents committed by
    // mutations are handed to this same queue here, so a committed change is
    // projected without any new user mutation even across dispatcher restarts.
    // The same sweep hands off support-version catch-up work (upgrade
    // reprojection): accounts whose ready projection predates the current
    // projector semantics are rebuilt from current state without a new user
    // mutation. Only runs when the operator opted the server in; per-account
    // kill flags are still honored inside the dispatch pass.
    if (
      (this.opts.scheduleGraphDispatch ?? !this.opts.jobIds) &&
      Date.now() - this.lastGraphDispatch > (this.opts.graphDispatchEveryMs ?? 5_000) &&
      (this.opts.config.INTEREST_GRAPH_PROJECTION_ENABLED === 'true' || this.opts.config.INTEREST_GRAPH_PROJECTION_ENABLED === '1')
    ) {
      this.lastGraphDispatch = Date.now();
      await dispatchGraphOutbox(this.opts.db, { config: this.opts.config }).catch((e: Error) =>
        this.log('graph outbox dispatch failed', { error: e.message }),
      );
    }
    // Interest-graph expansion sweep (PR 8 discovery): the closed-app sweeper.
    // Accounts whose committed projection published fresh support (or whose
    // 15-minute periodic window opened) get one bounded expansion job each,
    // coalesced by the queue dedupe; the sweep only runs when the operator
    // opted the server into discovery. Gate/kill/pause checks and the periodic
    // bound stay inside dispatchGraphExpansion.
    if (
      (this.opts.scheduleGraphExpansion ?? !this.opts.jobIds) &&
      Date.now() - this.lastGraphExpansion > (this.opts.graphExpansionEveryMs ?? 5_000) &&
      discoveryEnabledInConfig(this.opts.config)
    ) {
      this.lastGraphExpansion = Date.now();
      await dispatchGraphExpansion(this.opts.db, { config: this.opts.config }).catch((e: Error) =>
        this.log('graph expansion sweep failed', { error: e.message }),
      );
    }
    // Account-deletion cleanup re-arm (VAL-DELETE-004): deletions whose
    // cleanup is still owed get their purge job back after a crash, restart
    // or terminal queue failure. Deduplicated by the queue; never re-runs a
    // completed deletion and never restores any authority.
    if (
      (this.opts.scheduleAccountDeletionPurges ?? !this.opts.jobIds) &&
      Date.now() - this.lastAccountDeletionPurge > (this.opts.accountDeletionPurgeEveryMs ?? 30_000)
    ) {
      this.lastAccountDeletionPurge = Date.now();
      await ensureAccountDeletionPurgeJobs(this.opts.db).catch((e: Error) =>
        this.log('account-deletion purge sweep failed', { error: e.message }),
      );
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
      // Executions are tracked by (job, attempt): this worker can reclaim its
      // own lapsed job at a newer attempt while the old execution is still
      // running, and the old execution settling must never erase the
      // successor's slot (drain/stop await both executions).
      const key = `${job.id}#${job.attempt}`;
      const p = this.execute(job).finally(() => this.running.delete(key));
      this.running.set(key, p);
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
      heartbeatJob(db, job.id, this.workerId, job.attempt, this.leaseMs)
        .then((ok) => {
          if (!ok) abort('lease lost or cancelled');
        })
        .catch(() => undefined);
    }, this.heartbeatMs);

    const handler = this.opts.handlers[job.type] as (ctx: JobContext) => Promise<JobOutcome>;
    const ctx: JobContext = {
      job,
      payload: job.payload,
      attempt: job.attempt,
      workerId: this.workerId,
      db,
      // Budgeted model gateways (Concentrate) need verified server-owned identity per call.
      // Session-owned (anonymous) jobs get none, so the gateway refuses them rather than
      // charging spend to no account.
      providers: job.owner_account_id
        ? bindModelIdentity(
            providers,
            identitySequence({ accountId: job.owner_account_id, jobId: job.id, prefix: `v1:${job.type}:a${job.attempt}` }),
          )
        : providers,
      config,
      signal: controller.signal,
      budget: {
        qlooRequests: job.budget.qloo_requests ?? config.JOB_MAX_QLOO_REQUESTS,
        researchRefs: job.budget.research_refs ?? config.JOB_MAX_RESEARCH_REFS,
        providerRetries: job.budget.provider_retries ?? config.JOB_MAX_PROVIDER_RETRIES,
        deadlineMs,
      },
      setStage: async (stage) => {
        if (!(await setJobStage(db, job.id, this.workerId, job.attempt, stage))) abort('lease lost');
      },
      runStage: (stage, fn) => runStageOnce(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
      ensureActive: async () => {
        if (controller.signal.aborted || !(await stillOwnsJob(db, job.id, this.workerId, job.attempt))) {
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
      // DISC-SCR-042: when the handler reports a durably COMMITTED
      // publication, the returned outcome is final — its results, proofs
      // and the discovery parent's terminal status are already in the
      // database. A cancellation (or the attempt deadline) observed only
      // now — by a queued real heartbeat whose UPDATE landed after a later
      // cancel — must not retroactively classify that committed result as
      // cancelled: finalize the committed outcome instead. completeJob's own
      // lease-owner + claimed-attempt guard still fences a superseded
      // execution, so a lost lease cannot complete a successor's row.
      // Handlers that report no committed publication keep the ordinary
      // abort classification below.
      if (!outcome.publicationCommitted && controller.signal.aborted && stopReason !== 'deadline') {
        throw new JobCancelledError(stopReason ?? 'cancelled');
      }
      const ok = await completeJob(db, job.id, this.workerId, job.attempt, outcome);
      if (!ok) this.log('completion rejected (lease lost)', { jobId: job.id });
    } catch (err) {
      if (err instanceof JobCancelledError || (controller.signal.aborted && stopReason !== 'deadline')) {
        await markJobCancelled(db, job.id, this.workerId, job.attempt);
        this.log('stopped', { jobId: job.id, reason: stopReason ?? (err as Error).message });
      } else if (stopReason === 'deadline') {
        await failJob(db, job.id, this.workerId, job.attempt, {
          code: 'service_unavailable',
          message: 'The job did not finish in time.',
          retryable: true,
        });
      } else {
        const { failure, retryAfterMs } = toFailure(err);
        if (failure.code === 'internal') this.log('handler error', { jobId: job.id, error: (err as Error).message });
        await failJob(db, job.id, this.workerId, job.attempt, failure, { retryAfterMs });
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
  }
}
