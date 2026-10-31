import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { api, ApiError } from '@/lib/client/api';
import { StyledCard, StyledCaptureResponse } from '@/lib/client/style';
import { styleReading } from '../../e2e/mock/style';
import { capturePayload, discoveryIntentsFixture } from '../../e2e/mock/discovery-intents';
import { DISCOVERY_POLL_DEADLINE_MS, DISCOVERY_POLL_MS } from '@/lib/client/discovery-poll';

const m = vi.hoisted(() => ({
  account: 'account-a',
  toast: { show: vi.fn(), announce: vi.fn() },
  overrides: new Map(),
  watch: vi.fn(),
  job: null as { state: string } | null,
  jobUpdate: null as (() => void) | null,
}));
vi.mock('next/link', () => ({ default: (props: ComponentProps<'a'>) => <a {...props} /> }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/client/session', () => ({
  useSession: () => ({
    session: { principal: { kind: 'account', account_id: m.account, session_id: 'session' } },
  }),
}));
vi.mock('@/lib/client/jobs', () => ({
  useJob: (_id: string | null, onUpdate: () => void) => {
    m.jobUpdate = onUpdate;
    return { job: m.job, error: null };
  },
  isTerminal: (job: { state: string }) =>
    ['complete', 'partial', 'failed', 'cancelled'].includes(job.state),
}));
vi.mock('@/lib/client/save', () => ({
  useSave: () => ({ openSave: vi.fn() }),
  cardToTarget: vi.fn(),
}));
vi.mock('@/lib/client/store', () => ({
  useItemOverrides: () => m.overrides,
  getCapturePreview: () => null,
  applyOverrides: (cards: unknown[]) => cards,
}));
vi.mock('@/lib/client/ready', () => ({
  setViewingResult: vi.fn(),
  watchAnalysis: m.watch,
}));
vi.mock('../Toast', () => ({ useToast: () => m.toast }));
vi.mock('../style/CitySheet', () => ({ CitySheet: () => null }));

import { CaptureResultView } from './CaptureResultView';

