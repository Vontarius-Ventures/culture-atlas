import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { GoldenSet, Thresholds } from './labels';
import type { GuardDecisionLike, ReadingPipeline, Recording } from './pipeline';
import { scoreRuns, type Scorecard, type ScoredRun } from './scorer';

/**
 * Replay of recorded readings through a pipeline and the scorer
 * (docs/quality-plan.md §7.3). Two recording layouts are read:
 *
 *  - replay format: <dir>/manifest.json + one JSON file per recording
 *    ({ quick, enrichment?, quick_ms?, enrich_ms? }); fixtures/eval/replay-v1
 *    holds the hand-written synthetic ones used by CI, eval:live writes real
 *    ones outside git in the same format;
 *  - phase-4 layout (real recordings, kept outside git): <dir>/stage1/NNN.json
 *    is a quick read of photo NNN, and <dir>/enrich/NNN.json alternates a quick
 *    read (odd NNN) and its enrichment (even NNN) for photo NNN/2. Each file
 *    holds { http, ms, status, output: "<json string>" }.
 */

export const ReplayManifestSchema = z
  .object({
    version: z.string().regex(/^replay-v\d+$/),
    golden_set: z.string().regex(/^golden-v\d+$/),
    /** Versions this recording set was last reviewed against; a change shows up as a test diff. */
    guardrail_version: z.string().min(1),
    scorer_version: z.string().min(1),
    thresholds_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    recordings: z
      .array(
        z
          .object({
            id: z.string().regex(/^(FIXTURE|LIVE)-[A-Za-z0-9-]+$/),
            photo: z.string().regex(/^(p|h)\d{2}$/),
            file: z.string().regex(/^(FIXTURE|LIVE)-[A-Za-z0-9-]+\.json$/),
            /** Counted toward the replay gates (§7.2). */
            gate: z.boolean(),
            /** Reading shape: v1 (categories, keep) or v2 (domain/evidence, verdict). */
            shape: z.enum(['v1', 'v2']),
            /** Error classes from the taxonomy (§1) this recording exercises. */
            covers: z.array(z.string().regex(/^E\d+$/)).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;

const RecordingFileSchema = z
  .object({
    quick: z.unknown(),
    enrichment: z.unknown().optional(),
    quick_ms: z.number().nonnegative().optional(),
    enrich_ms: z.number().nonnegative().optional(),
    /** Plan G (round 4): the token counts the live calls reported (information only, never scored). */
    quick_usage: z
      .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() })
      .strict()
      .optional(),
    enrich_usage: z
      .object({ inputTokens: z.number().optional(), outputTokens: z.number().optional() })
      .strict()
      .optional(),
    /** Legacy verifier reply (vlm-verify-v1/v2, after stage 2, advisory) when eval:live ran it. */
    verification: z.unknown().optional(),
    verify_ms: z.number().nonnegative().optional(),
    /** vlm-verify-v3: the stage-1 and stage-2 checks (null: the call failed, which blocks its targets). */
    verification1: z.unknown().optional(),
    verify1_ms: z.number().nonnegative().optional(),
    verification2: z.unknown().optional(),
    verify2_ms: z.number().nonnegative().optional(),
  })
  .strict();

export interface LoadedRecording extends Recording {
  gate: boolean;
  shape: 'v1' | 'v2';
  covers: string[];
}

export async function loadReplayFixtures(
  dir: string,
): Promise<{ manifest: ReplayManifest; recordings: LoadedRecording[] }> {
  const manifest = ReplayManifestSchema.parse(
    JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
  );
  const recordings: LoadedRecording[] = [];
  for (const r of manifest.recordings) {
    const body = RecordingFileSchema.parse(
      JSON.parse(await readFile(path.join(dir, r.file), 'utf8')),
    );
    recordings.push({
      photoId: r.photo,
      runId: r.id,
      quick: body.quick,
      enrichment: body.enrichment,
      quickMs: body.quick_ms,
      enrichMs: body.enrich_ms,
      ...(body.verification !== undefined
        ? { verification: body.verification, verifyMs: body.verify_ms }
        : {}),
      ...(body.verification1 !== undefined
        ? { verification1: body.verification1, verify1Ms: body.verify1_ms }
        : {}),
      ...(body.verification2 !== undefined
        ? { verification2: body.verification2, verify2Ms: body.verify2_ms }
        : {}),
      gate: r.gate,
      shape: r.shape,
      covers: r.covers,
    });
  }
  return { manifest, recordings };
}

const Phase4FileSchema = z
  .object({ http: z.number(), ms: z.number(), status: z.string(), output: z.string() })
  .loose();

async function readPhase4(file: string): Promise<{ ms: number; value: unknown } | null> {
  const body = Phase4FileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (body.http !== 200 || body.status !== 'completed') return null;
  return { ms: body.ms, value: JSON.parse(body.output) };
}

const isDir = async (p: string) => (await stat(p).catch(() => null))?.isDirectory() ?? false;

/** Reads the phase-4 recording layout; photo NNN maps to golden id pNN. */
export async function loadPhase4Recordings(dir: string): Promise<Recording[]> {
  const out: Recording[] = [];
  const photo = (n: number) => `p${String(n).padStart(2, '0')}`;
  if (await isDir(path.join(dir, 'stage1')))
    for (const f of (await readdir(path.join(dir, 'stage1')))
      .filter((x) => /^\d{3}\.json$/.test(x))
      .sort()) {
      const r = await readPhase4(path.join(dir, 'stage1', f));
      if (r)
        out.push({
          photoId: photo(Number(f.slice(0, 3))),
          runId: `stage1-${f.slice(0, 3)}`,
          quick: r.value,
          quickMs: r.ms,
        });
    }
  if (await isDir(path.join(dir, 'enrich'))) {
    const files = (await readdir(path.join(dir, 'enrich')))
      .filter((x) => /^\d{3}\.json$/.test(x))
      .sort();
    for (const f of files) {
      const n = Number(f.slice(0, 3));
      if (n % 2 === 0) continue;
      const quick = await readPhase4(path.join(dir, 'enrich', f));
      const enrichFile = `${String(n + 1).padStart(3, '0')}.json`;
      const enrich = files.includes(enrichFile)
        ? await readPhase4(path.join(dir, 'enrich', enrichFile))
        : null;
      if (!quick) continue;
      out.push({
        photoId: photo((n + 1) / 2),
        runId: `enrich-${f.slice(0, 3)}`,
        quick: quick.value,
        quickMs: quick.ms,
        ...(enrich ? { enrichment: enrich.value, enrichMs: enrich.ms } : {}),
      });
    }
  }
  if (!out.length) throw new Error(`No phase-4 recordings found under ${dir}`);
  return out;
}

export interface ReplayResult {
  pipeline: ReadingPipeline['name'];
  guardrail_version: string | null;
  scorecard: Scorecard;
  decisions: Record<string, GuardDecisionLike[]>;
  runs: ScoredRun[];
}

export function runReplay(
  golden: Pick<GoldenSet, 'labels'>,
  recordings: readonly Recording[],
  pipeline: ReadingPipeline,
  thresholds: Thresholds,
  mode: 'replay' | 'live' = 'replay',
): ReplayResult {
  const runs: ScoredRun[] = [];
  const decisions: Record<string, GuardDecisionLike[]> = {};
  for (const rec of recordings) {
    const { decisions: d, finalCandidates: _f, verify: _v, ...run } = pipeline.run(rec);
    runs.push(run);
    decisions[`${rec.photoId}/${rec.runId}`] = d;
  }
  return {
    pipeline: pipeline.name,
    guardrail_version: pipeline.guardrailVersion,
    scorecard: scoreRuns(golden.labels, runs, thresholds, mode),
    decisions,
    runs,
  };
}

/** Human-readable summary lines (no model text beyond candidate names). */
export function summarize(result: ReplayResult): string[] {
  const lines = [
    `pipeline ${result.pipeline} (guardrails ${result.guardrail_version ?? 'none'}), scorer ${result.scorecard.scorer_version}, thresholds ${result.scorecard.thresholds_version}`,
  ];
  for (const [split, s] of Object.entries(result.scorecard.splits)) {
    const m = Object.entries(s.metrics)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    lines.push(`${split}: ${s.pass ? 'PASS' : 'FAIL'} ${m}`);
    for (const f of s.failures) lines.push(`  fail: ${f}`);
    if (s.notApplicable.length) lines.push(`  not applicable: ${s.notApplicable.join(', ')}`);
  }
  for (const r of result.scorecard.rows) {
    const bad = [
      ...r.forbiddenNames.map((n) => `forbidden:${n}`),
      ...r.violations.map((v) => `${v.class}:${v.detail}`),
      ...r.visibleTextBad.map((t) => `visible_text:${t}`),
    ];
    if (bad.length || r.cleanDropped.length || r.unlabelledNames.length || r.visibleTextBad.length)
      lines.push(
        `  ${r.photoId}/${r.runId}: ${[...bad, ...r.cleanDropped.map((n) => `clean-dropped:${n}`), ...r.unlabelledNames.map((n) => `unlabelled:${n}`)].join('; ')}`,
      );
  }
  return lines;
}
