import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CATALOG_SNAPSHOT_FILE, type ModelProfile } from '../../packages/providers/src/index';
import { fetchGoldenPhotos, verifiedGoldenPhotos } from './golden-photos';
import { loadGoldenSet, loadThresholds } from './labels';
import * as grounding from '../../packages/domain/src/compiler/grounding';
import { runLiveEval } from './live';
import { runtimeGuardedPipeline, runtimeGuardedPipelineWithoutVerifier, unguardedPipeline } from './pipeline';
import { loadReplayFixtures, runReplay } from './replay';
import { syntheticGolden, versionedTestPipeline } from './test-golden';

/**
 * Offline tests of the live evaluation and photo fetch rails (fake fetch only;
 * synthetic solid-colour photos). They prove the safety rails, not model quality.
 */
const KEY = 'synthetic-operator-key-never-written';
const root = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tmp(prefix: string) {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const base: Omit<ModelProfile, 'role'> = {
  gateway: 'concentrate',
  version: 'p-1',
  model: 'fixture/vision-1',
  provider: 'fixture',
  allowedFallbackProviders: [],
  maxOutputTokens: 600,
  reasoningEffort: 'none',
  maxInputTokens: 200_000,
  maxInputBytes: 200_000,
  image: { maxBytes: 80_000, maxPixels: 300_000, maxDimension: 512, maxCount: 1 },
  timeoutMs: 10_000,
  structuredOutput: true,
  requireZdr: true,
  providerZdrEligible: true,
  contentLoggingEnabled: false,
  privacyVerifiedAt: '2026-10-15T00:00:00Z',
  promptVersion: 'vlm-quick-v1',
  schemaVersion: 'atlas_quick_read_v1',
  catalogSnapshotAt: '2026-10-16T12:00:00.000Z',
  qualificationArtifactId: 'eval-live-test',
  pricingSnapshotVersion: 'price-1',
  reservationMicros: 20_000,
};
const quickProfile = { ...base, role: 'vision_photo' } as ModelProfile;
const enrichProfile = {
  ...base,
  role: 'vision_photo_enrich',
  promptVersion: 'vlm-enrich-v1',
  schemaVersion: 'atlas_enrichment_v1',
  maxOutputTokens: 1200,
  timeoutMs: 20_000,
  image: { maxBytes: 150_000, maxPixels: 589_824, maxDimension: 768, maxCount: 1 },
} as ModelProfile;

async function outDir() {
  const d = await tmp('ca-live-out-');
  await writeFile(
    path.join(d, CATALOG_SNAPSHOT_FILE),
    JSON.stringify({ kind: 'concentrate-catalog-snapshot', fetched_at: base.catalogSnapshotAt, pages: 1, models: [{ id: 'fixture/vision-1', providers: { fixture: {} } }] }),
  );
  return d;
}

/** Answers in the reading shape the request's schema name asks for (v1 or v2). */
function readings(status = 200) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    if (status !== 200) return new Response('{"error":{"message":"PRIVATE"}}', { status });
    const body = JSON.parse(init.body as string);
    const name: string = body.text.format.name;
    const v2 = name.endsWith('_v2');
    const candidate = v2
      ? { name: 'Mid-century modern', type: 'style', relation: 'resembles', certainty: 0.7, domain: 'interior', evidence: 'distinctive_form', evidence_text: null, tag_query: 'mid-century modern' }
      : { name: 'Mid-century modern', type: 'style', relation: 'resembles', certainty: 0.7, categories: [], tag_query: 'mid-century modern' };
    const quick = { title: 'A sunroom', interpretation: 'A room that resembles mid-century design.', candidates: [candidate], quality: { usable: true, issue: null } };
    const enrichment = {
      observations: [{ text: 'Tapered legs', kind: 'object' }],
      visible_text: [],
      ...(v2 ? { illegible_text_present: false } : {}),
      confirmed: [v2 ? { name: 'Mid-century modern', rationale: 'Tapered legs', verdict: 'supported' } : { name: 'Mid-century modern', rationale: 'Tapered legs', keep: true }],
      additional_candidates: [],
      regions: [],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
    };
    const text = JSON.stringify(name.includes('enrich') ? enrichment : quick);
    return new Response(
      JSON.stringify({ id: 'resp', model: 'fixture/vision-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1000, output_tokens: 100 } }),
    );
  });
}

async function setup(ids = ['p01', 'p02', 'h01']) {
  const g = await syntheticGolden(ids);
  const golden = await loadGoldenSet(g.dir);
  const { thresholds } = await loadThresholds(path.join(root, 'fixtures/eval/thresholds.json'));
  return { g, golden, thresholds };
}

