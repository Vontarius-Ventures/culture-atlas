import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_ASSET_CHECKER_VERSION, ProviderError, type ConnectionAssetProvider, type QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { admitDiscovery, type CandidateProof } from '../style/discovery-evidence';
import { compileSourceFeaturePlan } from '../style/source-feature-plan';
import type { StoredSubject } from '../style/types';
import type { Db } from '../db/pool';
import { CaptureCompiler } from './analyze';
import { JobBudget } from './budget';
import {
  compileConnectionRetrievalPlans, connectionContentForAdmission, FEATURE_BOUND_CONNECTION_COMPILER,
  reconcileConnectionProof, retainedConnectionContent, retainConnectionCandidateTags, selectConnectionConcepts,
  StyleStage, type ConnectionPublicationCandidate, type ResolvedConnectionPlan, type StyleHost,
} from './style-stage';

// All metadata, checker verdicts and DB handles here are explicitly synthetic.
// These tests perform NO DB, network, model, or source/candidate similarity calls.
const brand = 'urn:entity:brand';
const source = (): StoredSubject => ({
  id: 's1', category: 'fashion', label: 'Striped cotton shirt', region: { x: 0, y: 0, w: 1, h: 1 },
  aesthetics: [], era: null, lineage: [], materials: [], construction: [], palette: [], mood: [], details: [],
  brand: null, entity: null, qloo_links: [],
  observations: [
    { id: 'o1', kind: 'form', text: 'Short-sleeved top with a crew neck', certainty: 0.9, region: null },
    { id: 'o2', kind: 'surface', text: 'Horizontal stripes across the knit surface', certainty: 0.9, region: null },
  ],
});
const entity = (id = 'FIXTURE-BRAND'): QlooEntity => ({
  entity_id: id, name: `Fixture ${id}`, types: [brand],
  properties: { image: { url: `https://assets.example.test/${id}.jpg` } },
  tags: [
    { id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual' },
    { id: 'urn:tag:signature_piece:qloo:fixture_striped_shirts', name: 'Striped shirts' },
  ],
});
function proofFor(subject = source(), candidate = entity()): CandidateProof {
  const proof = admitDiscovery([subject], candidate, brand, { readingRev: 1, queryId: 'fixture-provider-query' });
  if (!proof?.sourceEvidence) throw new Error('Fixture must prove actual retained stripe observations');
  return retainConnectionCandidateTags(proof, candidate);
}
function publicationCandidate(id = 'FIXTURE-BRAND'): ConnectionPublicationCandidate {
  const candidate = entity(id);
  return { candidateId: id, name: candidate.name, actualTypes: candidate.types,
    imageUrl: `https://assets.example.test/${id}.jpg`, proof: proofFor(source(), candidate) };
}
const syntheticChecker = (identity: 'corroborated' | 'unknown' = 'corroborated'): ConnectionAssetProvider['checkConnectionAsset'] => async (metadata, imageUrl) => ({
  version: 'connection_asset_evidence_v1', candidateId: metadata.candidateId, imageUrl,
  originalSha256: 'a'.repeat(64), modelInputSha256: 'b'.repeat(64), identity, image: 'available',
  checkerVersion: CONNECTION_ASSET_CHECKER_VERSION,
});
function stageFixture(options: {
  checker?: ConnectionAssetProvider['checkConnectionAsset']; limit?: number; subject?: StoredSubject; qloo?: FakeQloo; budget?: number;
  deadline?: () => boolean;
} = {}) {
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) => ({
    rows: /INSERT INTO provider_queries/.test(sql) ? [{ id: 'fixture-provider-query' }]
      : /SELECT c.id FROM captures|FROM captures WHERE/.test(sql) ? [{ id: 'fixture-capture', active_analysis_id: 'fixture-analysis' }]
      : /INSERT INTO discovery_items|INSERT INTO recommendations/.test(sql) ? [{ id: 'fixture-result' }] : [],
  }));
  const db = { query, inTransaction: false } as unknown as Db;
  db.transaction = async (fn) => fn(db);
  const trace = vi.fn(async (_event: unknown) => undefined);
  const budget = new JobBudget({ qlooRequests: options.budget ?? 12, researchRefs: 0, retriesPerStage: 0 });
  const host = {
    compilerVersion: FEATURE_BOUND_CONNECTION_COMPILER,
    ctx: {
      db, providers: { qloo: options.qloo, connectionAsset: { isConfigured: () => false } },
      config: { CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE: options.limit ?? 3 },
      signal: new AbortController().signal, ensureActive: vi.fn(async () => undefined), trace,
      workerId: 'fixture-worker', job: { id: 'fixture-job' },
    },
    capture: { id: 'fixture-capture' }, analysisId: 'fixture-analysis',
    owner: { kind: 'account', accountId: 'fixture-account' }, traceId: null, startedAt: 0,
    budget, usedKeys: new Set<string>(), excludedKeys: async () => new Set<string>(),
    callOptions: () => ({ budget: budget.forStage('fixture') }), pastSoftDeadline: options.deadline ?? (() => false),
    qlooCall: async (key: string, fn: (o: object) => Promise<unknown>) => {
      if (!budget.forStage(key).take('qloo', 'request')) throw new ProviderError('qloo', 'budget_exhausted', 'Fixture request budget');
      return { value: await fn({ maxRetries: 0 }), attempts: 1 };
    },
    ...(options.checker ? { checkConnectionAsset: options.checker } : {}),
  } as unknown as StyleHost;
  const stage = new StyleStage(host);
  Object.assign(stage, { stored: { rev: 1, subjects: [options.subject ?? source()] } });
  return { stage, query, trace, budget, host };
}

