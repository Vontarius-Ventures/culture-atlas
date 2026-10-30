import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureResponse, JobResponse } from '@culture-atlas/domain/schemas';
import { ToastProvider } from '../Toast';
import { CaptureResultView } from './CaptureResultView';

/**
 * photo-unavailable-noop-retry: the failed-photo state must stay honest. A
 * failed initial reading has no active analysis, so no correction version
 * exists to re-run — a "Try again" there calls correct(), which silently
 * returns, and a real re-run would enqueue the unqualified paid vision role.
 * The unavailable explanation must therefore render with NO inert retry,
 * while a capture with an active analysis keeps its usable retry (it
 * corrects against that version) and a load error keeps its reload.
 */
const CAPTURE_ID = '00000000-0000-4000-8000-0000000000c1';
const JOB_ID = '00000000-0000-4000-8000-0000000000aa';
const UNAVAILABLE_MESSAGE = 'Photo reading isn’t available on this server yet. Your photo is saved.';

const { ctx, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    constructor(
      readonly status: number,
      readonly body: { code: string; message: string; retryable: boolean; request_id: string },
    ) {
      super(body.message);
    }
  }
  return {
    ctx: {
      request: vi.fn(async (_name: string, _payload?: unknown): Promise<unknown> => ({})),
      job: null as JobResponse | null,
    },
    MockApiError,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(`job=${JOB_ID}`),
}));
vi.mock('@/lib/client/api', () => ({
  api: { request: (name: string, payload?: unknown) => ctx.request(name, payload) },
  ApiError: MockApiError,
  newIdempotencyKey: () => 'k',
}));
vi.mock('@/lib/client/jobs', () => ({
  isTerminal: (j: { state: string } | null) =>
    Boolean(j && ['partial', 'complete', 'failed', 'cancelled'].includes(j.state)),
  useJob: () => ({ job: ctx.job, error: null, active: Boolean(ctx.job) }),
}));
vi.mock('@/lib/client/save', () => ({
  cardToTarget: (card: unknown) => card,
  useSave: () => ({ openSave: vi.fn() }),
}));

function capture(over: Partial<CaptureResponse> = {}): CaptureResponse {
  return {
    id: CAPTURE_ID,
    source: 'upload',
    status: 'failed',
    received_at: '2026-10-30T00:00:00Z',
    captured_at: null,
    image: { url: '/samples/room.jpg', width: 1000, height: 800, alt: 'Your photo' },
    focus: { kind: 'whole' },
    is_example: false,
    discovery_item_id: null,
    saved: false,
    analysis: null,
    references: [],
    recommendations: [],
    available_categories: [],
    job_id: null,
    ...over,
  } as CaptureResponse;
}

function activeAnalysis(over: Partial<NonNullable<CaptureResponse['analysis']>> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000a1',
    version: 2,
    title: 'Quiet corners',
    interpretation: null,
    sections: { wear: 'complete', play: 'unavailable' },
    question: null,
    warnings: [],
    created_at: '2026-10-30T00:00:00Z',
    ...over,
  } as NonNullable<CaptureResponse['analysis']>;
}

function failedJob(): JobResponse {
  return {
    id: JOB_ID,
    type: 'analyze_capture',
    state: 'failed',
    stage: null,
    sections: [],
    error: { code: 'provider_unavailable', message: UNAVAILABLE_MESSAGE, retryable: false },
    result: { type: 'capture', id: CAPTURE_ID },
    poll_after_ms: null,
    created_at: '2026-10-30T00:00:00Z',
    updated_at: '2026-10-30T00:00:00Z',
  } as JobResponse;
}

function renderView() {
  render(
    <ToastProvider>
      <CaptureResultView captureId={CAPTURE_ID} />
    </ToastProvider>,
  );
}

function correctionCalls() {
  return ctx.request.mock.calls.filter(([name]) => name === 'correctCapture');
}

beforeEach(() => {
  ctx.request.mockReset();
  ctx.request.mockImplementation(async () => ({}));
  ctx.job = null;
});
afterEach(cleanup);

