import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CATALOG_SNAPSHOT_FILE,
  CatalogSnapshotSchema,
  ConcentrateVlm,
  ConcentrateVlmEnricher,
  MemorySpendStore,
  ModelSpendLedger,
  ProviderError,
  QlooHttpProvider,
  StructuredResponseRunner,
  boundJpegForProfile,
  brandCorroboratedIds,
  catalogCompatible,
  createConcentrateTransport,
  guardQuickRead,
  readingForProfile,
  stage2Request,
  type ModelProfile,
  type ModelProfiles,
  type QlooEntity,
  type QlooTag,
  type VlmAnalysis,
} from '../../packages/providers/src/index';
import { RequestCounter } from '../qualify-concentrate-lib';
import { verifiedGoldenPhotos } from './golden-photos';
import type { GoldenSet, Thresholds } from './labels';
import type { ReadingPipeline, Recording } from './pipeline';
import { scoreRuns, type CallRecord, type QlooAcceptRecord, type Scorecard, type ScoredRun } from './scorer';

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
  planLookup(c: VlmAnalysis['candidates'][number] & { corroborated?: boolean }):
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
  /** vision_photo alone (stage 1) or with vision_photo_enrich (both stages). */
  roles: readonly ('vision_photo' | 'vision_photo_enrich')[];
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
  };
  fetch?: typeof fetch;
  ledgerFile?: string;
  packageName?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface LiveEvalResult {
  dryRun: boolean;
  plannedRequests: number;
  plannedQlooMax: number;
  stoppedBy?: string;
  scorecard?: Scorecard;
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

export async function runLiveEval(opts: LiveEvalOptions): Promise<LiveEvalResult> {
  const log = opts.log ?? (() => undefined);
  const now = opts.now ?? (() => new Date());
  if (!path.relative(opts.repoRoot, path.resolve(opts.outDir)).startsWith('..'))
    throw new Error('--out-dir must be outside the repository (raw outputs never enter git).');
  if (!opts.roles.includes('vision_photo')) throw new Error('eval:live always runs the stage-1 vision_photo reading.');
  const stage1 = opts.profiles.vision_photo;
  if (!stage1 || readingForProfile(stage1) !== 'quick') throw new Error('Need a quick-read vision_photo profile.');
  const enrichProfile = opts.roles.includes('vision_photo_enrich') ? opts.profiles.vision_photo_enrich : undefined;
  if (opts.roles.includes('vision_photo_enrich') && !enrichProfile) throw new Error('Need the vision_photo_enrich profile.');
  if (opts.pipeline.guardrailVersion === null) throw new Error('eval:live scores through the guarded pipeline only.');

  const snapshot = CatalogSnapshotSchema.parse(JSON.parse(await readFile(path.join(opts.outDir, CATALOG_SNAPSHOT_FILE), 'utf8')));
  for (const p of [stage1, enrichProfile].filter((x): x is ModelProfile => !!x))
    if (!catalogCompatible(p, snapshot)) throw new Error(`${p.role} profile is not catalog-compatible with the snapshot in --out-dir.`);

  // Hash check before anything is planned or sent.
  let golden = opts.golden;
  if (opts.only?.length) {
    const unknown = opts.only.filter((id) => !golden.manifest.photos.some((p) => p.id === id));
    if (unknown.length) throw new Error(`Unknown photo id(s) in --only: ${unknown.join(', ')}`);
    golden = { ...golden, manifest: { ...golden.manifest, photos: golden.manifest.photos.filter((p) => opts.only!.includes(p.id)) } };
  }
  const photos = await verifiedGoldenPhotos(golden, opts.photosDir, opts.split);
  const perPhoto = enrichProfile ? 2 : 1;
  const plannedRequests = photos.length * perPhoto;
  const worstCase = photos.length * (stage1.reservationMicros + (enrichProfile?.reservationMicros ?? 0));
  if (plannedRequests > opts.maxRequests)
    throw new Error(`The run needs ${plannedRequests} requests; --max-requests is ${opts.maxRequests}.`);
  if (worstCase > opts.spendCapMicros) throw new Error('Worst-case reservation exceeds --spend-cap-usd.');
  const plannedQlooMax = opts.qloo?.maxRequests ?? 0;
  log(`plan: ${photos.length} photo(s) (${opts.split}), ${plannedRequests} Concentrate request(s), worst case ${worstCase} micro-USD, Qloo at most ${plannedQlooMax}`);
  if (!opts.confirmPaidRequests) return { dryRun: true, plannedRequests, plannedQlooMax };
  if (!opts.apiKey) throw new Error('A Concentrate key is required with --confirm-paid-requests.');

  await mkdir(path.join(opts.outDir, 'recordings'), { recursive: true, mode: 0o700 });
  const ledger = async (entry: Omit<LedgerEntry, 'ts' | 'package'>) => {
    if (!opts.ledgerFile) return;
    const line: LedgerEntry = { ts: now().toISOString(), package: opts.packageName ?? 'eval', ...entry };
    await appendFile(opts.ledgerFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  };
  const counter = new RequestCounter(path.join(opts.outDir, CONCENTRATE_COUNTER), opts.maxRequests);
  const baseFetch = opts.fetch ?? fetch;
  const countedFetch: typeof fetch = async (input, init) => {
    await counter.reserve();
    const started = Date.now();
    try {
      const res = await baseFetch(input, init);
      await ledger({ provider: 'concentrate', endpoint: endpointOf(input), status: res.status, ms: Date.now() - started });
      return res;
    } catch (error) {
      await ledger({ provider: 'concentrate', endpoint: endpointOf(input), status: 'network_error', ms: Date.now() - started });
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
    new StructuredResponseRunner(p, createConcentrateTransport({ apiKey: opts.apiKey!, fetch: countedFetch }), spend, {
      allowTestStore: true,
      identity: { accountId: 'operator-eval', jobId: `eval-live:${p.role}`, attemptKey: 'e' },
    });
  // One operator job per run: the in-memory spend ledger counts it as a single analysis.
  const jobId = `eval-live:${now().toISOString()}`;
  const identity = (photoId: string, stage: string) => ({
    modelIdentity: { accountId: 'operator-eval', jobId, attemptKey: `${photoId}:${stage}` },
  });
  const quickVlm = new ConcentrateVlm(runnerFor(stage1));
  const enricher = enrichProfile ? new ConcentrateVlmEnricher(runnerFor(enrichProfile)) : undefined;

  const recordings: Recording[] = [];
  const failed: { photoId: string; call: CallRecord }[] = [];
  let stoppedBy: string | undefined;
  const fail = (photoId: string, stage: CallRecord['stage'], error: unknown, ms: number) => {
    const incomplete = error instanceof Error && /incomplete|max_output_tokens/i.test(error.message);
    failed.push({ photoId, call: { stage, ms, valid: false, incomplete } });
    if (error instanceof Error && /Request cap reached/.test(error.message)) stoppedBy = 'request_cap';
    else if (error instanceof ProviderError && STOP_STATUSES.includes(error.status ?? 0)) stoppedBy = `http_${error.status}`;
    else if (error instanceof ProviderError && error.kind === 'unavailable') stoppedBy = 'role_disabled';
    log(`${photoId} ${stage}: ${error instanceof ProviderError ? `${error.kind}${error.status ? ` ${error.status}` : ''}` : 'local_error'}`);
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
    const rec: Recording = { photoId: photo.id, runId: `LIVE-${photo.id}`, quick: quick.quick, quickMs: Date.now() - started };
    if (enricher && enrichProfile) {
      started = Date.now();
      try {
        const bounded = await boundJpegForProfile(bytes, enrichProfile.image);
        const res = await enricher.enrichImage(
          {
            image: { bytes: bounded.bytes, mediaType: 'image/jpeg' },
            // Exactly what production sends: the guarded title, published names, then held names.
            stage1: (() => {
              const g1 = guardQuickRead(quick.analysis, { twoStage: true });
              return stage2Request(g1.analysis, g1.held);
            })(),
          },
          { maxRetries: 0, ...identity(photo.id, 'stage2') },
        );
        rec.enrichment = res.enrichment;
        rec.enrichMs = Date.now() - started;
      } catch (error) {
        fail(photo.id, 'enrich', error, Date.now() - started);
      }
    }
    recordings.push(rec);
  }

  // Raw outputs go to --out-dir in the replay format, so eval:replay can re-score them offline.
  await writeFile(
    path.join(opts.outDir, 'recordings', 'manifest.json'),
    JSON.stringify(
      {
        version: 'replay-v1',
        golden_set: opts.golden.manifest.version,
        guardrail_version: opts.pipeline.guardrailVersion,
        scorer_version: 'score-v1',
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
      JSON.stringify({ quick: r.quick, enrichment: r.enrichment, quick_ms: r.quickMs, enrich_ms: r.enrichMs }, null, 2),
      { mode: 0o600 },
    );

  const runs: ScoredRun[] = [];
  // Each final candidate carries its G-BRAND-CORROBORATE result, as the compiler passes it to grounding.
  const finals = new Map<string, (VlmAnalysis['candidates'][number] & { corroborated: boolean })[]>();
  for (const r of recordings) {
    const { decisions, finalCandidates, ...run } = opts.pipeline.run(r);
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
      await ledger({ provider: 'qloo', endpoint: endpointOf(input), status: res.status, ms: Date.now() - started });
      return res;
    };
    // One request in flight, spaced; the hackathon key allows at most three.
    const qloo = new QlooHttpProvider({ apiKey: q.apiKey, baseUrl: q.baseUrl, timeoutMs: 20_000, fetch: qFetch, defaultRetries: 0 });
    const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    outer: for (const run of runs) {
      const records: QlooAcceptRecord[] = [];
      for (const c of finals.get(run.photoId) ?? []) {
        const plan = q.grounding.planLookup(c);
        if (plan.kind === 'none') {
          records.push({ candidate: c.name, accepted: false });
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
              ? await qloo.lookupTags({ query: plan.query, tagTypes: plan.tagTypes, take: 10 }, { maxRetries: 0 })
              : await qloo.searchEntities({ query: plan.query, types: plan.types as never, take: 10 }, { maxRetries: 0 });
          const verdict = q.grounding.acceptMatch(c, plan, res.data);
          const m = verdict.match;
          records.push({
            candidate: c.name,
            accepted: !!m,
            entityType: m && 'entity_id' in m ? (m.types[0] ?? null) : null,
            tagFamily: m && 'type' in m && !('entity_id' in m) ? tagFamily(m.type) : null,
          });
        } catch (error) {
          if (error instanceof ProviderError && STOP_STATUSES.includes(error.status ?? 0)) {
            stoppedBy = `qloo_http_${error.status}`;
            break outer;
          }
          records.push({ candidate: c.name, accepted: false });
        }
        await sleep(q.spacingMs);
      }
      (run as { qloo?: QlooAcceptRecord[] }).qloo = records;
    }
  }

  const scorecard = scoreRuns(opts.golden.labels, runs, opts.thresholds, 'live', failed);
  await writeFile(
    path.join(opts.outDir, 'scorecard.json'),
    JSON.stringify({ ...scorecard, stopped_by: stoppedBy ?? null, guardrail_version: opts.pipeline.guardrailVersion }, null, 2),
    { mode: 0o600 },
  );
  return {
    dryRun: false,
    plannedRequests,
    plannedQlooMax,
    stoppedBy,
    scorecard,
    requestsSent: await counter.used(),
    qlooSent,
  };
}
