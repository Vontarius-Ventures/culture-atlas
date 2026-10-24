import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { createDb } from '../../../domain/src/db/pool';
import { ConcurrencyLimiter } from '../http/concurrency';
import { QlooHttpProvider } from './client';
import { PostgresQlooRateGate } from './rate-gate';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Style design R-11: one Qloo key is shared by web, worker and media-worker,
 * so admission is a cross-process token bucket in Postgres plus a daily
 * limit; each process also spaces its own dispatches.
 */
const dbA = createDb(inject('databaseUrl'), 3);
const dbB = createDb(inject('databaseUrl'), 3);
afterAll(async () => {
  await dbA.end();
  await dbB.end();
});

describe('cross-process Qloo rate gate (R-11)', () => {
  it('two "processes" on one key never exceed the rate in any second', async () => {
    const keyId = `test-${randomUUID().slice(0, 8)}`;
    const opts = { keyId, ratePerSecond: 8, burst: 8, dailyLimit: 1000 };
    const a = new PostgresQlooRateGate(dbA, opts);
    const b = new PostgresQlooRateGate(dbB, opts);
    const admitted: number[] = [];
    const run = (gate: PostgresQlooRateGate) => async () => {
      await gate.acquire();
      admitted.push(Date.now());
    };
    const started = Date.now();
    await Promise.all(Array.from({ length: 24 }, (_, i) => (i % 2 ? run(a) : run(b))()));
    // 8 burst tokens, then 8 per second: 24 admissions need about 2 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1700);
    admitted.sort((x, y) => x - y);
    for (let i = 0; i < admitted.length; i++) {
      const inWindow = admitted.filter((t) => t >= admitted[i]! && t < admitted[i]! + 1000).length;
      // Burst (8) plus one second of refill (8) is the most any one-second window can hold.
      expect(inWindow).toBeLessThanOrEqual(16);
    }
    const after = admitted.filter((t) => t >= started + 1000 && t < started + 2000).length;
    expect(after).toBeLessThanOrEqual(9);
  });

  it('past the daily limit every acquire is refused with budget_exhausted (rails become an honest empty)', async () => {
    const gate = new PostgresQlooRateGate(dbA, { keyId: `test-${randomUUID().slice(0, 8)}`, ratePerSecond: 8, dailyLimit: 2 });
    await gate.acquire();
    await gate.acquire();
    await expect(gate.acquire()).rejects.toMatchObject({ kind: 'budget_exhausted' });
  });

  it('fails open (and reports once) when the table is unusable', async () => {
    const errors: unknown[] = [];
    const broken = { inTransaction: false, query: async () => Promise.reject(new Error('relation "qloo_rate_buckets" does not exist')), transaction: async () => Promise.reject(new Error('relation does not exist')) };
    const gate = new PostgresQlooRateGate(broken as never, { keyId: 'x', ratePerSecond: 8, dailyLimit: 10, onError: (e) => errors.push(e) });
    await gate.acquire();
    await gate.acquire();
    expect(errors).toHaveLength(1);
  });
});

describe('in-process spacing and per-request timeouts (R-11)', () => {
  it('spaces dispatches at least minSpacingMs apart under concurrency 3', async () => {
    const limiter = new ConcurrencyLimiter(3, 120);
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.run(async () => {
          starts.push(Date.now());
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    starts.sort((x, y) => x - y);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(115);
  });

  it('a tag-only call may pass its own longer timeout (12 s) over the default', async () => {
    let seen: AbortSignal | undefined;
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 60);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return new Response(JSON.stringify({ success: true, results: { entities: [] } }), { status: 200 });
    }) as typeof fetch;
    const p = new QlooHttpProvider({ apiKey: 'k', baseUrl: 'https://qloo.example.test', timeoutMs: 20, fetch: fetchImpl, limiter: new ConcurrencyLimiter(1) });
    await expect(p.insights({ filterType: 'urn:entity:brand', filterTags: ['urn:tag:x'] }, { maxRetries: 0 })).rejects.toMatchObject({ kind: 'timeout' });
    await expect(p.insights({ filterType: 'urn:entity:brand', filterTags: ['urn:tag:x'] }, { maxRetries: 0, timeoutMs: 12_000 })).resolves.toMatchObject({ status: 200 });
    expect(seen).toBeDefined();
  });

  it('sends filter.location.query and filter.popularity.min; a filter alone is a valid insights request', async () => {
    let url = '';
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ success: true, results: { entities: [] } }), { status: 200 });
    }) as typeof fetch;
    const p = new QlooHttpProvider({ apiKey: 'k', baseUrl: 'https://qloo.example.test', timeoutMs: 1000, fetch: fetchImpl, limiter: new ConcurrencyLimiter(1) });
    await p.insights({ filterType: 'urn:entity:place', filterTags: ['urn:tag:decor:qloo:japandi'], filterLocationQuery: 'Brooklyn, NY', filterPopularityMin: 0.9 }, { maxRetries: 0 });
    const q = new URL(url).searchParams;
    expect(q.get('filter.location.query')).toBe('Brooklyn, NY');
    expect(q.get('filter.popularity.min')).toBe('0.9');
    expect(q.get('filter.tags')).toBe('urn:tag:decor:qloo:japandi');
  });
});