describe('CaptureResultView failed/unavailable photo state', () => {
  it('shows the real unavailable explanation with no inert Try again when the initial reading has no analysis', async () => {
    // The real v1 fail-closed state: the worker failed the analysis before any
    // reading existed, so the capture has no analysis to correct against.
    ctx.request.mockImplementation(async (name: string) =>
      name === 'getCapture' ? Promise.resolve(capture()) : Promise.resolve({}),
    );
    ctx.job = failedJob();
    renderView();

    expect(
      await screen.findByRole('heading', { name: 'We can’t look at this photo yet' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(UNAVAILABLE_MESSAGE);
    // No action that silently does nothing: the only honest options here are
    // navigation, and a retry would have nothing to re-run.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(correctionCalls()).toEqual([]);
  });

  it('keeps the failed heading honest for a plain reading failure too', async () => {
    ctx.request.mockImplementation(async (name: string) =>
      name === 'getCapture' ? Promise.resolve(capture()) : Promise.resolve({}),
    );
    ctx.job = {
      ...failedJob(),
      error: { code: 'internal', message: 'Something went wrong while looking at this photo.', retryable: true },
    };
    renderView();
    expect(await screen.findByRole('heading', { name: 'We couldn’t read this photo' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'Something went wrong while looking at this photo.',
    );
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(correctionCalls()).toEqual([]);
  });

  it('still offers a working retry on the failed surface when an active analysis version exists', async () => {
    // View contract: retry presence follows analysis presence, not the failed
    // phase itself. With a version to correct against, Try again acts.
    ctx.request.mockImplementation(async (name: string) =>
      name === 'getCapture'
        ? Promise.resolve(
            capture({
              analysis: activeAnalysis({ version: 3, title: null, sections: {} }),
            }),
          )
        : Promise.resolve({ job_id: JOB_ID }),
    );
    ctx.job = failedJob();
    renderView();

    expect(await screen.findByRole('heading', { name: 'We can’t look at this photo yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(correctionCalls()).toHaveLength(1));
    expect(correctionCalls()[0]![1]).toEqual({
      params: { id: CAPTURE_ID },
      body: { expected_analysis_version: 3, focus: { kind: 'whole' } },
      idempotencyKey: 'k',
    });
  });

  it('keeps the partial-reading retry usable: it corrects against the active analysis version', async () => {
    ctx.request.mockImplementation(async (name: string) =>
      name === 'getCapture'
        ? Promise.resolve(
            capture({
              status: 'partial',
              analysis: activeAnalysis({ version: 2 }),
              recommendations: [],
            }),
          )
        : Promise.resolve({ job_id: JOB_ID }),
    );
    ctx.job = { ...failedJob(), state: 'partial', error: null };
    renderView();

    expect(await screen.findByRole('heading', { name: 'Quiet corners' })).toBeTruthy();
    expect(screen.getByText('Related discoveries are taking longer.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(correctionCalls()).toHaveLength(1));
    expect(correctionCalls()[0]![1]).toEqual({
      params: { id: CAPTURE_ID },
      body: { expected_analysis_version: 2, focus: { kind: 'whole' } },
      idempotencyKey: 'k',
    });
  });

  it('keeps the load-error retry usable and lands on the honest unavailable state', async () => {
    ctx.request
      .mockImplementationOnce(async () => {
        throw new MockApiError(503, {
          code: 'service_unavailable',
          message: 'The request did not go through.',
          retryable: true,
          request_id: 'test',
        });
      })
      .mockImplementation(async (name: string) =>
        name === 'getCapture' ? Promise.resolve(capture()) : Promise.resolve({}),
      );
    ctx.job = failedJob();
    renderView();

    expect(await screen.findByText('The request did not go through.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'We can’t look at this photo yet' }),
    ).toBeTruthy();
    // The retried load reached the honest unavailable state, still with no
    // inert action offered on it.
    expect(screen.getByRole('alert').textContent).toContain(UNAVAILABLE_MESSAGE);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});
