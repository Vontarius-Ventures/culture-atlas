'use client';

import { useEffect, useRef, useState } from 'react';
import type { JobResponse } from '@culture-atlas/domain/schemas';
import { api, ApiError } from './api';

/** Poll timing from the spec: 1.5 s while active, back off after 15 s, stop when terminal or hidden. */
export const POLL_FAST_MS = 1500;
export const POLL_SLOW_MS = 4000;
export const POLL_BACKOFF_AFTER_MS = 15_000;
export const POLL_ERROR_MAX_MS = 15_000;
export const POLL_MAX_ERRORS = 6;

export const TERMINAL_STATES = new Set(['partial', 'complete', 'failed', 'cancelled']);

export function isTerminal(job: Pick<JobResponse, 'state'> | null | undefined): boolean {
  return Boolean(job && TERMINAL_STATES.has(job.state));
}

/**
 * Next poll delay in ms, or null to stop.
 *  - terminal job -> stop;
 *  - server hint `poll_after_ms` wins when present (null from the server means terminal);
 *  - otherwise 1.5 s for the first 15 s, then 4 s;
 *  - after transport errors, exponential backoff (doubling from 1.5 s, capped at 15 s),
 *    giving up after POLL_MAX_ERRORS consecutive failures.
 */
export function nextPollDelay(input: {
  job: Pick<JobResponse, 'state' | 'poll_after_ms'> | null;
  elapsedMs: number;
  consecutiveErrors: number;
}): number | null {
  const { job, elapsedMs, consecutiveErrors } = input;
  if (consecutiveErrors > 0) {
    if (consecutiveErrors >= POLL_MAX_ERRORS) return null;
    return Math.min(POLL_FAST_MS * 2 ** consecutiveErrors, POLL_ERROR_MAX_MS);
  }
  if (job && isTerminal(job)) return null;
  if (job && typeof job.poll_after_ms === 'number') return Math.max(job.poll_after_ms, 250);
  return elapsedMs < POLL_BACKOFF_AFTER_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

export interface JobPollState {
  job: JobResponse | null;
  error: ApiError | null;
  /** True while the job is queued/running and polling continues. */
  active: boolean;
}

interface PollerDeps {
  fetchJob: (id: string) => Promise<JobResponse>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isHidden: () => boolean;
}

/**
 * Framework-free poller (unit-tested). Calls `onUpdate` after every fetch.
 * Pauses while the document is hidden; `resume()` polls immediately.
 */
export function createJobPoller(
  jobId: string,
  onUpdate: (s: JobPollState) => void,
  deps: PollerDeps,
) {
  const startedAt = deps.now();
  let errors = 0;
  let timer: unknown = null;
  let stopped = false;
  let inFlight = false;
  let last: JobPollState = { job: null, error: null, active: true };

  const schedule = (delay: number | null) => {
    if (stopped) return;
    if (delay === null) {
      last = { ...last, active: false };
      onUpdate(last);
      stopped = true;
      return;
    }
    if (deps.isHidden()) return; // resume() restarts polling when visible again
    timer = deps.setTimer(tick, delay);
  };

  const tick = async () => {
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const job = await deps.fetchJob(jobId);
      if (stopped) return;
      errors = 0;
      last = { job, error: null, active: !isTerminal(job) };
      onUpdate(last);
      schedule(nextPollDelay({ job, elapsedMs: deps.now() - startedAt, consecutiveErrors: 0 }));
    } catch (err) {
      if (stopped) return;
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError(0, {
              code: 'service_unavailable',
              message: 'Could not check progress.',
              retryable: true,
              request_id: 'client',
            });
      // A missing or forbidden job will not recover by polling.
      if (!apiErr.retryable && apiErr.status !== 0) {
        last = { ...last, error: apiErr, active: false };
        onUpdate(last);
        stopped = true;
        return;
      }
      errors += 1;
      last = { ...last, error: apiErr };
      onUpdate(last);
      schedule(
        nextPollDelay({
          job: last.job,
          elapsedMs: deps.now() - startedAt,
          consecutiveErrors: errors,
        }),
      );
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      void tick();
    },
    resume() {
      if (stopped || timer !== null || inFlight) return;
      void tick();
    },
    pause() {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
    stop() {
      stopped = true;
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
    },
    get stopped() {
      return stopped;
    },
  };
}

/**
 * React hook: polls GET /v1/jobs/{id} until terminal; stops while the tab is
 * hidden and resumes when it becomes visible. `onUpdate` fires for every new job state.
 */
export function useJob(
  jobId: string | null | undefined,
  onUpdate?: (job: JobResponse) => void,
): JobPollState {
  const [state, setState] = useState<JobPollState>({
    job: null,
    error: null,
    active: Boolean(jobId),
  });
  const callback = useRef(onUpdate);
  useEffect(() => {
    callback.current = onUpdate;
  });

  useEffect(() => {
    if (!jobId) return;
    let lastKey = '';
    const poller = createJobPoller(
      jobId,
      (s) => {
        setState(s);
        if (s.job) {
          const key = `${s.job.state}|${s.job.stage}|${s.job.sections.map((x) => `${x.name}:${x.status}`).join(',')}|${s.job.updated_at}`;
          if (key !== lastKey) {
            lastKey = key;
            callback.current?.(s.job);
          }
        }
      },
      {
        fetchJob: (id) => api.request('getJob', { params: { id } }),
        now: () => Date.now(),
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (h) => window.clearTimeout(h as number),
        isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
      },
    );
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') poller.pause();
      else poller.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    poller.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
    };
  }, [jobId]);

  return jobId ? state : { job: null, error: null, active: false };
}
