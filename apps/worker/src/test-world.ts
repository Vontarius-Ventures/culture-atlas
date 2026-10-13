import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { JOB_HANDLERS, type JobHandlerMap, type ServiceContext } from '@culture-atlas/domain';
import { getTestDb, insertAccount, insertAnonymousSession, testConfig, testContext, testProviders } from '@culture-atlas/domain/testing';
import {
  ProviderError,
  type ProviderOverrides,
  type QlooEntity,
  type QlooInsightsResult,
  type QlooTag,
  type ResearchExtraction,
  type ResearchSourceDoc,
  type VlmAnalysis,
} from '@culture-atlas/providers';
import { FakeQloo, FakeResearch, FakeTextModel, FakeVlm } from '@culture-atlas/providers/testing';
import { Worker } from './worker';

/**
 * Deterministic "world" for pipeline integration tests: fixture-backed fake
 * providers (never the network) and helpers to run the real Worker.
 */

const ROOT = path.resolve(import.meta.dirname, '../../..');
export const vlmFixture = (name: string): VlmAnalysis => JSON.parse(readFileSync(path.join(ROOT, 'fixtures/vlm', name), 'utf8')) as VlmAnalysis;

let seed = 0;
/** A distinct small JPEG per call (different bytes -> different sha256). */
export async function testJpeg(width = 64, height = 48): Promise<Uint8Array> {
  seed++;
  const buf = await sharp({ create: { width, height, channels: 3, background: { r: (seed * 37) % 255, g: (seed * 91) % 255, b: (seed * 53) % 255 } } })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

const entity = (id: string, name: string, type: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({ entity_id: id, name, types: [type], properties: {}, tags: [], ...extra });

/** Search/tag catalogue matching the VLM fixtures. Shape-only, Fixture-prefixed. */
export const CATALOG = {
  search: {
    'fixture denim co': [entity('FIXTURE-BRAND-0001', 'Fixture Denim Co', 'urn:entity:brand')],
  } as Record<string, QlooEntity[]>,
  tags: {
    'vintage racing': [{ id: 'urn:tag:style:qloo:fixture_vintage_racing', name: 'Vintage Racing', type: 'urn:tag:style:qloo' }],
    'italian aperitivo culture': [{ id: 'urn:tag:genre:qloo:fixture_aperitivo', name: 'Italian Aperitivo Culture', type: 'urn:tag:genre:qloo' }],
    'mid-century modern': [{ id: 'urn:tag:style:qloo:fixture_mcm', name: 'Mid-Century Modern', type: 'urn:tag:style:qloo' }],
  } as Record<string, QlooTag[]>,
  insights: {
    'urn:entity:brand': [
      entity('FIXTURE-BRAND-0101', 'Fixture Racing Knitwear', 'urn:entity:brand', { query: { affinity: 0.9, explainability: [{ entity_id: 'FIXTURE-BRAND-0001', score: 0.8 }] } }),
      entity('FIXTURE-BRAND-0001', 'Fixture Denim Co', 'urn:entity:brand'), // the anchor itself: never recommended back
      entity('FIXTURE-BRAND-0102', 'Fixture Driving Shoes', 'urn:entity:brand'),
      entity('FIXTURE-BRAND-0103', 'Fixture Leather Goods', 'urn:entity:brand'),
      entity('FIXTURE-BRAND-0104', 'Fixture Fourth Brand', 'urn:entity:brand'),
    ],
    'urn:entity:artist': [entity('FIXTURE-ARTIST-0001', 'Fixture Artist One', 'urn:entity:artist'), entity('FIXTURE-ARTIST-0002', 'Fixture Artist Two', 'urn:entity:artist')],
    'urn:entity:movie': [
      entity('FIXTURE-MOVIE-0001', 'Fixture Film One', 'urn:entity:movie', { properties: { release_year: 1966 } }),
      entity('FIXTURE-MOVIE-0002', 'Fixture Film Two', 'urn:entity:movie', { properties: { release_year: 1971 } }),
    ],
  } as Record<string, QlooEntity[]>,
};

export interface QlooOptions {
  live?: boolean;
  failInsights?: Partial<Record<string, Error>>;
  emptyInsights?: boolean;
}

export function fakeQloo(options: QlooOptions = {}): FakeQloo {
  return new FakeQloo(
    {
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req): QlooInsightsResult | Error => {
        const fail = options.failInsights?.[req.filterType];
        if (fail) return fail;
        if (options.emptyInsights) return { entities: [], tags: [] };
        return { entities: CATALOG.insights[req.filterType] ?? [], tags: [] };
      },
    },
    { live: options.live ?? true },
  );
}

export function fakeResearch(): FakeResearch {
  const src = (name: string): ResearchSourceDoc => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/ /g, '_'))}`,
    title: name,
    publisher: 'Wikipedia',
    retrieved_at: '2026-10-13T00:00:00.000Z',
    extract: `Test extract for ${name}.`,
  });
  return new FakeResearch(
    (name) => [src(name)],
    (name): ResearchExtraction => ({
      overview: `${name} is a test reference.`,
      sections: [{ heading: 'Context', body: `${name} is often associated with test fixtures.`, claim_indexes: [1] }],
      claims: [
        { text: `${name} is a test reference.`, claim_type: 'factual', source_urls: [src(name).url] },
        { text: `${name} is often associated with test fixtures.`, claim_type: 'interpretive', source_urls: [] },
      ],
    }),
  );
}

export function fakeComposer(): FakeTextModel {
  return new FakeTextModel((req) => {
    if (req.schemaName !== 'dish_ideas') return new ProviderError('text', 'bad_request', 'unexpected schema');
    const refs = JSON.parse(req.prompt.split('\n')[2]!) as { name: string }[];
    return {
      dishes: [
        { name: 'Fixture Spritz Bites', cuisine: 'Italian', reason: 'A creative nod to the aperitivo mood of your photo.', reference_names: [refs[0]!.name] },
        { name: 'Ungrounded Dish', cuisine: 'Unknown', reason: 'Not tied to any reference.', reference_names: ['Something invented'] },
      ],
    };
  });
}

export function world(options: { vlm?: VlmAnalysis | ((n: number) => VlmAnalysis | Error); qloo?: QlooOptions | null; research?: boolean; composer?: boolean; overrides?: ProviderOverrides } = {}) {
  let n = 0;
  const vlmSource = options.vlm ?? vlmFixture('clear-outfit.json');
  const vlm = new FakeVlm(() => (typeof vlmSource === 'function' ? vlmSource(++n) : structuredClone(vlmSource)));
  const providers = testProviders({
    vlm,
    ...(options.qloo === null ? {} : { qloo: fakeQloo(options.qloo ?? {}) }),
    ...(options.research === false ? {} : { research: fakeResearch() }),
    ...(options.composer === false ? {} : { composer: fakeComposer() }),
    ...options.overrides,
  });
  return { providers, vlm };
}

export async function anonCtx(providers: ServiceContext['providers'], config = testConfig()): Promise<ServiceContext> {
  return testContext(await insertAnonymousSession(), { providers, config });
}

export async function accountCtx(providers: ServiceContext['providers'], config = testConfig()): Promise<ServiceContext> {
  return testContext(await insertAccount(), { providers, config });
}

/** Runs the real Worker until the given jobs (and anything they enqueue by id) are done. */
export async function runJobs(ctx: ServiceContext, jobIds: string[], handlers: JobHandlerMap = JOB_HANDLERS): Promise<void> {
  const w = new Worker({ db: getTestDb(), providers: ctx.providers, config: ctx.config, handlers, jobIds, log: () => undefined, heartbeatMs: 1_000 });
  await w.drain();
}
