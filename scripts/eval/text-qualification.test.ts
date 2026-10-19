import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../../packages/providers/src/index';
import { fetchCatalog, qualifyProfile } from '../qualify-concentrate-lib';
import { readFile } from 'node:fs/promises';
import { TEXT_V1_DIR } from './build-text-fixtures';
import { runtimeTextScorer } from './golden-photos';
import { TEXT_FIXTURE_SCHEMAS } from './text-schemas';
import { TEXT_SCORER_VERSION } from './text-scorer';

/**
 * Offline: the text-v1 golden set runs through the operator qualification
 * harness with a fake gateway. Proves the fixtures are accepted, each request
 * carries the production wire schema name and output cap, and a role is never
 * qualified on another role's prompts. Not a qualification of any live model.
 */
const KEY = 'synthetic-operator-key-never-written';
const manifest = JSON.parse(await readFile(path.join(TEXT_V1_DIR, 'manifest.json'), 'utf8')) as { golden_sha256: string };
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const base: ModelProfile = {
  gateway: 'concentrate',
  role: 'composer',
  version: 'composer-test',
  model: 'fixture/text-1',
  provider: 'fixture',
  allowedFallbackProviders: [],
  maxOutputTokens: 1500,
  reasoningEffort: 'none',
  maxInputTokens: 60_000,
  maxInputBytes: 120_000,
  image: { maxBytes: 0, maxPixels: 0, maxDimension: 0, maxCount: 0 },
  timeoutMs: 12_000,
  structuredOutput: true,
  requireZdr: true,
  providerZdrEligible: true,
  contentLoggingEnabled: false,
  privacyVerifiedAt: '2026-10-15T00:00:00Z',
  promptVersion: 'composer-test',
  schemaVersion: 'composer-test',
  catalogSnapshotAt: '2026-10-16T12:00:00.000Z',
  qualificationArtifactId: 'composer-offline-test',
  pricingSnapshotVersion: 'price-1',
  reservationMicros: 2_000,
};
const research: ModelProfile = {
  ...base,
  role: 'research_text',
  version: 'research-test',
  maxOutputTokens: 4000,
  promptVersion: 'research-test',
  schemaVersion: 'research-test',
  qualificationArtifactId: 'research-offline-test',
};

/** Schema-valid, strict-shape replies keyed by what the request asks for. */
function replyFor(body: { text: { format: { name: string } }; input: Array<{ content: Array<{ text: string }> }> }): unknown {
  const prompt = body.input[0]!.content[0]!.text;
  switch (body.text.format.name) {
    case 'reference_notes':
      return { overview_claim_indexes: [0], sections: [], claims: [{ text: 'FIXTURE claim.', claim_type: 'interpretive', source_urls: [] }] };
    case 'plan_prose':
      return { title: 'FIXTURE title', summary: 'FIXTURE summary.', rationale: null };
    case 'film_ideas':
      return { films: [{ title: 'FIXTURE film', year: 2000, inputs: ['i1'], reason: 'FIXTURE.' }] };
    case 'artist_ideas':
      return { artists: [{ name: 'FIXTURE artist', inputs: ['i1'], reason: 'FIXTURE.' }] };
    case 'dish_ideas':
      // Two production calls share this wire name; the Eat call carries a <references> block.
      return prompt.includes('<references format="json">')
        ? { dishes: [{ name: 'FIXTURE dish', cuisine: 'FIXTURE', reason: 'FIXTURE.', reference_names: ['FIXTURE'] }] }
        : { dishes: [{ title: 'FIXTURE dish', description: 'FIXTURE.', cuisine: null, ingredients: [], inputs: ['i1'], reason: 'FIXTURE.' }] };
    default:
      throw new Error(`unexpected schema ${body.text.format.name}`);
  }
}

async function preparedOutDir() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'ca-text-qual-'));
  dirs.push(outDir);
  await fetchCatalog({
    apiKey: KEY,
    outDir,
    fetch: (async () =>
      new Response(JSON.stringify({ data: [{ id: 'fixture/text-1', providers: [{ name: 'fixture' }] }], has_more: false }))) as unknown as typeof fetch,
    now: () => new Date('2026-10-16T12:00:00Z'),
  });
  return outDir;
}

function gateway() {
  const bodies: Array<Record<string, unknown> & { max_output_tokens: number; text: { format: { name: string } }; input: Array<{ content: Array<{ text: string }> }> }> = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    bodies.push(body);
    return new Response(
      JSON.stringify({
        id: 'resp',
        model: 'fixture/text-1',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(replyFor(body)) }] }],
        usage: { input_tokens: 900, output_tokens: 120 },
      }),
    );
  });
  return { bodies, fetchImpl };
}

