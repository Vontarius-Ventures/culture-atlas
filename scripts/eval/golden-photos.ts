import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { goldenDigest, sha256Hex, type GoldenSet, type ManifestPhoto, type Thresholds } from './labels';
import type { ReadingPipeline, Recording } from './pipeline';
import { scoreRuns, SCORER_VERSION, type Scorecard } from './scorer';

/**
 * Shared by qualification (scripts/qualify-concentrate-lib.ts) and the live
 * evaluation (scripts/eval-live.ts): golden photos are located outside git and
 * hash-checked before any request; outputs are scored in memory.
 */

export interface GoldenPhotoFile {
  photo: ManifestPhoto;
  path: string;
}

/** Every manifest photo (both splits) from `photosDir`, each verified against its pinned sha256. */
export async function verifiedGoldenPhotos(golden: GoldenSet, photosDir: string, split: 'all' | 'tune' | 'holdout' = 'all'): Promise<GoldenPhotoFile[]> {
  const out: GoldenPhotoFile[] = [];
  const problems: string[] = [];
  for (const photo of golden.manifest.photos) {
    if (split !== 'all' && photo.split !== split) continue;
    const file = path.join(photosDir, photo.file);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      problems.push(`${photo.id}: missing ${photo.file}`);
      continue;
    }
    if (sha256Hex(bytes) !== photo.sha256) problems.push(`${photo.id}: sha256 differs from the manifest`);
    else out.push({ photo, path: file });
  }
  if (problems.length)
    throw new Error(`Golden photos failed verification (run pnpm eval:fetch): ${problems.join('; ')}`);
  return out;
}

export interface FetchReport {
  fetched: string[];
  present: string[];
  withheld: string[];
  failed: string[];
}

/**
 * Downloads each golden photo from its pinned raw URL into `dest` (outside
 * git) and refuses any file whose sha256 differs from the manifest. Files
 * already present with the right hash are kept. Photos whose source is
 * withheld are reported for the operator to copy by hand.
 */
export async function fetchGoldenPhotos(input: {
  golden: GoldenSet;
  dest: string;
  fetch?: typeof fetch;
  split?: 'all' | 'tune' | 'holdout';
  log?: (line: string) => void;
}): Promise<FetchReport> {
  const fetchImpl = input.fetch ?? fetch;
  const log = input.log ?? (() => undefined);
  const report: FetchReport = { fetched: [], present: [], withheld: [], failed: [] };
  await mkdir(input.dest, { recursive: true, mode: 0o700 });
  for (const photo of input.golden.manifest.photos) {
    if (input.split && input.split !== 'all' && photo.split !== input.split) continue;
    const file = path.join(input.dest, photo.file);
    const existing = await readFile(file).catch(() => null);
    if (existing && sha256Hex(existing) === photo.sha256) {
      report.present.push(photo.id);
      continue;
    }
    if (!photo.source.raw_url) {
      report.withheld.push(photo.id);
      log(`${photo.id}: source withheld (${photo.source.withheld}); copy ${photo.file} into ${input.dest}`);
      continue;
    }
    try {
      const res = await fetchImpl(photo.source.raw_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (sha256Hex(bytes) !== photo.sha256) throw new Error('sha256 differs from the manifest; refusing the file');
      await writeFile(file, bytes, { mode: 0o600 });
      report.fetched.push(photo.id);
    } catch (error) {
      report.failed.push(photo.id);
      log(`${photo.id}: ${(error as Error).message}`);
    }
  }
  return report;
}

export interface PhotoEval {
  scorecard: Scorecard;
  block: {
    golden_set: string;
    golden_sha256: string;
    thresholds_sha256: string;
    guardrail_version: string | null;
    grounding_version: string | null;
    scorer_version: string;
    metrics: Record<string, number>;
    pass: boolean;
  };
}

/** Numeric metrics of every evaluated split, prefixed with the split name (aggregates only). */
export function flattenMetrics(scorecard: Scorecard): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [split, s] of Object.entries(scorecard.splits))
    for (const [k, v] of Object.entries(s.metrics)) if (typeof v === 'number' && Number.isFinite(v)) metrics[`${split}_${k}`] = v;
  return metrics;
}

/** Scores recorded readings against the live gates and builds the artifact eval block. */
export function evaluatePhotoRecordings(input: {
  golden: GoldenSet;
  thresholds: Thresholds;
  thresholdsSha256: string;
  pipeline: ReadingPipeline;
  recordings: readonly Recording[];
  /** Calls that failed (no recording), counted against M13. */
  failedCalls?: number;
}): PhotoEval {
  const runs = input.recordings.map((r) => {
    const { decisions: _d, finalCandidates: _f, ...run } = input.pipeline.run(r);
    return run;
  });
  const scorecard = scoreRuns(input.golden.labels, runs, input.thresholds, 'live');
  const requiredSplits = new Set(input.golden.manifest.photos.map((p) => p.split));
  const allSplitsScored = [...requiredSplits].every((s) => scorecard.splits[s]);
  const metrics = flattenMetrics(scorecard);
  // M13 counts only completed calls; a failed call (no recording) fails the evaluation outright.
  metrics.failed_calls = input.failedCalls ?? 0;
  return {
    scorecard,
    block: {
      golden_set: input.golden.manifest.version,
      golden_sha256: goldenDigest(input.golden),
      thresholds_sha256: input.thresholdsSha256,
      guardrail_version: input.pipeline.guardrailVersion,
      grounding_version: null,
      scorer_version: SCORER_VERSION,
      metrics,
      pass: scorecard.pass && allSplitsScored && !input.failedCalls,
    },
  };
}

/** Text-role content checks (P4's scripts/eval/text-scorer.ts, plan §8). */
export type TextScorer = ((
  schema: 'reference_notes' | 'plan_prose',
  expect: unknown,
  output: unknown,
) => { pass: boolean; metrics: Record<string, number>; reasons: string[] }) & { version?: string };

/** Loads P4's scoreTextFixture, or null when the module is not present (text qualification then refuses). */
export async function loadTextScorer(): Promise<TextScorer | null> {
  const file = new URL('./text-scorer.ts', import.meta.url);
  try {
    await access(file);
  } catch {
    return null;
  }
  const mod = (await import(/* @vite-ignore */ file.href)) as { scoreTextFixture?: unknown; TEXT_SCORER_VERSION?: unknown };
  if (typeof mod.scoreTextFixture !== 'function') throw new Error('scripts/eval/text-scorer.ts does not export scoreTextFixture');
  const score = mod.scoreTextFixture as TextScorer;
  const version = typeof mod.TEXT_SCORER_VERSION === 'string' ? mod.TEXT_SCORER_VERSION : undefined;
  return Object.assign((...args: Parameters<TextScorer>) => score(...args), { version });
}

/** Digest of a text golden set directory: sorted file names and contents. */
export async function textGoldenDigest(dir: string): Promise<string> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const parts: string[] = [];
  for (const f of files) parts.push(f, sha256Hex(await readFile(path.join(dir, f))));
  return sha256Hex(parts.join('\n'));
}
