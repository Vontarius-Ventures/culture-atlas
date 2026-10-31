import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { writeFile } from 'node:fs/promises';
import type { VisualSimilarityRequest, VisualSimilarityResult } from '@culture-atlas/providers';
import { createIsolatedDatabase, insertAccount, testContext, testConfig, testProviders, type IsolatedDatabase } from '../testing';
import { claimJobs } from '../jobs/queue';
import { JobCancelledError, type JobContext } from '../jobs/handler';
import type { JobRecord } from '../jobs/types';
import { createCapture, deleteCapture, getCapture } from '../services/captures';
import { ensureAnalysisRow } from '../services/analyses';
import { syntheticVisualCatalog, syntheticVisualReading } from './visual-test-support';
import { acceptedVisualResult, eligibleVisualSubjects, enqueueVisualReferences, INTENT_COMPILER_VERSION, loadVisualReferenceState,
  shortlistVisualCandidates, visualReferenceDiscovery, VISUAL_CANDIDATE_SELECTION_POLICY_VERSION, visualReadingHash } from './visual-references';
import { COMMONS_LICENSES, loadVisualCatalog, visualSha256 } from './visual-catalog';
import { CaptureResponse } from '../schemas/captures';
import { stableStringify } from '../util/stable-json';

let isolated: IsolatedDatabase;
let assets: Awaited<ReturnType<typeof syntheticVisualCatalog>>;
beforeAll(async () => { isolated = await createIsolatedDatabase('visual'); assets = await syntheticVisualCatalog(); });
afterAll(async () => { await assets?.cleanup(); await isolated?.drop(); });
function suggestion(input: VisualSimilarityRequest): VisualSimilarityResult {
  return {
    sameObjectType: true, similarity: 'strong', matchedFeatures: ['similar silhouette', 'similar proportions'], differences: [],
    sourceImageSha256: visualSha256(input.sourceImage), candidateImageSha256: visualSha256(input.candidateImage),
    contactSheetSha256: 'c'.repeat(64), sourceRegion: input.sourceRegion, model: 'synthetic-test-model',
    profileVersion: 'synthetic-test-profile', schemaVersion: 'atlas_visual_similarity_v1', experimental: true,
  };
}
async function fixture(compare = vi.fn(async (input: VisualSimilarityRequest) => suggestion(input))) {
  const account = await insertAccount(isolated.db);
  const config = testConfig({ VISUAL_REFERENCE_CATALOG_FILE: assets.file, VISUAL_MAX_COMPARISONS_PER_CAPTURE: '2' });
  const providers = testProviders({ visualSimilarity: { isConfigured: () => true, compare } });
  const service = testContext(account, { db: isolated.db, config, providers });
  const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#e5e5e5' } }).jpeg().toBuffer();
  const created = await createCapture(service, { kind: 'multipart', image: { bytes: image }, fields: { source: 'upload', focus: undefined } });
  const a = await ensureAnalysisRow(isolated.db, {
    captureId: created.capture_id, version: 1, compilerVersion: INTENT_COMPILER_VERSION, focus: { kind: 'whole' }, jobId: created.job_id,
  });
  const reading = syntheticVisualReading();
  await isolated.db.query(`UPDATE analyses SET style_reading=$2::jsonb,section_statuses='{"style":"ready"}'::jsonb WHERE id=$1`, [a.id, JSON.stringify(reading)]);
  await isolated.db.query(`UPDATE captures SET active_analysis_id=$2,status='ready' WHERE id=$1`, [created.capture_id, a.id]);
  await isolated.db.query(`UPDATE jobs SET state='complete' WHERE id=$1`, [created.job_id]);
  const parentJob = (await isolated.db.query<JobRecord<'analyze_capture'>>('SELECT * FROM jobs WHERE id=$1', [created.job_id])).rows[0]!;
  function context<T extends JobRecord>(job: T): JobContext {
    return {
      job, payload: job.payload, attempt: 1, workerId: 'visual-test', db: isolated.db, providers, config,
      signal: new AbortController().signal, budget: { qlooRequests: 0, researchRefs: 0, providerRetries: 0, deadlineMs: 30_000 },
      setStage: async () => {}, runStage: async (_name, fn) => fn(), trace: async () => {}, log: () => {},
      ensureActive: async () => {
        const { rows } = await isolated.db.query<{ cancel_requested_at: Date | null; state: string }>('SELECT state,cancel_requested_at FROM jobs WHERE id=$1', [job.id]);
        if (!rows[0] || rows[0].cancel_requested_at || rows[0].state === 'cancelled') throw new JobCancelledError();
      },
    };
  }
  const parent = context(parentJob);
  const enqueue = () => enqueueVisualReferences(parent, created.capture_id, a.id);
  async function worker() {
    const jobs = await claimJobs(isolated.db, { workerId: 'visual-test', leaseMs: 60_000, limit: 1, types: ['visual_reference_discovery'],
      ids: (await isolated.db.query<{ job_id: string }>('SELECT job_id FROM visual_reference_runs WHERE capture_id=$1', [created.capture_id])).rows.map(r => r.job_id) });
    return context(jobs[0]!) as JobContext<'visual_reference_discovery'>;
  }
  return { account, config, providers, service, created, analysisId: a.id, reading, parent, enqueue, worker, compare };
}

