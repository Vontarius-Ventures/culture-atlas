import type { ProviderRegistry } from '@culture-atlas/providers';
import type { DomainConfig } from '../config';
import type { Db } from '../db/pool';
import type { JobType } from '../enums';
import type { TraceEventInput } from '../services/traces';
import type { JobOutcome, JobPayload, JobRecord } from './types';

/**
 * Contract between apps/worker and pipeline handlers (packages/domain/src/pipeline).
 * The worker owns leasing, heartbeats, deadlines, completion and failure;
 * handlers own the work. Handlers:
 *  - wrap each provider-calling stage in ctx.runStage(name, fn) so a retry
 *    after a lost lease reuses completed outputs (idempotent stage writes);
 *  - call ctx.ensureActive() immediately before publishing results (deletion
 *    or cancellation must prevent publication);
 *  - respect ctx.budget and ctx.signal;
 *  - throw AppError/ProviderError on failure (the worker maps retryability);
 *  - return { state: 'partial' } when useful output exists but some sections failed.
 */
export interface JobContext<T extends JobType = JobType> {
  job: JobRecord<T>;
  payload: JobPayload<T>;
  attempt: number;
  workerId: string;
  db: Db;
  providers: ProviderRegistry;
  config: DomainConfig;
  /** Aborted on cancellation, lease loss or the per-attempt deadline. */
  signal: AbortSignal;
  budget: {
    qlooRequests: number;
    researchRefs: number;
    providerRetries: number;
    deadlineMs: number;
  };
  setStage(stage: string): Promise<void>;
  runStage<R>(stage: string, fn: () => Promise<R>): Promise<R>;
  /** Throws JobCancelledError if the job was cancelled, lease lost, or deadline passed. */
  ensureActive(): Promise<void>;
  trace(event: Omit<TraceEventInput, 'jobId'>): Promise<void>;
  log(message: string, data?: Record<string, unknown>): void;
}

export type JobHandler<T extends JobType = JobType> = (ctx: JobContext<T>) => Promise<JobOutcome>;

export type JobHandlerMap = { [K in JobType]: JobHandler<K> };

/** Thrown when a job must stop without publishing (cancelled / lease lost / deleted). */
export class JobCancelledError extends Error {
  constructor(reason = 'cancelled') {
    super(`job stopped: ${reason}`);
    this.name = 'JobCancelledError';
  }
}
