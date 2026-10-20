import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CATALOG_SNAPSHOT_FILE,
  CatalogSnapshotSchema,
  ConcentrateVlm,
  ConcentrateVlmEnricher,
  ConcentrateVlmVerifier,
  MemorySpendStore,
  ModelSpendLedger,
  ProviderError,
  QlooHttpProvider,
  StructuredResponseRunner,
  boundJpegForProfile,
  brandCorroboratedIds,
  catalogCompatible,
  createConcentrateTransport,
  readingForProfile,
  stalePhotoPromptVersion,
  type ModelProfile,
  type ModelProfiles,
  type QlooEntity,
  type QlooTag,
  type VlmAnalysis,
  VlmEnrichmentV1,
  VlmEnrichmentV2,
  VlmQuickReadV1,
  VlmQuickReadV2,
  VlmVerification,
} from '../../packages/providers/src/index';
import {
  catalogEntry,
  type CatalogSnapshot,
} from '../../packages/providers/src/concentrate/profiles';
import { structuredOutputContract } from '../../packages/providers/src/model-gateway/schema';
import { RequestCounter } from '../qualify-concentrate-lib';
import { verifiedGoldenPhotos } from './golden-photos';
import type { GoldenSet, Thresholds } from './labels';
import type { ReadingPipeline, Recording } from './pipeline';
import { scoreGrounding, type GroundingJudgement, type GroundingRecord } from './release-gates';
import {
  SCORER_VERSION,
  scoreRuns,
  type CallRecord,
  type QlooAcceptRecord,
  type Scorecard,
  type ScoredRun,
} from './scorer';

/**
 * Budgeted live evaluation (docs/quality-plan.md §7.4), the same safety rails
 * as qualification: dry run by default, sha256 check of every photo before any
 * request, a persistent request counter reserved before each request, no
 * retries, stop on 401/402/403/404/422/429, every call in the ledger, and raw
 * outputs plus the scorecard written only to --out-dir outside git.
 */

export const STOP_STATUSES = [401, 402, 403, 404, 422, 429];
const CONCENTRATE_COUNTER = '.eval-live-concentrate-counter.json';
const QLOO_COUNTER = '.eval-live-qloo-counter.json';

export interface LedgerEntry {
  ts: string;
  package: string;
  provider: 'concentrate' | 'qloo';
  endpoint: string;
  status: number | string;
  ms: number;
}

/** P3's grounding surface (§5): planLookup + acceptMatch. Loaded only for --qloo. */
export interface GroundingModule {
  GROUNDING_VERSION: string;
  planLookup(
    c: VlmAnalysis['candidates'][number] & { corroborated?: boolean },
  ):
    | { kind: 'none'; reason: string }
    | { kind: 'tags'; query: string; tagTypes: string[] }
    | { kind: 'search'; query: string; types: string[] };
  acceptMatch(
    c: VlmAnalysis['candidates'][number] & { corroborated?: boolean },
    plan: unknown,
    results: readonly (QlooEntity | QlooTag)[],
  ): { match: QlooEntity | QlooTag | null; rule: string; reason: string };
}

export interface LiveEvalOptions {
  golden: GoldenSet;
  photosDir: string;
  split: 'all' | 'tune' | 'holdout';
  /** Restrict to these photo ids (smoke runs); every listed id must exist in the split. */
  only?: readonly string[];
  profiles: ModelProfiles;
  /**
   * vision_photo alone (stage 1), with vision_photo_enrich (both stages), and
   * optionally vision_verify (vlm-verify-v3: the binding check of the first
   * section's claims after stage 1 and of what stage 2 would publish, on the
   * compiler's own target selection; requires both stages).
   */
  roles: readonly ('vision_photo' | 'vision_photo_enrich' | 'vision_verify')[];
  /** Holds the catalog snapshot the profiles name; raw outputs and the scorecard are written here. */
  outDir: string;
  /** Repository root: --out-dir must be outside it. */
  repoRoot: string;
  maxRequests: number;
  spendCapMicros: number;
  confirmPaidRequests: boolean;
  apiKey?: string;
  pipeline: ReadingPipeline;
  thresholds: Thresholds;
  qloo?: {
    apiKey: string;
    baseUrl: string;
    maxRequests: number;
    spacingMs: number;
    grounding: GroundingModule;
    fetch?: typeof fetch;
    /** Hand judgements of the accepted matches (precision, recall); without them those gates cannot pass. */
    judgements?: readonly GroundingJudgement[];
  };
  fetch?: typeof fetch;
  ledgerFile?: string;
  packageName?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Round 4 (plan G): tokens and list-rate cost of one stage's calls in a live run. */
export interface StageUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls whose response carried no complete token counts. */
  unknownUsage: number;
  /** Cost at the catalog snapshot's list rate (the unconditioned pricing entry of the route), null when the snapshot lists none. */
  costMicros: number | null;
}

