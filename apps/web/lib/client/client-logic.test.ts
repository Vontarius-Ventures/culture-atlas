import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@culture-atlas/domain';
import type { DiscoveryCard, JobResponse } from '@culture-atlas/domain/schemas';
import { ApiClient, ApiError, buildPath, newIdempotencyKey } from './api';
import {
  clampCrop,
  cropForKey,
  cropToPixels,
  FULL_CROP,
  isFullCrop,
  MIN_CROP,
  moveCrop,
  resizeCrop,
} from './crop';
import { relativeTime } from './format';
import {
  createJobPoller,
  nextPollDelay,
  POLL_FAST_MS,
  POLL_MAX_ERRORS,
  POLL_SLOW_MS,
} from './jobs';
import { UI_LIMITS } from './limits';
import { checkImageFile, isHeic } from './samples';
import { applyOverrides } from './store';

const UUID = '00000000-0000-4000-8000-000000000001';

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
const session = {
  principal: {
    kind: 'anonymous',
    account_id: null,
    session_id: UUID,
    expires_at: null,
    is_demo_owner: false,
  },
  csrf_token: 'tok-1',
};

describe('UI limits mirror the domain LIMITS', () => {
  it('keeps the browser copies in sync', () => {
    for (const [key, value] of Object.entries(UI_LIMITS))
      expect(LIMITS[key as keyof typeof LIMITS], key).toBe(value);
  });
});