describe('golden photos outside git', () => {
  it('verifies every photo against its pinned sha256 before use', async () => {
    const { g, golden } = await setup();
    expect((await verifiedGoldenPhotos(golden, g.photosDir)).map((p) => p.photo.id)).toEqual(['p01', 'p02', 'h01']);
    expect((await verifiedGoldenPhotos(golden, g.photosDir, 'holdout')).map((p) => p.photo.id)).toEqual(['h01']);
    await writeFile(path.join(g.photosDir, 'p02.jpg'), 'tampered');
    await expect(verifiedGoldenPhotos(golden, g.photosDir)).rejects.toThrow('p02: sha256 differs');
    await rm(path.join(g.photosDir, 'p01.jpg'));
    await expect(verifiedGoldenPhotos(golden, g.photosDir)).rejects.toThrow('p01: missing');
  });

  it('eval:fetch keeps good files, downloads pinned URLs, refuses a wrong hash and reports withheld sources', async () => {
    const { g, golden } = await setup();
    const p02 = await readFile(path.join(g.photosDir, 'p02.jpg'));
    const dest = await tmp('ca-fetch-');
    await writeFile(path.join(dest, 'p01.jpg'), await readFile(path.join(g.photosDir, 'p01.jpg')));
    golden.manifest.photos[2]!.source = { ...golden.manifest.photos[2]!.source, path: null, raw_url: null, withheld: 'name in path' };
    const fetchImpl = vi.fn(async (url: string) => (url.endsWith('/p02.jpg') ? new Response(p02) : new Response('x')));
    const report = await fetchGoldenPhotos({ golden, dest, fetch: fetchImpl as unknown as typeof fetch });
    expect(report).toEqual({ fetched: ['p02'], present: ['p01'], withheld: ['h01'], failed: [] });
    expect((await stat(path.join(dest, 'p02.jpg'))).mode & 0o077).toBe(0);
    // A file whose bytes do not match the manifest is never written.
    const dest2 = await tmp('ca-fetch-');
    const wrong = vi.fn(async () => new Response('not the photo'));
    const bad = await fetchGoldenPhotos({ golden, dest: dest2, fetch: wrong as unknown as typeof fetch });
    expect(bad.failed).toEqual(['p01', 'p02']);
    expect(await readdir(dest2)).toEqual([]);
  });
});

