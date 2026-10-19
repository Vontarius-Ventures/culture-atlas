import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CATALOG_SNAPSHOT_FILE,
  CatalogSnapshotSchema,
  ConcentrateTextModel,
  ConcentrateVlm,
  ConcentrateVlmEnricher,
  MemorySpendStore,
  ModelSpendLedger,
  ProviderError,
  QUALIFICATION_MINIMUM_FIXTURES,
  QualificationArtifactSchema,
  StructuredResponseRunner,
  boundJpegForProfile,
  catalogCompatible,
  createConcentrateTransport,
  fetchCatalogSnapshot,
  profileHash,
  readingForProfile,
  type CatalogSnapshot,
  type ModelProfile,
  type QualificationArtifact,
} from '../packages/providers/src/index';
import { RawExtraction } from '../packages/providers/src/research/wikipedia';
import { PlanProse } from '../packages/domain/src/composer/creative';
import { REQUIRED_GOLDEN_SET, type EvalBlock } from '../packages/providers/src/concentrate/profiles';
import { evaluatePhotoRecordings, textGoldenDigest, verifiedGoldenPhotos, type TextScorer } from './eval/golden-photos';
import { loadGoldenSet, loadThresholds, type GoldenSet } from './eval/labels';
import type { ReadingPipeline, Recording } from './eval/pipeline';

/** Pass thresholds of the evaluation (docs/quality-plan.md §7.2). */
export const DEFAULT_THRESHOLDS = path.resolve(import.meta.dirname, '../fixtures/eval/thresholds.json');

/**
 * Deliberate operator qualification of ONE Concentrate role profile
 * (CONCENTRATE.md "Implementation and qualification gates"). Library for
 * scripts/qualify-concentrate.ts so the request counter, catalog paging,
 * dry run and artifact rules are testable offline.
 *
 * Safety rules:
 *  - Catalog listing (GET /v1/models) is not inference; it still needs the key.
 *  - Inference only with confirmPaidRequests, under a hard request counter that
 *    is persisted BEFORE every request and survives crashes/re-runs, and a
 *    spend cap computed from the profile's worst-case reservation.
 *  - No retries anywhere (runner maxRetries 0, transport single attempt).
 *  - Stops on 401/402/404/422/429. Never stores media, prompts, outputs or keys:
 *    the artifact holds aggregate counts, latency and usage only.
 */

const COUNTER_FILE = '.qualification-request-counter.json';

