import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REQUIRED_GUARDRAIL_VERSION } from '../../packages/providers/src/concentrate/profiles';
import { VlmEnrichment, VlmQuickRead } from '../../packages/providers/src/vlm/types';
import { loadGoldenSet, loadThresholds } from './labels';
import { guardedPipeline, loadGuardModule, unguardedPipeline } from './pipeline';
import { loadPhase4Recordings, loadReplayFixtures, runReplay } from './replay';
import { SCORER_VERSION, scorerTeeth } from './scorer';

/**
 * Hermetic CI replay (docs/quality-plan.md §7.3): hand-written synthetic
 * readings (fixtures/eval/replay-v1, FIXTURE- ids, no model output, no images)
 * through toVlmAnalysis -> guardQuickRead -> mergeEnrichmentContext ->
 * guardEnrichment -> scorer, against the golden-v1 tuning labels.
 */
const root = path.resolve(import.meta.dirname, '../..');
const golden = await loadGoldenSet(path.join(root, 'fixtures/eval/golden-v1'));
const { thresholds, sha256: thresholdsSha } = await loadThresholds(path.join(root, 'fixtures/eval/thresholds.json'));
const { manifest, recordings } = await loadReplayFixtures(path.join(root, 'fixtures/eval/replay-v1'));
const gated = recordings.filter((r) => r.gate);
// The guardrails module (P1) is loaded when present; a present but malformed module throws here.
const guards = await loadGuardModule();
/** Readings the providers' current schemas parse (v2-shape recordings need the reading-v2 schema). */
const parseable = (r: (typeof recordings)[number]) =>
  VlmQuickRead.safeParse(r.quick).success && (r.enrichment === undefined || VlmEnrichment.safeParse(r.enrichment).success);

describe('replay-v1 recordings (fixtures/eval/replay-v1)', () => {
  it('are hand-written FIXTURE- readings for labelled tuning photos', () => {
    expect(recordings.length).toBeGreaterThanOrEqual(15);
    for (const r of manifest.recordings) {
      expect(r.id).toMatch(/^FIXTURE-/);
      expect(r.covers.length).toBeGreaterThan(0);
      expect(golden.labels.get(r.photo)?.split).toBe('tune');
    }
  });

  it('cover every reading-level error class of §1 (E11, E12 and E15 are Qloo, seed and text: P3 and P4)', () => {
    const covered = new Set(manifest.recordings.filter((r) => r.gate).flatMap((r) => r.covers));
    for (const e of ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E8', 'E9', 'E10', 'E13', 'E14']) expect(covered).toContain(e);
    expect(new Set(manifest.recordings.map((r) => r.shape))).toEqual(new Set(['v1', 'v2']));
  });

  it('name the current scorer, thresholds and guardrail versions, so a silent rule change is a test diff', () => {
    expect(manifest.golden_set).toBe(golden.manifest.version);
    expect(manifest.scorer_version).toBe(SCORER_VERSION);
    expect(manifest.thresholds_sha256).toBe(thresholdsSha);
    expect(manifest.guardrail_version).toBe(REQUIRED_GUARDRAIL_VERSION);
    if (guards) expect(guards.GUARDRAIL_VERSION).toBe(REQUIRED_GUARDRAIL_VERSION);
  });
});

describe('M17: the scorer has teeth', () => {
  it('the unguarded readings fail M1 and the replay gates', () => {
    const v1 = gated.filter(parseable);
    expect(v1.length).toBeGreaterThanOrEqual(10);
    const result = runReplay(golden, v1, unguardedPipeline, thresholds, 'replay');
    expect(scorerTeeth(result.scorecard)).toBe(true);
    expect(result.scorecard.splits.tune!.metrics.M1).toBeGreaterThan(5);
    expect(result.scorecard.pass).toBe(false);
    const failed = result.scorecard.splits.tune!.gates.filter((g) => !g.pass).map((g) => g.metric);
    expect(failed).toEqual(expect.arrayContaining(['M1', 'M2', 'M6', 'M7', 'M8', 'M10', 'M11']));
  });
});

// Runs whenever packages/providers/src/vlm/guardrails.ts exists (P1). Until that module is
// merged there is nothing to replay through, and photo qualification refuses to run
// (qualify-concentrate.test.ts "fails closed without the guarded pipeline").
describe.runIf(guards)('guarded replay (§7.3)', () => {
  it('passes every replay gate on the gated recordings', () => {
    const result = runReplay(golden, gated, guardedPipeline(guards!), thresholds, 'replay');
    const tune = result.scorecard.splits.tune!;
    expect(tune.failures).toEqual([]);
    expect(tune.notApplicable).toEqual([]);
    expect(result.scorecard.pass).toBe(true);
  });

  it('the same recordings without guards fail M1 (M17 on the full set)', () => {
    expect(scorerTeeth(runReplay(golden, gated, unguardedPipeline, thresholds, 'replay').scorecard)).toBe(true);
  });

  it('records a decision for every candidate the reading emitted at stage 1', () => {
    const result = runReplay(golden, gated, guardedPipeline(guards!), thresholds, 'replay');
    for (const rec of gated) {
      const decisions = result.decisions[`${rec.photoId}/${rec.runId}`]!;
      expect(decisions.length).toBeGreaterThan(0);
    }
  });
});

describe('phase-4 recording layout (local real recordings, never committed)', () => {
  it('pairs quick reads with their enrichments and maps photo numbers to golden ids', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-p4-'));
    await mkdir(path.join(dir, 'stage1'));
    await mkdir(path.join(dir, 'enrich'));
    const quick = { title: 'T', interpretation: 'I.', candidates: [], quality: { usable: true, issue: null } };
    const body = (output: unknown, ms = 1000) => JSON.stringify({ http: 200, ms, status: 'completed', output: JSON.stringify(output) });
    await writeFile(path.join(dir, 'stage1', '013.json'), body(quick, 2100));
    await writeFile(path.join(dir, 'enrich', '001.json'), body(quick, 1900));
    await writeFile(path.join(dir, 'enrich', '002.json'), body({ observations: [] }, 4000));
    await writeFile(path.join(dir, 'enrich', '003.json'), JSON.stringify({ http: 429, ms: 10, status: 'failed', output: '' }));
    const recs = await loadPhase4Recordings(dir);
    expect(recs.map((r) => [r.photoId, r.runId, r.enrichment !== undefined, r.quickMs])).toEqual([
      ['p13', 'stage1-013', false, 2100],
      ['p01', 'enrich-001', true, 1900],
    ]);
  });
});
