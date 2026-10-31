import { afterAll, describe, expect, it } from 'vitest';
import { captures, schemas, setFeatureKill } from '@culture-atlas/domain';
import { closeTestDb, getTestDb } from '@culture-atlas/domain/testing';
import { ProviderError, type QlooEntity, type VlmStyleReader, type VlmStyleReading } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { legacyAccountCtx as accountCtx, legacyTestConfig as testConfig, CATALOG, runJobs, testJpeg, world } from './test-world';

const db = getTestDb();
afterAll(closeTestDb);

function reader(name: string, category: VlmStyleReading['subjects'][number]['category'] = 'fashion', over: Partial<VlmStyleReading['subjects'][number]> = {}): VlmStyleReader {
  const reading: VlmStyleReading = {
    schema: 'atlas_style_reading_v1', usable: true, unusable_reason: null, summary: 'A visible design.',
    subjects: [{
      id: 's1', category, label: category === 'fashion' ? 'Studded denim jacket' : 'Furnished room',
      region: { x: 0, y: 0, w: 1, h: 1 },
      aesthetics: [{ name, certainty: 0.8, defining_features: ['metal studs', 'torn denim'], evidence: { basis: 'visible', region: null }, tag_query: null }],
      lineage: [], materials: [], construction: [], details: [], palette: [], mood: [], era: null, brand: null, ...over,
    }],
  };
  return {
    id: 'vlm-style:discovery-fixture',
    capability: () => ({ status: 'available', provider: 'fake' }),
    readStyle: async () => ({ reading: structuredClone(reading), model: 'fake-style', durationMs: 1, image: { width: 640, height: 480 } }),
  };
}

const musicTag = { id: 'urn:tag:genre:music:punk', name: 'Punk', type: 'urn:tag:genre', parents: ['urn:entity:artist'] };
const musician = (id: string, name: string, tags: QlooEntity['tags']): QlooEntity => ({ entity_id: id, name, types: ['urn:entity:artist'], properties: {}, tags });