describe('feature-bound compiler integration without external services', () => {
  it('recovers source stripe/rib-trim concepts rather than spending the two-plan allowance on broad garment topics', () => {
    const s = source();
    s.observations!.push({ id: 'o3', kind: 'construction', text: 'Ribbed trim around the neck', certainty: 0.9, region: null });
    const plans = compileConnectionRetrievalPlans([s], 1);
    expect(plans.map((p) => [p.key, p.targetType])).toEqual([['feature:stripes', brand], ['feature:rib_trim', brand]]);
    const features = compileSourceFeaturePlan([s], 1).features;
    for (const plan of plans) {
      expect(plan.tagQueries!.length).toBeLessThanOrEqual(2);
      expect(plan.sourceFeatureIds!.every((id) => features.some((f) => f.id === id))).toBe(true);
    }
    expect(compileConnectionRetrievalPlans([{ ...s, observations: [] }], 1)).toEqual([]);
  });

  it.each(['book-only', 'missing-parents'] as const)('tries a closed typed alternate after a %s first lookup, memoizes requests, and makes at most one insights call per plan', async (failure) => {
    const s = source();
    s.observations!.push({ id: 'o3', kind: 'construction', text: 'Ribbed trim around the neck', certainty: 0.9, region: null });
    const qloo = new FakeQloo({
      tags: (query) => [{ id: `urn:tag:aesthetic_property:qloo:fixture_${query.replaceAll(' ', '_')}`, name: query,
        type: 'urn:tag:aesthetic_property:qloo', parents: query === 'striped' ? failure === 'book-only' ? ['urn:entity:book'] : [] : [brand] }],
      insights: () => ({ entities: [], tags: [] }),
    });
    const { stage, budget } = stageFixture({ qloo, subject: s });
    const first = stage.documentaryPlansFor();
    expect(stage.documentaryPlansFor()).toBe(first);
    const resolved = await first;
    expect(resolved.map((r) => r.lookupQuery)).toEqual(['stripes', 'ribbed trim']);
    expect(qloo.calls.filter((c) => c.op === 'tags')).toHaveLength(3);
    const railStatus = vi.fn(async () => undefined);
    Object.assign(stage, { railStatus });
    const seam = stage as unknown as { buildFeatureRail(subject: StoredSubject, plans: readonly ResolvedConnectionPlan[]): Promise<void> };
    await seam.buildFeatureRail(s, resolved);
    await seam.buildFeatureRail(s, resolved);
    expect(qloo.calls.filter((c) => c.op === 'insights')).toHaveLength(2);
    expect(budget.usedBy('qloo')).toBe(5);
    expect(qloo.calls.every((c) => c.op !== 'insights' || (c.req as { take: number }).take === 20)).toBe(true);
  });

  it('resolves one actual documentary genre shared by two original subject plans, never by a guessed genre ID', async () => {
    const coffee: StoredSubject = { ...source(), id: 'coffee', label: 'Coffee in a cup', category: 'food',
      observations: [{ id: 'coffee-form', kind: 'form', text: 'A cup filled with coffee', certainty: 0.9, region: null }] };
    const chair: StoredSubject = { ...source(), id: 'chair', label: 'Wooden armchair', category: 'interior',
      observations: [{ id: 'chair-form', kind: 'form', text: 'Armchair with four legs and armrests', certainty: 0.9, region: null }] };
    const qloo = new FakeQloo({
      tags: (query) => [{ id: `urn:tag:${query === 'documentary' ? 'genre:media' : 'keyword:qloo'}:fixture_${query}`,
        name: query, type: query === 'documentary' ? 'urn:tag:genre:media' : 'urn:tag:keyword:qloo', parents: ['urn:entity:movie'] }],
    });
    const { stage } = stageFixture({ qloo });
    Object.assign(stage, { stored: { rev: 1, subjects: [coffee, chair] } });
    const plans = await stage.documentaryPlansFor();
    expect(plans.map((r) => [r.plan.subjectId, r.plan.key])).toEqual([['coffee', 'coffee'], ['chair', 'furniture']]);
    expect(plans.every((r) => r.documentaryTagId === 'urn:tag:genre:media:fixture_documentary')).toBe(true);
    expect(qloo.calls.filter((c) => c.op === 'tags' && (c.req as { query: string }).query === 'documentary')).toHaveLength(1);
  });

  it('uses full returned candidate tags for proof while requiring the exact retrieved query tag on the candidate', async () => {
    const queryTag = 'urn:tag:aesthetic_property:qloo:fixture_striped';
    const good = { ...entity('WITH-QUERY'), tags: [...entity().tags, { id: queryTag, name: 'Striped patterns' }] };
    const absent = entity('WITHOUT-QUERY');
    const qloo = new FakeQloo({
      tags: (query) => [{ id: queryTag, name: query, type: 'urn:tag:aesthetic_property:qloo', parents: [brand] }],
      insights: () => ({ entities: [good, absent], tags: [] }),
    });
    const { stage } = stageFixture({ qloo });
    const publishRail = vi.fn(async () => 0);
    Object.assign(stage, { publishRail });
    const plans = await stage.documentaryPlansFor();
    const seam = stage as unknown as { buildFeatureRail(s: StoredSubject, p: readonly ResolvedConnectionPlan[]): Promise<void> };
    await seam.buildFeatureRail(source(), plans);
    expect(publishRail).toHaveBeenCalledTimes(1);
    const args = publishRail.mock.calls as unknown as [string, { entity: QlooEntity }[]][];
    expect(args[0]![1].map((c) => c.entity.entity_id)).toEqual(['WITH-QUERY']);
    expect(args[0]![1][0]!.entity.tags).toContainEqual(entity().tags[1]);
  });

  it.each(['empty', 'error'] as const)('does not let a first %s lookup suppress an independent second feature', async (failure) => {
    const s = source();
    s.observations!.push({ id: 'o3', kind: 'construction', text: 'Ribbed trim around the neck', certainty: 0.9, region: null });
    const qloo = new FakeQloo({
      tags: (query) => query.startsWith('ribbed') ? [{ id: 'urn:tag:signature_piece:qloo:fixture_ribbed', name: query, type: 'urn:tag:signature_piece:qloo', parents: [brand] }]
        : failure === 'error' ? new ProviderError('qloo', 'timeout', 'Fixture lookup failure') : [],
    });
    const { stage } = stageFixture({ qloo, subject: s });
    expect((await stage.documentaryPlansFor()).map((r) => r.plan.key)).toEqual(['feature:rib_trim']);
    expect(qloo.calls.filter((c) => c.op === 'tags')).toHaveLength(3);
  });

  it('logs cached queries as cached_hit rather than interpreting missing network rows as absent queries', async () => {
    const qloo = new FakeQloo({ tags: () => [] });
    const { stage, query, trace } = stageFixture({ qloo });
    query.mockImplementation(async (sql: string) => ({ rows: /SELECT results FROM provider_queries/.test(sql)
      ? [{ results: [{ id: 'urn:tag:signature_piece:qloo:fixture_striped', name: 'striped', type: 'urn:tag:signature_piece:qloo', parents: [brand] }] }] : [] }) as never);
    await stage.documentaryPlansFor();
    expect(qloo.calls).toEqual([]);
    expect(trace.mock.calls.some(([event]) => (event as unknown as { data: { terminal_status?: string } }).data.terminal_status === 'cached_hit')).toBe(true);
  });

  it.each(['budget', 'deadline'] as const)('records a terminal %s without fabricating tag IDs', async (reason) => {
    const qloo = new FakeQloo({ tags: () => [] });
    const { stage, trace } = stageFixture({ qloo, budget: reason === 'budget' ? 0 : 12, deadline: () => reason === 'deadline' });
    expect(await stage.documentaryPlansFor()).toEqual([]);
    expect(qloo.calls).toEqual([]);
    expect(trace.mock.calls.some(([event]) => (event as unknown as { data: { terminal_status?: string } }).data.terminal_status === reason)).toBe(true);
  });

  it('withholds missing/unconfigured asset checks, not default-success evidence', async () => {
    const { stage } = stageFixture();
    expect((await stage.qualifyConnectionProofs([publicationCandidate()], 'qloo')).size).toBe(0);
    const disabled = stageFixture({ checker: syntheticChecker(), limit: 0 }).stage;
    expect((await disabled.qualifyConnectionProofs([publicationCandidate()], 'qloo')).size).toBe(0);
  });

  it('does not inherit stale asset evidence when the current check returns no evidence', async () => {
    const { stage } = stageFixture({ checker: async () => null });
    const candidate = publicationCandidate();
    candidate.proof!.assetEvidence = {
      version: 'connection_asset_evidence_v1', candidateId: candidate.candidateId, imageUrl: candidate.imageUrl!,
      originalSha256: 'a'.repeat(64), modelInputSha256: 'b'.repeat(64),
      identity: 'corroborated', image: 'available', checkerVersion: CONNECTION_ASSET_CHECKER_VERSION,
    };
    expect((await stage.qualifyConnectionProofs([candidate], 'qloo')).size).toBe(0);
  });

  it('validates actual type, source evidence, live origin and image before allocating an asset attempt', async () => {
    const checker = vi.fn(syntheticChecker());
    const { stage } = stageFixture({ checker });
    const good = publicationCandidate();
    const bad = [
      { ...good, candidateId: 'mismatched-id' },
      { ...good, actualTypes: ['urn:entity:movie'] },
      { ...good, imageUrl: null },
      { ...good, proof: { ...good.proof!, sourceEvidence: undefined } },
    ];
    expect((await stage.qualifyConnectionProofs(bad, 'qloo')).size).toBe(0);
    expect((await stage.qualifyConnectionProofs([good], 'replay')).size).toBe(0);
    expect(checker).not.toHaveBeenCalled();
    expect((await stage.qualifyConnectionProofs([good], 'qloo')).get(good.candidateId)?.assetEvidence?.identity).toBe('corroborated');
    expect(checker).toHaveBeenCalledTimes(1);
    expect(checker.mock.calls[0]![0].typeScope).toEqual([...new Set([
      ...good.actualTypes, ...good.proof!.candidateTags.map(t => t.label),
    ])].slice(0, 8));
  });

  it.each(['unknown', 'null', 'throw'] as const)('burns at most three allocated attempts across concurrent MLT/fill/append origins after %s failures', async (failure) => {
    const check: ConnectionAssetProvider['checkConnectionAsset'] = failure === 'unknown' ? syntheticChecker('unknown') : async () => {
      if (failure === 'throw') throw new Error('Synthetic checker failure');
      return null;
    };
    const checker = vi.fn(check);
    const { stage } = stageFixture({ checker });
    const candidates = Array.from({ length: 7 }, (_, i) => publicationCandidate(`FIXTURE-${i}`));
    const outputs = await Promise.all([
      stage.qualifyConnectionProofs(candidates.slice(0, 4), 'qloo'),
      stage.qualifyConnectionProofs(candidates.slice(3), 'qloo'),
    ]);
    expect(outputs.every((out) => out.size === 0)).toBe(true);
    expect(checker).toHaveBeenCalledTimes(3);
  });

  it('single-flights the same candidate/image across origins and rejects a placeholder verdict', async () => {
    const checker = vi.fn(syntheticChecker());
    const { stage } = stageFixture({ checker });
    const candidate = publicationCandidate();
    expect((await stage.qualifyConnectionProofs([candidate], 'qloo')).size).toBe(1);
    expect((await stage.qualifyConnectionProofs([candidate], 'qloo')).size).toBe(1);
    expect(checker).toHaveBeenCalledTimes(1);
    const placeholder = stageFixture({ checker: async (metadata, imageUrl, context) => ({
      ...(await syntheticChecker('unknown')(metadata, imageUrl, context))!, image: 'placeholder',
    }) }).stage;
    expect((await placeholder.qualifyConnectionProofs([candidate], 'qloo')).size).toBe(0);
  });

  it.each(['initial', 'append'] as const)('runs the real %s cross-domain writer through the same source/type/image gate', async (origin) => {
    for (const identity of ['corroborated', 'unknown'] as const) {
      const { stage, host, query } = stageFixture({ checker: syntheticChecker(identity) });
      const compiler = new CaptureCompiler({ ...host.ctx, payload: { compiler_version: FEATURE_BOUND_CONNECTION_COMPILER },
        budget: { deadlineMs: 20_000 } } as never);
      Object.assign(compiler, { style: stage, analysisId: host.analysisId, capture: host.capture, owner: host.owner });
      const candidate = publicationCandidate();
      const rec = { category: 'wear', status: 'complete', isReplay: false, providerQueryId: 'fixture-provider-query',
        candidates: [{ entityId: candidate.candidateId, name: candidate.name, actualTypes: candidate.actualTypes,
          proof: candidate.proof, image: { url: candidate.imageUrl }, explain: [], tags: [] }] };
      const seam = compiler as unknown as { composeCategory(rec: unknown, refs: never[], order: string[], excluded: Set<string>,
        used: Set<string>, append?: { signals: never[]; existing: number }): Promise<number> };
      const added = await seam.composeCategory(rec, [], ['wear'], new Set(), new Set(),
        origin === 'append' ? { signals: [], existing: 0 } : undefined);
      expect(added).toBe(identity === 'corroborated' ? 1 : 0);
      const inserts = query.mock.calls.filter(([sql]) => /INSERT INTO recommendations/.test(sql));
      expect(inserts.length).toBe(identity === 'corroborated' ? 1 : 0);
      if (identity === 'corroborated') {
        const update = query.mock.calls.find(([sql]) => /SET rail = 'cross_domain'/.test(sql))!;
        expect(JSON.parse(update[1]![1] as string).discovery_proof.assetEvidence.identity).toBe('corroborated');
      }
    }
  });

  it('withholds a newly qualified candidate when its source revision changes during the checker call', async () => {
    const { stage } = stageFixture({ checker: async (metadata, imageUrl, context) => {
      Object.assign(stage, { stored: { rev: 2, subjects: [source()] } });
      return syntheticChecker()(metadata, imageUrl, context);
    } });
    expect((await stage.qualifyConnectionProofs([publicationCandidate()], 'qloo')).size).toBe(0);
  });

  it.each(['publishRail', 'publishAffinityRail'] as const)('runs the real %s MLT writer through asset qualification and stores the rematched revision, not a stale caller revision', async (method) => {
    const { stage, query } = stageFixture({ checker: syntheticChecker() });
    const candidate = entity();
    Object.assign(stage, { stored: { rev: 2, subjects: [source()] },
      retrievals: new WeakMap([[candidate, { queryId: 'fixture-provider-query', request: { filterType: brand } }]]) });
    const railCandidate = { entity: candidate, sources: ['primary'], overlap: 1, score: 1, match: { score: 1 } };
    const options = { via: 'overlap', entityName: null, palette: [], providerQueryId: 'fixture-provider-query',
      providerQueryIds: ['fixture-provider-query'], isReplay: false, rev: 1, append: false };
    const seam = stage as unknown as {
      publishRail(subjectId: string, candidates: unknown[], accepted: never[], options: unknown): Promise<number>;
      publishAffinityRail(subjectId: string, candidates: unknown[], options: unknown): Promise<number>;
    };
    const added = method === 'publishRail' ? await seam.publishRail('s1', [railCandidate], [], options)
      : await seam.publishAffinityRail('s1', [railCandidate], options);
    expect(added).toBe(1);
    const update = query.mock.calls.find(([sql]) => /SET rail = 'more_like_this'/.test(sql))!;
    expect(update[1]![3]).toBe(2);
    const match = JSON.parse(update[1]![2] as string);
    expect(match.discovery_proof.sourceEvidence.readingRev).toBe(2);
    expect(match.discovery_proof.assetEvidence.identity).toBe('corroborated');
    expect(match.actual_candidate_types).toEqual([brand]);
  });

  it('rematches unchanged features for a current revision, but refuses changed observations or a source-only relabel upgrade', () => {
    const s = source();
    const proof = proofFor(s);
    expect(reconcileConnectionProof(proof, s, 2)?.sourceEvidence?.readingRev).toBe(2);
    // PostgreSQL JSONB canonicalizes object key order; it is not evidence drift.
    const reordered = { ...proof, sourceEvidence: Object.fromEntries(
      Object.entries(proof.sourceEvidence!).reverse(),
    ) as NonNullable<CandidateProof['sourceEvidence']> };
    expect(reconcileConnectionProof(reordered, s, 2)?.sourceEvidence?.readingRev).toBe(2);
    const changed = structuredClone(s);
    changed.observations![1]!.text = 'Plain surface without the earlier pattern';
    expect(reconcileConnectionProof(proof, changed, 2)).toBeNull();
    expect(reconcileConnectionProof({ ...proof, sourceEvidence: undefined }, s, 2)).toBeNull();
    expect(reconcileConnectionProof({ ...proof, claim: { slot: 'label', name: 'Islamic object', wording: 'asserted' } }, s, 2)).toBeNull();
  });

  it('retains actual unchosen candidate tags and ranks a specific central feature match ahead of a generic same-topic result', () => {
    const { stage } = stageFixture();
    const specific = proofFor();
    const generic = { ...specific, candidateTags: [], sourceEvidence: { ...specific.sourceEvidence!, featureIds: [] },
      contentEvidence: { topic: 'fashion', claim: specific.claim, field: 'description' as const, excerpt: 'Synthetic central content.', focus: 'central' as const } };
    const allTags = retainConnectionCandidateTags(generic, entity());
    expect(allTags.candidateTags).toContainEqual({ id: entity().tags![1]!.id, label: 'Striped shirts' });
    const pool = [{ id: 'generic', proof: generic }, { id: 'specific', proof: specific }];
    expect(selectConnectionConcepts(pool, 2, (c) => c.proof, [], (c) => stage.connectionEvidenceStrength(c.proof)).map((c) => c.id)).toEqual(['specific', 'generic']);
  });

  it('keeps private replay retention off by default, bounded/hashed when opted in, and affected sensitive fields unknown', () => {
    const work: QlooEntity = { ...entity(), types: ['urn:entity:movie'], properties: { description: 'Synthetic public film synopsis.', private_token: 'never retain' } };
    expect(retainedConnectionContent(work)).toBeUndefined();
    const safe = retainedConnectionContent(work, true)!;
    expect(safe.fields.description).toMatchObject({ text: work.properties.description, reject_code: null, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const sensitive = { ...work, properties: { description: 'Contact person@example.test and https://private.example.test for details.' } };
    expect(JSON.stringify(retainedConnectionContent(sensitive, true))).not.toMatch(/person@|https:/);
    expect(connectionContentForAdmission(sensitive).properties.description).toBeUndefined();
    expect(retainedConnectionContent({ ...work, types: ['urn:entity:artist'] }, true)).toBeUndefined();
    expect(retainedConnectionContent({ ...work, properties: { description: 'x'.repeat(4_001) } }, true)!.fields.description?.reject_code).toBe('length');
  });

  it('disables the actual creative-food writer for v10 while leaving the legacy writer branch explicit', async () => {
    const supported = vi.fn(async () => []);
    const compiler = new CaptureCompiler({ payload: { compiler_version: FEATURE_BOUND_CONNECTION_COMPILER }, job: {},
      budget: { deadlineMs: 1_000 } } as never);
    Object.assign(compiler, { supportedFoodReferences: supported });
    type EatSeam = { composeEat(refs: never[], order: never[], excluded: Set<string>, used: Set<string>): Promise<string> };
    expect(await (compiler as unknown as EatSeam).composeEat([], [], new Set(), new Set())).toBe('skipped');
    expect(supported).not.toHaveBeenCalled();
    const legacy = new CaptureCompiler({ payload: { compiler_version: 'compiler-2026-10-27-intent-quality-v9' }, job: {},
      budget: { deadlineMs: 1_000 } } as never);
    supported.mockImplementationOnce(async () => { throw new Error('Legacy writer branch reached'); });
    Object.assign(legacy, { supportedFoodReferences: supported });
    await expect((legacy as unknown as EatSeam).composeEat([], [], new Set(), new Set())).rejects.toThrow('Legacy writer branch reached');
    expect(supported).toHaveBeenCalledTimes(1);
  });
});
