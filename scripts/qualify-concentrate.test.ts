import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  profileHash,
  qualificationState as realQualificationState,
  type EvalBindingLike,
  type ModelProfile,
} from '../packages/providers/src/index';
import type { TextScorer } from './eval/golden-photos';
import { runtimeGuardedPipeline, unguardedPipeline } from './eval/pipeline';
import { sha256Hex } from './eval/labels';
import { textManifestDigest } from './eval/text-golden';
import { syntheticBinding, syntheticGolden, versionedTestPipeline } from './eval/test-golden';
import { discoverFixtures, fetchCatalog, qualifyProfile as realQualifyProfile, readApiKey } from './qualify-concentrate-lib';

/*
 * The synthetic golden sets live in temp dirs, so they are not the committed
 * EVAL_BINDING. These wrappers bind each run to its own synthetic inputs (as
 * if they were committed) and read qualification state against that binding;
 * the committed binding itself is checked by scripts/eval/binding.test.ts.
 */
const bindings = new Map<string, EvalBindingLike>();
async function qualifyProfile(o: Parameters<typeof realQualifyProfile>[0]) {
  const binding = o.binding ?? (await syntheticBinding(o));
  if (binding) {
    const prev = bindings.get(o.outDir);
    bindings.set(o.outDir, prev ? { ...binding, sets: { ...prev.sets, ...binding.sets } } : binding);
  }
  return realQualifyProfile({ ...o, ...(binding ? { binding } : {}) });
}
function qualificationState(profile: ModelProfile, dir: string | undefined) {
  const binding = dir ? bindings.get(dir) : undefined;
  return binding ? realQualificationState(profile, dir, binding) : realQualificationState(profile, dir);
}

/**
 * Offline tests of the operator qualification harness (fake fetch only). They
 * prove the safety rails and the evaluation gating; they are NOT a
 * qualification of any live model. The photos are synthetic solid colours and
 * the guarded pipeline is a versioned test double (docs/quality-plan.md §7.5).
 */