describe('visual admission and cautious projection', () => {
  it.each(['CC-BY-4.0', 'CC-BY-SA-4.0'] as const)('projects complete %s credit for synthetic Commons evidence without changing legacy fields', async license => {
    const f = await fixture();
    const file = `${assets.dir}/catalog-${license}.json`;
    await writeFile(file, JSON.stringify({
      ...assets.catalog, schema_version: 'atlas_visual_catalog_v2',
      objects: [{
        ...assets.catalog.objects[0], id: 'commons:123', institution: 'Wikimedia Commons',
        object_type: 'vase', source_url: 'https://commons.wikimedia.org/?curid=123',
        image_url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic.jpg',
        creator: 'SYNTHETIC creator', attribution: 'SYNTHETIC credit', source_title: 'File:Synthetic.jpg',
        license, license_url: COMMONS_LICENSES[license], is_public_domain: false,
        retrieval: { basis: 'static_query_hint_not_verified_identity', query_class: 'vase', depiction: 'object' },
      }],
    }), { flag: 'wx', mode: 0o600 });
    f.config.VISUAL_REFERENCE_CATALOG_FILE = file;
    await f.enqueue();
    await visualReferenceDiscovery(await f.worker());
    const response = CaptureResponse.parse(await getCapture(f.service, { id: f.created.capture_id }));
    expect(response.discovery_intents?.visual.status).toBe('ready');
    const card = response.discovery_intents!.visual.cards[0]!;
    expect(card.catalog_id).toBe('commons:123');
    expect(card.credit).toEqual({
      attribution: 'SYNTHETIC creator; SYNTHETIC credit', license, license_url: COMMONS_LICENSES[license],
      changes: 'Converted to JPEG, orientation normalized, metadata removed.',
    });
    expect(card.explanation).not.toMatch(/museum|public.domain|for sale/i);
    expect(card.limitations).toContain('not an identification');
    expect(JSON.stringify(card)).not.toContain(assets.dir);
  });
  it('binds selection policy into reading, job and publication identity', () => {
    const reading = syntheticVisualReading();
    expect(visualReadingHash(reading)).toBe(visualSha256(stableStringify({
      selection_policy_version: VISUAL_CANDIDATE_SELECTION_POLICY_VERSION, reading,
    })));
    expect(visualReadingHash(reading)).not.toBe(visualSha256(stableStringify(reading)));
  });

  it('requires active visible guarded object evidence; hidden/person/context claims cannot widen retrieval', async () => {
    const reading = syntheticVisualReading();
    expect(eligibleVisualSubjects(reading)).toHaveLength(1);
    for (const patch of [{ held: true }, { retracted: true }, { basis: 'context' as const }]) {
      const r = syntheticVisualReading();
      Object.assign(r.subjects[0]!.aesthetics[0]!, patch);
      expect(eligibleVisualSubjects(r)).toHaveLength(0);
    }
    for (const label of ['Woman beside a vase', 'Person', 'Man with vase', 'Coffee drink', 'Blue jacket']) {
      const r = syntheticVisualReading(); r.subjects[0]!.label = label;
      expect(eligibleVisualSubjects(r)).toHaveLength(0);
    }
    const loaded = (await loadVisualCatalog(assets.file))!;
    expect(shortlistVisualCandidates(reading, loaded, 999)).toHaveLength(2);
    expect(shortlistVisualCandidates(reading, loaded, 0)).toHaveLength(0);
  });
  it('rejects wrong hashes/regions/types, weak/empty and unsupported identity claims', () => {
    const input = { sourceImage: Buffer.from('source'), candidateImage: Buffer.from('candidate'), sourceRegion: { x: 0, y: 0, w: 1, h: 1 }, subjectLabel: 'vase', candidateLabel: 'vase' };
    const result = suggestion(input);
    const candidate = { catalog_id: 'met:1', image_hash: result.candidateImageSha256, subject_id: 's1' as const, subject_label: 'vase', region: input.sourceRegion };
    const run = { source_hash: result.sourceImageSha256 };
    expect(acceptedVisualResult(result, run, candidate)).toBe(true);
    for (const patch of [{ sourceImageSha256: 'a'.repeat(64) }, { sameObjectType: false }, { similarity: 'weak' as const }, { matchedFeatures: [] },
      { matchedFeatures: ['same maker'] }, { sourceRegion: { ...input.sourceRegion, w: 0.5 } }, { schemaVersion: 'wrong-schema' }]) {
      expect(acceptedVisualResult({ ...result, ...patch }, run, candidate)).toBe(false);
    }
  });
  it('is off by default and unavailable providers/catalogs cannot trigger comparison work', async () => {
    const f = await fixture();
    f.parent.config = testConfig();
    await enqueueVisualReferences(f.parent, f.created.capture_id, f.analysisId);
    expect(f.compare).not.toHaveBeenCalled();
    expect(await loadVisualReferenceState({ ...f.service, config: testConfig() }, f.created.capture_id, f.analysisId))
      .toEqual({ status: 'unavailable', reason: 'not_configured', cards: [] });
    expect((await loadVisualReferenceState({ ...f.service, providers: testProviders() }, f.created.capture_id, f.analysisId)).reason).toBe('provider_unavailable');
  });
  it('queues at most one capture allocation, persists private evidence, keeps legacy fields and projects real external cards', async () => {
    const f = await fixture();
    await Promise.all([f.enqueue(), f.enqueue()]);
    const pending = await getCapture(f.service, { id: f.created.capture_id });
    expect(pending.discovery_intents?.default_intent).toBe('connections');
    expect(pending.discovery_intents?.visual.status).toBe('pending');
    const ctx = await f.worker();
    await visualReferenceDiscovery(ctx);
    await visualReferenceDiscovery(ctx); // same attempt cannot spend twice
    expect(f.compare).toHaveBeenCalledTimes(2);
    const response = await getCapture(f.service, { id: f.created.capture_id });
    expect(CaptureResponse.safeParse(response).success).toBe(true);
    expect(response.recommendations).toEqual([]);
    expect(response.discovery_intents?.visual.cards).toHaveLength(2);
    expect(response.discovery_intents?.connections.rails).toEqual(response.rails);
    const publicJson = JSON.stringify(response.discovery_intents);
    for (const privateValue of ['synthetic-test-profile', 'synthetic-test-model', 'sourceImageSha256', 'image_path', assets.dir, '"origin"', 'save', 'buy']) expect(publicJson).not.toContain(privateValue);
    const card = response.discovery_intents!.visual.cards[0]!;
    expect(card.source_url).toBe('https://www.metmuseum.org/art/collection/search/1');
    expect(card.image.url).toMatch(/^\/v1\/visual-references\/images\/[a-f0-9]{64}$/);
    expect(card.comparison).toBe('model_suggested');
    expect(card.limitations).toContain('not an identification');
    const audit = (await isolated.db.query('SELECT evidence,attempted_ids FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows[0]!;
    expect(audit.evidence).toHaveLength(2);
    expect(audit.evidence[0].result.profileVersion).toBe('synthetic-test-profile');
    await isolated.db.query(`UPDATE analyses SET compiler_version='compiler-2026-10-27-qloo-native-v6' WHERE id=$1`, [f.analysisId]);
    expect((await getCapture(f.service, { id: f.created.capture_id })).discovery_intents).toBeUndefined();
  });
  it.each(['empty', 'timeout', 'failure'] as const)('keeps %s outcomes honest with stable public reasons', async mode => {
    const f = await fixture(vi.fn(async input => {
      if (mode === 'timeout') throw Object.assign(new Error('secret profile/path provider detail'), { kind: 'timeout' });
      if (mode === 'failure') throw new Error('secret provider detail');
      return { ...suggestion(input), similarity: 'none', sameObjectType: false, matchedFeatures: [] };
    }));
    await f.enqueue(); await visualReferenceDiscovery(await f.worker());
    const output = await loadVisualReferenceState(f.service, f.created.capture_id, f.analysisId);
    expect(output.cards).toEqual([]);
    expect(output.status).toBe(mode === 'empty' ? 'empty' : 'failed');
    expect(output.reason).toBe(mode === 'empty' ? 'no_visual_matches' : mode === 'timeout' ? 'comparison_timeout' : 'comparison_failed');
    expect(JSON.stringify(output)).not.toContain('secret');
  });
  it.each(['owner', 'retraction', 'analysis', 'source', 'cancel', 'lease'] as const)('blocks late results after %s changes', async mode => {
    let mutate: () => Promise<void> = async () => {};
    const f = await fixture(vi.fn(async input => { await mutate(); return suggestion(input); }));
    await f.enqueue();
    const ctx = await f.worker();
    mutate = async () => {
      if (mode === 'owner') await isolated.db.query('UPDATE captures SET owner_account_id=$2 WHERE id=$1', [f.created.capture_id, (await insertAccount(isolated.db)).accountId]);
      if (mode === 'retraction') { f.reading.subjects[0]!.aesthetics[0]!.retracted = true; await isolated.db.query('UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1', [f.analysisId, JSON.stringify(f.reading)]); }
      if (mode === 'analysis') await isolated.db.query('UPDATE captures SET active_analysis_id=NULL WHERE id=$1', [f.created.capture_id]);
      if (mode === 'source') {
        const key = (await isolated.db.query<{ private_object_key: string }>('SELECT private_object_key FROM captures WHERE id=$1', [f.created.capture_id])).rows[0]!.private_object_key;
        await f.providers.storage.put(key, Buffer.from('replacement'), { contentType: 'image/jpeg' });
      }
      if (mode === 'cancel') await isolated.db.query('UPDATE jobs SET cancel_requested_at=now() WHERE id=$1', [ctx.job.id]);
      if (mode === 'lease') await isolated.db.query("UPDATE jobs SET lease_owner='new-worker' WHERE id=$1", [ctx.job.id]);
    };
    if (mode === 'cancel') await expect(visualReferenceDiscovery(ctx)).rejects.toBeInstanceOf(JobCancelledError);
    else await visualReferenceDiscovery(ctx);
    expect((await isolated.db.query('SELECT evidence FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows[0]!.evidence).toEqual([]);
    expect((await loadVisualReferenceState(f.service, f.created.capture_id, f.analysisId)).cards).toEqual([]);
    if (mode === 'owner') await expect(getCapture(f.service, { id: f.created.capture_id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('bounds global comparison concurrency to two across independent capture jobs', async () => {
    let inFlight = 0;
    let peak = 0;
    const compare = vi.fn(async (input: VisualSimilarityRequest) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 30));
      inFlight--; return suggestion(input);
    });
    const fixtures = await Promise.all(Array.from({ length: 3 }, () => fixture(compare)));
    for (const f of fixtures) await f.enqueue();
    const workers = await Promise.all(fixtures.map(f => f.worker()));
    await Promise.all(workers.map(w => visualReferenceDiscovery(w)));
    expect(peak).toBe(2);
    expect(compare.mock.calls.length).toBeLessThanOrEqual(6);
  });
  it('retains the per-capture allocation across reanalysis without additional comparison spend', async () => {
    const f = await fixture();
    await f.enqueue();
    const old = (await isolated.db.query('SELECT job_id FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows[0]!.job_id;
    const next = await ensureAnalysisRow(isolated.db, { captureId: f.created.capture_id, version: 2,
      compilerVersion: INTENT_COMPILER_VERSION, focus: { kind: 'whole' }, jobId: f.created.job_id });
    await isolated.db.query(`UPDATE analyses SET style_reading=$2::jsonb,section_statuses='{"style":"ready"}' WHERE id=$1`, [next.id, JSON.stringify(f.reading)]);
    await isolated.db.query('UPDATE captures SET active_analysis_id=$2 WHERE id=$1', [f.created.capture_id, next.id]);
    await enqueueVisualReferences(f.parent, f.created.capture_id, next.id);
    expect((await isolated.db.query('SELECT job_id FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows[0]!.job_id).toBe(old);
    expect((await loadVisualReferenceState(f.service, f.created.capture_id, next.id)).reason).toBe('comparison_limit');
    expect(f.compare).not.toHaveBeenCalled();
  });
  it('never allocates jobs for held subjects or an empty compatible catalog', async () => {
    const f = await fixture();
    f.reading.subjects[0]!.aesthetics[0]!.held = true;
    await isolated.db.query('UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1', [f.analysisId, JSON.stringify(f.reading)]);
    await f.enqueue();
    expect((await isolated.db.query('SELECT 1 FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows).toEqual([]);
    expect((await loadVisualReferenceState(f.service, f.created.capture_id, f.analysisId)).reason).toBe('no_supported_subject');
    const empty = await syntheticVisualCatalog(0);
    try {
      f.parent.config = { ...f.config, VISUAL_REFERENCE_CATALOG_FILE: empty.file };
      await f.enqueue();
      expect(f.compare).not.toHaveBeenCalled();
      expect((await isolated.db.query('SELECT 1 FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows).toEqual([]);
    } finally { await empty.cleanup(); }
  });
  it('deletion cancels late work and cascades all private evidence', async () => {
    let remove: () => Promise<void> = async () => {};
    const f = await fixture(vi.fn(async input => { await remove(); return suggestion(input); }));
    await f.enqueue(); const ctx = await f.worker();
    remove = () => deleteCapture(f.service, { id: f.created.capture_id });
    await expect(visualReferenceDiscovery(ctx)).rejects.toBeInstanceOf(JobCancelledError);
    expect((await isolated.db.query('SELECT 1 FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows).toEqual([]);
    await expect(getCapture(f.service, { id: f.created.capture_id })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.compare).toHaveBeenCalledTimes(1);
  });
  it('does not spend when the local catalog assets disappear', async () => {
    const local = await syntheticVisualCatalog();
    try {
      const f = await fixture();
      f.parent.config = { ...f.config, VISUAL_REFERENCE_CATALOG_FILE: local.file };
      await f.enqueue();
      await local.cleanup();
      const ctx = await f.worker(); ctx.config = f.parent.config;
      await visualReferenceDiscovery(ctx);
      expect(f.compare).not.toHaveBeenCalled();
      expect((await isolated.db.query('SELECT status,reason FROM visual_reference_runs WHERE capture_id=$1', [f.created.capture_id])).rows[0])
        .toMatchObject({ status: 'unavailable', reason: 'catalog_unavailable' });
    } finally { await local.cleanup(); }
  });
});
