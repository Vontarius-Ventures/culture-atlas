import { describe, expect, it } from 'vitest';
import { QlooHttpProvider } from './client';
import { parseInsights, parseSearch } from './parse';
import { recordingKey, ReplayQloo, type QlooRecording } from './replay';
import type { QlooInsightsRequest, QlooTagOperator } from './types';

// All IDs and response content in this file are synthetic, not provider recordings.
const TAGS = ['urn:tag:keyword:media:fixture_first', 'urn:tag:keyword:media:fixture_second'];
const EMPTY = { results: { entities: [], tags: [] } };

function http(body: unknown = EMPTY) {
  const calls: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    calls.push(new URL(String(input)));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof globalThis.fetch;
  return {
    calls,
    provider: new QlooHttpProvider({ apiKey: 'synthetic-test-key', baseUrl: 'https://qloo.example.test', timeoutMs: 500, fetch }),
  };
}

describe('Qloo GET Insights operators and validation', () => {
  it.each<QlooTagOperator>(['union', 'intersection'])('sends explicit %s operators and retains sanitized identity', async (operator) => {
    const { provider, calls } = http();
    const result = await provider.insights({
      filterType: 'urn:entity:movie',
      filterTags: TAGS,
      signalTags: TAGS.map((id) => ({ id })),
      filterTagsOperator: operator,
      signalTagsOperator: operator,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe('/v2/insights');
    expect(calls[0]!.searchParams.get('operator.filter.tags')).toBe(operator);
    expect(calls[0]!.searchParams.get('operator.signal.interests.tags')).toBe(operator);
    expect(calls[0]!.searchParams.get('filter.tags')).toBe(TAGS.join(','));
    expect(calls[0]!.searchParams.get('signal.interests.tags')).toBe(TAGS.join(','));
    expect(result.request).toMatchObject({
      method: 'GET',
      query: {
        'operator.filter.tags': operator,
        'operator.signal.interests.tags': operator,
        'filter.tags': TAGS,
        'signal.interests.tags': TAGS,
      },
    });
    expect(JSON.stringify(result.request)).not.toContain('synthetic-test-key');
  });

  it('leaves both omitted operators absent without changing tag order or input', async () => {
    const { provider, calls } = http();
    const signalTags = TAGS.map((id) => ({ id, weight: undefined }));
    const result = await provider.insights({ filterType: 'urn:entity:brand', filterTags: TAGS, signalTags });
    expect(calls[0]!.searchParams.has('operator.filter.tags')).toBe(false);
    expect(calls[0]!.searchParams.has('operator.signal.interests.tags')).toBe(false);
    expect(result.request.query).not.toHaveProperty('operator.filter.tags');
    expect(result.request.query).not.toHaveProperty('operator.signal.interests.tags');
    expect(result.request.query['signal.interests.tags']).toEqual(TAGS);
    expect(signalTags).toEqual(TAGS.map((id) => ({ id, weight: undefined })));
  });

  const invalid: [string, QlooInsightsRequest][] = [
    ['filter operator without IDs', { filterType: 'urn:entity:movie', signalEntities: ['FIXTURE-SEED'], filterTagsOperator: 'union' }],
    ['signal operator without IDs', { filterType: 'urn:entity:movie', filterTags: TAGS, signalTagsOperator: 'intersection' }],
    ['filter operator with empty IDs', { filterType: 'urn:entity:movie', signalEntities: ['FIXTURE-SEED'], filterTags: [], filterTagsOperator: 'intersection' }],
    ['signal operator with empty IDs', { filterType: 'urn:entity:movie', filterTags: TAGS, signalTags: [], signalTagsOperator: 'union' }],
    ['invalid filter operator', { filterType: 'urn:entity:movie', filterTags: TAGS, filterTagsOperator: 'and' as QlooTagOperator }],
    ['invalid signal operator', { filterType: 'urn:entity:movie', signalTags: TAGS.map((id) => ({ id })), signalTagsOperator: null as unknown as QlooTagOperator }],
    ['blank filter ID', { filterType: 'urn:entity:movie', filterTags: ['  '] }],
    ['blank signal tag ID', { filterType: 'urn:entity:movie', signalTags: [{ id: '' }] }],
    ['blank entity seed ID', { filterType: 'urn:entity:movie', signalEntities: ['\n'] }],
    ['blank candidate ID', { filterType: 'urn:entity:movie', filterTags: TAGS, filterResultsEntities: [''] }],
    ['blank tag type ID', { filterType: 'urn:entity:movie', filterTags: TAGS, filterTagTypes: [' '] }],
    ['no signal or filter', { filterType: 'urn:entity:movie' }],
    ...[0, 0.5, -1, Number.NaN].map((weight): [string, QlooInsightsRequest] => [
      `defined GET weight ${weight}`,
      { filterType: 'urn:entity:movie', signalTags: [{ id: TAGS[0]!, weight }] },
    ]),
  ];

  it.each(invalid)('rejects %s before HTTP or replay lookup', async (_name, req) => {
    const { provider, calls } = http();
    await expect(provider.insights(req)).rejects.toMatchObject({ provider: 'qloo', kind: 'bad_request' });
    expect(calls).toHaveLength(0);
    await expect(new ReplayQloo([]).insights(req)).rejects.toMatchObject({ provider: 'qloo', kind: 'bad_request' });
  });

  it('accepts filter-only requests without adding a new required signal', async () => {
    const { provider } = http();
    await expect(provider.insights({ filterType: 'urn:entity:brand', filterTags: TAGS, filterTagsOperator: 'intersection' })).resolves.toMatchObject({ data: { entities: [], tags: [] } });
  });
});

describe('Qloo Insights replay identity', () => {
  it('separates omitted, union and intersection operators for either tag list', async () => {
    for (const field of ['filterTagsOperator', 'signalTagsOperator'] as const) {
      const recordings: QlooRecording[] = [];
      const keys = new Set<string>();
      const requests: QlooInsightsRequest[] = [];
      for (const operator of [undefined, 'union', 'intersection'] as const) {
        const req: QlooInsightsRequest = {
          filterType: 'urn:entity:movie',
          filterTags: TAGS,
          signalTags: TAGS.map((id) => ({ id })),
          [field]: operator,
        };
        requests.push(req);
        const { provider } = http();
        const result = await provider.insights(req);
        keys.add(recordingKey('insights', result.request.query));
        recordings.push({
          op: 'insights',
          request: result.request,
          status: 200,
          recorded_at: '2026-10-26T00:00:00.000Z',
          body: { results: { entities: [{ entity_id: `FIXTURE-${field}-${operator ?? 'omitted'}`, name: 'Synthetic movie', subtype: 'urn:entity:movie' }] } },
        });
      }
      expect(keys.size).toBe(3);
      const replay = new ReplayQloo(recordings);
      expect(replay.size).toBe(3);
      for (const [index, req] of requests.entries()) {
        const result = await replay.insights(req);
        expect(result.is_replay).toBe(true);
        expect(result.request).toEqual(recordings[index]!.request);
        expect(result.data.entities[0]!.entity_id).toBe(`FIXTURE-${field}-${req[field] ?? 'omitted'}`);
      }
      await expect(new ReplayQloo([recordings[0]!]).insights(requests[1]!)).rejects.toMatchObject({ kind: 'unavailable' });
    }
  });

  it('retains every existing HTTP Insights constraint when replaying', async () => {
    const req: QlooInsightsRequest = {
      filterType: 'urn:entity:place',
      signalEntities: ['FIXTURE-SEED'],
      signalTags: TAGS.map((id) => ({ id })),
      signalTagsOperator: 'union',
      signalLocationQuery: 'Synthetic City',
      filterLocationQuery: 'Synthetic Borough',
      filterPopularityMin: 0,
      filterResultsEntities: ['FIXTURE-CANDIDATE'],
      filterTags: TAGS,
      filterTagsOperator: 'intersection',
      filterTagTypes: ['urn:tag:keyword:media'],
      biasTrends: 'off',
      explainability: true,
      take: 12,
      page: 2,
    };
    const { provider } = http();
    const response = await provider.insights(req);
    const replay = new ReplayQloo([{ op: 'insights', request: response.request, status: 200, body: EMPTY, recorded_at: '2026-10-26T00:00:00.000Z' }]);
    expect((await replay.insights(req)).request).toEqual(response.request);
    for (const changed of [
      { filterLocationQuery: 'Other synthetic city' },
      { signalLocationQuery: 'Other synthetic city' },
      { filterPopularityMin: 0.5 },
      { filterResultsEntities: ['FIXTURE-OTHER'] },
      { filterTags: [TAGS[0]!] },
      { filterTagTypes: ['urn:tag:genre:media'] },
      { biasTrends: 'high' as const },
      { page: 1 },
    ]) {
      await expect(replay.insights({ ...req, ...changed })).rejects.toMatchObject({ kind: 'unavailable' });
    }
    await expect(replay.insights({ ...req, signalTags: [{ id: TAGS[0]!, weight: 1 }] })).rejects.toMatchObject({ kind: 'bad_request' });
  });
});

describe('Qloo optional metadata and explainability diagnostics', () => {
  it('keeps documented contextual fields with their original shapes and invents none', () => {
    const properties = {
      description: 'Synthetic description',
      short_description: 'Synthetic singular description',
      short_descriptions: [{ value: 'Synthetic multilingual description', languages: ['en'] }],
      website: 'https://synthetic.example.test',
      websites: ['https://synthetic.example.test/film'],
      filming_location: 'Synthetic Studio',
      production_companies: ['Synthetic Company'],
      release_country: ['Synthetic Country'],
      image: { url: 'https://synthetic.example.test/poster.jpg', attribution: 'Synthetic attribution' },
    };
    const entities = [
      { entity_id: 'FIXTURE-MOVIE', name: 'Synthetic movie', subtype: 'urn:entity:movie', properties: { ...properties, internal_scoring_blob: 'not retained' } },
      { entity_id: 'FIXTURE-ARTIST', name: 'Synthetic creative entity', subtype: 'urn:entity:artist' },
      { entity_id: 'FIXTURE-BOOK', name: 'Synthetic written work', subtype: 'urn:entity:book' },
    ];
    for (const result of [parseSearch({ results: entities }), parseInsights({ results: { entities } }).entities]) {
      expect(result[0]!.properties).toEqual(properties);
      expect(result[1]!.properties).toEqual({});
      expect(result[1]!.types).toEqual(['urn:entity:artist']);
      expect(result[2]!.properties).toEqual({});
      expect(result[2]!.types).toEqual(['urn:entity:book']);
    }
  });

  it.each(['array', 'object'])('keeps entities and tags while retaining a warning in a legacy %s envelope', async (envelope) => {
    const entities = [{ entity_id: 'FIXTURE-MOVIE', name: 'Synthetic movie', subtype: 'urn:entity:movie', query: { affinity: 0.7 } }];
    const results = envelope === 'array' ? entities : { entities, tags: [{ id: TAGS[0], name: 'Synthetic topic', type: 'urn:tag:keyword:media' }] };
    const body = { results, query: { explainability: { warning: 'Synthetic influence unavailable' } } };
    const baseline = parseInsights({ results });
    const parsed = parseInsights(body);
    expect(parsed).toEqual({ ...baseline, diagnostics: { explainabilityWarning: 'Synthetic influence unavailable' } });
    const { provider } = http(body);
    expect((await provider.insights({ filterType: 'urn:entity:movie', signalEntities: ['FIXTURE-SEED'], explainability: true })).data).toEqual(parsed);
    expect(provider.capability().explainability.status).toBe('unverified');
  });

  it.each([undefined, null, {}, 42, ['not a warning']])('omits diagnostics for an absent/non-string warning (%j)', (warning) => {
    expect(parseInsights({ ...EMPTY, query: { explainability: { warning } } })).toEqual({ entities: [], tags: [] });
  });

  it('retains normalized per-result influence alongside a top-level warning', () => {
    const result = parseInsights({
      results: { entities: [{ entity_id: 'FIXTURE-MOVIE', name: 'Synthetic movie', query: { explainability: [{ entity_id: 'FIXTURE-SEED', influence: 0.4 }] } }] },
      query: { explainability: { warning: 'Synthetic aggregate warning' } },
    });
    expect(result.entities[0]!.query!.explainability).toEqual([{ entity_id: 'FIXTURE-SEED', score: 0.4 }]);
    expect(result.diagnostics).toEqual({ explainabilityWarning: 'Synthetic aggregate warning' });
  });
});
