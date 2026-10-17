import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  CATALOG_SNAPSHOT_FILE,
  CatalogSnapshotSchema,
  ConcentrateTextModel,
  ConcentrateVlm,
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
  type CatalogSnapshot,
  type ModelProfile,
  type QualificationArtifact,
} from '../packages/providers/src/index';
import { RawExtraction } from '../packages/providers/src/research/wikipedia';
import { PlanProse } from '../packages/domain/src/composer/creative';

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
  if (role === 'vision_photo')
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
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => ({ name: e.name, kind: 'text', files: [{ path: path.join(dir, e.name) }] }));
}

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

export async function qualifyProfile(
  opts: QualifyOptions & {
    profile: ModelProfile;
    fixturesDir: string;
    maxRequests: number;
    spendCapMicros: number;
    confirmPaidRequests: boolean;
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
  const fixtures = await discoverFixtures(opts.fixturesDir, profile.role);
  const minimum = QUALIFICATION_MINIMUM_FIXTURES[profile.role];
  if (fixtures.length < minimum)
    throw new Error(
      `Need at least ${minimum} fixtures for ${profile.role}; found ${fixtures.length}.`,
    );
  const plannedRequests = fixtures.reduce((n, f) => n + f.files.length, 0);
  if (plannedRequests > opts.maxRequests)
    throw new Error(
      `Fixtures need ${plannedRequests} requests; --max-requests is ${opts.maxRequests}.`,
    );
  if (plannedRequests * profile.reservationMicros > opts.spendCapMicros)
    throw new Error('Worst-case reservation for these fixtures exceeds the spend cap.');
  log(
    `plan: ${fixtures.length} fixtures, ${plannedRequests} requests, worst case ${plannedRequests * profile.reservationMicros} micro-USD`,
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
  const outcomes: Record<string, number> = {};
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let unknownUsage = 0;
  let passed = 0;
  let failed = 0;
  let sent = 0;
  let stoppedBy: string | undefined;
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
      const started = Date.now();
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
        } else {
          const { bytes } = await boundJpegForProfile(await readFile(file.path), profile.image);
          const res = await new ConcentrateVlm(runner).analyzeImage(
            { image: { bytes, mediaType: 'image/jpeg' } },
            { maxRetries: 0, modelIdentity: identity },
          );
          usage = res.usage;
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
        count(error instanceof ProviderError && error.status ? `http_${error.status}` : kind);
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
  const artifact = QualificationArtifactSchema.parse({
    kind: 'concentrate-qualification',
    artifact_id: profile.qualificationArtifactId,
    created_at: (opts.now?.() ?? new Date()).toISOString(),
    role: profile.role,
    model: profile.model,
    provider: profile.provider,
    profile_hash: profileHash(profile),
    catalog_snapshot_at: snapshot.fetched_at,
    result: !stoppedBy && failed === 0 && passed >= minimum && passed === total ? 'pass' : 'fail',
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
      ...(stoppedBy ? [`Stopped early: ${stoppedBy}.`] : []),
    ],
  });
  await writeFile(
    path.join(opts.outDir, `${profile.qualificationArtifactId}.json`),
    JSON.stringify(artifact, null, 2),
    { mode: 0o600 },
  );
  return { dryRun: false, plannedRequests, artifact, stoppedBy };
}
