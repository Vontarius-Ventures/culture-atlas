import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  profileHash,
  qualificationState,
  type ModelProfile,
} from '../packages/providers/src/index';
import { solidJpeg } from '../packages/providers/src/testing/images';
import { fetchCatalog, qualifyProfile, readApiKey } from './qualify-concentrate-lib';

/**
 * Offline tests of the operator qualification harness (fake fetch only). They
 * prove the safety rails; they are NOT a qualification of any live model.
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
  maxOutputTokens: 2000,
  maxInputTokens: 200_000,
  maxInputBytes: 200_000,
  image: { maxBytes: 80_000, maxPixels: 300_000, maxDimension: 512, maxCount: 1 },
  timeoutMs: 30_000,
  structuredOutput: true,
  requireZdr: true,
  providerZdrEligible: true,
  contentLoggingEnabled: false,
  privacyVerifiedAt: '2026-10-15T00:00:00Z',
  promptVersion: 'vlm-p1',
  schemaVersion: 'atlas_observations_v2',
  catalogSnapshotAt: '2026-10-16T12:00:00.000Z',
  qualificationArtifactId: 'vision-photo-2026-10-16',
  pricingSnapshotVersion: 'price-1',
  reservationMicros: 20_000,
};
const vision = {
  title: 'Table',
  interpretation: 'A table that resembles mid-century design.',
  observations: [{ id: 'o1', text: 'Round table', kind: 'object', region_ids: [] }],
  visible_text: [],
  candidates: [],
  regions: [],
  uncertainty: { overall: 'medium', notes: [] },
  competing_subjects: [],
  quality: { usable: true, issue: null },
};
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
async function photos(n: number) {
  const dir = await tmp('ca-qfix-');
  for (let i = 0; i < n; i++)
    await writeFile(
      path.join(dir, `photo-${String(i).padStart(2, '0')}.jpg`),
      await solidJpeg(900, 700, `#${(i * 20).toString(16).padStart(2, '0')}5050`),
    );
  return dir;
}
function responses(status = 200) {
  return vi.fn(async () =>
    status === 200
      ? new Response(
          JSON.stringify({
            id: 'resp',
            model: 'fixture/vision-1',
            status: 'completed',
            output: [
              { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(vision) }] },
            ],
            usage: { input_tokens: 1000, output_tokens: 120 },
          }),
        )
      : new Response('{"error":{"message":"PRIVATE"}}', { status }),
  );
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

  it('dry run plans and sends nothing; refuses fewer than 10 owned photos or a plan above the caps', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses();
    const base = {
      apiKey: KEY,
      outDir,
      profile,
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      fetch: fetchImpl as unknown as typeof fetch,
    };
    await expect(
      qualifyProfile({ ...base, fixturesDir: await photos(10), confirmPaidRequests: false }),
    ).resolves.toEqual({ dryRun: true, plannedRequests: 10 });
    await expect(
      qualifyProfile({ ...base, fixturesDir: await photos(9), confirmPaidRequests: true }),
    ).rejects.toThrow('at least 10');
    await expect(
      qualifyProfile({
        ...base,
        maxRequests: 5,
        fixturesDir: await photos(10),
        confirmPaidRequests: true,
      }),
    ).rejects.toThrow('--max-requests');
    await expect(
      qualifyProfile({
        ...base,
        spendCapMicros: 100_000,
        fixturesDir: await photos(10),
        confirmPaidRequests: true,
      }),
    ).rejects.toThrow('spend cap');
    await expect(
      qualifyProfile({
        ...base,
        profile: { ...profile, model: 'fixture/not-in-catalog' },
        fixturesDir: await photos(10),
        confirmPaidRequests: false,
      }),
    ).rejects.toThrow('catalog-compatible');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a confirmed passing run writes an aggregate-only artifact that makes the profile qualified', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses();
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      fixturesDir: await photos(10),
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
    });
    expect(qualificationState(profile, outDir)).toBe('qualified');
    const artifact = await readFile(
      path.join(outDir, `${profile.qualificationArtifactId}.json`),
      'utf8',
    );
    expect(artifact).not.toContain(KEY);
    expect(artifact).not.toContain('Round table');
    expect(artifact).not.toMatch(/base64|\/9j\//);
    // The persistent counter survives re-runs: only 2 more requests fit under a cap of 12.
    const again = responses();
    const rerun = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      fixturesDir: await photos(10),
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      confirmPaidRequests: true,
      fetch: again as unknown as typeof fetch,
    });
    expect(again).toHaveBeenCalledTimes(2);
    expect(rerun).toMatchObject({ stoppedBy: 'request_cap', artifact: { result: 'fail' } });
    expect(qualificationState(profile, outDir)).toBe('catalog-compatible');
  });

  it('two-stage: qualifies the quick read with its reasoning effort, then enrichment on real stage-1 readings', async () => {
    const quick: ModelProfile = {
      ...profile,
      promptVersion: 'vlm-quick-v1',
      schemaVersion: 'atlas_quick_read_v1',
      reasoningEffort: 'none',
      maxOutputTokens: 600,
      qualificationArtifactId: 'vision-photo-quick-2026-10-18',
    };
    const enrich: ModelProfile = {
      ...profile,
      role: 'vision_photo_enrich',
      promptVersion: 'vlm-enrich-v1',
      schemaVersion: 'atlas_enrichment_v1',
      reasoningEffort: 'none',
      maxOutputTokens: 1200,
      timeoutMs: 20_000,
      image: { maxBytes: 150_000, maxPixels: 589_824, maxDimension: 768, maxCount: 1 },
      qualificationArtifactId: 'vision-photo-enrich-2026-10-18',
    };
    const quickRead = {
      title: 'Round table',
      interpretation: 'A table that resembles mid-century design.',
      candidates: [{ name: 'Mid-century modern', type: 'style', relation: 'resembles', certainty: 0.7, categories: ['wear'], tag_query: 'mid-century modern' }],
      quality: { usable: true, issue: null },
    };
    const enrichment = {
      observations: [{ text: 'Round table', kind: 'object' }],
      visible_text: [],
      confirmed: [{ name: 'Mid-century modern', rationale: 'Tapered legs', keep: true }],
      additional_candidates: [],
      regions: [],
      uncertainty: { overall: 'low', notes: [] },
      competing_subjects: [],
    };
    const bodies: Array<Record<string, unknown> & { text: { format: { name: string } } }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      bodies.push(body);
      const text = JSON.stringify(body.text.format.name === 'atlas_enrichment_v1' ? enrichment : quickRead);
      return new Response(
        JSON.stringify({
          id: 'resp',
          model: 'fixture/vision-1',
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: 1600, output_tokens: 300 },
        }),
      );
    });
    const outDir = await preparedOutDir();
    const fixturesDir = await photos(10);
    const common = { apiKey: KEY, outDir, fixturesDir, spendCapMicros: 2_000_000, fetch: fetchImpl as unknown as typeof fetch };

    const q = await qualifyProfile({ ...common, profile: quick, maxRequests: 10, confirmPaidRequests: true });
    expect(q.artifact).toMatchObject({ result: 'pass', role: 'vision_photo', requests_sent: 10 });
    expect(q.artifact!.notes).toEqual(
      expect.arrayContaining([
        'Reading: quick (prompt vlm-quick-v1, schema atlas_quick_read_v1).',
        'Reasoning effort: none (sent as reasoning.effort on every request).',
      ]),
    );
    expect(bodies.every((b) => b.text.format.name === 'atlas_quick_read_v1')).toBe(true);
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
      qualifyProfile({ ...common, profile: enrich, stage1Profile: { ...profile }, maxRequests: 40, confirmPaidRequests: false }),
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
      Array.from({ length: 10 }, () => ['atlas_quick_read_v1', 'atlas_enrichment_v1']).flat(),
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
    });
    expect(e.artifact!.notes.some((n) => n.startsWith('Stage-1 input from fixture/vision-1 quick read'))).toBe(true);
    expect(qualificationState(enrich, outDir)).toBe('qualified');
    const artifact = await readFile(path.join(outDir, `${enrich.qualificationArtifactId}.json`), 'utf8');
    expect(artifact).not.toContain('Tapered legs');
    expect(artifact).not.toContain(KEY);
  });

  it('stops at the first 402 (no retry, no further spend) and records a failing artifact', async () => {
    const outDir = await preparedOutDir();
    const fetchImpl = responses(402);
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile,
      fixturesDir: await photos(10),
      maxRequests: 12,
      spendCapMicros: 2_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({
      stoppedBy: 'http_402',
      artifact: { result: 'fail', fixtures: { outcomes: { http_402: 1 } } },
    });
    expect(JSON.stringify(run.artifact)).not.toContain('PRIVATE');
  });
});
