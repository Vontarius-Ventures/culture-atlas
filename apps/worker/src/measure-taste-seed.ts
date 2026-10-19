/**
 * Live measurement of the taste seed job (amendment 2.2, ONB-04) against real
 * Qloo, in a throwaway database that is dropped afterwards:
 *
 *   pnpm --filter @culture-atlas/worker exec tsx src/measure-taste-seed.ts \
 *     [--env-file ../../.env] [--tag <qloo tag id>]... [--entity <qloo entity id>]...
 *
 * Creates one account whose picks are the given REAL Qloo ids (defaults: tags
 * observed live on Oct 18, 2026), queues the seed exactly as onboarding
 * completion does, runs it on the real Worker and prints time to the first
 * ready category, per-category results, the number of Qloo requests and the
 * peak concurrency. Makes at most 6 Qloo requests per attempt. Needs
 * QLOO_API_KEY (never printed) and a Postgres reachable at TEST_DATABASE_URL.
 */
import path from 'node:path';
import { JOB_HANDLERS, tasteSeed } from '@culture-atlas/domain';
import { createIsolatedDatabase, insertAccount, testConfig } from '@culture-atlas/domain/testing';
import { CircuitBreaker, QlooHttpProvider, createProviderRegistry } from '@culture-atlas/providers';
import { Worker } from './worker';

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

const envFile = args('env-file')[0] ?? path.resolve(import.meta.dirname, '../../../.env');
try {
  process.loadEnvFile(envFile);
} catch {
  // keys may come from the environment
}
const apiKey = process.env.QLOO_API_KEY?.trim();
if (!apiKey) {
  console.error('QLOO_API_KEY is not set; nothing was measured.');
  process.exit(2);
}

const tags = args('tag').length ? args('tag') : ['urn:tag:decor:qloo:japandi', 'urn:tag:cuisine:qloo:sichuan'];
const entities = args('entity');

let inflight = 0;
let peak = 0;
let requests = 0;
const countingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  requests++;
  inflight++;
  peak = Math.max(peak, inflight);
  try {
    return await fetch(input, init);
  } finally {
    inflight--;
  }
}) as typeof fetch;

const qloo = new QlooHttpProvider({
  apiKey,
  baseUrl: process.env.QLOO_API_URL?.trim() || 'https://hackathon.api.qloo.com',
  timeoutMs: Number(process.env.QLOO_TIMEOUT_MS ?? 10_000),
  fetch: countingFetch,
  breaker: new CircuitBreaker(),
});
const providers = createProviderRegistry({ STORAGE_DRIVER: 'memory' }, { qloo });
const iso = await createIsolatedDatabase('seedlive');
try {
  const db = iso.db;
  const { accountId } = await insertAccount(db);
  for (const id of [...tags, ...entities]) {
    const item = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title, external_ids)
       VALUES ($1, $2, NULL, $3, $4, $5::jsonb) RETURNING id`,
      [accountId, id.startsWith('urn:tag:') ? 'style' : 'reference', `qloo:${id}`, id.split(':').pop()!.replace(/_/g, ' '), JSON.stringify({ qloo: id })],
    );
    await db.query('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)', [accountId, item.rows[0]!.id]);
  }
  const config = testConfig();
  const started = Date.now();
  const { status } = await tasteSeed.enqueueTasteSeed(db, { accountId, tasteRevision: 1, catalogVersion: 'measurement', config });
  const worker = new Worker({ db, providers, config, handlers: JOB_HANDLERS, jobIds: [status.job_id!], log: () => undefined });
  const readyAt: Record<string, number> = {};
  let done = false;
  const draining = worker.drain().finally(() => (done = true));
  while (!done) {
    const s = await tasteSeed.getTasteSeedStatus(db, accountId);
    for (const c of s.categories) if (c.state !== 'pending' && readyAt[c.category] === undefined) readyAt[c.category] = Date.now() - started;
    await new Promise((r) => setTimeout(r, 100));
  }
  await draining;
  const final = await tasteSeed.getTasteSeedStatus(db, accountId);
  const recs = await db.query<{ category: string; title: string; origin: string }>(
    `SELECT r.category, r.title, r.origin FROM recommendations r JOIN taste_seed_runs tr ON tr.id = r.taste_seed_run_id
      WHERE tr.owner_account_id = $1 ORDER BY r.category, r.rank`,
    [accountId],
  );
  // Database ready_at is exact; the poll only fills in categories without one (empty/unavailable).
  for (const c of final.categories) if (c.ready_at) readyAt[c.category] = Date.parse(c.ready_at) - started;
  const firstReady = Math.min(...final.categories.filter((c) => c.state === 'ready').map((c) => readyAt[c.category] ?? Infinity));
  console.log(
    JSON.stringify(
      {
        picks: { tags, entities },
        state: final.state,
        qloo_requests: requests,
        peak_concurrency: peak,
        first_ready_ms: Number.isFinite(firstReady) ? firstReady : null,
        total_ms: Date.now() - started,
        categories: final.categories.map((c) => ({
          category: c.category,
          state: c.state,
          card_count: c.card_count,
          settled_ms: readyAt[c.category] ?? null,
          sample: recs.rows.filter((r) => r.category === c.category).slice(0, 3).map((r) => `${r.title} (${r.origin})`),
          // Every card title, to judge the category's quality by hand (food share, echoes, type).
          titles: recs.rows.filter((r) => r.category === c.category).map((r) => r.title),
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await iso.drop();
}
