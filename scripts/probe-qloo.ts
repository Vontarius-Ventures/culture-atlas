/**
 * Qloo contract probes (build spec "Qloo integration contract"): run once the
 * hackathon key is issued, then record the results in docs/capability-matrix.md.
 *
 * Usage: pnpm tsx scripts/probe-qloo.ts [--brand "Levi's"] [--tag streetwear] [--record]
 *   --record  writes sanitized responses (no key) to fixtures/qloo/recordings/
 *             for labeled "Example result" replay. Confirm Qloo's storage terms
 *             before committing recordings.
 *
 * Probes: resolve one brand (/search), look up one tag (/v2/tags), request
 * artist/film/brand/place results (/v2/insights) with explainability, entity
 * trend history (/trends/entity) and trending (/v2/trending), and report
 * rate-limit headers. Nothing here is simulated: without QLOO_API_KEY it exits.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { loadProviderConfig } from '../packages/providers/src/config';
import { ProviderError } from '../packages/providers/src/errors';
import { QlooHttpProvider } from '../packages/providers/src/qloo/client';
import type { QlooRecording } from '../packages/providers/src/qloo/replay';
import type { QlooEntityType, QlooResponse } from '../packages/providers/src/qloo/types';

const ROOT = path.resolve(import.meta.dirname, '..');
loadRootEnv(ROOT);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const record = process.argv.includes('--record');

const config = loadProviderConfig();
if (!config.QLOO_API_KEY) {
  console.error('QLOO_API_KEY is not set: every Qloo capability stays unavailable (not_configured). Nothing to probe.');
  process.exit(2);
}

const qloo = new QlooHttpProvider({ apiKey: config.QLOO_API_KEY, baseUrl: config.QLOO_API_URL, timeoutMs: config.QLOO_TIMEOUT_MS, defaultRetries: 1 });
const rows: { probe: string; status: string; detail: string }[] = [];
const recordingsDir = path.join(ROOT, 'fixtures/qloo/recordings');

function save(op: QlooRecording['op'], res: QlooResponse<unknown>, name: string): void {
  if (!record) return;
  mkdirSync(recordingsDir, { recursive: true });
  const rec: QlooRecording = { op, request: res.request, status: res.status, body: res.raw, recorded_at: res.retrieved_at };
  writeFileSync(path.join(recordingsDir, `${name}.json`), `${JSON.stringify(rec, null, 2)}\n`);
}

async function probe<T>(name: string, fn: () => Promise<QlooResponse<T>>, describe: (r: QlooResponse<T>) => string, op?: QlooRecording['op']): Promise<QlooResponse<T> | null> {
  try {
    const res = await fn();
    const rl = res.rate_limit ? ` · rate limit ${res.rate_limit.remaining ?? '?'}/${res.rate_limit.limit ?? '?'}` : '';
    rows.push({ probe: name, status: 'ok', detail: `${describe(res)} · ${res.duration_ms} ms${rl}` });
    if (op) save(op, res as QlooResponse<unknown>, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
    return res;
  } catch (err) {
    const e = err as ProviderError;
    rows.push({ probe: name, status: e instanceof ProviderError ? e.kind : 'error', detail: `${e.status ? `HTTP ${e.status} ` : ''}${e.message}` });
    return null;
  }
}

const brandName = arg('brand', "Levi's");
const tagQuery = arg('tag', 'streetwear');
const search = await probe('search brand', () => qloo.searchEntities({ query: brandName, types: ['urn:entity:brand'], take: 5 }), (r) => `${r.data.length} results; top: ${r.data[0]?.name ?? '-'} (${r.data[0]?.entity_id ?? '-'})`, 'search');
await probe('tags lookup', () => qloo.lookupTags({ query: tagQuery, take: 5 }), (r) => `${r.data.length} tags; top: ${r.data[0]?.name ?? '-'} (${r.data[0]?.type ?? '-'})`, 'tags');
const brandId = search?.data[0]?.entity_id;
if (brandId) {
  const types: QlooEntityType[] = ['urn:entity:artist', 'urn:entity:movie', 'urn:entity:brand', 'urn:entity:place'];
  for (const t of types) {
    await probe(
      `insights ${t.split(':').pop()}`,
      () => qloo.insights({ filterType: t, signalEntities: [brandId], explainability: true, take: 5 }),
      (r) => `${r.data.entities.length} entities; explainability on ${r.data.entities.filter((e) => e.query?.explainability?.length).length}`,
      'insights',
    );
  }
  const end = new Date();
  const start = new Date(end.getTime() - 28 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  await probe('trends/entity', () => qloo.entityTrends({ entityId: brandId, startDate: iso(start), endDate: iso(end) }), (r) => `${r.data.points.length} points`, 'trendsEntity');
  await probe('trending brand', () => qloo.trending({ signalEntities: [brandId], filterType: 'urn:entity:brand', startDate: iso(start), endDate: iso(end) }), (r) => `${r.data.entities.length} entities`, 'trending');
} else {
  rows.push({ probe: 'insights / trends', status: 'skipped', detail: 'brand did not resolve' });
}

console.log(`\nQloo probes against ${config.QLOO_API_URL} (${new Date().toISOString()})\n`);
console.log('| Probe | Result | Detail |\n| --- | --- | --- |');
for (const r of rows) console.log(`| ${r.probe} | ${r.status} | ${r.detail.replace(/\|/g, '/')} |`);
console.log('\nCapabilities after probes:', JSON.stringify(qloo.capability(), null, 2));
if (record) console.log(`\nSanitized recordings written to ${path.relative(ROOT, recordingsDir)}/ (no API key).`);
