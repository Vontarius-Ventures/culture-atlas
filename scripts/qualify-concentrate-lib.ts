import { appendFile, readFile, readdir, rename, stat, writeFile, mkdir } from 'node:fs/promises';
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
  guardQuickRead,
  profileHash,
  readingForProfile,
  stage2Request,
  type CatalogSnapshot,
  type ModelProfile,
  type QualificationArtifact,
} from '../packages/providers/src/index';
import { parseTextFixture } from './eval/text-schemas';
import { REQUIRED_GOLDEN_SET, type EvalBindingLike, type EvalBlock } from '../packages/providers/src/concentrate/profiles';
import { EVAL_BINDING } from '../packages/providers/src/concentrate/eval-binding';
import { BOUND_CODE, codeDigest } from './eval/binding';
import { loadFreezeRecord, type BlindRun } from './eval/freeze';
import { HOLDOUT_MIN_PHOTOS, evaluatePhotoRecordings, verifiedGoldenPhotos, type TextScorer } from './eval/golden-photos';
import { goldenDigest, loadGoldenSet, loadThresholds, type GoldenSet } from './eval/labels';
import { SCORER_VERSION } from './eval/scorer';
import type { ReadingPipeline, Recording } from './eval/pipeline';
import { verifiedTextGolden, type VerifiedTextGolden } from './eval/text-golden';
import { summarizeTextRun, type TextRunRow } from './eval/text-scorer';

/** Pass thresholds of the evaluation (docs/quality-plan.md §7.2). */
export const DEFAULT_THRESHOLDS = path.resolve(import.meta.dirname, '../fixtures/eval/thresholds.json');
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Refuses, before any request, an evaluation whose inputs differ from the
 * committed binding (EVAL_BINDING): its artifact could never qualify, so the
 * spend would be wasted. The binding is regenerated with `pnpm eval:binding --write`.
 */
export function bindingPreflight(input: {
  goldenSet: string;
  goldenSha256: string;
  thresholdsSha256: string;
  scorerVersion: string;
  codeSha256: string;
  binding: EvalBindingLike;
}): string | null {
  const bound = input.binding.sets[input.goldenSet];
  if (!bound) return `no committed binding for ${input.goldenSet}`;
  if (bound.golden_sha256 !== input.goldenSha256) return `${input.goldenSet} differs from the committed binding (labels or manifest changed)`;
  if (input.binding.thresholds_sha256 !== input.thresholdsSha256) return 'thresholds.json differs from the committed binding';
  if (bound.scorer_version !== input.scorerVersion) return `scorer ${input.scorerVersion} differs from the committed ${bound.scorer_version}`;
  if (bound.code_sha256 !== input.codeSha256) return 'the evaluated code (guards, prompts, scorer) differs from the committed binding';
  return null;
}

/**
 * A failed blind run consumed the set's held-out split (fixtures/eval/<set>/freeze.json,
 * carried into the binding as blind_consumed): reading it again would be a second look,
 * and evalGateFailure() refuses any artifact on it (docs/requalification-plan.md).
 */
function consumedBlindSet(set: string, run?: BlindRun): Error {
  const detail = run ? ` (${run.date}, code ${run.code_commit.slice(0, 7)}, failed ${run.failed_gates.join(', ')})` : '';
  return new Error(
    `${set}'s blind held-out split was consumed by a failed blind run${detail}; photo roles qualify only on a fresh blind set (docs/requalification-plan.md). Nothing was sent.`,
  );
}

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

/**
 * Persistent hard counter: reserved before each request, never decremented.
 * Reads and reservations are serialized within the process (a request that
 * times out while its reservation is still being written cannot race the next
 * check), and every write replaces the file atomically (temp file + rename),
 * so a crash never leaves a truncated counter behind.
 */
export class RequestCounter {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly max: number,
  ) {}
  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private async read(): Promise<number> {
    let raw: string;
    try {
      raw = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw new Error('Request counter is unreadable; refusing to send.', { cause: error });
    }
    let sent: unknown;
    try {
      sent = (JSON.parse(raw) as { sent?: unknown }).sent;
    } catch {
      sent = undefined;
    }
    // A corrupt counter must never reset the cap to zero.
    if (typeof sent !== 'number' || !Number.isSafeInteger(sent) || sent < 0)
      throw new Error('Request counter is unreadable; refusing to send.');
    return sent;
  }
  used(): Promise<number> {
    return this.serial(() => this.read());
  }
  reserve(): Promise<void> {
    return this.serial(async () => {
      const sent = await this.read();
      if (sent >= this.max)
        throw new Error(
          `Request cap reached (${sent}/${this.max}). Raise --max-requests deliberately.`,
        );
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ sent: sent + 1 }), { mode: 0o600 });
      await rename(tmp, this.file);
    });
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
  // Text fixtures are <name>.json prompts; <name>.expect.json holds their content checks (scripts/eval/text-scorer.ts).
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