/** The unconditioned list rate of a route in the catalog snapshot (micro-USD per token), or null. */
export function listRate(
  profile: Pick<ModelProfile, 'model' | 'provider'>,
  snapshot: CatalogSnapshot,
): { input: number; output: number } | null {
  const entry = catalogEntry(profile, snapshot) as
    { providers?: Record<string, { pricing?: unknown }> } | undefined;
  const pricing = entry?.providers?.[profile.provider]?.pricing;
  if (!Array.isArray(pricing)) return null;
  type Price = { price?: { USD?: number }; units?: number };
  const plain = pricing.find(
    (p: { condition?: unknown }) => p && typeof p === 'object' && p.condition === undefined,
  ) as { tokens?: { input?: Price; output?: Price } } | undefined;
  const per = (x?: Price) =>
    typeof x?.price?.USD === 'number' && typeof x.units === 'number' && x.units > 0
      ? (x.price.USD * 1_000_000) / x.units
      : null;
  const input = per(plain?.tokens?.input);
  const output = per(plain?.tokens?.output);
  return input === null || output === null ? null : { input, output };
}

export interface LiveEvalResult {
  /** Plan G: token usage and list-rate cost per stage (live runs only). */
  usage?: Record<'quick' | 'enrich' | 'verify', StageUsage>;
  dryRun: boolean;
  plannedRequests: number;
  plannedQlooMax: number;
  stoppedBy?: string;
  scorecard?: Scorecard;
  /** The grounding gate of thresholds.json, applied to this run's Qloo lookups (--qloo only). */
  grounding?: ReturnType<typeof scoreGrounding>;
  requestsSent?: number;
  qlooSent?: number;
}

function endpointOf(input: unknown): string {
  try {
    return new URL(input instanceof Request ? input.url : String(input)).pathname;
  } catch {
    return 'unknown';
  }
}

function tagFamily(type: string): string | null {
  // urn:tag:<family>:<namespace>
  const parts = type.split(':');
  return parts[0] === 'urn' && parts[1] === 'tag' ? (parts[2] ?? null) : null;
}

/**
 * Why a completed reply failed validation: the zod issue paths and messages of
 * the decoded output against the reading schema (for --out-dir only).
 */
export function diagnoseInvalidOutput(
  body: string,
  stage: CallRecord['stage'],
  v1: boolean,
): { issues: { path: string; message: string }[]; output: unknown } {
  const schema =
    stage === 'verify'
      ? VlmVerification
      : stage === 'quick'
        ? v1
          ? VlmQuickReadV1
          : VlmQuickReadV2
        : v1
          ? VlmEnrichmentV1
          : VlmEnrichmentV2;
  try {
    const envelope = JSON.parse(body) as {
      output?: { type?: string; content?: { type?: string; text?: string }[] }[];
    };
    const text = (envelope.output ?? [])
      .filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
    const output = structuredOutputContract(schema).decode(JSON.parse(text));
    const parsed = schema.safeParse(output);
    return {
      issues: parsed.success
        ? []
        : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      output,
    };
  } catch (error) {
    return {
      issues: [{ path: '', message: `undecodable: ${(error as Error).message}` }],
      output: null,
    };
  }
}

