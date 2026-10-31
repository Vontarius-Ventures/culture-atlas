import { VisualSimilarityWireSchema, validateVisualSimilarity, VISUAL_SIMILARITY_SCHEMA_VERSION, type VisualSimilarityResult } from '@culture-atlas/providers';
import { z } from 'zod';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { lockLiveCapture } from '../compiler/store';
import type { JobContext, JobHandler } from '../jobs/handler';
import { enqueueJob } from '../jobs/queue';
import { activeKills } from '../flags/feature-flags';
import { stableStringify } from '../util/stable-json';
import type { VisualReferenceCard, VisualReferenceState } from '../schemas/discovery-intents';
import type { StoredStyleReading } from './types';
import { loadVisualCatalog, readVisualCatalogImage, visualSha256, type VisualCatalogObject, type LoadedVisualCatalog } from './visual-catalog';
import { eligibleVisualSubjects, selectVisualCandidates, VISUAL_CANDIDATE_SELECTION_POLICY_VERSION } from './visual-candidate-selection';
import { INTENT_COMPILER_VERSION } from './intent-version';

export { eligibleVisualSubjects, selectVisualCandidates, VISUAL_CANDIDATE_SELECTION_POLICY_VERSION } from './visual-candidate-selection';
export type { VisualCandidate, VisualCandidateDiagnostic, VisualCandidateSelection, VisualCandidateReason, VisualSubjectReason } from './visual-candidate-selection';

export { INTENT_COMPILER_VERSION } from './intent-version';
const Region = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) })
  .refine(b => b.x + b.w <= 1.000001 && b.y + b.h <= 1.000001);
const Candidate = z.object({
  catalog_id: z.string(), image_hash: z.string().regex(/^[a-f0-9]{64}$/),
  subject_id: z.enum(['s1', 's2']), subject_label: z.string().max(100), region: Region,
});
type Candidate = z.infer<typeof Candidate>;
const Result = VisualSimilarityWireSchema.extend({
  sourceImageSha256: z.string().regex(/^[a-f0-9]{64}$/), candidateImageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contactSheetSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceRegion: Region,
  model: z.string().min(1).max(200), profileVersion: z.string().min(1).max(200),
  schemaVersion: z.literal(VISUAL_SIMILARITY_SCHEMA_VERSION), experimental: z.boolean(),
});
type Evidence = { candidate: Candidate; result?: VisualSimilarityResult; reason?: VisualReferenceState['reason'] };
interface Run {
  capture_id: string; analysis_id: string; job_id: string | null; owner_account_id: string;
  catalog_hash: string; catalog_version: string; source_hash: string; source_asset_hash: string; reading_hash: string;
  status: VisualReferenceState['status']; reason: VisualReferenceState['reason'];
  candidates: Candidate[]; attempted_ids: string[]; evidence: Evidence[];
}
interface Analysis {
  style_reading: StoredStyleReading | null; section_statuses: Record<string, string>; compiler_version: string;
}
const state = (status: VisualReferenceState['status'], reason: VisualReferenceState['reason'], cards: VisualReferenceCard[] = []): VisualReferenceState => ({ status, reason, cards });
export const visualReadingHash = (reading: StoredStyleReading): string => visualSha256(stableStringify({
  selection_policy_version: VISUAL_CANDIDATE_SELECTION_POLICY_VERSION, reading,
}));

/** Backward-compatible shortlist shape; diagnostics are available separately. */
export function shortlistVisualCandidates(reading: StoredStyleReading, catalog: LoadedVisualCatalog, limit: number): Candidate[] {
  return selectVisualCandidates(reading, catalog, limit).candidates;
}