describe('text-v1 through the qualification harness (fake gateway)', () => {
  it('composer: every fixture is sent with its production wire name and output cap', async () => {
    const outDir = await preparedOutDir();
    const { bodies, fetchImpl } = gateway();
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile: base,
      fixturesDir: path.join(TEXT_V1_DIR, 'composer'),
      textScorer: runtimeTextScorer,
      maxRequests: 11,
      spendCapMicros: 1_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    // Every request went through and parsed (transport), but the placeholder replies say
    // nothing the content checks accept, so the role is not qualified on them.
    expect(run.artifact).toMatchObject({
      result: 'fail',
      role: 'composer',
      requests_sent: 11,
      fixtures: { total: 11, passed: 11 },
      eval: { golden_set: 'text-v1', golden_sha256: manifest.golden_sha256, scorer_version: TEXT_SCORER_VERSION, pass: false },
    });
    expect(run.artifact!.eval!.metrics.fixtures_content_passed).toBeLessThan(11);
    const caps = new Map<string, Set<number>>();
    for (const b of bodies) {
      const set = caps.get(b.text.format.name) ?? new Set<number>();
      set.add(b.max_output_tokens);
      caps.set(b.text.format.name, set);
    }
    expect(Object.fromEntries([...caps].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))).toEqual({
      artist_ideas: [TEXT_FIXTURE_SCHEMAS.artist_ideas.maxTokens],
      dish_ideas: [TEXT_FIXTURE_SCHEMAS.plan_dish_ideas.maxTokens, TEXT_FIXTURE_SCHEMAS.eat_dish_ideas.maxTokens],
      film_ideas: [TEXT_FIXTURE_SCHEMAS.film_ideas.maxTokens],
      plan_prose: [TEXT_FIXTURE_SCHEMAS.plan_prose.maxTokens],
    });
    // Three Eat calls (the photo-analysis path) are part of the composer run.
    expect(bodies.filter((b) => b.input[0]!.content[0]!.text.includes('<references format="json">'))).toHaveLength(3);
  });

  it('research_text: six fixtures at the 4000-token production cap', async () => {
    const outDir = await preparedOutDir();
    const { bodies, fetchImpl } = gateway();
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile: research,
      fixturesDir: path.join(TEXT_V1_DIR, 'research_text'),
      textScorer: runtimeTextScorer,
      maxRequests: 6,
      spendCapMicros: 1_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    // One interpretive placeholder claim: transport passes, T4 (two kept claims) fails the content checks.
    expect(run.artifact).toMatchObject({ result: 'fail', role: 'research_text', requests_sent: 6, fixtures: { passed: 6 }, eval: { golden_set: 'text-v1', pass: false } });
    expect(bodies.every((b) => b.text.format.name === 'reference_notes' && b.max_output_tokens === 4000)).toBe(true);
  });

  it('logs every request to the call ledger without its body, reply or key', async () => {
    const outDir = await preparedOutDir();
    const { fetchImpl } = gateway();
    const ledgerFile = path.join(outDir, 'ledger.jsonl');
    await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile: research,
      fixturesDir: path.join(TEXT_V1_DIR, 'research_text'),
      textScorer: runtimeTextScorer,
      maxRequests: 6,
      spendCapMicros: 1_000_000,
      confirmPaidRequests: true,
      fetch: fetchImpl as unknown as typeof fetch,
      ledgerFile,
      ledgerPackage: 'evaluate',
    });
    const raw = await readFile(ledgerFile, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(6);
    for (const l of lines) {
      expect(Object.keys(l).sort()).toEqual(['endpoint', 'ms', 'package', 'provider', 'status', 'ts']);
      expect(l).toMatchObject({ package: 'evaluate', provider: 'concentrate', status: 200 });
    }
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain('FIXTURE claim');
  });

  it('refuses another role’s fixtures before sending anything, even on a dry run', async () => {
    const outDir = await preparedOutDir();
    const { fetchImpl } = gateway();
    for (const confirmPaidRequests of [false, true])
      await expect(
        qualifyProfile({
          apiKey: KEY,
          outDir,
          profile: research,
          fixturesDir: path.join(TEXT_V1_DIR, 'composer'),
          textScorer: runtimeTextScorer,
          maxRequests: 20,
          spendCapMicros: 1_000_000,
          confirmPaidRequests,
          fetch: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toThrow(/belongs to role composer, not research_text/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dry run plans one request per fixture and ignores the expect files', async () => {
    const outDir = await preparedOutDir();
    const lines: string[] = [];
    const run = await qualifyProfile({
      apiKey: KEY,
      outDir,
      profile: base,
      fixturesDir: path.join(TEXT_V1_DIR, 'composer'),
      textScorer: runtimeTextScorer,
      maxRequests: 11,
      spendCapMicros: 1_000_000,
      confirmPaidRequests: false,
      log: (l) => lines.push(l),
    });
    expect(run).toEqual({ dryRun: true, plannedRequests: 11 });
    expect(lines.join('\n')).toMatch(/plan: 11 fixtures, 11 requests/);
  });
});