const id = '00000000-0000-4000-8000-000000000001';
const result = (mode: Parameters<typeof discoveryIntentsFixture>[0] = 'running') =>
  StyledCaptureResponse.parse(capturePayload(discoveryIntentsFixture(mode)));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  await act(async () => {});
};
const advance = async (ms = DISCOVERY_POLL_MS) => {
  await act(() => vi.advanceTimersByTimeAsync(ms));
};
function chooseVisual() {
  fireEvent.click(screen.getByRole('button', { name: 'Visual references' }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  m.account = 'account-a';
  m.job = null;
  m.jobUpdate = null;
  m.watch.mockClear();
  m.toast.announce.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('capture visual polling lifecycle', () => {
  it.each(['older API', 'terminal visual intent'] as const)(
    'does not miss batched running/ready reads; removes a late vetoed claim and card with %s',
    async (mode) => {
      const base = result('ready');
      if (mode === 'older API') base.discovery_intents = null;
      const vetoCard = StyledCard.parse({
        id: '00000000-0000-4000-8000-000000000003',
        kind: 'brand',
        category: 'wear',
        title: 'Retro paddock wear',
        subtitle: null,
        image: null,
        is_example: true,
        saved: false,
        saved_item_id: null,
        recommendation_id: null,
        evidence_available: false,
        reason: 'For the vintage motorsport look your photo resembles',
      });
      const rail = {
        key: 'more_like_this:s1',
        kind: 'more_like_this',
        title: 'Brands to explore',
        subtitle: null,
        subject_id: 's1',
        status: 'ready',
        empty_message: null,
        cards: [vetoCard],
      };
      const ready = {
        ...base,
        style: { ...base.style, status: 'ready', reading: styleReading(), rails: [rail] },
      };
      const pending = { ...ready, style: { ...ready.style, status: 'running', reading: null } };
      const vetoed = {
        ...ready,
        style: {
          ...ready.style,
          reading: styleReading({ retracted: true }),
          rails: [{ ...rail, cards: [] }],
        },
      };
      m.job = { state: 'complete' };
      const read = vi
        .spyOn(api, 'requestAs')
        .mockResolvedValueOnce(base)
        .mockResolvedValueOnce(pending)
        .mockResolvedValueOnce(ready)
        .mockResolvedValue(vetoed);
      render(<CaptureResultView captureId={id} />);
      await flush();
      // The retained browser trace delivered these reads 18 ms apart via job
      // updates. One React batch need never commit the intermediate running UI.
      await act(async () => {
        m.jobUpdate!();
        await Promise.resolve();
        m.jobUpdate!();
        await Promise.resolve();
      });
      expect(read).toHaveBeenCalledTimes(3);
      expect(screen.getByText('Resembles vintage motorsport')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Retro paddock wear' })).toBeTruthy();
      await advance();
      expect(read).toHaveBeenCalledTimes(4);
      await advance(250);
      expect(screen.queryByText('Resembles vintage motorsport')).toBeNull();
      expect(screen.queryByRole('link', { name: 'Retro paddock wear' })).toBeNull();
      expect(screen.getByText('Style reading updated')).toBeTruthy();
      await advance(180_000);
      expect(read).toHaveBeenCalledTimes(4);
    },
  );

  it('refreshes once after late legacy style work settles, then stops', async () => {
    const settled = result('unavailable');
    const pending = { ...settled, style: { ...settled.style, status: 'running' } };
    const updated = {
      ...settled,
      analysis: { ...settled.analysis!, title: 'Guard updated the photo reading' },
    };
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(settled)
      .mockResolvedValue(updated);
    render(<CaptureResultView captureId={id} />);
    await flush();
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
    await advance();
    expect(read).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Guard updated the photo reading',
    );
    await advance(30_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('records pending style while the parent job is active and checks once after it settles', async () => {
    const settled = result('ready');
    const pending = { ...settled, style: { ...settled.style, status: 'running' } };
    m.job = { state: 'running' };
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(settled)
      .mockResolvedValue(settled);
    const view = render(<CaptureResultView captureId={id} />);
    await flush();
    await advance();
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      m.jobUpdate!();
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledTimes(2);
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
    m.job = { state: 'complete' };
    view.rerender(<CaptureResultView captureId={id} />);
    await flush();
    await advance();
    expect(read).toHaveBeenCalledTimes(3);
    await advance(180_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('skips a final guard refresh when hidden without restarting terminal visual polling', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const settled = result('ready');
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce({ ...settled, style: { ...settled.style, status: 'running' } })
      .mockResolvedValue(settled);
    render(<CaptureResultView captureId={id} />);
    await flush();
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    await advance(180_000);
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await advance(180_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds a hanging final guard refresh, aborts it and ignores late stale data', async () => {
    const settled = result('ready');
    const late = deferred<ReturnType<typeof result>>();
    let signal: AbortSignal | undefined;
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce({ ...settled, style: { ...settled.style, status: 'running' } })
      .mockResolvedValueOnce(settled)
      .mockImplementationOnce((_name, _schema, options) => {
        signal = options.signal;
        return late.promise;
      });
    render(<CaptureResultView captureId={id} />);
    await flush();
    await advance();
    await advance();
    expect(read).toHaveBeenCalledTimes(3);
    expect(signal?.aborted).toBe(false);
    await advance(DISCOVERY_POLL_DEADLINE_MS);
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      late.resolve({
        ...settled,
        analysis: { ...settled.analysis!, title: 'Stale final guard data' },
      }),
    );
    expect(screen.queryByRole('heading', { name: 'Stale final guard data' })).toBeNull();
    await advance(180_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(['unmount', 'account change', 'capture change'] as const)(
    'aborts an in-flight final guard refresh on %s and rejects its late response',
    async (boundary) => {
      const settled = result('ready');
      const late = deferred<ReturnType<typeof result>>();
      let signal: AbortSignal | undefined;
      const read = vi
        .spyOn(api, 'requestAs')
        .mockResolvedValueOnce({ ...settled, style: { ...settled.style, status: 'running' } })
        .mockResolvedValueOnce(settled)
        .mockImplementationOnce((_name, _schema, options) => {
          signal = options.signal;
          return late.promise;
        })
        .mockResolvedValue(settled);
      const view = render(<CaptureResultView captureId={id} />);
      await flush();
      await advance();
      await advance();
      expect(read).toHaveBeenCalledTimes(3);
      expect(signal?.aborted).toBe(false);
      if (boundary === 'unmount') view.unmount();
      else {
        if (boundary === 'account change') m.account = 'account-b';
        view.rerender(
          <CaptureResultView
            captureId={boundary === 'capture change' ? `${id.slice(0, -1)}9` : id}
          />,
        );
        await flush();
      }
      expect(signal?.aborted).toBe(true);
      await act(async () =>
        late.resolve({
          ...settled,
          analysis: { ...settled.analysis!, title: 'Previous owner guard data' },
        }),
      );
      expect(screen.queryByRole('heading', { name: 'Previous owner guard data' })).toBeNull();
      const readsAtBoundary = read.mock.calls.length;
      await advance(180_000);
      expect(read).toHaveBeenCalledTimes(readsAtBoundary);
    },
  );

  it.each(['unmount', 'account change', 'capture change'] as const)(
    'cancels the final legacy refresh on %s',
    async (boundary) => {
      const settled = result('unavailable');
      const read = vi
        .spyOn(api, 'requestAs')
        .mockResolvedValueOnce({
          ...settled,
          style: { ...settled.style, status: 'running' },
        })
        .mockResolvedValue(settled);
      const view = render(<CaptureResultView captureId={id} />);
      await flush();
      await advance();
      expect(read).toHaveBeenCalledTimes(2);
      if (boundary === 'unmount') view.unmount();
      else {
        if (boundary === 'account change') m.account = 'account-b';
        view.rerender(
          <CaptureResultView
            captureId={boundary === 'capture change' ? `${id.slice(0, -1)}9` : id}
          />,
        );
        await flush();
      }
      const readsAtBoundary = read.mock.calls.length;
      await advance(30_000);
      expect(read).toHaveBeenCalledTimes(readsAtBoundary);
    },
  );

  it('polls after parent readiness, does not change the main ready notice, and stops on visual completion', async () => {
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce(result())
      .mockResolvedValue(result('ready'));
    render(<CaptureResultView captureId={id} />);
    await flush();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Synthetic photo reading');
    expect(m.watch).not.toHaveBeenCalled();
    chooseVisual();
    expect(screen.getByRole('status').textContent).toContain('Comparing reference images');
    expect(read).toHaveBeenCalledTimes(1);
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('list', { name: 'Attributed reference images' })).toBeTruthy();
    await advance(30_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(m.toast.announce).not.toHaveBeenCalled();
  });

  it('uses cached capture data for rapid mode switching without any additional requests', async () => {
    const read = vi.spyOn(api, 'requestAs').mockResolvedValue(result('ready'));
    render(<CaptureResultView captureId={id} />);
    await flush();
    for (let i = 0; i < 10; i++) {
      chooseVisual();
      fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    }
    await advance(30_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it('times out a hanging read truthfully, aborts it, and ignores late success', async () => {
    const late = deferred<ReturnType<typeof result>>();
    let signal: AbortSignal | undefined;
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce(result())
      .mockImplementationOnce((_name, _schema, options) => {
        signal = options.signal;
        return late.promise;
      });
    render(<CaptureResultView captureId={id} />);
    await flush();
    chooseVisual();
    await advance(DISCOVERY_POLL_DEADLINE_MS);
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('their result is not known yet');
    await act(async () => late.resolve(result('ready')));
    expect(screen.queryByRole('list', { name: 'Attributed reference images' })).toBeNull();
    await advance(180_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated completed pending reads instead of polling forever', async () => {
    const read = vi.spyOn(api, 'requestAs').mockResolvedValue(result('pending'));
    render(<CaptureResultView captureId={id} />);
    await flush();
    chooseVisual();
    await advance(180_000);
    expect(read.mock.calls.length).toBeLessThanOrEqual(61);
    expect(screen.getByRole('status').textContent).toContain('stopped checking');
    const count = read.mock.calls.length;
    await advance(180_000);
    expect(read).toHaveBeenCalledTimes(count);
  });

  it('aborts in-flight requests on unmount', async () => {
    const late = deferred<ReturnType<typeof result>>();
    let signal: AbortSignal | undefined;
    vi.spyOn(api, 'requestAs').mockImplementation((_name, _schema, options) => {
      signal = options.signal;
      return late.promise;
    });
    const view = render(<CaptureResultView captureId={id} />);
    await flush();
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => late.resolve(result('ready')));
    expect(screen.queryByRole('heading')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot publish a stale account response after the principal changes', async () => {
    const previous = deferred<ReturnType<typeof result>>();
    const next = deferred<ReturnType<typeof result>>();
    let previousSignal: AbortSignal | undefined;
    const read = vi
      .spyOn(api, 'requestAs')
      .mockResolvedValueOnce(result())
      .mockImplementationOnce((_name, _schema, options) => {
        previousSignal = options.signal;
        return previous.promise;
      })
      .mockReturnValueOnce(next.promise);
    const view = render(<CaptureResultView captureId={id} />);
    await flush();
    await advance();
    m.account = 'account-b';
    view.rerender(<CaptureResultView captureId={id} />);
    await flush();
    expect(previousSignal?.aborted).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Synthetic photo reading' })).toBeNull();
    await act(async () => previous.resolve(result('ready')));
    expect(screen.queryByRole('list', { name: 'Attributed reference images' })).toBeNull();
    const newer = result('empty');
    newer.analysis!.title = 'Next account reading';
    await act(async () => next.resolve(newer));
    expect(screen.getByRole('heading', { name: 'Next account reading' })).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403, 404])(
    'clears private capture data and stops on HTTP %s even if retryable',
    async (status) => {
      const read = vi
        .spyOn(api, 'requestAs')
        .mockResolvedValueOnce(result())
        .mockRejectedValueOnce(
          new ApiError(status, {
            code: 'not_found',
            message: 'Photo unavailable.',
            retryable: true,
            request_id: 'test',
          }),
        );
      render(<CaptureResultView captureId={id} />);
      await flush();
      await advance();
      expect(screen.queryByRole('heading', { name: 'Synthetic photo reading' })).toBeNull();
      await advance(180_000);
      expect(read).toHaveBeenCalledTimes(2);
    },
  );

  it('pauses reads while hidden and resumes when visible within its deadline', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const read = vi.spyOn(api, 'requestAs').mockResolvedValue(result());
    render(<CaptureResultView captureId={id} />);
    await flush();
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    await advance(10_000);
    expect(read).toHaveBeenCalledOnce();
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    await advance();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not require additive visual fields from an older API', async () => {
    const old = capturePayload();
    delete (old as { discovery_intents?: unknown }).discovery_intents;
    const read = vi.spyOn(api, 'requestAs').mockResolvedValue(StyledCaptureResponse.parse(old));
    render(<CaptureResultView captureId={id} />);
    await flush();
    chooseVisual();
    expect(screen.getByRole('status').textContent).toContain('not available for this photo');
    await advance(180_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it('still reaches its wall-clock deadline while hidden, and does not restart on visibility', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const read = vi.spyOn(api, 'requestAs').mockResolvedValue(result());
    render(<CaptureResultView captureId={id} />);
    await flush();
    chooseVisual();
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    await advance(DISCOVERY_POLL_DEADLINE_MS);
    visibility = 'visible';
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByRole('status').textContent).toContain('their result is not known yet');
    await advance(10_000);
    expect(read).toHaveBeenCalledOnce();
  });

  it('rejects a late result after navigating to a different capture', async () => {
    const old = deferred<ReturnType<typeof result>>();
    const read = vi
      .spyOn(api, 'requestAs')
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(result('empty'));
    const view = render(<CaptureResultView captureId={id} />);
    await flush();
    view.rerender(<CaptureResultView captureId="00000000-0000-4000-8000-000000000099" />);
    await flush();
    chooseVisual();
    await act(async () => old.resolve(result('ready')));
    expect(screen.queryByRole('list', { name: 'Attributed reference images' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('No reference images passed');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