/** Called once after final guarded style publication, not by reads or mode switching. */
export async function enqueueVisualReferences(ctx: JobContext, captureId: string, analysisId: string): Promise<void> {
  if (!ctx.job.owner_account_id || ctx.config.VISUAL_MAX_COMPARISONS_PER_CAPTURE === 0 ||
    !ctx.config.VISUAL_REFERENCE_CATALOG_FILE || !ctx.providers.visualSimilarity.isConfigured()) return;
  const loaded = await loadVisualCatalog(ctx.config.VISUAL_REFERENCE_CATALOG_FILE);
  if (!loaded) return;
  const kills = await activeKills(ctx.db, ctx.job.owner_account_id, ctx.config);
  if (kills.has('concentrate_analysis_enabled') || kills.has('experimental_analysis_enabled')) return;
  await ctx.ensureActive();
  await ctx.db.transaction(async tx => {
    const c = await lockLiveCapture(tx, captureId);
    if (!c || c.active_analysis_id !== analysisId || c.owner_account_id !== ctx.job.owner_account_id || !c.private_object_key) return;
    const { rows } = await tx.query<Analysis>('SELECT style_reading, section_statuses, compiler_version FROM analyses WHERE id = $1', [analysisId]);
    const a = rows[0];
    if (!a?.style_reading || a.section_statuses.style !== 'ready' || a.compiler_version !== INTENT_COMPILER_VERSION) return;
    const candidates = shortlistVisualCandidates(a.style_reading, loaded, ctx.config.VISUAL_MAX_COMPARISONS_PER_CAPTURE);
    if (!candidates.length) return;
    const source = await ctx.providers.storage.get(c.private_object_key).catch(() => null);
    if (!source || source.body.length > ctx.config.UPLOAD_MAX_BYTES) return;
    const hash = visualReadingHash(a.style_reading);
    const inserted = await tx.query(
      `INSERT INTO visual_reference_runs (capture_id, analysis_id, owner_account_id, catalog_hash, catalog_version,
         source_hash, reading_hash, status, candidates, source_asset_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8::jsonb,$9) ON CONFLICT (capture_id) DO NOTHING RETURNING capture_id`,
      [captureId, analysisId, c.owner_account_id, loaded.hash, loaded.catalog.catalog_version, visualSha256(source.body), hash, JSON.stringify(candidates), c.image_sha256],
    );
    if (!inserted.rows.length) return;
    const { job } = await enqueueJob(tx, {
      type: 'visual_reference_discovery', owner: { kind: 'account', accountId: c.owner_account_id! },
      payload: { capture_id: captureId, analysis_id: analysisId, catalog_hash: loaded.hash, reading_hash: hash },
      maxAttempts: 1, budget: { qloo_requests: 0, research_refs: 0, provider_retries: 0, deadline_ms: 30_000 },
      dedupeKey: `visual:${visualSha256(stableStringify({ owner: c.owner_account_id, captureId, analysisId, source: visualSha256(source.body), catalog: loaded.hash, hash, candidates }))}`,
      agentConnectionId: ctx.job.agent_connection_id, traceId: ctx.job.trace_id ?? undefined,
      resultType: 'capture', resultId: captureId,
    });
    await tx.query('UPDATE visual_reference_runs SET job_id = $2 WHERE capture_id = $1', [captureId, job.id]);
  });
}