describe('discovery evidence through the real compiler and database', () => {
  it.each([
    ['media', 'Terracotta head vessel sculpture', 'Documentary on sculpture; prompted by sculptural object form your photo may suggest'],
    ['other', 'Terracotta head figurine', 'Documentary on sculpture; prompted by sculptural object form your photo may suggest'],
    ['other', 'Marble figure sculpture', 'Documentary on sculpture; prompted by sculptural object form your photo may suggest'],
  ] as const)('retrieves documentaries for %s / %s with exact content evidence, not incidental keywords', async (category, label, expectedReason) => {
    const sculpture = { id: 'urn:tag:keyword:qloo:sculpture', name: 'Sculpture', type: 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] };
    const documentary = { id: 'urn:tag:genre:media:documentary', name: 'Documentary', type: 'urn:tag:genre:media', parents: ['urn:entity:movie'] };
    // Exact sentence and entity ID from documentary-probe-v1.json, replayed offline.
    const excerpt = 'Rivers and Tides (2001/2002) is a documentary directed by Thomas Riedelsheimer that profiles British sculptor Andy Goldsworthy and his ephemeral works made from natural materials.';
    const michelangeloExcerpt = 'The film intercuts high-quality images of sculptures and frescoes with staged readings and dramatized sequences to illuminate creative processes and commissions.';
    const film = (id: string, name: string, description: string): QlooEntity => ({
      entity_id: id, name, types: ['urn:entity:movie'], tags: [sculpture, documentary], properties: { description },
    });
    const qloo = new FakeQloo({
      search: () => [],
      tags: (query) => query === 'sculpture' ? [sculpture] : query === 'documentary' ? [documentary] : [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:movie' && req.filterTagsOperator === 'intersection' ? [
          film('EEE6AC4B-7D67-4133-907B-4E3AF024FD76', 'Rivers and Tides', excerpt),
          film('46C2E49F-A033-4A71-92F8-A8BE76926C00', 'Michelangelo - Infinito', michelangeloExcerpt),
          film('FIXTURE-CRIME-DOC', 'Fixture Museum Crime', 'The film examines a murder trial involving a sculptor.'),
          film('FIXTURE-KEYWORD-DOC', 'Fixture Incidental Sculpture', 'A sculpture appears in the background.'),
          { ...film('FIXTURE-MISSING-TAG', 'Fixture Missing Topic', excerpt), tags: [documentary] },
        ] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Hand-modelled clay', category, { label, aesthetics: [] }) } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
    const { rows } = await db.query<{ title: string; display_reason: string; provider_query_ids: string[]; style_match: { discovery_proof: { sourceQueryId: string; contentEvidence: { excerpt: string } } } }>(
      `SELECT r.title, r.display_reason, r.provider_query_ids, r.style_match FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.category = 'watch' AND r.hidden_at IS NULL`, [capture.capture_id],
    );
    expect(view.style_reading?.subjects[0]).toMatchObject({ category, label });
    expect(rows.map((r) => r.title).sort()).toEqual(['Rivers and Tides']);
    for (const row of rows) {
      expect(row.display_reason).toBe(expectedReason);
      expect(row.style_match.discovery_proof.contentEvidence.excerpt).toBe(row.title === 'Rivers and Tides' ? excerpt : michelangeloExcerpt);
      expect(row.provider_query_ids).toContain(row.style_match.discovery_proof.sourceQueryId);
    }
    expect(qloo.calls.some((call) => call.op === 'insights' && (call.req as { filterTagsOperator?: string }).filterTagsOperator === 'intersection')).toBe(true);
  });

  it.each([true, false])('recovers a coffee-practice documentary when supported (%s), never the recorded crime film', async (withPositive) => {
    const coffee = { id: 'urn:tag:keyword:qloo:coffee', name: 'Coffee', type: 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] };
    const documentary = { id: 'urn:tag:genre:media:documentary', name: 'Documentary', type: 'urn:tag:genre:media', parents: ['urn:entity:movie'] };
    const excerpt = 'A Film About Coffee (2014), directed by Brandon Loper and featuring Kent Bakke, Kevin Bohlin and Katie Cargiulo, is a documentary that travels from coffee farms to specialty cafes.';
    const crimeExcerpt = 'Ice Cold: Murder, Coffee and Jessica Wongso (2023), directed by Rob Sixsmith, is a documentary crime film that examines the controversial trial and conviction of Jessica Wongso following the suspicious death of her friend.';
    const film = (id: string, name: string, description: string): QlooEntity => ({
      entity_id: id, name, types: ['urn:entity:movie'], tags: [coffee, documentary], properties: { description },
    });
    const qloo = new FakeQloo({
      search: () => [],
      tags: (query) => query === 'coffee' ? [coffee] : query === 'documentary' ? [documentary] : [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:movie' && req.filterTagsOperator === 'intersection' ? [
          film('4C9E058C-9275-4982-A397-E6BFB11E7408', 'Ice Cold: Murder, Coffee and Jessica Wongso', crimeExcerpt),
          ...(withPositive ? [film('AD3C1891-6DA9-4D87-9019-3DA68BBB5CAE', 'A Film About Coffee', excerpt)] : []),
        ] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Visible coffee', 'food', { label: 'Espresso coffee drink', aesthetics: [] }) } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(view.recommendations.map((card) => card.title)).toEqual(withPositive ? ['A Film About Coffee'] : []);
    if (withPositive) expect(view.recommendations[0]?.reason).toBe('Documentary on coffee; prompted by coffee-related appearance your photo may suggest');
    const { rows } = await db.query<{ output: { status: string; reason?: string; providerQueryIds: string[]; fill: { cards: number; tags: string[] } } }>(
      `SELECT output FROM job_stages WHERE job_id = $1 AND stage = 'recommend:watch'`, [capture.job_id],
    );
    expect(rows[0]!.output).toMatchObject({ status: 'complete', fill: { cards: withPositive ? 1 : 0, tags: ['Coffee'] } });
    expect(rows[0]!.output.reason).toBeUndefined();
    expect(rows[0]!.output.providerQueryIds).toHaveLength(1);
    const { rows: analyses } = await db.query<{ section_statuses: { watch: string } }>(
      `SELECT a.section_statuses FROM analyses a JOIN captures c ON c.active_analysis_id = a.id WHERE c.id = $1`, [capture.capture_id],
    );
    expect(analyses[0]!.section_statuses.watch).toBe(withPositive ? 'complete' : 'empty');
  });

  it.each(['Sunroom dining nook', 'Galley kitchen'])('routes %s to content-gated architecture documentaries without commercial waivers', async (label) => {
    const architecture = { id: 'urn:tag:keyword:qloo:architecture', name: 'Architecture', type: 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] };
    const documentary = { id: 'urn:tag:genre:media:documentary', name: 'Documentary', type: 'urn:tag:genre:media', parents: ['urn:entity:movie'] };
    const excerpt = 'The film examines architecture and urban planning through interviews with architects.';
    const qloo = new FakeQloo({
      search: () => [],
      // Mimic an unscoped top-ten lookup crowded with unrelated tags: only
      // the scoped documentary lookup may resolve the actual movie topic.
      tags: (query, types) => !types?.includes('urn:tag:keyword:qloo') ? [] : query === 'architecture' ? [architecture] : query === 'documentary' ? [documentary] : [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:movie' && req.filterTagsOperator === 'intersection' ? [
          { entity_id: 'FIXTURE-ROOM-DOC', name: 'Fixture Architecture Process', types: ['urn:entity:movie'], tags: [architecture, documentary], properties: { description: excerpt } },
          { entity_id: 'FIXTURE-ROOM-CRIME', name: 'Fixture Architecture Heist', types: ['urn:entity:movie'], tags: [architecture, documentary], properties: { description: 'The film follows a crime involving an architect.' } },
          { entity_id: 'FIXTURE-ROOM-TAG', name: 'Fixture Architecture Tag Only', types: ['urn:entity:movie'], tags: [architecture, documentary], properties: {} },
        ] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Visible room', 'interior', { label, aesthetics: [] }) } });
    const ctx = await accountCtx(providers, testConfig({ STYLE_INTERIOR_BRANDS: 'true' }));
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(view.recommendations.map((card) => card.title)).toEqual(['Fixture Architecture Process']);
    expect(view.recommendations[0]?.reason).toBe('Documentary on architecture; prompted by architectural space your photo may suggest');
    expect(qloo.calls.filter((call) => call.op === 'insights').map((call) => call.req)).toEqual([
      expect.objectContaining({ filterType: 'urn:entity:movie', filterTags: [architecture.id, documentary.id], filterTagsOperator: 'intersection' }),
    ]);
  });

  it.each([['Walnut four-poster bed', 'Bed'], ['Painted walnut chair', 'Chairs']])('applies home relevance gates in the compiler for %s', async (label, publicNoun) => {
    const industry = { id: 'urn:tag:industry:qloo:furniture', name: 'Furniture' };
    const design = { id: 'urn:tag:aesthetic_property:qloo:mid_century_modern', name: 'Mid-Century Modern', type: 'urn:tag:aesthetic_property', parents: ['urn:entity:brand'] };
    const qloo = new FakeQloo({
      search: () => [],
      tags: (query) => /mid.?century/i.test(query) ? [design] : [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:brand' ? [
          {
            entity_id: 'FIXTURE-HOME-MATERIAL', name: 'Fixture Timber Maker', types: ['urn:entity:brand'], properties: {},
            tags: [industry, { id: 'urn:tag:signature_product:qloo:walnut', name: 'Walnut' }],
            query: { explainability: (req.signalEntities ?? []).slice(0, 1).map((entity_id) => ({ entity_id, score: 0.9 })) },
          },
          { entity_id: 'FIXTURE-HOME-WEAK', name: 'Fixture Generic Maker', types: ['urn:entity:brand'], properties: {}, tags: [industry] },
          {
            entity_id: 'FIXTURE-HOME-BACK', name: 'Fixture Mattress Maker', types: ['urn:entity:brand'], properties: {},
            tags: [industry, { id: 'urn:tag:keyword:qloo:back_pain_relief', name: 'Back Pain Relief' }],
          },
        ] : [], tags: [],
      }),
    }, { live: true });
    const vlmStyle = reader('Mid-century modern', 'interior', {
      label,
      aesthetics: [{ name: 'Mid-century modern', certainty: 0.9, defining_features: ['Tapered wooden legs', 'Open wooden back'], evidence: { basis: 'visible', region: null }, tag_query: null }],
    });
    const { providers } = world({ overrides: { qloo, vlmStyle } });
    const ctx = await accountCtx(providers, testConfig({ STYLE_INTERIOR_BRANDS: 'true' }));
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
    expect(view.style_reading?.subjects[0]?.label).toBe(label);
    const { rows } = await db.query<{ title: string; style_match: { discovery_proof: { relation: string; claim: { slot: string; name: string } } } }>(
      `SELECT r.title, r.style_match FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.rail = 'more_like_this' AND r.hidden_at IS NULL`, [capture.capture_id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Fixture Timber Maker']);
    expect(rows.find((r) => r.title === 'Fixture Timber Maker')!.style_match.discovery_proof)
      .toMatchObject({ relation: 'qloo_taste', claim: { slot: 'label', name: publicNoun } });
  });

  it.each(['unavailable', 'disabled', 'failed'] as const)('keeps %s style-reader jobs useful only through actual reference evidence', async (mode) => {
    const tag = CATALOG.tags['vintage racing']![0]!;
    const film: QlooEntity = { entity_id: 'FIXTURE-FALLBACK-FILM', name: 'Fixture Catalogue Film', types: ['urn:entity:movie'], properties: {}, tags: [tag] };
    const qloo = new FakeQloo({
      search: () => [],
      tags: (query) => CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:movie' ? [
          film,
          { ...film, entity_id: 'FIXTURE-FALLBACK-NO-TAG', name: 'Fixture Generic Popular Film', tags: [], query: { affinity: 0.99 } },
          { ...film, entity_id: 'FIXTURE-FALLBACK-WRONG-TYPE', name: 'Fixture Wrong Type', types: ['urn:entity:brand'] },
        ] : req.filterType === 'urn:entity:artist' ? [
          musician('FIXTURE-FALLBACK-JAZZ', 'Fixture Tagged Musician', [tag, musicTag]),
          musician('FIXTURE-FALLBACK-SCULPTOR', 'Fixture Nonmusical Artist', [tag]),
        ] : [], tags: [],
      }),
    }, { live: true });
    let styleCalls = 0;
    const vlmStyle: VlmStyleReader = {
      ...reader('Workwear'),
      async readStyle() { styleCalls++; throw new ProviderError('model-gateway', 'timeout', 'Fixture unavailable reading'); },
    };
    const { providers } = world({ overrides: { qloo, ...(mode === 'unavailable' ? {} : { vlmStyle }) } });
    const gateway = { experimentalRoles: new Set(['vision_style']), runners: {}, readiness: async () => ({}) } as unknown as NonNullable<typeof providers.modelGateway>;
    const ctx = await accountCtx(mode === 'disabled' ? { ...providers, modelGateway: gateway } : providers);
    if (mode === 'disabled') await setFeatureKill(db, { flag: 'experimental_analysis_enabled', accountId: (ctx.principal as { accountId: string }).accountId, reason: 'fixture', actor: 'test' });
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg() }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
    expect(view.style_reading).toBeNull();
    expect(styleCalls).toBe(mode === 'failed' ? 1 : 0);
    expect(view.recommendations.map((card) => card.title).sort()).toEqual(['Fixture Catalogue Film', 'Fixture Tagged Musician']);
    expect(view.recommendations.find((card) => card.title === film.name)).toMatchObject({
      reason: 'A film tagged Vintage Racing', style_match: { subject_id: null, attributes: [], palette: [] },
    });
    const { rows } = await db.query<{ contributing_reference_ids: string[]; style_match: { subject_id: null; discovery_proof: { subjectId: null; relation: string; sourceQueryId: string; referenceEvidence: unknown } }; provider_query_ids: string[] }>(
      `SELECT r.contributing_reference_ids, r.style_match, r.provider_query_ids FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1`, [capture.capture_id],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.contributing_reference_ids).toEqual([]);
      expect(row.style_match).toMatchObject({ subject_id: null, discovery_proof: { subjectId: null, relation: 'catalogue_facet', referenceEvidence: { kind: 'exact_request_tag' } } });
      expect(row.provider_query_ids).toEqual([row.style_match.discovery_proof.sourceQueryId]);
    }
  });

  it('anchor-only retrieval keeps a supported subculture, rejects audience-only fill, and never invents contributors', async () => {
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => query.toLowerCase() === 'punk' ? [musicTag] : CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:artist' ? [
          musician('FIXTURE-EVIDENCE-POP', 'Fixture Audience Artist', [{ id: 'urn:tag:genre:music:pop', name: 'Pop' }]),
          musician('FIXTURE-EVIDENCE-PUNK', 'Fixture Punk Artist', [musicTag]),
        ] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Punk') } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(schemas.CaptureResponse.safeParse(view).success).toBe(true);
    const artistCall = qloo.calls.find((call) => call.op === 'insights' && (call.req as { filterType: string }).filterType === 'urn:entity:artist')!;
    expect(artistCall.req).toMatchObject({ signalEntities: [], signalTags: [{ id: CATALOG.tags['vintage racing']![0]!.id }] });
    const { rows } = await db.query<{ title: string; contributing_reference_ids: string[]; style_match: { discovery_proof: { subjectId: string; origin: string; relation: string; candidateTags: { id: string }[] } }; display_reason: string }>(
      `SELECT r.title, r.contributing_reference_ids, r.style_match, r.display_reason FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.category = 'play'`, [capture.capture_id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Fixture Punk Artist']);
    expect(rows[0]!.contributing_reference_ids).toEqual([]);
    expect(rows[0]!.style_match.discovery_proof).toMatchObject({
      subjectId: 's1', origin: 'anchor', relation: 'shared_subculture', candidateTags: [{ id: musicTag.id }],
    });
    expect(rows[0]!.display_reason).toContain('tagged Punk');
    expect(rows[0]!.display_reason).not.toMatch(/shares a taste|Fixture Denim/i);
  });

  it('does not even query music audience overlap for an interior adjective', async () => {
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: () => [{ id: 'urn:tag:genre:music:minimalism', name: 'Minimalism', type: 'urn:tag:genre', parents: ['urn:entity:artist'] }],
      insights: () => ({ entities: [musician('FIXTURE-EVIDENCE-MINIMAL', 'Fixture Composer', [{ id: 'urn:tag:genre:music:minimalism', name: 'Minimalism' }])], tags: [] }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Warm minimalism', 'interior') } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    expect(qloo.calls.some((call) => call.op === 'insights' && (call.req as { filterType: string }).filterType === 'urn:entity:artist')).toBe(false);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(view.recommendations.filter((r) => r.category === 'play')).toEqual([]);
  });

  it('the recorded statue failure shape cannot publish eight generic Stylized films on any rail', async () => {
    const names = ['Fight Club', 'Inception', 'Pulp Fiction', 'Sinners', 'The Matrix', 'The Substance', 'Nosferatu', 'Django Unchained'];
    const stylized = { id: 'urn:tag:style:qloo:stylized', name: 'Stylized', type: 'urn:tag:style', parents: ['urn:entity:movie'] };
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => query === 'sculpture'
        ? [{ id: 'urn:tag:keyword:qloo:sculpture', name: 'Sculpture', type: 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] }]
        : query === 'documentary'
          ? [{ id: 'urn:tag:genre:media:documentary', name: 'Documentary', type: 'urn:tag:genre:media', parents: ['urn:entity:movie'] }]
          : query.toLowerCase() === 'stylized' ? [stylized] : CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:movie' ? names.map((name, i) => ({
          entity_id: `FIXTURE-STATUE-FILM-${i}`, name, types: ['urn:entity:movie'], properties: {},
          tags: [stylized], query: { affinity: 0.8 },
        })) : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Stylized', 'media', { label: 'Classical marble sculpture', brand: null }) } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const view = await captures.getCapture(ctx, { id: capture.capture_id });
    expect(view.style_reading?.subjects[0]?.label).toBe('Classical marble sculpture');
    const { rows } = await db.query<{ title: string }>(
      `SELECT r.title FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.external_ids->>'qloo' LIKE 'FIXTURE-STATUE-FILM-%' AND r.hidden_at IS NULL`, [capture.capture_id],
    );
    expect(rows).toEqual([]);
    expect(qloo.calls.some((call) => call.op === 'insights' && (call.req as { filterType: string }).filterType === 'urn:entity:movie')).toBe(true);
    const { rows: logs } = await db.query<{ status: string; results: { name: string; tags: { id: string }[]; schema_version: string; metadataAvailability: { imageRole: string } }[] }>(
      `SELECT p.status, p.results FROM provider_queries p JOIN captures c ON c.active_analysis_id = p.analysis_id WHERE c.id = $1 AND p.provider = 'qloo' AND p.operation = 'insights' AND jsonb_array_length(p.results) = 8`, [capture.capture_id],
    );
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((log) => log.status === 'ok')).toBe(true);
    expect(logs[0]!.results[0]).toMatchObject({ schema_version: 'qloo_candidate_audit_v1', tags: [{ id: stylized.id }], metadataAvailability: { imageRole: 'unknown' } });
  });

  it('retains explained Qloo music taste without shared visual tags, but does not route a visual artist to Play', async () => {
    const seedId = 'FIXTURE-BRAND-BRIDGE';
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:artist' ? [
          { ...musician('FIXTURE-MUSIC-TASTE', 'Fixture Jazz Group', [{ id: 'urn:tag:genre:music:jazz', name: 'Jazz' }]), query: { explainability: [{ entity_id: seedId, score: 0.8 }] } },
          { ...musician('FIXTURE-MUSIC-TASTE-2', 'Fixture Pop Group', [{ id: 'urn:tag:genre:music:pop', name: 'Pop' }]), query: { explainability: [{ entity_id: seedId, score: 0.8 }] } },
          { ...musician('FIXTURE-MUSIC-TASTE-3', 'Fixture Classical Group', [{ id: 'urn:tag:genre:music:classical', name: 'Classical' }]), query: { explainability: [{ entity_id: seedId, score: 0.8 }] } },
          { ...musician('FIXTURE-VISUAL-ARTIST', 'Fixture Sculptor', [{ id: 'urn:tag:theme:qloo:sculpture', name: 'Sculpture' }]), query: { explainability: [{ entity_id: seedId, score: 0.8 }] } },
        ] : req.filterType === 'urn:entity:brand' ? [{
          entity_id: seedId, name: 'Fixture Denim Brand', types: ['urn:entity:brand'], properties: {},
          tags: [{ id: 'urn:tag:genre:brand:fashion:jeans', name: 'Jeans' }, { id: 'urn:tag:fashion_segment:qloo:workwear', name: 'Workwear' }],
          query: { affinity: 0.8 },
        }] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Workwear', 'fashion') } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const { rows } = await db.query<{ title: string; display_reason: string; style_match: { discovery_proof: { relation: string; provenance: { seedIds: string[] } } } }>(
      `SELECT r.title, r.display_reason, r.style_match FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.category = 'play' AND r.hidden_at IS NULL`, [capture.capture_id],
    );
    expect(rows.map((r) => r.title)).toEqual(['Fixture Jazz Group']);
    expect(rows[0]!.display_reason).toBe('Explore a Qloo taste connection through Fixture Denim Brand');
    expect(rows[0]!.style_match.discovery_proof).toMatchObject({ relation: 'qloo_taste', provenance: { seedIds: [seedId] } });
  });

  it('does not turn a scope-only brand into a style bridge for another taste hop', async () => {
    const seedId = 'FIXTURE-SCOPE-ONLY-BRAND';
    const qloo = new FakeQloo({
      search: (query) => CATALOG.search[query.toLowerCase()] ?? [],
      tags: (query) => CATALOG.tags[query.toLowerCase()] ?? [],
      insights: (req) => ({
        entities: req.filterType === 'urn:entity:brand' ? [{
          entity_id: seedId, name: 'Fixture Apparel Explorer', types: ['urn:entity:brand'], properties: {},
          tags: [{ id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual apparel' }],
        }] : [], tags: [],
      }),
    }, { live: true });
    const { providers } = world({ overrides: { qloo, vlmStyle: reader('Workwear') } });
    const ctx = await accountCtx(providers);
    const capture = await captures.createCapture(ctx, { kind: 'multipart', image: { bytes: await testJpeg(640, 480) }, fields: { source: 'upload', focus: undefined } });
    await runJobs(ctx, [capture.job_id]);
    const { rows } = await db.query<{ style_match: { discovery_proof: { relation: string } } }>(
      `SELECT r.style_match FROM recommendations r JOIN captures c ON c.active_analysis_id = r.analysis_id WHERE c.id = $1 AND r.external_ids->>'qloo' = $2 AND r.hidden_at IS NULL`, [capture.capture_id, seedId],
    );
    expect(rows).toHaveLength(0);
    expect(qloo.calls.some((call) => call.op === 'insights' && ((call.req as { signalEntities?: string[] }).signalEntities ?? []).includes(seedId))).toBe(false);
  });
});