const KEY = 'synthetic-operator-key-never-written';
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tmp(prefix: string) {
  const d = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const profile: ModelProfile = {
  gateway: 'concentrate',
  role: 'vision_photo',
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
  qualificationArtifactId: 'vision-photo-2026-10-16',
  pricingSnapshotVersion: 'price-1',
  reservationMicros: 20_000,
};
const enrich: ModelProfile = {
  ...profile,
  role: 'vision_photo_enrich',
  promptVersion: 'vlm-enrich-v1',
  schemaVersion: 'atlas_enrichment_v1',
  maxOutputTokens: 1200,
  timeoutMs: 20_000,
  image: { maxBytes: 150_000, maxPixels: 589_824, maxDimension: 768, maxCount: 1 },
  qualificationArtifactId: 'vision-photo-enrich-2026-10-18',
};

/** A reading in the shape the request's schema name asks for (v1 or v2). */
function reading(name: string, candidate = 'Mid-century modern') {
  const v2 = name.endsWith('_v2');
  if (name.includes('enrich'))
    return {
      observations: [{ text: 'Round table', kind: 'object' }],
      visible_text: [],
      ...(v2 ? { illegible_text_present: false } : {}),
      confirmed: [v2 ? { name: candidate, rationale: 'Tapered legs', verdict: 'supported' } : { name: candidate, rationale: 'Tapered legs', keep: true }],
      additional_candidates: [],
      regions: [],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
    };
  const c = v2
    ? { name: candidate, type: 'style', relation: 'resembles', certainty: 0.7, domain: 'interior', evidence: 'distinctive_form', evidence_text: null, tag_query: 'mid-century modern' }
    : { name: candidate, type: 'style', relation: 'resembles', certainty: 0.7, categories: [], tag_query: 'mid-century modern' };
  return { title: 'Round table', interpretation: 'A table that resembles mid-century design.', candidates: [c], quality: { usable: true, issue: null } };
}
function catalogPages() {
  return vi.fn(async (url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const after = new URL(url).searchParams.get('after');
    const body = after
      ? { data: [{ id: 'fixture/vision-1', providers: [{ name: 'fixture' }] }], has_more: false }
      : { data: [{ id: 'other/text-1' }], has_more: true, last_id: 'other/text-1' };
    return new Response(JSON.stringify(body));
  });
}
/** Blind held-out photo ids (h01..): photo roles qualify only with at least 10 of them (quality plan §7.5). */
const ids = (n: number, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`);
/** Width of the first base64 JPEG in a request body (SOF marker), to check the bounds a call was sent at. */
function jpegWidth(text: string): number {
  const b64 = /data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/.exec(text)?.[1];
  if (!b64) throw new Error('no JPEG in the request');
  const bytes = Buffer.from(b64, 'base64');
  for (let i = 2; i < bytes.length - 9; ) {
    if (bytes[i] !== 0xff) throw new Error('bad JPEG marker');
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xc3) return bytes.readUInt16BE(i + 7);
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('no SOF marker');
}
function responses(status = 200, candidate?: string) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    if (status !== 200) return new Response('{"error":{"message":"PRIVATE"}}', { status });
    const body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        id: 'resp',
        model: 'fixture/vision-1',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reading(body.text.format.name, candidate)) }] }],
        usage: { input_tokens: 1000, output_tokens: 120 },
      }),
    );
  });
}
async function preparedOutDir() {
  const outDir = await tmp('ca-qout-');
  await fetchCatalog({
    apiKey: KEY,
    outDir,
    fetch: catalogPages() as unknown as typeof fetch,
    now: () => new Date('2026-10-16T12:00:00Z'),
  });
  return outDir;
}

describe('scripts/qualify-concentrate (offline harness)', () => {
  it('snapshots the paginated catalog without inference, privately', async () => {
    const outDir = await tmp('ca-qcat-');
    const fetchImpl = catalogPages();
    const snapshot = await fetchCatalog({
      apiKey: KEY,
      outDir,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => new Date('2026-10-16T12:00:00Z'),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://api.concentrate.ai/v1/models?after=other%2Ftext-1',
    );
    expect(snapshot).toMatchObject({
      pages: 2,
      models: [{ id: 'other/text-1' }, { id: 'fixture/vision-1' }],
    });
    const file = path.join(outDir, 'catalog-snapshot.json');
    expect((await stat(file)).mode & 0o077).toBe(0);
    expect(await readFile(file, 'utf8')).not.toContain(KEY);
  });

  it('reads the key only from a private file (or env), never a group/world-readable one', async () => {
    const dir = await tmp('ca-qkey-');
    const file = path.join(dir, 'key');
    await writeFile(file, `${KEY}\n`);
    await chmod(file, 0o644);
    await expect(readApiKey({ keyFile: file })).rejects.toThrow('chmod 600');
    await chmod(file, 0o600);
    await expect(readApiKey({ keyFile: file })).resolves.toBe(KEY);
    await expect(readApiKey({})).rejects.toThrow('CONCENTRATE_API_KEY');
  });

  it('dry run hash-checks the golden photos, plans and sends nothing; refuses fewer than 10 photos or a plan above the caps', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses();
    const base = {
      apiKey: KEY,
      outDir,
      profile,
      pipeline: versionedTestPipeline,
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    const ten = await syntheticGolden(ids(10));
    await expect(qualifyProfile({ ...base, golden: { dir: ten.dir, photosDir: ten.photosDir }, confirmPaidRequests: false })).resolves.toEqual({
      dryRun: true,
      plannedRequests: 10,
    });
    const nine = await syntheticGolden(ids(9));
    await expect(
      qualifyProfile({ ...base, golden: { dir: nine.dir, photosDir: nine.photosDir }, confirmPaidRequests: true }),
    ).rejects.toThrow('at least 10');
    await expect(
      qualifyProfile({ ...base, golden: { dir: ten.dir, photosDir: ten.photosDir }, maxRequests: 5, confirmPaidRequests: true }),
    ).rejects.toThrow('--max-requests');
    await expect(
      qualifyProfile({ ...base, golden: { dir: ten.dir, photosDir: ten.photosDir }, spendCapMicros: 100_000, confirmPaidRequests: true }),
    ).rejects.toThrow('spend cap');
    await expect(
      qualifyProfile({
        ...base,
        profile: { ...profile, model: 'fixture/not-in-catalog' },
        golden: { dir: ten.dir, photosDir: ten.photosDir },
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow('catalog-compatible');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('photo roles fail closed: golden set, guarded pipeline and untampered photos are required before any request', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses();
    const g = await syntheticGolden(ids(10));
    const base = { apiKey: KEY, outDir, profile, maxRequests: 12, spendCapMicros: 2_000_000, confirmPaidRequests: true, fetch: fetchImpl as unknown as typeof fetch };
    await expect(qualifyProfile({ ...base, pipeline: versionedTestPipeline, fixturesDir: g.photosDir })).rejects.toThrow('golden set');
    await expect(qualifyProfile({ ...base, golden: { dir: g.dir, photosDir: g.photosDir } })).rejects.toThrow('guarded reading pipeline');
    await expect(
      qualifyProfile({ ...base, golden: { dir: g.dir, photosDir: g.photosDir }, pipeline: unguardedPipeline }),
    ).rejects.toThrow('guarded reading pipeline');
    await writeFile(path.join(g.photosDir, 'h03.jpg'), 'tampered');
    await expect(
      qualifyProfile({ ...base, golden: { dir: g.dir, photosDir: g.photosDir }, pipeline: versionedTestPipeline }),
    ).rejects.toThrow('h03: sha256 differs');
    await expect(
      qualifyProfile({
        ...base,
        profile: { ...profile, schemaVersion: 'atlas_observations_v2' },
        golden: { dir: g.dir, photosDir: g.photosDir },
        pipeline: versionedTestPipeline,
      }),
    ).rejects.toThrow('quick-read profile');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /*
   * vision_verify (requalification round 3): a different-family verifier is qualified on the full
   * two-stage reading it guards. The catalog below is FIXTURE metadata: two authors, ZDR listed per route.
   */
  const verifyProfile: ModelProfile = {
    ...profile,
    role: 'vision_verify',
    model: 'checker/verify-1',
    provider: 'checker',
    promptVersion: 'vlm-verify-v3',
    schemaVersion: 'atlas_verify_v1',
    image: { maxBytes: 150_000, maxPixels: 589_824, maxDimension: 768, maxCount: 1 },
    timeoutMs: 20_000,
    qualificationArtifactId: 'vision-verify-2026-10-20',
  };
  async function familyOutDir(opts: { verifierAuthor?: string; verifierZdr?: boolean } = {}) {
    const outDir = await tmp('ca-qfam-');
    const catalog = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'fixture/vision-1', author: { slug: 'fixturelab' }, providers: { fixture: { zdr: { policy_url: 'https://example.invalid/zdr' } } } },
            {
              id: 'checker/verify-1',
              author: { slug: opts.verifierAuthor ?? 'otherlab' },
              providers: { checker: opts.verifierZdr === false ? {} : { zdr: { policy_url: 'https://example.invalid/zdr' } } },
            },
          ],
          has_more: false,
        }),
      ),
    );
    await fetchCatalog({ apiKey: KEY, outDir, fetch: catalog as unknown as typeof fetch, now: () => new Date('2026-10-16T12:00:00Z') });
    return outDir;
  }
  /** Quick reads and enrichments as before; the verifier answers "yes" to every claim it is asked. */
  function verifyingResponses(answer: 'yes' | 'no' = 'yes') {
    return vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string; text: { format: { name: string } }; input: { content: { type: string; text?: string }[] }[] };
      const name = body.text.format.name;
      let output: unknown;
      if (name === 'atlas_verify_v1') {
        const text = body.input[0]!.content.find((c) => c.type === 'input_text')!.text!;
        const data = JSON.parse(text.split('\n').slice(2, -1).join('\n')) as { claims: { name: string }[] };
        output = { checks: data.claims.map((c) => ({ name: c.name, answer, reason: 'Fixture answer' })) };
      } else output = reading(name);
      return new Response(
        JSON.stringify({ id: 'resp', model: body.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 900, output_tokens: 80 } }),
      );
    });
  }

  it('vision_verify: refuses, before any request, a verifier without both photo profiles, of the same family, or without a listed ZDR route', async () => {
    const fetchImpl = verifyingResponses();
    const g = await syntheticGolden(ids(10));
    const base = {
      apiKey: KEY,
      profile: verifyProfile,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: runtimeGuardedPipeline,
      maxRequests: 40,
      spendCapMicros: 5_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    await expect(qualifyProfile({ ...base, outDir: await familyOutDir(), enrichProfile: enrich })).rejects.toThrow('stage-1 vision_photo quick-read profile');
    await expect(qualifyProfile({ ...base, outDir: await familyOutDir(), stage1Profile: profile })).rejects.toThrow('vision_photo_enrich profile');
    await expect(
      qualifyProfile({ ...base, outDir: await familyOutDir({ verifierAuthor: 'FixtureLab' }), stage1Profile: profile, enrichProfile: enrich }),
    ).rejects.toThrow(/same model family \(fixturelab\).*Nothing was sent/);
    await expect(
      qualifyProfile({ ...base, outDir: await familyOutDir({ verifierZdr: false }), stage1Profile: profile, enrichProfile: enrich }),
    ).rejects.toThrow('no zero-data-retention policy for the checker route');
    await expect(
      qualifyProfile({ ...base, outDir: await familyOutDir(), profile, enrichProfile: enrich }),
    ).rejects.toThrow('only applies when qualifying vision_verify');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('vision_verify: reads every photo as production does with the verifier on, and binds family and use into the artifact', async () => {
    const outDir = await familyOutDir();
    const fetchImpl = verifyingResponses();
    const g = await syntheticGolden(ids(10));
    const base = {
      apiKey: KEY,
      outDir,
      profile: verifyProfile,
      stage1Profile: profile,
      enrichProfile: enrich,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: runtimeGuardedPipeline,
      spendCapMicros: 5_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    // Planned: quick read, stage-1 check, enrichment and stage-2 check for every photo.
    await expect(qualifyProfile({ ...base, maxRequests: 40, confirmPaidRequests: false })).resolves.toEqual({ dryRun: true, plannedRequests: 40 });
    await expect(qualifyProfile({ ...base, maxRequests: 39, confirmPaidRequests: true })).rejects.toThrow('--max-requests');
    const run = await qualifyProfile({ ...base, maxRequests: 40, confirmPaidRequests: true });
    // The style is checked before it publishes (stage 1); stage 2 adds nothing, so no stage-2 check is sent.
    const names = fetchImpl.mock.calls.map((c) => (JSON.parse(c[1].body as string) as { text: { format: { name: string } } }).text.format.name);
    expect(names.slice(0, 3)).toEqual(['atlas_quick_read_v1', 'atlas_verify_v1', 'atlas_enrichment_v1']);
    expect(names.filter((n) => n === 'atlas_verify_v1')).toHaveLength(10);
    const a = run.artifact!;
    expect(a).toMatchObject({ role: 'vision_verify', model: 'checker/verify-1', requests_sent: 30, fixtures: { total: 10, passed: 10, failed: 0 } });
    expect(a.eval!.metrics).toMatchObject({ verifier_independent_family: 1, verifier_checked_photos: 10, verifier_calls: 10, verifier_blocked_claims: 0 });
    expect(a.notes.join(' ')).toContain('family otherlab');
    expect(a.eval!.guardrail_version).toBe(runtimeGuardedPipeline.guardrailVersion);
    // Nothing but aggregates is written.
    const written = await readFile(path.join(outDir, `${a.artifact_id}.json`), 'utf8');
    expect(written).not.toContain('Fixture answer');
    expect(written).not.toContain(KEY);
  });

  it('refuses, before any request, a golden set without 10 blind held-out photos (a tuned split is no generalization gate)', async () => {
    const fetchImpl = responses();
    const base = { apiKey: KEY, profile, pipeline: versionedTestPipeline, maxRequests: 30, spendCapMicros: 2_000_000, confirmPaidRequests: true, fetch: fetchImpl as unknown as typeof fetch };
    const tuneOnly = await syntheticGolden(ids(12, 'p'));
    await expect(qualifyProfile({ ...base, outDir: await preparedOutDir(), golden: tuneOnly })).rejects.toThrow('0 blind held-out photo(s)');
    const contaminated = await syntheticGolden(ids(12));
    const manifestFile = path.join(contaminated.dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { photos: { id: string; blind?: boolean }[] };
    for (const photo of manifest.photos.slice(0, 3)) photo.blind = false;
    await writeFile(manifestFile, JSON.stringify(manifest));
    await expect(qualifyProfile({ ...base, outDir: await preparedOutDir(), golden: contaminated })).rejects.toThrow('9 blind held-out photo(s)');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses, before any request, a golden set whose blind split a failed blind run consumed (no second look)', async () => {
    const fetchImpl = responses();
    const base = { apiKey: KEY, profile, pipeline: versionedTestPipeline, maxRequests: 30, spendCapMicros: 2_000_000, confirmPaidRequests: true, fetch: fetchImpl as unknown as typeof fetch };
    // The set's own record: freeze.json with a failed blind run (and its held-out entries still claiming blind: true).
    const recorded = await syntheticGolden(ids(12));
    await writeFile(
      path.join(recorded.dir, 'freeze.json'),
      JSON.stringify({
        golden_set: 'golden-v3',
        split: 'holdout',
        labelled_on: '2026-10-19',
        labelled_from: '0'.repeat(40),
        model_runs_before_freeze: 0,
        holdout_manifest_sha256: 'f'.repeat(64),
        photos: {},
        blind_run: {
          date: '2026-10-19',
          binding_commit: '1'.repeat(40),
          code_commit: '2'.repeat(40),
          result: 'fail',
          failed_gates: ['M1', 'M11'],
          requests: { concentrate: 24, qloo: 12 },
          report: 'docs/quality-plan.md section 16',
        },
      }),
    );
    await expect(qualifyProfile({ ...base, outDir: await preparedOutDir(), golden: recorded })).rejects.toThrow(
      /blind held-out split was consumed by a failed blind run \(2026-10-19, code 2222222, failed M1, M11\).*Nothing was sent/,
    );
    // The committed binding's record alone (a copy of the set without its freeze.json) is enough.
    const copy = await syntheticGolden(ids(12));
    const committed = (await syntheticBinding({ golden: copy }))!;
    const consumed: EvalBindingLike = { ...committed, sets: { 'golden-v3': { ...committed.sets['golden-v3']!, blind_consumed: true } } };
    await expect(qualifyProfile({ ...base, outDir: await preparedOutDir(), golden: copy, binding: consumed })).rejects.toThrow('consumed by a failed blind run');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the review probe: the committed golden-v2 (consumed) refuses both photo stages before any request, with the default binding', async () => {
    const fetchImpl = responses();
    const photos = await tmp('ca-qphotos-');
    for (const [p, stage1] of [
      [profile, undefined],
      [enrich, profile],
    ] as const) {
      await expect(
        realQualifyProfile({
          apiKey: KEY,
          outDir: await preparedOutDir(),
          profile: p,
          stage1Profile: stage1,
          stage1Artifact: !!stage1,
          pipeline: versionedTestPipeline,
          golden: { dir: path.resolve(import.meta.dirname, '../fixtures/eval/golden-v2'), photosDir: photos },
          maxRequests: 100,
          spendCapMicros: 5_000_000,
          confirmPaidRequests: true,
          fetch: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toThrow(`${p.role} must qualify on golden-v3; got golden-v2.`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the review probe: the committed golden-v3 (round-2 blind run failed) refuses both photo stages before any request', async () => {
    const fetchImpl = responses();
    const photos = await tmp('ca-qphotos-');
    for (const [p, stage1] of [
      [profile, undefined],
      [enrich, profile],
    ] as const) {
      await expect(
        realQualifyProfile({
          apiKey: KEY,
          outDir: await preparedOutDir(),
          profile: p,
          stage1Profile: stage1,
          stage1Artifact: !!stage1,
          pipeline: versionedTestPipeline,
          golden: { dir: path.resolve(import.meta.dirname, '../fixtures/eval/golden-v3'), photosDir: photos },
          maxRequests: 100,
          spendCapMicros: 5_000_000,
          confirmPaidRequests: true,
          fetch: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/golden-v3's blind held-out split was consumed by a failed blind run \(2026-10-20, code cc281e4, failed M1, M2, M4, M9, M11\)/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses, before any request, inputs that differ from the committed binding (the artifact could never qualify)', async () => {
    const fetchImpl = responses();
    const g = await syntheticGolden(ids(10));
    const binding = (await syntheticBinding({ golden: g }))!;
    const set = binding.sets['golden-v3']!;
    const run = async (b?: EvalBindingLike) =>
      realQualifyProfile({
        apiKey: KEY,
        outDir: await preparedOutDir(),
        profile,
        golden: g,
        pipeline: versionedTestPipeline,
        maxRequests: 12,
        spendCapMicros: 2_000_000,
        confirmPaidRequests: true,
        fetch: fetchImpl as unknown as typeof fetch,
        ...(b ? { binding: b } : {}),
      });
    await expect(run({ ...binding, thresholds_sha256: '1'.repeat(64) })).rejects.toThrow('thresholds.json differs');
    await expect(run({ ...binding, sets: { 'golden-v3': { ...set, golden_sha256: '0'.repeat(64) } } })).rejects.toThrow('golden-v3 differs');
    await expect(run({ ...binding, sets: { 'golden-v3': { ...set, scorer_version: 'score-v0' } } })).rejects.toThrow('differs from the committed score-v0');
    await expect(run({ ...binding, sets: { 'golden-v3': { ...set, code_sha256: '2'.repeat(64) } } })).rejects.toThrow('the evaluated code');
    // The committed binding (the default) does not describe a temp golden set either.
    await expect(run()).rejects.toThrow('not the committed ones');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a confirmed passing run writes an aggregate-only artifact with a passing eval block that makes the profile qualified', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses();
    const g = await syntheticGolden(ids(10));
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(run.artifact).toMatchObject({
      result: 'pass',
      requests_sent: 10,
      profile_hash: profileHash(profile),
      fixtures: { total: 10, passed: 10, failed: 0, outcomes: { complete: 10 } },
      usage: { input_tokens: 10_000, output_tokens: 1200, unknown_usage_attempts: 0 },
      eval: { golden_set: 'golden-v3', guardrail_version: 'guard-v8', scorer_version: 'score-v7', holdout_blind: true, pass: true },
    });
    expect(run.artifact!.eval!.metrics).toMatchObject({ holdout_M1: 0, holdout_M3: 1, holdout_M13: 1, failed_calls: 0, holdout_photos: 10, holdout_blind_photos: 10 });
    expect(qualificationState(profile, outDir)).toBe('qualified');
    const artifact = await readFile(path.join(outDir, `${profile.qualificationArtifactId}.json`), 'utf8');
    expect(artifact).not.toContain(KEY);
    expect(artifact).not.toContain('Round table');
    expect(artifact).not.toContain('Mid-century modern');
    expect(artifact).not.toMatch(/base64|\/9j\//);
    // The persistent counter survives re-runs: only 2 more requests fit under a cap of 12.
    const again = responses();
    const rerun = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      confirmPaidRequests: true,
      fetch: again as unknown as typeof fetch,
    });
    expect(again).toHaveBeenCalledTimes(2);
    expect(rerun).toMatchObject({ stoppedBy: 'request_cap', artifact: { result: 'fail', eval: { pass: false } } });
    expect(qualificationState(profile, outDir)).toBe('catalog-compatible');
  });

  it('a clean transport run with readings that fail the scorer is a failing artifact', async () => {
    const outDir = await preparedOutDir();
    // Every reading names a designer the labels forbid (M2) and nothing expected (M5).
    const fetchImpl = responses(200, 'Eames lounge chair');
    const g = await syntheticGolden(ids(10));
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(run.artifact).toMatchObject({ result: 'fail', fixtures: { passed: 10, failed: 0 }, eval: { pass: false } });
    expect(run.artifact!.eval!.metrics.holdout_M2).toBe(1);
    expect(run.artifact!.notes.some((n) => /Evaluation golden-v3 .*: fail/.test(n))).toBe(true);
    expect(qualificationState(profile, outDir)).toBe('catalog-compatible');
  });

  it('two-stage: qualifies the quick read with its reasoning effort, then enrichment on real stage-1 readings', async () => {
    const quick: ModelProfile = { ...profile, qualificationArtifactId: 'vision-photo-quick-2026-10-18' };
    const bodies: Array<Record<string, unknown> & { text: { format: { name: string } } }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      return new Response(
        JSON.stringify({
          id: 'resp',
          model: 'fixture/vision-1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reading(body.text.format.name)) }] }],
          usage: { input_tokens: 1600, output_tokens: 300 },
        }),
      );
    });
    const outDir = await preparedOutDir();
    const g = await syntheticGolden(ids(10));
    const common = {
      apiKey: KEY,
      outDir,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      spendCapMicros: 2_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
    };

    const q = await qualifyProfile({ ...common, profile: quick, maxRequests: 10, confirmPaidRequests: true });
    expect(q.artifact).toMatchObject({ result: 'pass', role: 'vision_photo', requests_sent: 10 });
    expect(q.artifact!.notes).toEqual(
      expect.arrayContaining([
        `Reading: quick (prompt ${quick.promptVersion}, schema ${quick.schemaVersion}).`,
        'Reasoning effort: none (sent as reasoning.effort on every request).',
      ]),
    );
    expect(bodies.every((b) => b.text.format.name === quick.schemaVersion)).toBe(true);
    expect(bodies.every((b) => JSON.stringify(b.reasoning) === '{"effort":"none"}')).toBe(true);
    expect(qualificationState(quick, outDir)).toBe('qualified');
    // The same profile without the effort is a different, unqualified profile.
    const { reasoningEffort: _e, ...noEffort } = quick;
    expect(qualificationState(noEffort, outDir)).toBe('catalog-compatible');

    // Stage 2 needs the stage-1 profile and plans two requests per photo.
    await expect(
      qualifyProfile({ ...common, profile: enrich, maxRequests: 40, confirmPaidRequests: false }),
    ).rejects.toThrow('stage-1');
    await expect(
      qualifyProfile({ ...common, profile: enrich, stage1Profile: { ...profile, schemaVersion: 'atlas_observations_v2' }, maxRequests: 40, confirmPaidRequests: false }),
    ).rejects.toThrow('stage-1');
    await expect(
      qualifyProfile({ ...common, profile: quick, stage1Profile: quick, maxRequests: 40, confirmPaidRequests: false }),
    ).rejects.toThrow('only applies');
    await expect(
      qualifyProfile({ ...common, profile: enrich, stage1Profile: quick, maxRequests: 40, confirmPaidRequests: false }),
    ).resolves.toEqual({ dryRun: true, plannedRequests: 20 });
    await expect(
      qualifyProfile({ ...common, profile: enrich, stage1Profile: quick, maxRequests: 25, spendCapMicros: 300_000, confirmPaidRequests: true }),
    ).rejects.toThrow('spend cap');

    bodies.length = 0;
    const e = await qualifyProfile({ ...common, profile: enrich, stage1Profile: quick, maxRequests: 30, confirmPaidRequests: true });
    expect(bodies.map((b) => b.text.format.name)).toEqual(
      Array.from({ length: 10 }, () => [quick.schemaVersion, enrich.schemaVersion]).flat(),
    );
    // The enrichment request carries the real stage-1 reading as DATA.
    expect(JSON.stringify(bodies[1]!.input)).toContain('Mid-century modern');
    expect(e.artifact).toMatchObject({
      result: 'pass',
      role: 'vision_photo_enrich',
      profile_hash: profileHash(enrich),
      requests_sent: 20,
      fixtures: { total: 10, passed: 10, failed: 0 },
      usage: { input_tokens: 16_000, output_tokens: 3000 },
      eval: { golden_set: 'golden-v3', pass: true },
    });
    expect(e.artifact!.notes.some((n) => n.startsWith('Stage-1 input from fixture/vision-1 quick read'))).toBe(true);
    expect(qualificationState(enrich, outDir)).toBe('qualified');
    const artifact = await readFile(path.join(outDir, `${enrich.qualificationArtifactId}.json`), 'utf8');
    expect(artifact).not.toContain('Tapered legs');
    expect(artifact).not.toContain(KEY);
  });

  it('one enrichment run can also write the stage-1 artifact, scored on its stage-1 readings alone', async () => {
    const quick: ModelProfile = { ...profile, qualificationArtifactId: 'vision-photo-quick-combined' };
    const bodies: Array<{ text: { format: { name: string } }; input: unknown }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      return new Response(
        JSON.stringify({
          id: 'resp',
          model: 'fixture/vision-1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(reading(body.text.format.name)) }] }],
          usage: body.text.format.name === quick.schemaVersion ? { input_tokens: 900, output_tokens: 100 } : { input_tokens: 1600, output_tokens: 300 },
        }),
      );
    });
    const outDir = await preparedOutDir();
    const g = await syntheticGolden(ids(10));
    const common = {
      apiKey: KEY,
      outDir,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      spendCapMicros: 2_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    // Only with an enrichment run and its stage-1 profile, and never onto the same artifact file.
    await expect(qualifyProfile({ ...common, profile: quick, stage1Artifact: true, maxRequests: 30, confirmPaidRequests: false })).rejects.toThrow('stage-1 artifact');
    await expect(
      qualifyProfile({ ...common, profile: enrich, stage1Profile: { ...quick, qualificationArtifactId: enrich.qualificationArtifactId }, stage1Artifact: true, maxRequests: 30, confirmPaidRequests: false }),
    ).rejects.toThrow('different qualificationArtifactId');
    // The plan is the enrichment run's: two requests per photo, nothing bought twice.
    await expect(
      qualifyProfile({ ...common, profile: enrich, stage1Profile: quick, stage1Artifact: true, maxRequests: 30, confirmPaidRequests: false }),
    ).resolves.toEqual({ dryRun: true, plannedRequests: 20 });
    expect(fetchImpl).not.toHaveBeenCalled();

    const run = await qualifyProfile({ ...common, profile: enrich, stage1Profile: quick, stage1Artifact: true, maxRequests: 20, confirmPaidRequests: true });
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    // Each stage is bounded from the original photo at its own profile's bounds (640 px synthetic photos).
    const widths = bodies.map((b) => ({ schema: b.text.format.name, width: jpegWidth(JSON.stringify(b.input)) }));
    expect(widths.filter((w) => w.schema === quick.schemaVersion).every((w) => w.width === quick.image.maxDimension)).toBe(true);
    expect(widths.filter((w) => w.schema === enrich.schemaVersion).every((w) => w.width === 640)).toBe(true);
    expect(run.artifact).toMatchObject({
      result: 'pass',
      role: 'vision_photo_enrich',
      requests_sent: 20,
      usage: { input_tokens: 16_000, output_tokens: 3000 },
      eval: { golden_set: 'golden-v3', pass: true },
    });
    expect(run.stage1Artifact).toMatchObject({
      result: 'pass',
      role: 'vision_photo',
      artifact_id: quick.qualificationArtifactId,
      profile_hash: profileHash(quick),
      requests_sent: 10,
      fixtures: { total: 10, passed: 10, failed: 0, outcomes: { complete: 10 } },
      usage: { input_tokens: 9000, output_tokens: 1000, unknown_usage_attempts: 0 },
      eval: { golden_set: 'golden-v3', guardrail_version: 'guard-v8', holdout_blind: true, pass: true },
    });
    // Scored as a stage-1-only run: the same block a separate vision_photo qualification would carry.
    expect(run.stage1Artifact!.eval!.metrics).toMatchObject({ holdout_M13: 1, failed_calls: 0, holdout_photos: 10 });
    expect(run.artifact!.eval!.metrics).toHaveProperty('holdout_M14_enrich_p95');
    expect(run.stage1Artifact!.eval!.metrics).not.toHaveProperty('holdout_M14_enrich_p95');
    expect(run.stage1Artifact!.notes.some((n) => n.includes(`qualification run ${enrich.qualificationArtifactId}`))).toBe(true);
    expect(qualificationState(quick, outDir)).toBe('qualified');
    expect(qualificationState(enrich, outDir)).toBe('qualified');
    const file = await readFile(path.join(outDir, `${quick.qualificationArtifactId}.json`), 'utf8');
    expect(file).not.toContain('Mid-century modern');
    expect(file).not.toContain(KEY);
    expect((await stat(path.join(outDir, `${quick.qualificationArtifactId}.json`))).mode & 0o077).toBe(0);
  });

  it('a stage-1 call that fails fails the stage-1 artifact as well as the enrichment one', async () => {
    const quick: ModelProfile = { ...profile, qualificationArtifactId: 'vision-photo-quick-combined-fail' };
    let calls = 0;
    const ok = responses();
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls++;
      // The third photo's stage-1 call returns a reading that fails its schema.
      if (calls === 5)
        return new Response(JSON.stringify({ id: 'r', model: 'fixture/vision-1', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"title":1}' }] }] }));
      return ok(url, init);
    });
    const g = await syntheticGolden(ids(10));
    const outDir = await preparedOutDir();
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      spendCapMicros: 2_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
      profile: enrich,
      stage1Profile: quick,
      stage1Artifact: true,
      maxRequests: 20,
      confirmPaidRequests: true,
    });
    expect(run.stage1Artifact).toMatchObject({ result: 'fail', requests_sent: 10, fixtures: { passed: 9, failed: 1 }, eval: { pass: false } });
    expect(run.stage1Artifact!.eval!.metrics.failed_calls).toBe(1);
    expect(run.artifact).toMatchObject({ result: 'fail' });
    expect(qualificationState(quick, outDir)).toBe('catalog-compatible');
  });

  it('stage 2 is asked about exactly what production sends: the guarded stage-1 names, never a dropped claim', async () => {
    const quick: ModelProfile = { ...profile, qualificationArtifactId: 'vision-photo-quick-guarded' };
    const bodies: Array<{ text: { format: { name: string } }; input: unknown }> = [];
    const inner = responses(200, 'Still life painting');
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return inner(url, init);
    });
    const g = await syntheticGolden(ids(10));
    await qualifyProfile({
      apiKey: KEY,
      outDir: await preparedOutDir(),
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      spendCapMicros: 2_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
      profile: enrich,
      stage1Profile: quick,
      maxRequests: 30,
      confirmPaidRequests: true,
    });
    const enrichBodies = bodies.filter((b) => b.text.format.name === enrich.schemaVersion);
    expect(enrichBodies).toHaveLength(10);
    // G-MEDIUM drops the medium-word claim at stage 1, so stage 2 never sees it (as in the compiler).
    for (const b of enrichBodies) {
      expect(JSON.stringify(b.input)).toContain('Round table');
      expect(JSON.stringify(b.input)).not.toContain('Still life painting');
    }
  });

  it('stops at the first 402 (no retry, no further spend) and records a failing artifact', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses(402);
    const g = await syntheticGolden(ids(10));
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      golden: { dir: g.dir, photosDir: g.photosDir },
      pipeline: versionedTestPipeline,
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({
      stoppedBy: 'http_402',
      artifact: { result: 'fail', fixtures: { outcomes: { http_402: 1 } }, eval: { pass: false } },
    });
    expect(JSON.stringify(run.artifact)).not.toContain('PRIVATE');
  });
});

describe('text roles: content checks gate qualification (plan §8)', () => {
  const textProfile: ModelProfile = {
    ...profile,
    role: 'composer',
    image: { maxBytes: 0, maxPixels: 0, maxDimension: 0, maxCount: 0 },
    timeoutMs: 15_000,
    promptVersion: 'composer-v2',
    schemaVersion: 'plan_prose',
    qualificationArtifactId: 'composer-2026-10-19',
  };
  const prose = { title: 'An evening plan', summary: 'A short plan for the evening.', rationale: null };
  /** A synthetic text golden set laid out like fixtures/eval/text-v1: <root>/manifest.json pins <root>/composer/*. */
  async function textFixtures(n: number, withExpect = true) {
    const root = path.join(await tmp('ca-text-'), 'text-v1');
    const dir = path.join(root, 'composer');
    await mkdir(dir, { recursive: true });
    const files: Record<string, string> = {};
    const put = async (name: string, body: string) => {
      await writeFile(path.join(dir, name), body);
      files[`composer/${name}`] = sha256Hex(body);
    };
    for (let i = 0; i < n; i++) {
      await put(`plan-${i}.json`, JSON.stringify({ system: 'S', prompt: `P${i}`, schema: 'plan_prose' }));
      if (withExpect) await put(`plan-${i}.expect.json`, JSON.stringify({ word_limits: { overview: 150 } }));
    }
    const roles = { composer: Array.from({ length: n }, (_, i) => `composer/plan-${i}.json`) };
    await writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ golden_set: 'text-v1', scorer_version: 'text-double', roles, files, golden_sha256: textManifestDigest(files) }),
    );
    return dir;
  }
  function textResponses() {
    return vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: 'resp',
          model: 'fixture/vision-1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(prose) }] }],
          usage: { input_tokens: 500, output_tokens: 80 },
        }),
      ),
    );
  }
  /** A content-check double; the real checks are P4's scoreTextFixture. */
  const scorer = (pass: boolean): TextScorer =>
    Object.assign(
      vi.fn(() => ({ pass, metrics: { t6_word_limits_met: pass ? 1 : 0 }, reasons: pass ? [] : ['over the word limit'] })),
      { version: 'text-double' },
    );

  it('discovers prompts and skips their *.expect.json siblings', async () => {
    const dir = await textFixtures(2);
    expect((await discoverFixtures(dir, 'composer')).map((f) => f.name)).toEqual(['plan-0.json', 'plan-1.json']);
  });

  it('refuses without the content checks or without an expect file for every prompt', async () => {
    const outDir = await preparedOutDir();
    const base = { apiKey: KEY, outDir, profile: textProfile, maxRequests: 10, spendCapMicros: 2_000_000, confirmPaidRequests: false };
    await expect(qualifyProfile({ ...base, fixturesDir: await textFixtures(5) })).rejects.toThrow('content checks');
    await expect(qualifyProfile({ ...base, fixturesDir: await textFixtures(5, false), textScorer: scorer(true) })).rejects.toThrow('expect.json');
    await expect(qualifyProfile({ ...base, fixturesDir: await textFixtures(4), textScorer: scorer(true) })).rejects.toThrow('at least 5');
  });

  it('refuses a composer profile that names an older prompt version (round 3: composer-v2), before any request', async () => {
    const fetchImpl = textResponses();
    await expect(
      qualifyProfile({
        apiKey: KEY,
        outDir: await preparedOutDir(),
        profile: { ...textProfile, promptVersion: 'composer-v1' },
        fixturesDir: await textFixtures(5),
        textScorer: scorer(true),
        maxRequests: 10,
        spendCapMicros: 2_000_000,
        confirmPaidRequests: true,
        fetch: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow('the composer prompts are composer-v2. Nothing was sent.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes only when every fixture passes its content checks; the artifact keeps aggregates only', async () => {
    const fixturesDir = await textFixtures(5);
    const outDir = await preparedOutDir();
    const base = { apiKey: KEY, outDir, profile: textProfile, fixturesDir, maxRequests: 20, spendCapMicros: 2_000_000, confirmPaidRequests: true };
    const good = scorer(true);
    const ok = await qualifyProfile({ ...base, textScorer: good, fetch: textResponses() as unknown as typeof fetch });
    expect(good).toHaveBeenCalledTimes(5);
    expect(ok.artifact).toMatchObject({
      result: 'pass',
      eval: { golden_set: 'text-v1', guardrail_version: null, scorer_version: 'text-double', pass: true, metrics: { fixtures_content_passed: 5 } },
    });
    expect(qualificationState(textProfile, outDir)).toBe('qualified');
    expect(await readFile(path.join(outDir, `${textProfile.qualificationArtifactId}.json`), 'utf8')).not.toContain('An evening plan');
    const bad = await qualifyProfile({ ...base, textScorer: scorer(false), fetch: textResponses() as unknown as typeof fetch });
    expect(bad.artifact).toMatchObject({ result: 'fail', fixtures: { passed: 5 }, eval: { pass: false } });
    expect(qualificationState(textProfile, outDir)).toBe('catalog-compatible');
  });

  it('qualifies only on the pinned golden set: a tampered, unlisted or missing fixture is refused before any request', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = textResponses();
    const base = { apiKey: KEY, outDir, profile: textProfile, maxRequests: 20, spendCapMicros: 2_000_000, confirmPaidRequests: true, textScorer: scorer(true), fetch: fetchImpl as unknown as typeof fetch };
    const tampered = await textFixtures(5);
    await writeFile(path.join(tampered, 'plan-0.json'), JSON.stringify({ system: 'S', prompt: 'changed', schema: 'plan_prose' }));
    await expect(qualifyProfile({ ...base, fixturesDir: tampered })).rejects.toThrow('composer/plan-0.json: sha256 differs');
    const unlisted = await textFixtures(5);
    await writeFile(path.join(unlisted, 'extra.json'), JSON.stringify({ system: 'S', prompt: 'X', schema: 'plan_prose' }));
    await expect(qualifyProfile({ ...base, fixturesDir: unlisted })).rejects.toThrow('not listed: extra.json');
    const missing = await textFixtures(5);
    await rm(path.join(missing, 'plan-4.expect.json'));
    await expect(qualifyProfile({ ...base, fixturesDir: missing })).rejects.toThrow('missing: plan-4.expect.json');
    const forged = await textFixtures(5);
    const manifestFile = path.join(path.dirname(forged), 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    await writeFile(manifestFile, JSON.stringify({ ...manifest, golden_sha256: '0'.repeat(64) }));
    await expect(qualifyProfile({ ...base, fixturesDir: forged })).rejects.toThrow('golden_sha256 does not match');
    const flat = path.join(await tmp('ca-text-flat-'), 'text-v1');
    await mkdir(flat);
    await expect(qualifyProfile({ ...base, fixturesDir: flat })).rejects.toThrow("golden set's composer/ directory");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('binds the manifest digest, the scorer version and T9/T10 into the eval block; a slow p95 fails', async () => {
    const fixturesDir = await textFixtures(5);
    const manifest = JSON.parse(await readFile(path.join(path.dirname(fixturesDir), 'manifest.json'), 'utf8'));
    const outDir = await preparedOutDir();
    const ok = await qualifyProfile({
      apiKey: KEY, outDir, profile: textProfile, fixturesDir, maxRequests: 20, spendCapMicros: 2_000_000, confirmPaidRequests: true,
      textScorer: scorer(true), fetch: textResponses() as unknown as typeof fetch,
    });
    expect(ok.artifact?.eval).toMatchObject({ golden_sha256: manifest.golden_sha256, metrics: { t10_fixtures_total: 5, t10_fixtures_passed: 5, t9_timeouts: 0, t1_valid_share: 1 } });
    // T9: a profile whose timeout every reply exceeds cannot qualify, even with every content check passing.
    const slowProfile = { ...textProfile, timeoutMs: 1, qualificationArtifactId: 'composer-slow' };
    const slowFetch = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return (textResponses() as unknown as () => Promise<Response>)();
    });
    const slow = await qualifyProfile({
      apiKey: KEY, outDir: await preparedOutDir(), profile: slowProfile, fixturesDir, maxRequests: 40, spendCapMicros: 2_000_000, confirmPaidRequests: true,
      textScorer: scorer(true), fetch: slowFetch as unknown as typeof fetch,
    });
    // Either the transport times out (a T9 timeout) or the p95 is over the timeout: never a pass.
    expect(slow.artifact).toMatchObject({ result: 'fail', eval: { pass: false } });
  });
});