async function currentRun(db: Queryable, run: Run, owner: string, jobId?: string, workerId?: string): Promise<boolean> {
  const { rows } = await db.query<Analysis & { owner_account_id: string; active_analysis_id: string; image_sha256: string; source_key: string | null; live: boolean }>(
    `SELECT a.style_reading, a.section_statuses, a.compiler_version, c.owner_account_id, c.active_analysis_id,
       c.private_object_key AS source_key, c.image_sha256, (c.deleted_at IS NULL) AS live
       FROM captures c JOIN analyses a ON a.id = c.active_analysis_id WHERE c.id = $1`, [run.capture_id],
  );
  const a = rows[0];
  if (!a?.live || !a.source_key || a.image_sha256 !== run.source_asset_hash || a.owner_account_id !== owner || run.owner_account_id !== owner ||
    a.active_analysis_id !== run.analysis_id || !a.style_reading || a.section_statuses.style !== 'ready' ||
    a.compiler_version !== INTENT_COMPILER_VERSION || visualReadingHash(a.style_reading) !== run.reading_hash) return false;
  const subjects = eligibleVisualSubjects(a.style_reading);
  if (!run.candidates.every(c => subjects.some(s => s.id === c.subject_id && s.label === c.subject_label &&
    stableStringify(s.region) === stableStringify(c.region)))) return false;
  if (jobId) {
    if (run.job_id !== jobId) return false;
    const { rows: jobs } = await db.query(`SELECT 1 FROM jobs WHERE id=$1 AND state='running'
      AND cancel_requested_at IS NULL AND lease_expiry > now() AND ($2::text IS NULL OR lease_owner=$2)`, [jobId, workerId ?? null]);
    if (!jobs.length) return false;
  }
  return true;
}
async function sourceStillMatches(ctx: Pick<JobContext, 'db' | 'providers' | 'config'>, run: Run, db: Queryable = ctx.db): Promise<boolean> {
  const { rows } = await db.query<{ private_object_key: string | null }>('SELECT private_object_key FROM captures WHERE id=$1 AND deleted_at IS NULL', [run.capture_id]);
  const key = rows[0]?.private_object_key;
  const source = key ? await ctx.providers.storage.get(key).catch(() => null) : null;
  return !!source && source.body.length <= ctx.config.UPLOAD_MAX_BYTES && visualSha256(source.body) === run.source_hash;
}
export function acceptedVisualResult(result: VisualSimilarityResult, run: { source_hash: string }, candidate: Candidate): boolean {
  const parsed = Result.safeParse(result);
  if (!parsed.success) return false;
  try { validateVisualSimilarity(parsed.data); } catch { return false; }
  return parsed.success && result.sameObjectType && ['strong', 'moderate'].includes(result.similarity) &&
    result.matchedFeatures.length > 0 && result.sourceImageSha256 === run.source_hash &&
    result.candidateImageSha256 === candidate.image_hash && result.sourceImageSha256 !== result.candidateImageSha256 &&
    stableStringify(result.sourceRegion) === stableStringify(candidate.region);
}
function card(run: Run, candidate: Candidate, item: VisualCatalogObject, result: VisualSimilarityResult): VisualReferenceCard {
  return {
    id: `visual:${run.analysis_id}:${candidate.subject_id}:${item.id}`, catalog_id: item.id, subject_id: candidate.subject_id,
    title: item.title, object_type: item.object_type, institution: item.institution,
    image: { url: `/v1/visual-references/images/${item.image_sha256}`, alt: item.title }, source_url: item.source_url,
    // Never copy free-form provider claims into public explanations.
    explanation: 'A model suggests similarities in visible form or surface to this reference image.',
    ...('creator' in item ? {
      credit: {
        attribution: `${item.creator}${item.attribution === item.creator ? '' : `; ${item.attribution}`}`,
        license: item.license, license_url: item.license_url,
        changes: 'Converted to JPEG, orientation normalized, metadata removed.',
      },
    } : {}),
    limitations: 'Experimental visual reference, not an identification, maker attribution, authentication, or item for sale.',
    comparison: 'model_suggested', experimental: result.experimental,
  };
}

