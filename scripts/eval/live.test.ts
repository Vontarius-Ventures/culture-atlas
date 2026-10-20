import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CATALOG_SNAPSHOT_FILE, type ModelProfile } from '../../packages/providers/src/index';
import { fetchGoldenPhotos, verifiedGoldenPhotos } from './golden-photos';
import { loadGoldenSet, loadThresholds } from './labels';
import * as grounding from '../../packages/domain/src/compiler/grounding';
import { listRate, PRODUCTION_RETRY_POLICY, runLiveEval } from './live';
import {
  runtimeGuardedPipeline,
  runtimeGuardedPipelineWithoutVerifier,
  unguardedPipeline,
} from './pipeline';
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
    JSON.stringify({
      kind: 'concentrate-catalog-snapshot',
      fetched_at: base.catalogSnapshotAt,
      pages: 1,
      models: [{ id: 'fixture/vision-1', providers: { fixture: {} } }],
    }),
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
      ? {
          name: 'Mid-century modern',
          type: 'style',
          relation: 'resembles',
          certainty: 0.7,
          domain: 'interior',
          evidence: 'distinctive_form',
          evidence_text: null,
          tag_query: 'mid-century modern',
        }
      : {
          name: 'Mid-century modern',
          type: 'style',
          relation: 'resembles',
          certainty: 0.7,
          categories: [],
          tag_query: 'mid-century modern',
        };
    const quick = {
      title: 'A sunroom',
      interpretation: 'A room that resembles mid-century design.',
      candidates: [candidate],
      quality: { usable: true, issue: null },
    };
    const enrichment = {
      observations: [{ text: 'Tapered legs', kind: 'object' }],
      visible_text: [],
      ...(v2 ? { illegible_text_present: false } : {}),
      confirmed: [
        v2
          ? { name: 'Mid-century modern', rationale: 'Tapered legs', verdict: 'supported' }
          : { name: 'Mid-century modern', rationale: 'Tapered legs', keep: true },
      ],
      additional_candidates: [],
      regions: [],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
    };
    const text = JSON.stringify(name.includes('enrich') ? enrichment : quick);
    return new Response(
      JSON.stringify({
        id: 'resp',
        model: 'fixture/vision-1',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
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
    expect((await verifiedGoldenPhotos(golden, g.photosDir)).map((p) => p.photo.id)).toEqual([
      'p01',
      'p02',
      'h01',
    ]);
    expect(
      (await verifiedGoldenPhotos(golden, g.photosDir, 'holdout')).map((p) => p.photo.id),
    ).toEqual(['h01']);
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
    golden.manifest.photos[2]!.source = {
      ...golden.manifest.photos[2]!.source,
      path: null,
      raw_url: null,
      withheld: 'name in path',
    };
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/p02.jpg') ? new Response(p02) : new Response('x'),
    );
    const report = await fetchGoldenPhotos({
      golden,
      dest,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(report).toEqual({ fetched: ['p02'], present: ['p01'], withheld: ['h01'], failed: [] });
    expect((await stat(path.join(dest, 'p02.jpg'))).mode & 0o077).toBe(0);
    // A file whose bytes do not match the manifest is never written.
    const dest2 = await tmp('ca-fetch-');
    const wrong = vi.fn(async () => new Response('not the photo'));
    const bad = await fetchGoldenPhotos({
      golden,
      dest: dest2,
      fetch: wrong as unknown as typeof fetch,
    });
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
    await expect(
      runLiveEval({ ...common, outDir: out, confirmPaidRequests: false }),
    ).resolves.toEqual({ dryRun: true, plannedRequests: 6, plannedQlooMax: 0 });
    await expect(
      runLiveEval({ ...common, outDir: out, only: ['h01'], confirmPaidRequests: false }),
    ).resolves.toMatchObject({ plannedRequests: 2 });
    await expect(
      runLiveEval({ ...common, outDir: out, only: ['p99'], confirmPaidRequests: false }),
    ).rejects.toThrow('Unknown photo id');
    await expect(
      runLiveEval({
        ...common,
        outDir: path.join(root, 'tmp-eval-out'),
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow('outside the repository');
    await expect(
      runLiveEval({
        ...common,
        outDir: out,
        maxRequests: 5,
        confirmPaidRequests: true,
        apiKey: KEY,
      }),
    ).rejects.toThrow('--max-requests');
    await expect(
      runLiveEval({
        ...common,
        outDir: out,
        spendCapMicros: 1000,
        confirmPaidRequests: true,
        apiKey: KEY,
      }),
    ).rejects.toThrow('spend-cap');
    await expect(
      runLiveEval({
        ...common,
        outDir: out,
        pipeline: unguardedPipeline,
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow('guarded pipeline');
    // Round 4: a reading-v2 photo profile naming a prompt the code no longer sends is refused before anything is planned.
    const staleQuick = {
      ...quickProfile,
      promptVersion: 'vlm-quick-v2',
      schemaVersion: 'atlas_quick_read_v2',
    } as ModelProfile;
    const staleEnrich = {
      ...enrichProfile,
      promptVersion: 'vlm-enrich-v3',
      schemaVersion: 'atlas_enrichment_v2',
    } as ModelProfile;
    await expect(
      runLiveEval({
        ...common,
        outDir: out,
        profiles: { vision_photo: staleQuick, vision_photo_enrich: enrichProfile },
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow(
      'names promptVersion vlm-quick-v2; schema atlas_quick_read_v2 is sent with vlm-quick-v4',
    );
    await expect(
      runLiveEval({
        ...common,
        outDir: out,
        profiles: {
          vision_photo: { ...staleQuick, promptVersion: 'vlm-quick-v4' },
          vision_photo_enrich: staleEnrich,
        },
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow('sent with vlm-enrich-v8');
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
    const ledger = (await readFile(ledgerFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(6);
    expect(ledger[0]).toMatchObject({
      package: 'eval',
      provider: 'concentrate',
      endpoint: '/v1/responses',
      status: 200,
    });
    const written = JSON.stringify([
      await readFile(path.join(out, 'scorecard.json'), 'utf8'),
      await readFile(ledgerFile, 'utf8'),
    ]);
    expect(written).not.toContain(KEY);
    const replay = await loadReplayFixtures(path.join(out, 'recordings'));
    expect(replay.recordings.map((r) => r.photoId).sort()).toEqual(['h01', 'p01', 'p02']);
    expect(replay.recordings.every((r) => r.enrichment !== undefined)).toBe(true);
    // Plan G (round 4): the tokens each stage used; the fixture catalog lists no price, so the cost is unknown.
    expect(result.usage!.quick).toEqual({
      calls: 3,
      inputTokens: 3000,
      outputTokens: 300,
      unknownUsage: 0,
      costMicros: null,
    });
    expect(result.usage!.enrich).toMatchObject({ calls: 3, inputTokens: 3000, outputTokens: 300 });
    expect(JSON.parse(await readFile(path.join(out, 'usage.json'), 'utf8'))).toMatchObject({
      total_cost_micros: null,
    });
  });

  it('prices a run at the catalog snapshot list rate of its route (plan G)', () => {
    const snapshot = {
      kind: 'concentrate-catalog-snapshot' as const,
      fetched_at: base.catalogSnapshotAt,
      pages: 1,
      models: [
        {
          id: 'vision-1',
          providers: {
            fixture: {
              pricing: [
                {
                  condition: { input_gte: 100001 },
                  tokens: {
                    input: { price: { USD: 9 }, units: 1_000_000 },
                    output: { price: { USD: 9 }, units: 1_000_000 },
                  },
                },
                {
                  tokens: {
                    input: { price: { USD: 1 }, units: 1_000_000 },
                    output: { price: { USD: 5 }, units: 1_000_000 },
                  },
                },
              ],
            },
          },
        },
      ],
    };
    expect(listRate({ model: 'fixture/vision-1', provider: 'fixture' }, snapshot)).toEqual({
      input: 1,
      output: 5,
    });
    expect(listRate({ model: 'fixture/vision-2', provider: 'fixture' }, snapshot)).toBeNull();
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
          results: {
            tags: [
              {
                id: 'urn:tag:style:qloo:fixture_mcm',
                name: 'Mid-century modern',
                type: 'urn:tag:style:qloo',
              },
            ],
          },
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
      qloo: {
        apiKey: 'synthetic-qloo-key',
        baseUrl: 'https://qloo.invalid',
        maxRequests: 2,
        spacingMs: 700,
        grounding,
        fetch: qlooFetch as unknown as typeof fetch,
      },
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
    const ledger = (await readFile(ledgerFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledger.filter((l) => l.provider === 'qloo')).toEqual([
      expect.objectContaining({ endpoint: '/v2/tags', status: 200 }),
    ]);
    expect(await readFile(path.join(out, 'grounding.json'), 'utf8')).not.toContain(
      'synthetic-qloo-key',
    );
    // The grounding gate of thresholds.json is applied, not left to be read by eye: one lookup is
    // below the sample-size gates and nothing was judged by hand, so the run does not pass.
    expect(result.grounding).toMatchObject({
      pass: false,
      metrics: { lookups: 1, accepted: 1, forbidden_accepts: 0, grounding_precision: null },
    });
    expect(result.grounding!.gates.find((g) => g.metric === 'labelled_candidates')).toMatchObject({
      value: 1,
      pass: false,
    });
    expect(
      JSON.parse(await readFile(path.join(out, 'scorecard.json'), 'utf8')).grounding_gate,
    ).toMatchObject({ pass: false });
  });

  it('with vision_verify, checks the first section before stage 2 and the stage-2 claims after it (binding), and re-scores with and without it', async () => {
    const { g, golden, thresholds } = await setup(['p01']);
    const quickV2 = {
      ...quickProfile,
      promptVersion: 'vlm-quick-v4',
      schemaVersion: 'atlas_quick_read_v2',
    } as ModelProfile;
    const enrichV2 = {
      ...enrichProfile,
      promptVersion: 'vlm-enrich-v8',
      schemaVersion: 'atlas_enrichment_v2',
      maxOutputTokens: 1600,
    } as ModelProfile;
    const verifyP = {
      ...enrichProfile,
      role: 'vision_verify',
      promptVersion: 'vlm-verify-v3',
      schemaVersion: 'atlas_verify_v1',
      maxOutputTokens: 600,
    } as ModelProfile;
    // FIXTURE replies: the stage-1 style is a target and the verifier answers "no", so it never publishes
    // and is not sent to stage 2; stage 2 adds a style, which the second check answers "yes".
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string) as {
        text: { format: { name: string } };
        input: { content: { type: string; text?: string }[] }[];
      };
      const name = request.text.format.name;
      const userText = request.input[0]!.content.find((c) => c.type === 'input_text')?.text ?? '';
      const body =
        name === 'atlas_verify_v1'
          ? userText.includes('Fixture celadon')
            ? {
                checks: [
                  { name: 'Fixture celadon', answer: 'yes', reason: 'Pale green crackled glaze' },
                ],
              }
            : {
                checks: [
                  {
                    name: 'Fixture lustreware',
                    answer: 'no',
                    reason: 'The label names another origin',
                  },
                ],
              }
          : name.includes('enrich')
            ? {
                observations: [],
                visible_text: [],
                illegible_text_present: false,
                confirmed: [],
                additional_candidates: [
                  {
                    name: 'Fixture celadon',
                    type: 'style',
                    relation: 'resembles',
                    certainty: 0.7,
                    domain: 'craft',
                    evidence: 'distinctive_form',
                    evidence_text: null,
                    tag_query: 'celadon',
                    rationale: 'Green glaze',
                  },
                ],
                regions: [],
                uncertainty: { overall: 'medium', notes: [] },
                competing_subjects: [],
              }
            : {
                title: 'Glazed bowls',
                interpretation: 'Bowls that resemble a lustre glaze.',
                candidates: [
                  {
                    name: 'Fixture lustreware',
                    type: 'style',
                    relation: 'resembles',
                    certainty: 0.6,
                    domain: 'craft',
                    evidence: 'distinctive_form',
                    evidence_text: null,
                    tag_query: 'lustreware',
                  },
                ],
                quality: { usable: true, issue: null },
              };
      return new Response(
        JSON.stringify({
          id: 'resp',
          model: 'fixture/vision-1',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] },
          ],
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
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
    // The plan reserves both verifier checks for every photo; it needs both stages.
    await expect(
      runLiveEval({ ...common, maxRequests: 4, confirmPaidRequests: false }),
    ).resolves.toMatchObject({ plannedRequests: 4 });
    await expect(
      runLiveEval({
        ...common,
        roles: ['vision_photo', 'vision_verify'],
        maxRequests: 4,
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow('both photo stages');
    const result = await runLiveEval({
      ...common,
      maxRequests: 4,
      confirmPaidRequests: true,
      apiKey: KEY,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    type Sent = {
      text: { format: { name: string } };
      input: { content: { type: string; text?: string }[] }[];
    };
    const sent = fetchImpl.mock.calls.map((c) => JSON.parse(c[1].body as string) as Sent);
    const text = (s: Sent) => s.input[0]!.content.find((c) => c.type === 'input_text')!.text!;
    // Order: quick read, stage-1 check, enrichment, stage-2 check.
    expect(sent.map((s) => s.text.format.name)).toEqual([
      quickV2.schemaVersion,
      'atlas_verify_v1',
      enrichV2.schemaVersion,
      'atlas_verify_v1',
    ]);
    expect(text(sent[1]!)).toContain('Fixture lustreware');
    // The blocked claim is not sent to stage 2 as published.
    expect(text(sent[2]!)).not.toContain('Fixture lustreware');
    expect(text(sent[3]!)).toContain('Fixture celadon');
    expect(text(sent[3]!)).not.toContain('Fixture lustreware');
    expect(result.scorecard!.splits.tune!.metrics).toMatchObject({
      verifier_checked: 1,
      verifier_blocked: 1,
      published: 1,
    });
    // The recording keeps both replies, so the same readings re-score with and without the verifier, offline.
    const { recordings } = await loadReplayFixtures(path.join(out, 'recordings'));
    expect(recordings[0]!.verification1).toEqual({
      checks: [
        { name: 'Fixture lustreware', answer: 'no', reason: 'The label names another origin' },
      ],
    });
    expect(recordings[0]!.verification2).toEqual({
      checks: [{ name: 'Fixture celadon', answer: 'yes', reason: 'Pale green crackled glaze' }],
    });
    const withV = runReplay(golden, recordings, runtimeGuardedPipeline, thresholds, 'live');
    const without = runReplay(
      golden,
      recordings,
      runtimeGuardedPipelineWithoutVerifier,
      thresholds,
      'live',
    );
    expect(withV.runs[0]!.final.candidates.map((c) => [c.name, c.verifier, c.certainty])).toEqual([
      ['Fixture celadon', 'yes', 0.7],
    ]);
    expect(withV.runs[0]!.stage1Published).toEqual([]);
    expect(without.runs[0]!.final.candidates.map((c) => [c.name, c.verifier ?? null])).toEqual([
      ['Fixture lustreware', null],
      ['Fixture celadon', null],
    ]);
    expect(
      withV.decisions['p01/LIVE-p01']!.filter((d) => d.rules.includes('G-VERIFY')).map((d) => [
        d.name,
        d.action,
        d.note,
      ]),
    ).toEqual([
      ['Fixture lustreware', 'observe', 'verifier_no'],
      ['Fixture celadon', 'publish', 'verifier_yes'],
    ]);
  });

  it('with vision_verify, a failed check blocks its claims (fail closed) and is recorded as null', async () => {
    const { g, golden, thresholds } = await setup(['p01']);
    const quickV2 = {
      ...quickProfile,
      promptVersion: 'vlm-quick-v4',
      schemaVersion: 'atlas_quick_read_v2',
    } as ModelProfile;
    const enrichV2 = {
      ...enrichProfile,
      promptVersion: 'vlm-enrich-v8',
      schemaVersion: 'atlas_enrichment_v2',
      maxOutputTokens: 1600,
    } as ModelProfile;
    const verifyP = {
      ...enrichProfile,
      role: 'vision_verify',
      promptVersion: 'vlm-verify-v3',
      schemaVersion: 'atlas_verify_v1',
      maxOutputTokens: 600,
    } as ModelProfile;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const name: string = JSON.parse(init.body as string).text.format.name;
      if (name === 'atlas_verify_v1') return new Response('{"error":"upstream"}', { status: 500 });
      const body = name.includes('enrich')
        ? {
            observations: [],
            visible_text: [],
            illegible_text_present: false,
            confirmed: [],
            additional_candidates: [],
            regions: [],
            uncertainty: { overall: 'medium', notes: [] },
            competing_subjects: [],
          }
        : {
            title: 'Glazed bowls',
            interpretation: 'Bowls that resemble a lustre glaze.',
            candidates: [
              {
                name: 'Fixture lustreware',
                type: 'style',
                relation: 'resembles',
                certainty: 0.6,
                domain: 'craft',
                evidence: 'distinctive_form',
                evidence_text: null,
                tag_query: 'lustreware',
              },
            ],
            quality: { usable: true, issue: null },
          };
      return new Response(
        JSON.stringify({
          id: 'resp',
          model: 'fixture/vision-1',
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(body) }] },
          ],
          usage: { input_tokens: 1000, output_tokens: 100 },
        }),
      );
    });
    const out = await outDir();
    const result = await runLiveEval({
      golden,
      photosDir: g.photosDir,
      split: 'all',
      profiles: { vision_photo: quickV2, vision_photo_enrich: enrichV2, vision_verify: verifyP },
      roles: ['vision_photo', 'vision_photo_enrich', 'vision_verify'],
      outDir: out,
      repoRoot: root,
      maxRequests: 4,
      spendCapMicros: 500_000,
      confirmPaidRequests: true,
      apiKey: KEY,
      pipeline: runtimeGuardedPipeline,
      thresholds,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const { recordings } = await loadReplayFixtures(path.join(out, 'recordings'));
    expect(recordings[0]!.verification1).toBeNull();
    expect(result.scorecard!.splits.tune!.metrics).toMatchObject({
      published: 0,
      verifier_blocked: 1,
    });
    expect(result.scorecard!.splits.tune!.metrics.M13).toBeLessThan(1);
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

  // Round 4 (docs/quality-plan.md §19.19): eval:live retries exactly as production does.
  describe('production retry policy', () => {
    const run = async (fetchImpl: ReturnType<typeof vi.fn>, profiles: Parameters<typeof runLiveEval>[0]['profiles'], roles: Parameters<typeof runLiveEval>[0]['roles'], maxRequests: number) => {
      const { g, golden, thresholds } = await setup();
      const out = await outDir();
      const ledgerFile = path.join(out, 'ledger.jsonl');
      const logs: string[] = [];
      const pauses: number[] = [];
      const result = await runLiveEval({
        log: (l) => logs.push(l),
        golden,
        photosDir: g.photosDir,
        split: 'all',
        profiles,
        roles,
        outDir: out,
        repoRoot: root,
        maxRequests,
        spendCapMicros: 5_000_000,
        confirmPaidRequests: true,
        apiKey: KEY,
        pipeline: versionedTestPipeline,
        thresholds,
        fetch: fetchImpl as unknown as typeof fetch,
        ledgerFile,
        sleep: async (ms) => void pauses.push(ms),
      });
      const ledger = (await readFile(ledgerFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      return { result, logs, ledger, pauses };
    };
    /** The first `n` calls fail with `status`, then the normal readings. */
    const failingFirst = (n: number, status: number) => {
      const ok = readings();
      let calls = 0;
      return vi.fn(async (url: string, init: RequestInit) => (++calls <= n ? new Response('{}', { status }) : ok(url, init)));
    };

    it('mirrors the production defaults: one in-process retry for a transient failure, three job attempts', () => {
      expect(PRODUCTION_RETRY_POLICY).toEqual({ providerRetries: 2, jobAttempts: 3 });
    });

    it('a transient stage-1 failure is retried once in-process, then the job is re-queued; every attempt is in the ledger', async () => {
      // p01: 503, 503 (job attempt 1, in-process retry), 200 (job attempt 2); p02 and p03 first time.
      const fetchImpl = failingFirst(2, 503);
      const { result, logs, ledger, pauses } = await run(fetchImpl, { vision_photo: quickProfile }, ['vision_photo'], 10);
      expect(fetchImpl).toHaveBeenCalledTimes(5);
      expect(ledger.map((l) => l.status)).toEqual([503, 503, 200, 200, 200]);
      expect(result).toMatchObject({ requestsSent: 5, jobRetries: 1 });
      expect(logs).toContain('p01 quick: server; job attempt 1 of 3 re-queued (production policy)');
      expect(pauses).toHaveLength(1);
      expect(result.scorecard!.splits.tune!.metrics.M13).toBe(1);
    });

    it('a stage-1 failure on every job attempt counts against M13 after three attempts; stage-2 failures are never re-queued', async () => {
      const fetchImpl = failingFirst(6, 503);
      const { result } = await run(fetchImpl, { vision_photo: quickProfile }, ['vision_photo'], 12);
      // p01: 3 job attempts x 2 calls, then p02 and p03.
      expect(fetchImpl).toHaveBeenCalledTimes(8);
      expect(result.jobRetries).toBe(2);
      expect(result.scorecard!.splits.tune!.metrics.M13).toBeLessThan(1);
      // Stage 2 fails twice (in-process retry): the analysis continues without it, no job retry.
      const ok = readings();
      let calls = 0;
      const stage2Down = vi.fn(async (url: string, init: RequestInit) => {
        calls++;
        return calls === 2 || calls === 3 ? new Response('{}', { status: 503 }) : ok(url, init);
      });
      const two = await run(stage2Down, { vision_photo: quickProfile, vision_photo_enrich: enrichProfile }, ['vision_photo', 'vision_photo_enrich'], 12);
      expect(stage2Down).toHaveBeenCalledTimes(7);
      expect(two.result.jobRetries).toBe(0);
    });

    it('a 429 still stops the run without a retry', async () => {
      const fetchImpl = readings(429);
      const { result } = await run(fetchImpl, { vision_photo: quickProfile }, ['vision_photo'], 6);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ stoppedBy: 'http_429', jobRetries: 0 });
    });
  });
});
