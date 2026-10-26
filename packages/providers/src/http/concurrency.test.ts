import { describe, expect, it } from 'vitest';
import { loadProviderConfig } from '../config';
import { createQlooProvider, QlooHttpProvider } from '../qloo/client';
import { ConcurrencyLimiter, sharedLimiter } from './concurrency';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('ConcurrencyLimiter', () => {
  it('never runs more than max at once and serves waiters first in, first out', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const gates = Array.from({ length: 7 }, deferred);
    const started: number[] = [];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        started.push(i);
        await g.promise;
        return i;
      }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);
    expect(limiter.inFlight).toBe(3);
    expect(limiter.queued).toBe(4);
    gates[1]!.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2, 3]);
    for (const g of gates) g.resolve();
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(limiter.peak).toBe(3);
    expect(limiter.inFlight).toBe(0);
  });

  it('releases the slot when the task throws, and an aborted waiter leaves the queue', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(limiter.inFlight).toBe(0);
    const gate = deferred();
    const holder = limiter.run(() => gate.promise);
    const ctrl = new AbortController();
    const waiter = limiter.run(async () => 'never', { signal: ctrl.signal });
    ctrl.abort();
    await expect(waiter).rejects.toMatchObject({ kind: 'aborted' });
    expect(limiter.queued).toBe(0);
    gate.resolve();
    await holder;
    expect(limiter.inFlight).toBe(0);
  });

  it('shares one limiter per key', () => {
    expect(sharedLimiter('k', 3)).toBe(sharedLimiter('k', 3));
    expect(sharedLimiter('k', 3)).not.toBe(sharedLimiter('other', 3));
  });
});

describe('Qloo shares one in-flight cap across callers', () => {
  it('two providers built from the same config hold at most QLOO_MAX_CONCURRENCY requests at once', async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return new Response(JSON.stringify({ success: true, results: { entities: [] } }), { status: 200 });
    }) as typeof fetch;
    // Spacing off here: this test is about the in-flight cap (spacing has its own test).
    const config = loadProviderConfig({ QLOO_API_KEY: `limiter-test-${Date.now()}`, QLOO_MAX_CONCURRENCY: '3', QLOO_MIN_SPACING_MS: '0' });
    const a = createQlooProvider(config, { fetch: fetchImpl }) as QlooHttpProvider;
    const b = createQlooProvider(config, { fetch: fetchImpl }) as QlooHttpProvider;
    expect(a.limiter).toBe(b.limiter);
    const calls = Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).searchEntities({ query: `q${i}` }, { maxRetries: 0 }));
    await Promise.all(calls);
    expect(peak).toBe(3);
  });

  it('a queued request does not spend its own timeout while waiting', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const fetchImpl = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ success: true, results: { entities: [] } }), { status: 200 });
    }) as typeof fetch;
    const p = new QlooHttpProvider({ apiKey: 'k', baseUrl: 'https://qloo.example.test', timeoutMs: 45, fetch: fetchImpl, limiter });
    const results = await Promise.allSettled([1, 2, 3].map((i) => p.searchEntities({ query: `q${i}` }, { maxRetries: 0 })));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(limiter.peak).toBe(1);
  });
});