export const visualReferenceDiscovery: JobHandler<'visual_reference_discovery'> = async ctx => {
  const done = { state: 'complete' as const, resultType: 'capture', resultId: ctx.payload.capture_id };
  const { rows } = await ctx.db.query<Run>('SELECT * FROM visual_reference_runs WHERE capture_id = $1', [ctx.payload.capture_id]);
  const run = rows[0];
  if (!run || !ctx.job.owner_account_id || run.analysis_id !== ctx.payload.analysis_id ||
    run.catalog_hash !== ctx.payload.catalog_hash || run.reading_hash !== ctx.payload.reading_hash ||
    !(await currentRun(ctx.db, run, ctx.job.owner_account_id, ctx.job.id, ctx.workerId))) return done;
  const finish = async (status: Run['status'], reason: Run['reason']) => {
    await ctx.ensureActive();
    await ctx.db.query('UPDATE visual_reference_runs SET status=$2, reason=$3, updated_at=now() WHERE capture_id=$1 AND job_id=$4',
      [run.capture_id, status, reason, ctx.job.id]);
    return done;
  };
  if (!ctx.config.VISUAL_MAX_COMPARISONS_PER_CAPTURE || !ctx.providers.visualSimilarity.isConfigured()) return finish('unavailable', 'provider_unavailable');
  const kills = await activeKills(ctx.db, ctx.job.owner_account_id, ctx.config);
  if (kills.has('concentrate_analysis_enabled') || kills.has('experimental_analysis_enabled')) return finish('unavailable', 'provider_unavailable');
  const loaded = await loadVisualCatalog(ctx.config.VISUAL_REFERENCE_CATALOG_FILE);
  if (!loaded || loaded.hash !== run.catalog_hash) return finish('unavailable', 'catalog_unavailable');
  const { rows: captures } = await ctx.db.query<{ private_object_key: string | null }>('SELECT private_object_key FROM captures WHERE id=$1', [run.capture_id]);
  const key = captures[0]?.private_object_key;
  const source = key ? await ctx.providers.storage.get(key).catch(() => null) : null;
  if (!source || source.body.length > ctx.config.UPLOAD_MAX_BYTES || visualSha256(source.body) !== run.source_hash) return finish('unavailable', 'asset_unavailable');
  await finish('running', null);
  // Two candidates maximum. Database advisory slots bound comparison concurrency across workers.
  // Attempt markers commit BEFORE calling the provider. Lease loss never replays a paid comparison.
  for (const candidate of z.array(Candidate).max(2).parse(run.candidates).slice(0, ctx.config.VISUAL_MAX_COMPARISONS_PER_CAPTURE)) {
    await ctx.ensureActive();
    if (!(await currentRun(ctx.db, run, ctx.job.owner_account_id, ctx.job.id, ctx.workerId)) || !(await sourceStillMatches(ctx, run))) return done;
    const item = loaded.catalog.objects.find(o => o.id === candidate.catalog_id && o.image_sha256 === candidate.image_hash);
    let evidence: Evidence = { candidate, reason: 'asset_unavailable' };
    try {
      if (!item) throw new Error('asset_unavailable');
      const image = await readVisualCatalogImage(loaded.catalog, item);
      if (candidate.image_hash === run.source_hash) continue;
      const admitted = await ctx.db.query(
        `UPDATE visual_reference_runs SET attempted_ids = array_append(attempted_ids, $2), updated_at=now()
         WHERE capture_id=$1 AND NOT ($2 = ANY(attempted_ids)) AND cardinality(attempted_ids)<2 AND job_id=$3 RETURNING capture_id`,
        [run.capture_id, `${candidate.subject_id}:${candidate.catalog_id}`, ctx.job.id],
      );
      if (!admitted.rows.length) continue;
      const result = await ctx.db.transaction(async slot => {
        // No queue or automatic favorable retry when both global slots are busy.
        let acquired = false;
        for (const id of [1, 2]) {
          const { rows: locks } = await slot.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock(742109, $1) AS acquired', [id]);
          if (locks[0]?.acquired) { acquired = true; break; }
        }
        if (!acquired) throw new Error('comparison_concurrency');
        await ctx.ensureActive();
        if (!(await currentRun(slot, run, ctx.job.owner_account_id!, ctx.job.id, ctx.workerId))) throw new Error('stale_analysis');
        const currentKills = await activeKills(slot, ctx.job.owner_account_id!, ctx.config);
        if (currentKills.has('concentrate_analysis_enabled') || currentKills.has('experimental_analysis_enabled')) throw new Error('comparison_paused');
        return ctx.providers.visualSimilarity.compare({
          sourceImage: source.body, candidateImage: image.bytes, sourceRegion: candidate.region,
          subjectLabel: candidate.subject_label, candidateLabel: `${item.object_type}: ${item.title}`.slice(0, 160),
        }, {
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]), maxRetries: 0, timeoutMs: 20_000,
          modelIdentity: {
            accountId: ctx.job.owner_account_id!, jobId: ctx.job.id,
            attemptKey: visualSha256(stableStringify({ analysis: run.analysis_id, source: run.source_hash, candidate, catalog: run.catalog_hash, reading: run.reading_hash })),
          },
        });
      });
      const validated = Result.parse(result);
      validateVisualSimilarity(validated);
      if (validated.sourceImageSha256 !== run.source_hash || validated.candidateImageSha256 !== candidate.image_hash ||
        stableStringify(validated.sourceRegion) !== stableStringify(candidate.region)) throw new Error('comparison_binding');
      evidence = { candidate, result: validated };
    } catch (err) {
      evidence = { candidate, reason: ctx.signal.aborted || (err as { kind?: string }).kind === 'timeout' ? 'comparison_timeout' : 'comparison_failed' };
    }
    await ctx.ensureActive();
    await ctx.db.transaction(async tx => {
      const capture = await lockLiveCapture(tx, run.capture_id);
      if (!capture || !(await currentRun(tx, run, ctx.job.owner_account_id!, ctx.job.id, ctx.workerId)) || !(await sourceStillMatches(ctx, run, tx))) return;
      if (item && evidence.result) {
        try { await readVisualCatalogImage(loaded.catalog, item); } catch { return; }
      }
      await tx.query(`UPDATE visual_reference_runs SET evidence = evidence || $2::jsonb, updated_at=now() WHERE capture_id=$1 AND job_id=$3`,
        [run.capture_id, JSON.stringify([evidence]), ctx.job.id]);
    });
  }
  const { rows: completed } = await ctx.db.query<Run>('SELECT * FROM visual_reference_runs WHERE capture_id=$1', [run.capture_id]);
  const evidence = completed[0]?.evidence ?? [];
  const accepted = evidence.some(e => e.result && acceptedVisualResult(e.result, run, e.candidate));
  return finish(accepted ? 'ready' : evidence.some(e => e.reason) || !evidence.length ? 'failed' : 'empty',
    accepted ? null : evidence.some(e => e.reason === 'comparison_timeout') ? 'comparison_timeout' :
      evidence.some(e => e.reason) || !evidence.length ? 'comparison_failed' : 'no_visual_matches');
};