export interface QualifyOptions {
  apiKey: string;
  outDir: string;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Reads the key from a private file (0600-style) or returns the env value. */
export async function readApiKey(input: { keyFile?: string; env?: string }): Promise<string> {
  if (input.keyFile) {
    const info = await stat(input.keyFile);
    if (info.mode & 0o077)
      throw new Error('Key file must not be readable by group or others (chmod 600).');
    const key = (await readFile(input.keyFile, 'utf8')).trim();
    if (!key) throw new Error('Key file is empty.');
    return key;
  }
  if (input.env?.trim()) return input.env.trim();
  throw new Error('Set CONCENTRATE_API_KEY_FILE (preferred) or CONCENTRATE_API_KEY.');
}

/** Paginated catalog snapshot written to <outDir>/catalog-snapshot.json (no inference). */
export async function fetchCatalog(opts: QualifyOptions): Promise<CatalogSnapshot> {
  const snapshot = await fetchCatalogSnapshot({
    apiKey: opts.apiKey,
    fetch: opts.fetch,
    now: opts.now,
  });
  await mkdir(opts.outDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(opts.outDir, CATALOG_SNAPSHOT_FILE),
    JSON.stringify(snapshot, null, 2),
    { mode: 0o600 },
  );
  return snapshot;
}

/** Persistent hard counter: reserved before each request, never decremented. */
export class RequestCounter {
  constructor(
    private readonly file: string,
    private readonly max: number,
  ) {}
  async used(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch {
      return 0;
    }
    const sent = (JSON.parse(raw) as { sent?: unknown }).sent;
    // A corrupt counter must never reset the cap to zero.
    if (typeof sent !== 'number' || !Number.isSafeInteger(sent) || sent < 0)
      throw new Error('Request counter is unreadable; refusing to send.');
    return sent;
  }
  async reserve(): Promise<void> {
    const sent = await this.used();
    if (sent >= this.max)
      throw new Error(
        `Request cap reached (${sent}/${this.max}). Raise --max-requests deliberately.`,
      );
    await writeFile(this.file, JSON.stringify({ sent: sent + 1 }), { mode: 0o600 });
  }
}

export interface Fixture {
  name: string;
  kind: 'image' | 'video' | 'text';
  /** image: one file; video: ordered frames with timestamps; text: JSON prompt file. */
  files: Array<{ path: string; timestampMs?: number }>;
}

/** Fixture layout: photos as files; videos as directories of <timestamp_ms>.jpg frames; text as *.json. */
export async function discoverFixtures(
  dir: string,
  role: ModelProfile['role'],
): Promise<Fixture[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  // Both photo stages (quick read and enrichment) qualify on the same owned photos.
  if (role === 'vision_photo' || role === 'vision_photo_enrich')
    return entries
      .filter((e) => e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name))
      .map((e) => ({ name: e.name, kind: 'image', files: [{ path: path.join(dir, e.name) }] }));
  if (role === 'vision_video_frame') {
    const videos: Fixture[] = [];
    for (const e of entries.filter((x) => x.isDirectory())) {
      const frames = (await readdir(path.join(dir, e.name)))
        .filter((f) => /^\d+\.(jpe?g|png)$/i.test(f))
        .map((f) => ({ path: path.join(dir, e.name, f), timestampMs: Number(f.split('.')[0]) }))
        .sort((a, b) => a.timestampMs - b.timestampMs)
        .slice(0, 8);
      if (frames.length) videos.push({ name: e.name, kind: 'video', files: frames });
    }
    return videos;
  }
  // Text fixtures are <name>.json prompts; <name>.expect.json holds their content checks (plan §8).
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json') && !e.name.endsWith('.expect.json'))
    .map((e) => ({ name: e.name, kind: 'text', files: [{ path: path.join(dir, e.name) }] }));
}

/** The content-check file next to a text fixture: foo.json -> foo.expect.json. */
export function expectFileFor(fixturePath: string): string {
  return fixturePath.replace(/\.json$/, '.expect.json');
}

const PHOTO_ROLES: readonly ModelProfile['role'][] = ['vision_photo', 'vision_photo_enrich'];
const TEXT_ROLES: readonly ModelProfile['role'][] = ['research_text', 'composer'];

function textFixture(value: unknown): {
  system: string;
  prompt: string;
  schema: 'reference_notes' | 'plan_prose';
} {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    typeof v.system !== 'string' ||
    !v.system ||
    typeof v.prompt !== 'string' ||
    !v.prompt ||
    (v.schema !== 'reference_notes' && v.schema !== 'plan_prose') ||
    Object.keys(v).some((k) => !['system', 'prompt', 'schema'].includes(k))
  )
    throw new Error('Text fixture must be {system, prompt, schema: reference_notes|plan_prose}.');
  return { system: v.system, prompt: v.prompt, schema: v.schema };
}