describe('ApiClient', () => {
  it('builds paths from contract templates and drops empty query values', () => {
    expect(buildPath('/v1/collections/{id}/items/{item_id}', { id: 'a b', item_id: 'c' })).toBe(
      '/v1/collections/a%20b/items/c',
    );
    expect(
      buildPath('/v1/discoveries', undefined, { limit: 12, category: undefined, cursor: '' }),
    ).toBe('/v1/discoveries?limit=12');
    expect(() => buildPath('/v1/items/{id}', {})).toThrow(/Missing path param/);
  });

  it('loads the session once, sends CSRF + Idempotency-Key on mutations and validates responses', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url === '/v1/session') return json(200, session);
      return json(200, {
        action: 'save',
        target_type: 'discovery_item',
        target_id: UUID,
        saved_item: null,
        taste_revision: 2,
        undo: null,
      });
    });
    const client = new ApiClient({ fetch: fetchImpl as unknown as typeof fetch });
    const res = await client.request('recordPreference', {
      body: { action: 'save', target_id: UUID },
      idempotencyKey: 'k-1',
    });
    await client.request('recordPreference', { body: { action: 'save', target_id: UUID } });
    expect(res.taste_revision).toBe(2);
    expect(calls.filter((c) => c.url === '/v1/session')).toHaveLength(1);
    const mutation = calls[1]!;
    const headers = mutation.init.headers as Record<string, string>;
    expect(headers['x-csrf-token']).toBe('tok-1');
    expect(headers['idempotency-key']).toBe('k-1');
    // The contract's request schema applied its default before sending.
    expect(JSON.parse(String(mutation.init.body))).toEqual({
      action: 'save',
      target_type: 'discovery_item',
      target_id: UUID,
    });
  });

  it('rejects invalid bodies before sending', async () => {
    const fetchImpl = vi.fn(async () => json(200, session));
    const client = new ApiClient({ fetch: fetchImpl as unknown as typeof fetch });
    await expect(
      client.request('createCollection', { body: { name: 'x'.repeat(81) } }),
    ).rejects.toMatchObject({ body: { code: 'invalid_input' } });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // only the session
  });

  it('maps error bodies, retries once after a CSRF failure, and flags contract drift', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/v1/session') return json(200, { ...session, csrf_token: `tok-${++n}` });
      if (url.startsWith('/v1/collections'))
        return n < 2
          ? json(403, { code: 'csrf_failed', message: 'x', retryable: false, request_id: 'r' })
          : json(201, { nope: true });
      return json(404, {
        code: 'not_found',
        message: 'Not found.',
        retryable: false,
        request_id: 'r1',
      });
    });
    const client = new ApiClient({ fetch: fetchImpl as unknown as typeof fetch });
    const notFound = await client
      .request('getItem', { params: { id: UUID } })
      .catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(ApiError);
    expect((notFound as ApiError).status).toBe(404);
    expect((notFound as ApiError).code).toBe('not_found');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const drift = await client
      .request('createCollection', { body: { name: 'Slow Sunday' } })
      .catch((e: unknown) => e);
    expect(n).toBe(2); // session refreshed after csrf_failed
    expect((drift as ApiError).code).toBe('internal');
    consoleError.mockRestore();
  });

  it('turns network failures into a retryable offline error', async () => {
    const client = new ApiClient({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(client.request('getDiscoveries', { query: {} })).rejects.toMatchObject({
      status: 0,
      body: { retryable: true },
    });
  });

  it('creates v4-shaped idempotency keys', () => {
    expect(newIdempotencyKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('job polling', () => {
  const job = (state: JobResponse['state'], poll: number | null = null) => ({
    state,
    poll_after_ms: poll,
  });

  it('polls at 1.5 s, backs off after 15 s, honors server hints and stops when terminal', () => {
    expect(nextPollDelay({ job: null, elapsedMs: 0, consecutiveErrors: 0 })).toBe(POLL_FAST_MS);
    expect(nextPollDelay({ job: job('running'), elapsedMs: 14_000, consecutiveErrors: 0 })).toBe(
      POLL_FAST_MS,
    );
    expect(nextPollDelay({ job: job('running'), elapsedMs: 16_000, consecutiveErrors: 0 })).toBe(
      POLL_SLOW_MS,
    );
    expect(nextPollDelay({ job: job('running', 4000), elapsedMs: 0, consecutiveErrors: 0 })).toBe(
      4000,
    );
    for (const s of ['complete', 'partial', 'failed', 'cancelled'] as const)
      expect(nextPollDelay({ job: job(s), elapsedMs: 0, consecutiveErrors: 0 })).toBeNull();
  });

  it('backs off exponentially on errors and gives up', () => {
    expect(nextPollDelay({ job: null, elapsedMs: 0, consecutiveErrors: 1 })).toBe(3000);
    expect(nextPollDelay({ job: null, elapsedMs: 0, consecutiveErrors: 3 })).toBe(12_000);
    expect(nextPollDelay({ job: null, elapsedMs: 0, consecutiveErrors: 4 })).toBe(15_000);
    expect(
      nextPollDelay({ job: null, elapsedMs: 0, consecutiveErrors: POLL_MAX_ERRORS }),
    ).toBeNull();
  });

  it('pauses while hidden and resumes on demand; stops at a terminal state', async () => {
    const states: JobResponse['state'][] = ['queued', 'running', 'running', 'complete'];
    let i = 0;
    let hidden = false;
    const timers: Array<() => void> = [];
    const updates: string[] = [];
    const poller = createJobPoller(UUID, (s) => updates.push(`${s.job?.state}:${s.active}`), {
      fetchJob: async () =>
        ({
          id: UUID,
          type: 'analyze_capture',
          state: states[i++]!,
          stage: null,
          sections: [],
          error: null,
          result: null,
          poll_after_ms: null,
          created_at: '',
          updated_at: '',
        }) as JobResponse,
      now: () => 0,
      setTimer: (fn) => (timers.push(fn), timers.length),
      clearTimer: () => undefined,
      isHidden: () => hidden,
    });
    poller.start();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    hidden = true;
    timers.shift()!();
    await vi.waitFor(() => expect(updates).toHaveLength(2));
    expect(timers).toHaveLength(0); // hidden: nothing scheduled
    hidden = false;
    poller.resume();
    await vi.waitFor(() => expect(updates).toHaveLength(3));
    timers.shift()!();
    await vi.waitFor(() => expect(updates.at(-1)).toBe('complete:false'));
    expect(poller.stopped).toBe(true);
  });

  it('stops on a non-retryable error such as not_found', async () => {
    const updates: unknown[] = [];
    const poller = createJobPoller(UUID, (s) => updates.push(s), {
      fetchJob: async () => {
        throw new ApiError(404, {
          code: 'not_found',
          message: 'Not found.',
          retryable: false,
          request_id: 'r',
        });
      },
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => undefined,
      isHidden: () => false,
    });
    poller.start();
    await vi.waitFor(() => expect(poller.stopped).toBe(true));
    expect(updates).toHaveLength(1);
  });
});

describe('crop', () => {
  it('clamps, moves and resizes within the image', () => {
    expect(isFullCrop(FULL_CROP)).toBe(true);
    const moved = moveCrop({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 0.4, -0.9);
    expect(moved).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    const shrunk = resizeCrop(FULL_CROP, -0.95, -0.2);
    expect(shrunk.w).toBe(MIN_CROP);
    expect(shrunk.h).toBeCloseTo(0.8);
    expect(clampCrop({ x: -1, y: 2, w: 3, h: 0 })).toEqual({
      x: 0,
      y: 1 - MIN_CROP,
      w: 1,
      h: MIN_CROP,
    });
    expect(cropForKey(FULL_CROP, 'Enter', false)).toBeNull();
    expect(cropForKey({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'ArrowLeft', false)?.x).toBeCloseTo(0.18);
    expect(cropForKey({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 'ArrowUp', true)?.h).toBeCloseTo(0.48);
  });

  it('converts to pixel rectangles inside the image', () => {
    expect(cropToPixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.5 }, 1000, 800)).toEqual({
      sx: 250,
      sy: 400,
      sw: 500,
      sh: 400,
    });
  });
});

describe('file checks', () => {
  it('accepts JPEG/PNG/WebP/HEIC up to 15 MB and explains otherwise', () => {
    expect(checkImageFile({ type: 'image/jpeg', size: 1000, name: 'a.jpg' })).toBeNull();
    expect(checkImageFile({ type: '', size: 1000, name: 'a.webp' })).toBeNull();
    expect(checkImageFile({ type: 'image/gif', size: 10, name: 'a.gif' })?.kind).toBe('type');
    expect(
      checkImageFile({ type: 'image/png', size: 16 * 1024 * 1024, name: 'a.png' })?.message,
    ).toMatch(/up to 15 MB/);
    expect(isHeic({ type: '', name: 'IMG_1.HEIC' })).toBe(true);
  });
});

describe('overrides and formatting', () => {
  it('applies saved overrides and drops hidden cards without reordering', () => {
    const card = (id: string): DiscoveryCard => ({
      id,
      kind: 'film',
      category: 'watch',
      title: id,
      subtitle: null,
      image: null,
      is_example: false,
      saved: false,
      saved_item_id: null,
      recommendation_id: null,
      evidence_available: false,
    });
    const out = applyOverrides(
      [card('a'), card('b'), card('c')],
      new Map([
        ['b', { hidden: true }],
        ['c', { saved: true, saved_item_id: 's' }],
      ]),
    );
    expect(out.map((c) => [c.id, c.saved])).toEqual([
      ['a', false],
      ['c', true],
    ]);
  });

  it('formats relative times', () => {
    const now = Date.parse('2026-10-13T12:00:00Z');
    expect(relativeTime('2026-10-13T11:59:50Z', now)).toBe('just now');
    expect(relativeTime('2026-10-13T09:00:00Z', now)).toBe('3 hours ago');
    expect(relativeTime(null, now)).toBe('never');
  });
});