export interface QualificationRun {
  dryRun: boolean;
  plannedRequests: number;
  artifact?: QualificationArtifact;
  /** With `stage1Artifact`: the vision_photo artifact scored on the same run's stage-1 readings. */
  stage1Artifact?: QualificationArtifact;
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
     * Photo roles (required): the golden set (fixtures/eval/golden-v3 since requalification round 2) and the
     * directory holding its photos outside git. Every photo of both splits is
     * hash-checked before any request; outputs are scored in memory against
     * the live gates and never written.
     */
    golden?: { dir: string; photosDir: string };
    /** Photo roles (required): the guarded reading pipeline the outputs are scored through. */
    pipeline?: ReadingPipeline;
    /**
     * Text roles (required): the content checks (the CLI passes scoreTextFixture
     * from scripts/eval/text-scorer.ts). `fixturesDir` must then be the role's
     * directory of the hash-pinned text golden set (fixtures/eval/text-v1/<role>).
     */
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
    /**
     * vision_photo_enrich only: also write the stage-1 profile's own artifact
     * from this run. Every photo's stage-1 call is exactly the call a separate
     * vision_photo qualification would send (same profile, same bounds, same
     * golden set), so its readings are scored alone (a stage-1-only run: M15
     * for coverage, M5 and M9 scoped out, thr-v2) instead of being bought
     * twice. The stage-1 artifact counts only its own requests, latency and
     * usage; the enrichment artifact keeps counting both, as before.
     */
    stage1Artifact?: boolean;
    /**
     * Optional call ledger (JSON lines, outside git): every inference request
     * is appended as { ts, package, provider, endpoint, status, ms }, never
     * with its body, key or reply.
     */
    ledgerFile?: string;
    ledgerPackage?: string;
    /** The binding the artifact must match (default: the committed EVAL_BINDING; tests pass their own). */
    binding?: EvalBindingLike;
    /** Repository root holding the bound code (default: this checkout). */
    repoRoot?: string;
  },
): Promise<QualificationRun> {
  const log = opts.log ?? (() => undefined);
  const { profile } = opts;
  /** Validates an artifact against the schema and writes it to the out dir (mode 600). */
  const writeArtifact = async (raw: unknown): Promise<QualificationArtifact> => {
    const a = QualificationArtifactSchema.parse(raw);
    await writeFile(path.join(opts.outDir, `${a.artifact_id}.json`), JSON.stringify(a, null, 2), { mode: 0o600 });
    return a;
  };
  const snapshot = CatalogSnapshotSchema.parse(
    JSON.parse(await readFile(path.join(opts.outDir, CATALOG_SNAPSHOT_FILE), 'utf8')),
  );
  if (!catalogCompatible(profile, snapshot))
    throw new Error(
      'Profile is not catalog-compatible: pin a model/provider from the snapshot and set catalogSnapshotAt to its fetched_at.',
    );
  // The verifier is scored on the two-stage readings it checks (eval:live --roles ...,vision_verify);
  // its qualification run is added only if the tune-split evaluation enables it. Until then it stays
  // unqualified (qualificationState requires a golden-v3 eval block), so production never dispatches it.
  if (profile.role === 'vision_verify')
    throw new Error('vision_verify is not qualified by this script yet: the tune-split evaluation kept it off (docs/quality-plan.md §15), so it is not qualified this round.');
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
  if (opts.stage1Artifact && !stage1)
    throw new Error('A stage-1 artifact is written only when qualifying vision_photo_enrich with its stage-1 profile.');
  if (opts.stage1Artifact && stage1!.qualificationArtifactId === profile.qualificationArtifactId)
    throw new Error('The stage-1 and enrichment profiles need different qualificationArtifactId values.');
  const photoRole = PHOTO_ROLES.includes(profile.role);
  const textRole = TEXT_ROLES.includes(profile.role);
  const { thresholds, sha256: thresholdsSha256 } = await loadThresholds(opts.thresholdsFile ?? DEFAULT_THRESHOLDS);
  let golden: GoldenSet | undefined;
  let textGolden: VerifiedTextGolden | undefined;
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
    // A failed blind run consumed the held-out split: reading it again would be a second look,
    // and no artifact on the set can qualify (docs/requalification-plan.md, FREEZE.md step 5).
    // The set's own record (freeze.json) is checked here; the committed binding's copy after the binding check below.
    const run = (await loadFreezeRecord(opts.golden.dir))?.blind_run;
    if (run?.result === 'fail') throw consumedBlindSet(golden.manifest.version, run);
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
    // A fixture for another role's schema is refused first (e.g. composer prompts under research_text).
    for (const f of fixtures) parseTextFixture(JSON.parse(await readFile(f.files[0]!.path, 'utf8')), profile.role);
    // Only the hash-pinned golden set: exactly its fixtures for this role, every file untampered.
    textGolden = await verifiedTextGolden(opts.fixturesDir!, profile.role);
    if (textGolden.goldenSet !== REQUIRED_GOLDEN_SET[profile.role])
      throw new Error(`${profile.role} must qualify on ${REQUIRED_GOLDEN_SET[profile.role]}; got ${textGolden.goldenSet}.`);
    const pinned = textGolden.fixtures.map((f) => path.basename(f)).sort();
    if (JSON.stringify(fixtures.map((f) => f.name).sort()) !== JSON.stringify(pinned))
      throw new Error('Text fixtures differ from the golden manifest.');
    for (const f of fixtures) {
      const file = expectFileFor(f.files[0]!.path);
      try {
        expectations.set(f.name, JSON.parse(await readFile(file, 'utf8')));
      } catch {
        throw new Error(`Text fixture ${f.name} has no readable ${path.basename(file)}.`);
      }
    }
  }
  // The artifact binds the inputs it was scored on; refuse a run that could never qualify.
  const binding: EvalBindingLike = opts.binding ?? EVAL_BINDING;
  const evalSet = golden?.manifest.version ?? textGolden?.goldenSet;
  let codeSha256: string | undefined;
  if (evalSet) {
    const files = BOUND_CODE[evalSet];
    if (!files) throw new Error(`No bound code list for ${evalSet} (scripts/eval/binding.ts).`);
    codeSha256 = await codeDigest(opts.repoRoot ?? REPO_ROOT, files);
    const stale = bindingPreflight({
      goldenSet: evalSet,
      goldenSha256: golden ? goldenDigest(golden) : textGolden!.goldenSha256,
      thresholdsSha256,
      scorerVersion: golden ? SCORER_VERSION : (opts.textScorer?.version ?? 'scoreTextFixture'),
      codeSha256,
      binding,
    });
    if (stale) throw new Error(`Evaluation inputs are not the committed ones: ${stale}. Run pnpm eval:binding --write first; nothing was sent.`);
    if (golden && binding.sets[evalSet]?.blind_consumed === true) throw consumedBlindSet(evalSet);
  }
  if (golden) {
    const blind = golden.manifest.photos.filter((p) => p.split === 'holdout' && p.blind === true).length;
    if (blind < HOLDOUT_MIN_PHOTOS)
      throw new Error(
        `${golden.manifest.version} has ${blind} blind held-out photo(s); photo roles qualify only with at least ${HOLDOUT_MIN_PHOTOS} (quality plan §7.5). Nothing was sent.`,
      );
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
  // Text fixtures are validated before anything is sent: a fixture for another
  // role's schema (e.g. composer prompts under research_text) is refused.
  for (const fixture of fixtures)
    if (fixture.kind === 'text')
      parseTextFixture(JSON.parse(await readFile(fixture.files[0]!.path, 'utf8')), profile.role);
  log(
    `plan: ${fixtures.length} fixtures, ${plannedRequests} requests, worst case ${files * perFileMicros} micro-USD; ${profile.role.startsWith('vision') ? `reading ${readingForProfile(profile)}; ` : ''}${effortNote(profile)}`,
  );
  if (!opts.confirmPaidRequests) return { dryRun: true, plannedRequests };

  const counter = new RequestCounter(path.join(opts.outDir, COUNTER_FILE), opts.maxRequests);
  const baseFetch = opts.fetch ?? fetch;
  // Every HTTP request reserves the persistent counter first, so a crash never undercounts.
  const ledgerLine = async (input: Parameters<typeof fetch>[0], status: number | string, started: number) => {
    if (!opts.ledgerFile) return;
    let endpoint = 'unknown';
    try {
      endpoint = new URL(input instanceof Request ? input.url : String(input)).pathname;
    } catch {
      /* keep 'unknown' */
    }
    const line = { ts: (opts.now ?? (() => new Date()))().toISOString(), package: opts.ledgerPackage ?? 'qualify', provider: 'concentrate', endpoint, status, ms: Date.now() - started };
    await appendFile(opts.ledgerFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  };
  const countedFetch: typeof fetch = async (input, init) => {
    await counter.reserve();
    const started = Date.now();
    try {
      const res = await baseFetch(input, init);
      await ledgerLine(input, res.status, started);
      return res;
    } catch (error) {
      await ledgerLine(input, 'network_error', started);
      throw error;
    }
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
  // Stage-1 side of an enrichment run (only reported when opts.stage1Artifact is set).
  const s1 = { outcomes: {} as Record<string, number>, latencies: [] as number[], inputTokens: 0, outputTokens: 0, unknownUsage: 0, sent: 0, passed: 0, recordings: [] as Recording[] };
  const count1 = (key: string) => (s1.outcomes[key] = (s1.outcomes[key] ?? 0) + 1);
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
  // One row per text fixture (T9/T10 via summarizeTextRun): its outcome, latency and content score.
  const textRows: TextRunRow[] = [];
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
          const spec = parseTextFixture(JSON.parse(await readFile(file.path, 'utf8')), profile.role);
          const model = new ConcentrateTextModel(runner);
          // Same wire schema name and output cap as the production builder.
          const res = await model.generateStructured(
            {
              system: spec.system,
              prompt: spec.prompt,
              schemaName: spec.entry.schemaName,
              schema: spec.entry.schema,
              maxTokens: spec.entry.maxTokens,
            },
            { maxRetries: 0, modelIdentity: identity },
          );
          usage = res.usage;
          // Content checks run in memory; only their aggregate reaches the artifact.
          const verdict = opts.textScorer!(spec.schema, expectations.get(fixture.name), res.data);
          textVerdicts.push({ pass: verdict.pass, metrics: verdict.metrics });
          // The runner already validated the reply against the wire schema (T1), unless the scorer says otherwise.
          textRows.push({
            fixture: fixture.name,
            outcome: 'complete',
            latencyMs: Date.now() - started,
            score: { ...verdict, metrics: { t1_schema_valid: 1, ...verdict.metrics } },
          });
        } else if (stage1Runner) {
          // Stage 1 at its own bounds, then stage 2 on the same photo at the enrichment bounds,
          // each bounded from the original photo (as eval:live and a vision_photo qualification do).
          const original = await readFile(file.path);
          const { bytes } = await boundJpegForProfile(original, profile.image);
          const { bytes: quickBytes } = await boundJpegForProfile(original, stage1!.image);
          inStage1 = true;
          sent++;
          s1.sent++;
          const quick = await new ConcentrateVlm(stage1Runner).analyzeImage(
            { image: { bytes: quickBytes, mediaType: 'image/jpeg' } },
            { maxRetries: 0, modelIdentity: { ...identity, attemptKey: `${identity.attemptKey}:stage1` } },
          );
          const quickMs = Date.now() - started;
          inStage1 = false;
          s1.latencies.push(quickMs);
          if (quick.usage?.inputTokens !== undefined && quick.usage.outputTokens !== undefined) {
            s1.inputTokens += quick.usage.inputTokens;
            s1.outputTokens += quick.usage.outputTokens;
          } else s1.unknownUsage++;
          count1('complete');
          s1.passed++;
          const stage1PhotoId = photoIds.get(file.path);
          if (stage1PhotoId) s1.recordings.push({ photoId: stage1PhotoId, runId: 'qualification', quick: quick.quick, quickMs });
          // Latency and usage in the artifact are the enrichment call's own.
          started = Date.now();
          const res = await new ConcentrateVlmEnricher(runner).enrichImage(
            {
              image: { bytes, mediaType: 'image/jpeg' },
              // Exactly what production sends: the guarded title, published names, then held names.
              stage1: (() => {
                const g1 = guardQuickRead(quick.analysis, { twoStage: true });
                return stage2Request(g1.analysis, g1.held);
              })(),
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
        if (inStage1) {
          count1(outcome);
          s1.unknownUsage++;
        }
        if (fixture.kind === 'text') textRows.push({ fixture: fixture.name, outcome: kind === 'timeout' ? 'timeout' : outcome });
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
      codeSha256: codeSha256!,
    }).block;
  } else if (textRole && textGolden) {
    // T1, T9 (p95 under the profile timeout, no timeouts) and T10 (every fixture passed, enough fixtures).
    const run = summarizeTextRun(textRows, {
      timeoutMs: profile.timeoutMs,
      minimumFixtures: Math.max(thresholds.text.t10_fixtures_min ?? 0, QUALIFICATION_MINIMUM_FIXTURES[profile.role]),
    });
    const metrics: Record<string, number> = {
      ...run.metrics,
      fixtures_total: total,
      fixtures_scored: textVerdicts.length,
      fixtures_content_passed: textVerdicts.filter((v) => v.pass).length,
    };
    // Mean of each content metric across fixtures; the per-fixture gates are applied by the scorer.
    const keys = new Set(textVerdicts.flatMap((v) => Object.keys(v.metrics)));
    for (const k of keys) {
      const values = textVerdicts.map((v) => v.metrics[k]).filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      if (values.length && /^[A-Za-z0-9_]{1,35}$/.test(k)) metrics[`mean_${k}`] = values.reduce((a, b) => a + b, 0) / values.length;
    }
    evalBlock = {
      golden_set: textGolden.goldenSet,
      golden_sha256: textGolden.goldenSha256,
      thresholds_sha256: thresholdsSha256,
      guardrail_version: null,
      grounding_version: null,
      scorer_version: opts.textScorer?.version ?? 'scoreTextFixture',
      code_sha256: codeSha256!,
      holdout_blind: null,
      metrics,
      pass: run.pass && textVerdicts.length === total && textVerdicts.every((v) => v.pass),
    };
    if (!run.pass) log(`text evaluation: ${run.reasons.join('; ')}`);
  }
  const transportPass = !stoppedBy && failed === 0 && passed >= minimum && passed === total;
  const artifact = await writeArtifact({
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
  let stage1Artifact: QualificationArtifact | undefined;
  if (opts.stage1Artifact && stage1 && golden && opts.pipeline) {
    // The stage-1 readings alone, scored exactly as a separate vision_photo qualification scores them.
    const block = evaluatePhotoRecordings({
      golden,
      thresholds,
      thresholdsSha256,
      pipeline: opts.pipeline,
      recordings: s1.recordings,
      failedCalls: total - s1.recordings.length,
      codeSha256: codeSha256!,
    }).block;
    const minimum1 = QUALIFICATION_MINIMUM_FIXTURES[stage1.role];
    const transport1 = !stoppedBy && s1.passed === total && s1.passed >= minimum1;
    stage1Artifact = await writeArtifact({
      kind: 'concentrate-qualification',
      artifact_id: stage1.qualificationArtifactId,
      created_at: (opts.now?.() ?? new Date()).toISOString(),
      role: stage1.role,
      model: stage1.model,
      provider: stage1.provider,
      profile_hash: profileHash(stage1),
      catalog_snapshot_at: snapshot.fetched_at,
      result: transport1 && block.pass ? 'pass' : 'fail',
      eval: block,
      requests_sent: s1.sent,
      spend_cap_micros: opts.spendCapMicros,
      fixtures: { total, passed: s1.passed, failed: total - s1.passed, outcomes: s1.outcomes },
      latency_ms: { p50: percentile(s1.latencies, 50), p95: percentile(s1.latencies, 95) },
      usage: { input_tokens: s1.inputTokens, output_tokens: s1.outputTokens, unknown_usage_attempts: s1.unknownUsage },
      notes: [
        'Offline-safe aggregate only: no media, prompts, outputs or credentials are stored.',
        'Billing is not reconciled here; usage tokens are not dollar charges.',
        `Reading: ${readingForProfile(stage1)} (prompt ${stage1.promptVersion}, schema ${stage1.schemaVersion}).`,
        effortNote(stage1),
        `Scored on the stage-1 calls of the ${profile.role} qualification run ${profile.qualificationArtifactId} (one stage-1 call per golden photo at this profile's bounds); requests_sent, latency and usage are this profile's own.`,
        ...(stoppedBy ? [`Stopped early: ${stoppedBy}.`] : []),
        `Evaluation ${block.golden_set} (${block.golden_sha256.slice(0, 12)}): ${block.pass ? 'pass' : 'fail'}; scorer ${block.scorer_version}, guardrails ${block.guardrail_version ?? 'n/a'}, thresholds ${block.thresholds_sha256.slice(0, 12)}. Outputs were scored in memory and not stored.`,
      ],
    });
  }
  return { dryRun: false, plannedRequests, artifact, ...(stage1Artifact ? { stage1Artifact } : {}), stoppedBy };
}