/** Reads never enqueue/retry. Ownership is checked again even after the caller's capture grant. */
export async function loadVisualReferenceState(ctx: ServiceContext, captureId: string, analysisId: string): Promise<VisualReferenceState> {
  if (!ctx.config.VISUAL_MAX_COMPARISONS_PER_CAPTURE || !ctx.config.VISUAL_REFERENCE_CATALOG_FILE) return state('unavailable', 'not_configured');
  if (!ctx.providers.visualSimilarity.isConfigured()) return state('unavailable', 'provider_unavailable');
  const loaded = await loadVisualCatalog(ctx.config.VISUAL_REFERENCE_CATALOG_FILE);
  if (!loaded) return state('unavailable', 'catalog_unavailable');
  const { rows } = await ctx.db.query<Run>('SELECT * FROM visual_reference_runs WHERE capture_id=$1 AND analysis_id=$2', [captureId, analysisId]);
  const run = rows[0];
  if (!run) {
    const { rows: parent } = await ctx.db.query(`SELECT 1 FROM analyses a JOIN jobs j ON j.id=a.job_id
      WHERE a.id=$1 AND j.state IN ('queued','running') AND j.cancel_requested_at IS NULL`, [analysisId]);
    if (parent.length) return state('pending', null);
    const { rows: previous } = await ctx.db.query('SELECT 1 FROM visual_reference_runs WHERE capture_id=$1', [captureId]);
    if (previous.length) return state('unavailable', 'comparison_limit');
    const { rows: analyses } = await ctx.db.query<Analysis>('SELECT style_reading, section_statuses, compiler_version FROM analyses WHERE id=$1', [analysisId]);
    const a = analyses[0];
    if (a?.section_statuses.style === 'pending' || a?.section_statuses.style === 'running') return state('pending', null);
    if (!a?.style_reading || !eligibleVisualSubjects(a.style_reading).length) return state('unavailable', 'no_supported_subject');
    if (shortlistVisualCandidates(a.style_reading, loaded, ctx.config.VISUAL_MAX_COMPARISONS_PER_CAPTURE).length) {
      const { rows: source } = await ctx.db.query<{ private_object_key: string | null }>('SELECT private_object_key FROM captures WHERE id=$1 AND deleted_at IS NULL', [captureId]);
      const key = source[0]?.private_object_key;
      if (!key || !(await ctx.providers.storage.get(key).catch(() => null))) return state('unavailable', 'asset_unavailable');
      // Configuration enabled after analysis does not retroactively start paid work.
      return state('unavailable', 'not_configured');
    }
    return state('empty', 'no_compatible_candidates');
  }
  const owner = 'accountId' in ctx.principal ? ctx.principal.accountId : null;
  if (!owner || run.catalog_hash !== loaded.hash || !(await currentRun(ctx.db, run, owner))) return state('unavailable', 'stale_analysis');
  if (!(await sourceStillMatches(ctx, run))) return state('unavailable', 'asset_unavailable');
  const { rows: jobs } = await ctx.db.query<{ state: string; cancel_requested_at: Date | null }>('SELECT state, cancel_requested_at FROM jobs WHERE id=$1', [run.job_id]);
  const job = jobs[0];
  if (!job || job.cancel_requested_at || job.state === 'cancelled') return state('unavailable', 'cancelled');
  if (job.state === 'failed') return state('failed', 'comparison_failed');
  const cards: VisualReferenceCard[] = [];
  for (const e of run.evidence) {
    if (!e.result || !acceptedVisualResult(e.result, run, e.candidate)) continue;
    const item = loaded.catalog.objects.find(o => o.id === e.candidate.catalog_id && o.image_sha256 === e.candidate.image_hash);
    if (!item) continue;
    try { await readVisualCatalogImage(loaded.catalog, item); } catch { continue; }
    cards.push(card(run, e.candidate, item, e.result));
  }
  if (run.status === 'ready' && !cards.length) return state('unavailable', 'asset_unavailable');
  return state(run.status, run.reason, cards.slice(0, 2));
}