export interface QualificationRun {
  dryRun: boolean;
  plannedRequests: number;
  artifact?: QualificationArtifact;
  stoppedBy?: string;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Safe artifact note naming the reasoning effort the run sent (FAST-03). */
export function effortNote(profile: ModelProfile): string {
  return profile.reasoningEffort
    ? `Reasoning effort: ${profile.reasoningEffort} (sent as reasoning.effort on every request).`
    : 'Reasoning effort: not set (no reasoning field sent).';
}

export async function qualifyProfile(
  opts: QualifyOptions & {
    profile: ModelProfile;
    /** vision_video_frame and text roles: the fixture directory. Photo roles use `golden` instead. */
    fixturesDir?: string;
    /**
     * Photo roles (required): the golden set (fixtures/eval/golden-v1) and the
     * directory holding its photos outside git. Every photo of both splits is
     * hash-checked before any request; outputs are scored in memory against
     * the live gates and never written.
     */
    golden?: { dir: string; photosDir: string };
    /** Photo roles (required): the guarded reading pipeline the outputs are scored through. */
    pipeline?: ReadingPipeline;
    /** Text roles (required): P4's content checks, scoreTextFixture. */
    textScorer?: TextScorer;
    /** Defaults to fixtures/eval/thresholds.json. */
    thresholdsFile?: string;
    maxRequests: number;
    spendCapMicros: number;
    confirmPaidRequests: boolean;
    /**
     * vision_photo_enrich only: the stage-1 (quick read) vision_photo profile
     * whose real reading is the enrichment's input, exactly as in production.
     * Its requests count against the same request cap and spend cap; the
     * artifact qualifies only the enrichment profile.
     */
    stage1Profile?: ModelProfile;
  },
): Promise<QualificationRun> {
  const log = opts.log ?? (() => undefined);
  const { profile } = opts;
  const snapshot = CatalogSnapshotSchema.parse(
    JSON.parse(await readFile(path.join(opts.outDir, CATALOG_SNAPSHOT_FILE), 'utf8')),
  );
  if (!catalogCompatible(profile, snapshot))
    throw new Error(
      'Profile is not catalog-compatible: pin a model/provider from the snapshot and set catalogSnapshotAt to its fetched_at.',
    );
  const enrich = profile.role === 'vision_photo_enrich';
  const stage1 = enrich ? opts.stage1Profile : undefined;
  if (enrich) {
    if (!stage1 || stage1.role !== 'vision_photo' || readingForProfile(stage1) !== 'quick')
      throw new Error(
        'Qualifying vision_photo_enrich needs the stage-1 vision_photo quick-read profile (same profile file).',
      );
    if (!catalogCompatible(stage1, snapshot))
      throw new Error('The stage-1 profile is not catalog-compatible with this snapshot.');
  } else if (opts.stage1Profile) {
    throw new Error('A stage-1 profile only applies when qualifying vision_photo_enrich.');
  }
  const photoRole = PHOTO_ROLES.includes(profile.role);
  const textRole = TEXT_ROLES.includes(profile.role);
  const { thresholds, sha256: thresholdsSha256 } = await loadThresholds(opts.thresholdsFile ?? DEFAULT_THRESHOLDS);
  let golden: GoldenSet | undefined;
  let fixtures: Fixture[];
  const photoIds = new Map<string, string>();
  const expectations = new Map<string, unknown>();
  if (photoRole) {
    // Photo roles qualify only on the hash-pinned golden set, scored through the guarded pipeline.
    if (!opts.golden)
      throw new Error('Photo roles qualify on the golden set: pass --golden <dir> and --photos <dir>.');
    if (opts.fixturesDir) throw new Error('Photo roles take --golden and --photos, not --fixtures.');
    if (!opts.pipeline || opts.pipeline.guardrailVersion === null)
      throw new Error('Photo roles need the guarded reading pipeline (vlm/guardrails.ts); refusing to qualify without it.');
    if (profile.role === 'vision_photo' && readingForProfile(profile) !== 'quick')
      throw new Error('The golden evaluation scores the two-stage reading; vision_photo must be a quick-read profile.');
    golden = await loadGoldenSet(opts.golden.dir);
    if (golden.manifest.version !== REQUIRED_GOLDEN_SET[profile.role])
      throw new Error(`${profile.role} must qualify on ${REQUIRED_GOLDEN_SET[profile.role]}; got ${golden.manifest.version}.`);
    const verified = await verifiedGoldenPhotos(golden, opts.golden.photosDir);
    fixtures = verified.map((v) => ({ name: v.photo.file, kind: 'image', files: [{ path: v.path }] }));
    for (const v of verified) photoIds.set(v.path, v.photo.id);
  } else {
    if (!opts.fixturesDir) throw new Error(`--fixtures is required for ${profile.role}.`);
    fixtures = await discoverFixtures(opts.fixturesDir, profile.role);
  }
  if (textRole) {
    if (!opts.textScorer)
      throw new Error('Text roles need the content checks (scripts/eval/text-scorer.ts); refusing to qualify without them.');
    for (const f of fixtures) {
      const file = expectFileFor(f.files[0]!.path);
      try {
        expectations.set(f.name, JSON.parse(await readFile(file, 'utf8')));
      } catch {
        throw new Error(`Text fixture ${f.name} has no readable ${path.basename(file)}.`);
      }
    }
  }
  const minimum = Math.max(
    QUALIFICATION_MINIMUM_FIXTURES[profile.role],
    textRole ? (thresholds.text.t10_fixtures_min ?? 0) : 0,
  );
  if (fixtures.length < minimum)
    throw new Error(
      `Need at least ${minimum} fixtures for ${profile.role}; found ${fixtures.length}.`,
    );
  // Enrichment: one stage-1 quick read plus one enrichment per photo.
  const perFile = stage1 ? 2 : 1;
  const perFileMicros = profile.reservationMicros + (stage1?.reservationMicros ?? 0);
  const files = fixtures.reduce((n, f) => n + f.files.length, 0);
  const plannedRequests = files * perFile;
  if (plannedRequests > opts.maxRequests)
    throw new Error(
      `Fixtures need ${plannedRequests} requests; --max-requests is ${opts.maxRequests}.`,
    );
  if (files * perFileMicros > opts.spendCapMicros)
    throw new Error('Worst-case reservation for these fixtures exceeds the spend cap.');
  log(
    `plan: ${fixtures.length} fixtures, ${plannedRequests} requests, worst case ${files * perFileMicros} micro-USD; reading ${readingForProfile(profile)}; ${effortNote(profile)}`,
  );
  if (!opts.confirmPaidRequests) return { dryRun: true, plannedRequests };

  const counter = new RequestCounter(path.join(opts.outDir, COUNTER_FILE), opts.maxRequests);
  const baseFetch = opts.fetch ?? fetch;
  // Every HTTP request reserves the persistent counter first, so a crash never undercounts.
  const countedFetch: typeof fetch = async (input, init) => {
    await counter.reserve();
    return baseFetch(input, init);
  };
  const ledger = new ModelSpendLedger(new MemorySpendStore(), {
    dailyMicros: opts.spendCapMicros,
    accountDailyMicros: opts.spendCapMicros,
    maxUnknownMicros: opts.spendCapMicros,
    accountDailyAnalyses: 1,
  });
  // The persistent counter (not this in-memory ledger) is the durable hard bound here.
  const runner = new StructuredResponseRunner(
    profile,
    createConcentrateTransport({ apiKey: opts.apiKey, fetch: countedFetch }),
    ledger,
    {
      allowTestStore: true,
      identity: {
        accountId: 'operator-qualification',
        jobId: `qualify:${profile.qualificationArtifactId}`,
        attemptKey: 'q',
      },
    },
  );
  // Enrichment input comes from a real stage-1 quick read, never a made-up one.
  const stage1Runner = stage1
    ? new StructuredResponseRunner(
        stage1,
        createConcentrateTransport({ apiKey: opts.apiKey, fetch: countedFetch }),
        ledger,
        { allowTestStore: true },
      )
    : undefined;
  const outcomes: Record<string, number> = {};
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownUsage = 0;
  let passed = 0;
  let failed = 0;
  let sent = 0;
  let stoppedBy: string | undefined;
  // Outputs kept in memory for scoring only; never written anywhere.
  const recordings: Recording[] = [];
  const textVerdicts: Array<{ pass: boolean; metrics: Record<string, number> }> = [];
  const count = (key: string) => (outcomes[key] = (outcomes[key] ?? 0) + 1);
  outer: for (const fixture of fixtures) {
    let fixtureOk = true;
    for (const [i, file] of fixture.files.entries()) {
      const identity = {
        accountId: 'operator-qualification',
        jobId: `qualify:${profile.qualificationArtifactId}`,
        attemptKey: `${fixture.name}:${i}`,
      };
      // Checked before each call (the in-fetch reservation is the hard guard).
      if ((await counter.used()) >= opts.maxRequests) {
        fixtureOk = false;
        stoppedBy = 'request_cap';
        break;
      }
      let started = Date.now();
      let inStage1 = false;
      try {
        sent++;
        let usage: { inputTokens?: number; outputTokens?: number } | undefined;
        if (fixture.kind === 'text') {
          const spec = textFixture(JSON.parse(await readFile(file.path, 'utf8')));
          const model = new ConcentrateTextModel(runner);
          const res = await model.generateStructured(
            {
              system: spec.system,
              prompt: spec.prompt,
              schemaName: spec.schema,
              schema: spec.schema === 'reference_notes' ? RawExtraction : PlanProse,
            },
            { maxRetries: 0, modelIdentity: identity },
          );
          usage = res.usage;
          // Content checks run in memory; only their aggregate reaches the artifact.
          const verdict = opts.textScorer!(spec.schema, expectations.get(fixture.name), res.data);
          textVerdicts.push({ pass: verdict.pass, metrics: verdict.metrics });
        } else if (stage1Runner) {
          // Stage 1 at its own bounds, then stage 2 on the same photo at the enrichment bounds.
          const { bytes } = await boundJpegForProfile(await readFile(file.path), profile.image);
          inStage1 = true;
          sent++;
          const quick = await new ConcentrateVlm(stage1Runner).analyzeImage(
            { image: { bytes, mediaType: 'image/jpeg' } },
            { maxRetries: 0, modelIdentity: { ...identity, attemptKey: `${identity.attemptKey}:stage1` } },
          );
          const quickMs = Date.now() - started;
          inStage1 = false;
          // Latency and usage in the artifact are the enrichment call's own.
          started = Date.now();
          const res = await new ConcentrateVlmEnricher(runner).enrichImage(
            {
              image: { bytes, mediaType: 'image/jpeg' },
              stage1: {
                title: quick.analysis.title,
                candidates: quick.analysis.candidates.map((c) => c.name),
              },
            },
            { maxRetries: 0, modelIdentity: identity },
          );
          usage = res.usage;
          const photoId = photoIds.get(file.path);
          if (photoId)
            recordings.push({
              photoId,
              runId: 'qualification',
              quick: quick.quick,
              enrichment: res.enrichment,
              quickMs,
              enrichMs: Date.now() - started,
            });
        } else {
          const { bytes } = await boundJpegForProfile(await readFile(file.path), profile.image);
          const res = await new ConcentrateVlm(runner).analyzeImage(
            { image: { bytes, mediaType: 'image/jpeg' } },
            { maxRetries: 0, modelIdentity: identity },
          );
          usage = res.usage;
          const photoId = photoIds.get(file.path);
          if (photoId)
            recordings.push({ photoId, runId: 'qualification', quick: res.quick, quickMs: Date.now() - started });
        }
        latencies.push(Date.now() - started);
        if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
        } else unknownUsage++;
        count('complete');
      } catch (error) {
        fixtureOk = false;
        unknownUsage++;
        const kind = error instanceof ProviderError ? error.kind : 'local_error';
        const outcome = error instanceof ProviderError && error.status ? `http_${error.status}` : kind;
        count(inStage1 ? `stage1_${outcome}` : outcome);
        if (error instanceof Error && /Request cap reached/.test(error.message)) {
          stoppedBy = 'request_cap';
          break outer;
        }
        if (
          error instanceof ProviderError &&
          [401, 402, 403, 404, 422, 429].includes(error.status ?? 0)
        ) {
          stoppedBy = `http_${error.status}`;
          break outer;
        }
        if (error instanceof ProviderError && error.kind === 'unavailable') {
          stoppedBy = 'role_disabled';
          break outer;
        }
      }
    }
    if (fixtureOk) passed++;
    else failed++;
    if (stoppedBy) break;
  }
  const total = fixtures.length;
  let evalBlock: EvalBlock | undefined;
  if (golden && opts.pipeline) {
    evalBlock = evaluatePhotoRecordings({
      golden,
      thresholds,
      thresholdsSha256,
      pipeline: opts.pipeline,
      recordings,
      failedCalls: total - recordings.length,
    }).block;
  } else if (textRole && opts.fixturesDir) {
    const metrics: Record<string, number> = {
      fixtures_total: total,
      fixtures_scored: textVerdicts.length,
      fixtures_content_passed: textVerdicts.filter((v) => v.pass).length,
    };
    // Worst value per content metric across fixtures would need P4's direction; report means only.
    const keys = new Set(textVerdicts.flatMap((v) => Object.keys(v.metrics)));
    for (const k of keys) {
      const values = textVerdicts.map((v) => v.metrics[k]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      if (values.length && /^[A-Za-z0-9_]{1,35}$/.test(k)) metrics[`mean_${k}`] = values.reduce((a, b) => a + b, 0) / values.length;
    }
    evalBlock = {
      golden_set: path.basename(path.resolve(opts.fixturesDir)),
      golden_sha256: await textGoldenDigest(opts.fixturesDir),
      thresholds_sha256: thresholdsSha256,
      guardrail_version: null,
      grounding_version: null,
      scorer_version: opts.textScorer?.version ?? 'scoreTextFixture',
      metrics,
      pass:
        textVerdicts.length === total &&
        total >= (thresholds.text.t10_fixtures_min ?? 0) &&
        textVerdicts.every((v) => v.pass),
    };
  }
  const transportPass = !stoppedBy && failed === 0 && passed >= minimum && passed === total;
  const artifact = QualificationArtifactSchema.parse({
    kind: 'concentrate-qualification',
    artifact_id: profile.qualificationArtifactId,
    created_at: (opts.now?.() ?? new Date()).toISOString(),
    role: profile.role,
    model: profile.model,
    provider: profile.provider,
    profile_hash: profileHash(profile),
    catalog_snapshot_at: snapshot.fetched_at,
    // Roles with a golden set pass only when the transport run and the evaluation both pass.
    result: transportPass && (!evalBlock || evalBlock.pass) && (!(photoRole || textRole) || !!evalBlock) ? 'pass' : 'fail',
    ...(evalBlock ? { eval: evalBlock } : {}),
    requests_sent: sent,
    spend_cap_micros: opts.spendCapMicros,
    fixtures: { total, passed, failed: total - passed, outcomes },
    latency_ms: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      unknown_usage_attempts: unknownUsage,
    },
    notes: [
      'Offline-safe aggregate only: no media, prompts, outputs or credentials are stored.',
      'Billing is not reconciled here; usage tokens are not dollar charges.',
      `Reading: ${readingForProfile(profile)} (prompt ${profile.promptVersion}, schema ${profile.schemaVersion}).`,
      effortNote(profile),
      ...(stage1
        ? [
            `Stage-1 input from ${stage1.model} quick read (profile ${profileHash(stage1).slice(0, 12)}); its requests are counted in requests_sent, its latency and usage are not.`,
          ]
        : []),
      ...(stoppedBy ? [`Stopped early: ${stoppedBy}.`] : []),
      ...(evalBlock
        ? [
            `Evaluation ${evalBlock.golden_set} (${evalBlock.golden_sha256.slice(0, 12)}): ${evalBlock.pass ? 'pass' : 'fail'}; scorer ${evalBlock.scorer_version}, guardrails ${evalBlock.guardrail_version ?? 'n/a'}, thresholds ${evalBlock.thresholds_sha256.slice(0, 12)}. Outputs were scored in memory and not stored.`,
          ]
        : []),
    ],
  });
  await writeFile(
    path.join(opts.outDir, `${profile.qualificationArtifactId}.json`),
    JSON.stringify(artifact, null, 2),
    { mode: 0o600 },
  );
  return { dryRun: false, plannedRequests, artifact, stoppedBy };
}