export async function runLiveEval(opts: LiveEvalOptions): Promise<LiveEvalResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  if (!path.relative(opts.repoRoot, path.resolve(opts.outDir)).startsWith('..'))
    throw new Error('--out-dir must be outside the repository (raw outputs never enter git).');
  if (!opts.roles.includes('vision_photo'))
    throw new Error('eval:live always runs the stage-1 vision_photo reading.');
  const stage1 = opts.profiles.vision_photo;
  if (!stage1 || readingForProfile(stage1) !== 'quick')
    throw new Error('Need a quick-read vision_photo profile.');
  const enrichProfile = opts.roles.includes('vision_photo_enrich')
    ? opts.profiles.vision_photo_enrich
    : undefined;
  if (opts.roles.includes('vision_photo_enrich') && !enrichProfile)
    throw new Error('Need the vision_photo_enrich profile.');
  const verifyProfile = opts.roles.includes('vision_verify')
    ? opts.profiles.vision_verify
    : undefined;
  if (opts.roles.includes('vision_verify') && (!verifyProfile || !enrichProfile))
    throw new Error(
      'vision_verify needs its profile and both photo stages (it checks the claims of both).',
    );
  if (opts.pipeline.guardrailVersion === null)
    throw new Error('eval:live scores through the guarded pipeline only.');
  // Round 4: a reading-v2 photo profile names the prompt the code sends (vlm-quick-v3, vlm-enrich-v4).
  for (const p of [stage1, enrichProfile].filter((x): x is ModelProfile => !!x)) {
    const stale = stalePhotoPromptVersion(p);
    if (stale) throw new Error(`${stale} Nothing was sent.`);
  }

  const snapshot = CatalogSnapshotSchema.parse(
    JSON.parse(await readFile(path.join(opts.outDir, CATALOG_SNAPSHOT_FILE), 'utf8')),
  );
  for (const p of [stage1, enrichProfile, verifyProfile].filter((x): x is ModelProfile => !!x))
    if (!catalogCompatible(p, snapshot))
      throw new Error(
        `${p.role} profile is not catalog-compatible with the snapshot in --out-dir.`,
      );

  // Hash check before anything is planned or sent.
  let golden = opts.golden;
  if (opts.only?.length) {
    const unknown = opts.only.filter((id) => !golden.manifest.photos.some((p) => p.id === id));
    if (unknown.length) throw new Error(`Unknown photo id(s) in --only: ${unknown.join(', ')}`);
    golden = {
      ...golden,
      manifest: {
        ...golden.manifest,
        photos: golden.manifest.photos.filter((p) => opts.only!.includes(p.id)),
      },
    };
  }
  const photos = await verifiedGoldenPhotos(golden, opts.photosDir, opts.split);
  // The verifier is called only when a reading has targets: at most twice per photo (stage 1 and stage 2),
  // and the plan reserves both for every photo (worst case).
  const perPhoto = 1 + (enrichProfile ? 1 : 0) + (verifyProfile ? 2 : 0);
  const plannedRequests = photos.length * perPhoto;
  const worstCase =
    photos.length *
    (stage1.reservationMicros +
      (enrichProfile?.reservationMicros ?? 0) +
      2 * (verifyProfile?.reservationMicros ?? 0));
  if (plannedRequests > opts.maxRequests)
    throw new Error(
      `The run needs ${plannedRequests} requests; --max-requests is ${opts.maxRequests}.`,
    );
  if (worstCase > opts.spendCapMicros)
    throw new Error('Worst-case reservation exceeds --spend-cap-usd.');
  const plannedQlooMax = opts.qloo?.maxRequests ?? 0;
  log(
    `plan: ${photos.length} photo(s) (${opts.split}), ${plannedRequests} Concentrate request(s), worst case ${worstCase} micro-USD, Qloo at most ${plannedQlooMax}`,
  );
  if (!opts.confirmPaidRequests) return { dryRun: true, plannedRequests, plannedQlooMax };
  if (!opts.apiKey) throw new Error('A Concentrate key is required with --confirm-paid-requests.');

  await mkdir(path.join(opts.outDir, 'recordings'), { recursive: true, mode: 0o700 });
  const ledger = async (entry: Omit<LedgerEntry, 'ts' | 'package'>) => {
    if (!opts.ledgerFile) return;
    const line: LedgerEntry = {
      ts: now().toISOString(),
      package: opts.packageName ?? 'eval',
      ...entry,
    };
    await appendFile(opts.ledgerFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  };
  const counter = new RequestCounter(path.join(opts.outDir, CONCENTRATE_COUNTER), opts.maxRequests);
  const baseFetch = opts.fetch ?? fetch;
  // The last response body (requests are sequential), kept in memory only so an
  // output that fails validation can be diagnosed in --out-dir (never in git).
  let lastBody: string | null = null;
  const countedFetch: typeof fetch = async (input, init) => {
    await counter.reserve();
    const started = Date.now();
    lastBody = null;
    try {
      const res = await baseFetch(input, init);
      await ledger({
        provider: 'concentrate',
        endpoint: endpointOf(input),
        status: res.status,
        ms: Date.now() - started,
      });
      if (res.ok)
        lastBody = await res
          .clone()
          .text()
          .catch(() => null);
      return res;
    } catch (error) {
      await ledger({
        provider: 'concentrate',
        endpoint: endpointOf(input),
        status: 'network_error',
        ms: Date.now() - started,
      });
      throw error;
    }
  };
  const spend = new ModelSpendLedger(new MemorySpendStore(), {
    dailyMicros: opts.spendCapMicros,
    accountDailyMicros: opts.spendCapMicros,
    maxUnknownMicros: opts.spendCapMicros,
    accountDailyAnalyses: 1,
  });
  const runnerFor = (p: ModelProfile) =>
    new StructuredResponseRunner(
      p,
      createConcentrateTransport({ apiKey: opts.apiKey!, fetch: countedFetch }),
      spend,
      {
        allowTestStore: true,
        identity: { accountId: 'operator-eval', jobId: `eval-live:${p.role}`, attemptKey: 'e' },
      },
    );
  // One operator job per run: the in-memory spend ledger counts it as a single analysis.
  const jobId = `eval-live:${now().toISOString()}`;
  const identity = (photoId: string, stage: string) => ({
    modelIdentity: { accountId: 'operator-eval', jobId, attemptKey: `${photoId}:${stage}` },
  });
  const quickVlm = new ConcentrateVlm(runnerFor(stage1));
  const enricher = enrichProfile ? new ConcentrateVlmEnricher(runnerFor(enrichProfile)) : undefined;
  const verifier = verifyProfile ? new ConcentrateVlmVerifier(runnerFor(verifyProfile)) : undefined;

  const recordings: Recording[] = [];
  // Plan G (round 4): what each stage actually used, priced at the snapshot's list rate.
  const usage: Record<'quick' | 'enrich' | 'verify', StageUsage> = {
    quick: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, costMicros: 0 },
    enrich: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, costMicros: 0 },
    verify: { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0, costMicros: 0 },
  };
  const rates = {
    quick: listRate(stage1, snapshot),
    enrich: enrichProfile ? listRate(enrichProfile, snapshot) : null,
    verify: verifyProfile ? listRate(verifyProfile, snapshot) : null,
  };
  const used = (
    stage: 'quick' | 'enrich' | 'verify',
    u: { inputTokens?: number; outputTokens?: number } | undefined,
  ) => {
    const s = usage[stage];
    s.calls++;
    if (typeof u?.inputTokens !== 'number' || typeof u.outputTokens !== 'number') {
      s.unknownUsage++;
      return;
    }
    s.inputTokens += u.inputTokens;
    s.outputTokens += u.outputTokens;
    const r = rates[stage];
    s.costMicros =
      r === null || s.costMicros === null
        ? null
        : s.costMicros + Math.round(u.inputTokens * r.input + u.outputTokens * r.output);
  };
  const failed: { photoId: string; call: CallRecord }[] = [];
  let stoppedBy: string | undefined;
  const failures: Record<string, unknown>[] = [];
  const fail = (photoId: string, stage: CallRecord['stage'], error: unknown, ms: number) => {
    const incomplete =
      error instanceof Error && /incomplete|max_output_tokens/i.test(error.message);
    failed.push({ photoId, call: { stage, ms, valid: false, incomplete } });
    if (error instanceof ProviderError && error.kind === 'invalid_response' && lastBody) {
      const profile =
        stage === 'quick' ? stage1 : stage === 'enrich' ? enrichProfile! : verifyProfile!;
      failures.push({
        photoId,
        stage,
        ...diagnoseInvalidOutput(lastBody, stage, profile.schemaVersion.endsWith('_v1')),
      });
    }
    if (error instanceof Error && /Request cap reached/.test(error.message))
      stoppedBy = 'request_cap';
    else if (error instanceof ProviderError && STOP_STATUSES.includes(error.status ?? 0))
      stoppedBy = `http_${error.status}`;
    else if (error instanceof ProviderError && error.kind === 'unavailable')
      stoppedBy = 'role_disabled';
    log(
      `${photoId} ${stage}: ${error instanceof ProviderError ? `${error.kind}${error.status ? ` ${error.status}` : ''}` : 'local_error'}`,
    );
  };
  for (const { photo, path: file } of photos) {
    if (stoppedBy) break;
    const bytes = await readFile(file);
    let started = Date.now();
    let quick: Awaited<ReturnType<ConcentrateVlm['analyzeImage']>>;
    try {
      const bounded = await boundJpegForProfile(bytes, stage1.image);
      quick = await quickVlm.analyzeImage(
        { image: { bytes: bounded.bytes, mediaType: 'image/jpeg' } },
        { maxRetries: 0, ...identity(photo.id, 'stage1') },
      );
    } catch (error) {
      fail(photo.id, 'quick', error, Date.now() - started);
      continue;
    }
    used('quick', quick.usage);
    const rec: Recording = {
      photoId: photo.id,
      runId: `LIVE-${photo.id}`,
      quick: quick.quick,
      quickMs: Date.now() - started,
      quickUsage: quick.usage,
    };
    /** One binding verifier check (vlm-verify-v3) on exactly the claims the compiler would send; a failed call is recorded as null. */
    const check = async (stage: 1 | 2): Promise<void> => {
      if (!verifier || !verifyProfile || stoppedBy) return;
      const pre = opts.pipeline.run(rec).verify;
      const targets = stage === 1 ? pre.targets1 : pre.targets2;
      if (!targets.length) return;
      const t0 = Date.now();
      try {
        const bounded = await boundJpegForProfile(bytes, verifyProfile.image);
        const res = await verifier.verifyImage(
          {
            image: { bytes: bounded.bytes, mediaType: 'image/jpeg' },
            claims: targets.map((t) => ({ name: t.name, type: t.type })),
            visibleText: stage === 1 ? [] : [...pre.stage2Text],
          },
          { maxRetries: 0, ...identity(photo.id, `verify${stage}`) },
        );
        used('verify', res.usage);
        if (stage === 1) {
          rec.verification1 = res.verification;
          rec.verify1Ms = Date.now() - t0;
        } else {
          rec.verification2 = res.verification;
          rec.verify2Ms = Date.now() - t0;
        }
      } catch (error) {
        if (stage === 1) rec.verification1 = null;
        else rec.verification2 = null;
        fail(photo.id, 'verify', error, Date.now() - t0);
      }
    };
    // Stage-1 check: the first section's claims (production runs it in parallel with Qloo).
    if (enricher) await check(1);
    if (enricher && enrichProfile && !stoppedBy) {
      started = Date.now();
      try {
        const bounded = await boundJpegForProfile(bytes, enrichProfile.image);
        const res = await enricher.enrichImage(
          {
            image: { bytes: bounded.bytes, mediaType: 'image/jpeg' },
            // Exactly what production sends: the guarded title, published names (after the
            // verifier's stage-1 check when it ran), then held names.
            stage1: opts.pipeline.run(rec).verify.stage2Input,
          },
          { maxRetries: 0, ...identity(photo.id, 'stage2') },
        );
        rec.enrichment = res.enrichment;
        rec.enrichMs = Date.now() - started;
        rec.enrichUsage = res.usage;
        used('enrich', res.usage);
      } catch (error) {
        fail(photo.id, 'enrich', error, Date.now() - started);
      }
    }
    // Stage-2 check: what stage 2 would publish.
    if (rec.enrichment !== undefined) await check(2);
    recordings.push(rec);
  }

  if (failures.length)
    await writeFile(
      path.join(opts.outDir, 'invalid-outputs.json'),
      JSON.stringify(failures, null, 2),
      { mode: 0o600 },
    );
  const costs = Object.values(usage).map((u) => u.costMicros);
  const totalMicros = costs.every((c) => c !== null) ? costs.reduce((a, b) => a! + b!, 0)! : null;
  await writeFile(
    path.join(opts.outDir, 'usage.json'),
    JSON.stringify(
      {
        priced_at: 'catalog snapshot list rate',
        snapshot: snapshot.fetched_at,
        stages: usage,
        total_cost_micros: totalMicros,
      },
      null,
      2,
    ),
    {
      mode: 0o600,
    },
  );
  if (Object.values(usage).some((u) => u.calls))
    log(
      `usage: ${(['quick', 'enrich', 'verify'] as const)
        .filter((k) => usage[k].calls)
        .map(
          (k) =>
            `${k} ${usage[k].calls} call(s) ${usage[k].inputTokens} in / ${usage[k].outputTokens} out${usage[k].unknownUsage ? ` (${usage[k].unknownUsage} unknown)` : ''}`,
        )
        .join(
          '; ',
        )}; cost at list rate ${totalMicros === null ? 'unknown' : `$${(totalMicros / 1_000_000).toFixed(4)}`}`,
    );
  // Raw outputs go to --out-dir in the replay format, so eval:replay can re-score them offline.
  await writeFile(
    path.join(opts.outDir, 'recordings', 'manifest.json'),
    JSON.stringify(
      {
        version: 'replay-v1',
        golden_set: opts.golden.manifest.version,
        guardrail_version: opts.pipeline.guardrailVersion,
        scorer_version: SCORER_VERSION,
        thresholds_sha256: '0'.repeat(64),
        recordings: recordings.map((r) => ({
          id: r.runId,
          photo: r.photoId,
          file: `${r.runId}.json`,
          gate: true,
          shape: stage1.schemaVersion.endsWith('_v1') ? 'v1' : 'v2',
        })),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  for (const r of recordings)
    await writeFile(
      path.join(opts.outDir, 'recordings', `${r.runId}.json`),
      JSON.stringify(
        {
          quick: r.quick,
          enrichment: r.enrichment,
          quick_ms: r.quickMs,
          enrich_ms: r.enrichMs,
          quick_usage: r.quickUsage,
          enrich_usage: r.enrichUsage,
          verification1: r.verification1,
          verify1_ms: r.verify1Ms,
          verification2: r.verification2,
          verify2_ms: r.verify2Ms,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

  const runs: ScoredRun[] = [];
  // Each final candidate carries its G-BRAND-CORROBORATE result, as the compiler passes it to grounding.
  const finals = new Map<
    string,
    (VlmAnalysis['candidates'][number] & { corroborated: boolean })[]
  >();
  for (const r of recordings) {
    const { decisions, finalCandidates, verify: _v, ...run } = opts.pipeline.run(r);
    runs.push(run);
    const corroborated = brandCorroboratedIds(decisions);
    finals.set(
      r.photoId,
      finalCandidates.map((c) => ({ ...c, corroborated: corroborated.has(c.id) })),
    );
  }

  let qlooSent = 0;
  if (opts.qloo && !stoppedBy) {
    const q = opts.qloo;
    const qCounter = new RequestCounter(path.join(opts.outDir, QLOO_COUNTER), q.maxRequests);
    const qFetch: typeof fetch = async (input, init) => {
      await qCounter.reserve();
      const started = Date.now();
      const res = await (q.fetch ?? fetch)(input, init);
      await ledger({
        provider: 'qloo',
        endpoint: endpointOf(input),
        status: res.status,
        ms: Date.now() - started,
      });
      return res;
    };
    // One request in flight, spaced; the hackathon key allows at most three.
    const qloo = new QlooHttpProvider({
      apiKey: q.apiKey,
      baseUrl: q.baseUrl,
      timeoutMs: 20_000,
      fetch: qFetch,
      defaultRetries: 0,
    });
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    outer: for (const run of runs) {
      const records: GroundingRecord[] = [];
      for (const c of finals.get(run.photoId) ?? []) {
        const plan = q.grounding.planLookup(c);
        if (plan.kind === 'none') {
          records.push({
            candidate: c.name,
            accepted: false,
            plan: 'none',
            reason: plan.reason,
            candidateType: c.type,
            corroborated: c.corroborated,
            textOnly: c.text_only === true,
          });
          continue;
        }
        if ((await qCounter.used()) >= q.maxRequests) {
          stoppedBy = 'qloo_request_cap';
          break outer;
        }
        try {
          qlooSent++;
          const res =
            plan.kind === 'tags'
              ? await qloo.lookupTags(
                  { query: plan.query, tagTypes: plan.tagTypes, take: 10 },
                  { maxRetries: 0 },
                )
              : await qloo.searchEntities(
                  { query: plan.query, types: plan.types as never, take: 10 },
                  { maxRetries: 0 },
                );
          const verdict = q.grounding.acceptMatch(c, plan, res.data);
          const m = verdict.match;
          records.push({
            candidate: c.name,
            candidateType: c.type,
            corroborated: c.corroborated,
            textOnly: c.text_only === true,
            accepted: !!m,
            entityType: m && 'entity_id' in m ? (m.types[0] ?? null) : null,
            tagFamily: m && 'type' in m && !('entity_id' in m) ? tagFamily(m.type) : null,
            plan: plan.kind,
            query: plan.query,
            rule: verdict.rule,
            reason: verdict.reason,
            matchedName: m?.name ?? null,
            matchedId: m ? ('entity_id' in m ? m.entity_id : m.id) : null,
            top: res.data
              .slice(0, 5)
              .map((x) => ({ name: x.name, type: 'entity_id' in x ? x.types.join(',') : x.type })),
          });
        } catch (error) {
          if (error instanceof ProviderError && STOP_STATUSES.includes(error.status ?? 0)) {
            stoppedBy = `qloo_http_${error.status}`;
            break outer;
          }
          records.push({
            candidate: c.name,
            accepted: false,
            plan: plan.kind,
            query: plan.query,
            reason: 'request_failed',
            candidateType: c.type,
            corroborated: c.corroborated,
            textOnly: c.text_only === true,
          });
        }
        await sleep(q.spacingMs);
      }
      (run as { qloo?: QlooAcceptRecord[] }).qloo = records;
    }
  }

  const scorecard = scoreRuns(opts.golden.labels, runs, opts.thresholds, 'live', failed);
  // Grounding decisions per photo (candidate, query, accepted Qloo name and rule) for hand-labelled precision.
  if (opts.qloo)
    await writeFile(
      path.join(opts.outDir, 'grounding.json'),
      JSON.stringify(
        runs.map((r) => ({ photo: r.photoId, records: r.qloo ?? [] })),
        null,
        2,
      ),
      { mode: 0o600 },
    );
  // The grounding gate (thresholds.json "grounding") over every lookup this run made.
  const grounding = opts.qloo
    ? scoreGrounding(
        runs.map((r) => ({ photo: r.photoId, records: (r.qloo ?? []) as GroundingRecord[] })),
        opts.golden.labels,
        opts.thresholds.grounding,
        opts.qloo.judgements,
      )
    : undefined;
  await writeFile(
    path.join(opts.outDir, 'scorecard.json'),
    JSON.stringify(
      {
        ...scorecard,
        grounding_gate: grounding ?? null,
        stopped_by: stoppedBy ?? null,
        guardrail_version: opts.pipeline.guardrailVersion,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return {
    dryRun: false,
    plannedRequests,
    plannedQlooMax,
    stoppedBy,
    scorecard,
    ...(grounding ? { grounding } : {}),
    requestsSent: await counter.used(),
    qlooSent,
    usage,
  };
}