describe('eval:live (offline rails)', () => {
  it('is a dry run by default, refuses an out-dir inside the repository, and checks caps before sending', async () => {
    const { g, golden, thresholds } = await setup();
    const fetchImpl = readings();
    const common = {
      golden,
      photosDir: g.photosDir,
      split: 'all' as const,
      profiles: { vision_photo: quickProfile, vision_photo_enrich: enrichProfile },
      roles: ['vision_photo', 'vision_photo_enrich'] as const,
      repoRoot: root,
      maxRequests: 6,
      spendCapMicros: 500_000,
      pipeline: versionedTestPipeline,
      thresholds,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    const out = await outDir();
    await expect(runLiveEval({ ...common, outDir: out, confirmPaidRequests: false })).resolves.toEqual({ dryRun: true, plannedRequests: 6, plannedQlooMax: 0 });
    await expect(runLiveEval({ ...common, outDir: out, only: ['h01'], confirmPaidRequests: false })).resolves.toMatchObject({ plannedRequests: 2 });
    await expect(runLiveEval({ ...common, outDir: out, only: ['p99'], confirmPaidRequests: false })).rejects.toThrow('Unknown photo id');
    await expect(runLiveEval({ ...common, outDir: path.join(root, 'tmp-eval-out'), confirmPaidRequests: false })).rejects.toThrow('outside the repository');
    await expect(runLiveEval({ ...common, outDir: out, maxRequests: 5, confirmPaidRequests: true, apiKey: KEY })).rejects.toThrow('--max-requests');
    await expect(runLiveEval({ ...common, outDir: out, spendCapMicros: 1000, confirmPaidRequests: true, apiKey: KEY })).rejects.toThrow('spend-cap');
    await expect(runLiveEval({ ...common, outDir: out, pipeline: unguardedPipeline, confirmPaidRequests: false })).rejects.toThrow('guarded pipeline');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a confirmed run logs every call, writes raw outputs and the scorecard only to the out-dir, and re-scores offline', async () => {
    const { g, golden, thresholds } = await setup();
    const fetchImpl = readings();
    const out = await outDir();
    const ledgerFile = path.join(out, 'ledger.jsonl');
    const result = await runLiveEval({
      golden,
      photosDir: g.photosDir,
      split: 'all',
      profiles: { vision_photo: quickProfile, vision_photo_enrich: enrichProfile },
      roles: ['vision_photo', 'vision_photo_enrich'],
      outDir: out,
      repoRoot: root,
      maxRequests: 6,
      spendCapMicros: 500_000,
      confirmPaidRequests: true,
      apiKey: KEY,
      pipeline: versionedTestPipeline,
      thresholds,
      fetch: fetchImpl as unknown as typeof fetch,
      ledgerFile,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(result.requestsSent).toBe(6);
    expect(result.stoppedBy).toBeUndefined();
    expect(Object.keys(result.scorecard!.splits).sort()).toEqual(['holdout', 'tune']);
    expect(result.scorecard!.splits.tune!.metrics.M3).toBe(1);
    const ledger = (await readFile(ledgerFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(6);
    expect(ledger[0]).toMatchObject({ package: 'eval', provider: 'concentrate', endpoint: '/v1/responses', status: 200 });
    const written = JSON.stringify([await readFile(path.join(out, 'scorecard.json'), 'utf8'), await readFile(ledgerFile, 'utf8')]);
    expect(written).not.toContain(KEY);
    const replay = await loadReplayFixtures(path.join(out, 'recordings'));
    expect(replay.recordings.map((r) => r.photoId).sort()).toEqual(['h01', 'p01', 'p02']);
    expect(replay.recordings.every((r) => r.enrichment !== undefined)).toBe(true);
  });

  it('with --qloo, records what grounding sent and accepted per candidate in grounding.json, and logs each Qloo call', async () => {
    const { g, golden, thresholds } = await setup(['p01']);
    const out = await outDir();
    const ledgerFile = path.join(out, 'ledger.jsonl');
    const qlooFetch = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe('/v2/tags');
      return new Response(
        JSON.stringify({
          success: true,
          results: { tags: [{ id: 'urn:tag:style:qloo:fixture_mcm', name: 'Mid-century modern', type: 'urn:tag:style:qloo' }] },
        }),
      );
    });
    const result = await runLiveEval({
      golden,
      photosDir: g.photosDir,
      split: 'all',
      profiles: { vision_photo: quickProfile, vision_photo_enrich: enrichProfile },
      roles: ['vision_photo', 'vision_photo_enrich'],
      outDir: out,
      repoRoot: root,
      maxRequests: 2,
      spendCapMicros: 500_000,
      confirmPaidRequests: true,
      apiKey: KEY,
      pipeline: versionedTestPipeline,
      thresholds,
      fetch: readings() as unknown as typeof fetch,
      ledgerFile,
      sleep: async () => undefined,
      qloo: { apiKey: 'synthetic-qloo-key', baseUrl: 'https://qloo.invalid', maxRequests: 2, spacingMs: 700, grounding, fetch: qlooFetch as unknown as typeof fetch },
    });
    expect(result.qlooSent).toBe(1);
    const records = JSON.parse(await readFile(path.join(out, 'grounding.json'), 'utf8'));
    expect(records).toEqual([
      {
        photo: 'p01',
        records: [
          expect.objectContaining({
            candidate: 'Mid-century modern',
            accepted: true,
            plan: 'tags',
            tagFamily: 'style',
            matchedName: 'Mid-century modern',
            matchedId: 'urn:tag:style:qloo:fixture_mcm',
          }),
        ],
      },
    ]);
    const ledger = (await readFile(ledgerFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(ledger.filter((l) => l.provider === 'qloo')).toEqual([expect.objectContaining({ endpoint: '/v2/tags', status: 200 })]);
    expect(await readFile(path.join(out, 'grounding.json'), 'utf8')).not.toContain('synthetic-qloo-key');
    // The grounding gate of thresholds.json is applied, not left to be read by eye: one lookup is
    // below the sample-size gates and nothing was judged by hand, so the run does not pass.
    expect(result.grounding).toMatchObject({ pass: false, metrics: { lookups: 1, accepted: 1, forbidden_accepts: 0, grounding_precision: null } });
    expect(result.grounding!.gates.find((g) => g.metric === 'labelled_candidates')).toMatchObject({ value: 1, pass: false });
    expect(JSON.parse(await readFile(path.join(out, 'scorecard.json'), 'utf8')).grounding_gate).toMatchObject({ pass: false });
  });

  it('with vision_verify, checks the compiler\'s verifier targets after stage 2 and re-scores with and without the verifier', async () => {
    const { g, golden, thresholds } = await setup(['p01']);
    const quickV2 = { ...quickProfile, promptVersion: 'vlm-quick-v2', schemaVersion: 'atlas_quick_read_v2' } as ModelProfile;
    const enrichV2 = { ...enrichProfile, promptVersion: 'vlm-enrich-v2', schemaVersion: 'atlas_enrichment_v2', maxOutputTokens: 1600 } as ModelProfile;
    const verifyP = { ...enrichProfile, role: 'vision_verify', promptVersion: 'vlm-verify-v1', schemaVersion: 'atlas_verify_v1', maxOutputTokens: 600 } as ModelProfile;
    // FIXTURE replies: stage 2 hedges the style (weak), so it is a verifier target; the verifier answers "no".
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const name: string = JSON.parse(init.body as string).text.format.name;
      const body =
        name === 'atlas_verify_v1'
          ? { checks: [{ name: 'Fixture lustreware', answer: 'no', reason: 'The label names another origin' }] }
          : name.includes('enrich')
            ? {
                observations: [],
                visible_text: [],
                illegible_text_present: false,
                confirmed: [{ name: 'Fixture lustreware', rationale: 'Could be several glazes', verdict: 'weak' }],
                additional_candidates: [],
                regions: [],
                uncertainty: { overall: 'medium', notes: [] },
                competing_subjects: [],
              }
            : {
                title: 'Glazed bowls',
                interpretation: 'Bowls that resemble a lustre glaze.',
                candidates: [{ name: 'Fixture lustreware', type: 'style', relation: 'resembles', certainty: 0.6, domain: 'craft', evidence: 'distinctive_form', evidence_text: null, tag_query: 'lustreware' }],
                quality: { usable: true, issue: null },
              };
      return new Response(
        JSON.stringify({ id: 'resp', model: 'fixture/vision-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] }], usage: { input_tokens: 1000, output_tokens: 100 } }),
      );
    });
    const out = await outDir();
    const common = {
      golden,
      photosDir: g.photosDir,
      split: 'all' as const,
      profiles: { vision_photo: quickV2, vision_photo_enrich: enrichV2, vision_verify: verifyP },
      roles: ['vision_photo', 'vision_photo_enrich', 'vision_verify'] as const,
      outDir: out,
      repoRoot: root,
      spendCapMicros: 500_000,
      pipeline: runtimeGuardedPipeline,
      thresholds,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    // The plan reserves the verifier for every photo; it needs both stages.
    await expect(runLiveEval({ ...common, maxRequests: 3, confirmPaidRequests: false })).resolves.toMatchObject({ plannedRequests: 3 });
    await expect(
      runLiveEval({ ...common, roles: ['vision_photo', 'vision_verify'], maxRequests: 3, confirmPaidRequests: false }),
    ).rejects.toThrow('both photo stages');
    const result = await runLiveEval({ ...common, maxRequests: 3, confirmPaidRequests: true, apiKey: KEY });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sent = JSON.parse(fetchImpl.mock.calls[2]![1].body as string) as { text: { format: { name: string } }; input: { content: { type: string; text?: string }[] }[] };
    expect(sent.text.format.name).toBe('atlas_verify_v1');
    expect(sent.input[0]!.content.find((c) => c.type === 'input_text')!.text).toContain('Fixture lustreware');
    expect(result.scorecard!.splits.tune!.metrics).toMatchObject({ verifier_checked: 1, published: 1 });
    // The recording keeps the verifier reply, so the same readings re-score with and without it, offline.
    const { recordings } = await loadReplayFixtures(path.join(out, 'recordings'));
    expect(recordings[0]!.verification).toEqual({ checks: [{ name: 'Fixture lustreware', answer: 'no', reason: 'The label names another origin' }] });
    const withV = runReplay(golden, recordings, runtimeGuardedPipeline, thresholds, 'live');
    const without = runReplay(golden, recordings, runtimeGuardedPipelineWithoutVerifier, thresholds, 'live');
    expect(withV.runs[0]!.final.candidates.map((c) => [c.name, c.verifier, c.certainty])).toEqual([['Fixture lustreware', 'no', 0.3]]);
    expect(without.runs[0]!.final.candidates.map((c) => [c.name, c.verifier ?? null, c.certainty])).toEqual([['Fixture lustreware', null, 0.6]]);
    // Nothing is ever removed by the verifier.
    expect(withV.scorecard.splits.tune!.metrics.published).toBe(without.scorecard.splits.tune!.metrics.published);
  });

  it('stops at the first 429 without retrying and counts the failure against M13', async () => {
    const { g, golden, thresholds } = await setup();
    const fetchImpl = readings(429);
    const logs: string[] = [];
    const result = await runLiveEval({
      log: (l) => logs.push(l),
      golden,
      photosDir: g.photosDir,
      split: 'all',
      profiles: { vision_photo: quickProfile },
      roles: ['vision_photo'],
      outDir: await outDir(),
      repoRoot: root,
      maxRequests: 3,
      spendCapMicros: 500_000,
      confirmPaidRequests: true,
      apiKey: KEY,
      pipeline: versionedTestPipeline,
      thresholds,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(logs.slice(1)).toEqual(['p01 quick: rate_limited 429']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.stoppedBy).toBe('http_429');
    expect(result.scorecard!.splits.tune!.metrics.M13).toBe(0);
    expect(result.scorecard!.pass).toBe(false);
  });
});
