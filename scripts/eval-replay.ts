/**
 * Local replay of recorded readings against the golden labels (docs/quality-plan.md §7.3).
 * Makes no network calls. Real recordings stay outside git; only the scorecard is printed.
 *
 *   pnpm eval:replay --recordings <dir> [--golden fixtures/eval/golden-v1] \
 *     [--thresholds fixtures/eval/thresholds.json] [--pipeline guarded|unguarded|both] \
 *     [--mode replay|live] [--verifier on|off|both] [--out <file outside git>]
 *
 * --verifier both scores the guarded readings twice: with the recorded
 * verifier replies applied (eval:live --roles ...,vision_verify) and as if the
 * verifier were off, for the tune-split decision (docs/requalification-plan.md
 * step 3: forbidden_uncontested and M5_uncontested against M2's count and the
 * M5 gate).
 *
 * <dir> is either the replay format (manifest.json, as written by eval:live and
 * fixtures/eval/replay-v1) or the phase-4 layout (stage1/ and enrich/).
 */
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadGoldenSet, loadThresholds } from './eval/labels';
import { runtimeGuardedPipeline, runtimeGuardedPipelineWithoutVerifier, unguardedPipeline, type ReadingPipeline } from './eval/pipeline';
import { loadPhase4Recordings, loadReplayFixtures, runReplay, summarize } from './eval/replay';
import { scorerTeeth } from './eval/scorer';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const root = path.resolve(import.meta.dirname, '..');
const recordingsDir = arg('recordings');
if (!recordingsDir) {
  console.error('--recordings <dir> is required.');
  process.exit(2);
}
const golden = await loadGoldenSet(arg('golden', path.join(root, 'fixtures/eval/golden-v1'))!);
const { thresholds, sha256 } = await loadThresholds(arg('thresholds', path.join(root, 'fixtures/eval/thresholds.json'))!);
const mode = arg('mode', 'replay') === 'live' ? 'live' : 'replay';
const which = arg('pipeline', 'both');

const hasManifest = await access(path.join(recordingsDir, 'manifest.json')).then(
  () => true,
  () => false,
);
const loaded = hasManifest ? (await loadReplayFixtures(recordingsDir)).recordings : await loadPhase4Recordings(recordingsDir);
// Replay-format sets mark which recordings count toward the gates; the rest are reported as residual risks.
const recordings = loaded.filter((r) => !('gate' in r) || (r as { gate: boolean }).gate);
const residual = loaded.filter((r) => 'gate' in r && !(r as { gate: boolean }).gate);

const pipelines: ReadingPipeline[] = [];
if (which === 'unguarded' || which === 'both') pipelines.push(unguardedPipeline);
const verifier = arg('verifier', 'on');
if (which === 'guarded' || which === 'both') {
  if (verifier !== 'off') pipelines.push(runtimeGuardedPipeline);
  if (verifier === 'off' || verifier === 'both') pipelines.push(runtimeGuardedPipelineWithoutVerifier);
}
const results = pipelines.map((p) => runReplay(golden, recordings, p, thresholds, mode));
console.log(`[eval-replay] ${recordings.length} recording(s), thresholds ${thresholds.version} (${sha256.slice(0, 12)})`);
for (const r of results) for (const line of summarize(r)) console.log(line);
if (residual.length)
  for (const p of pipelines) {
    console.log(`residual risks (not gated), ${p.name}:`);
    for (const line of summarize(runReplay(golden, residual, p, thresholds, mode)).slice(1)) console.log(`  ${line}`);
  }
const unguarded = results.find((r) => r.pipeline === 'unguarded');
if (unguarded) console.log(`M17 scorer teeth (unguarded fails M1): ${scorerTeeth(unguarded.scorecard) ? 'yes' : 'NO'}`);
const out = arg('out');
if (out) {
  await writeFile(out, JSON.stringify(results.map((r) => ({ pipeline: r.pipeline, guardrail_version: r.guardrail_version, scorecard: r.scorecard })), null, 2), { mode: 0o600 });
  console.log(`[eval-replay] scorecards written to ${out}`);
}
const guarded = results.find((r) => r.pipeline === 'guarded') ?? results.find((r) => r.pipeline === 'guarded-without-verifier');
process.exit(guarded ? (guarded.scorecard.pass ? 0 : 1) : 0);
