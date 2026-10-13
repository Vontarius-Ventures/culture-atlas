import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasWholeLibrary, requireNotSensorBridge, requireScopes, requireWholeLibrary } from '../authz';
import type { ServiceContext } from '../context';
import type { Db, Queryable } from '../db/pool';
import { CATEGORIES, LIMITS, type CaptureSource, type Category } from '../enums';
import { AppError } from '../errors';
import { analysisDedupeKey } from '../jobs/dedupe';
import { cancelJobsForResult, enqueueJob } from '../jobs/queue';
import type { JobRecord } from '../jobs/types';
import { normalizeImage } from '../media/image';
import { ownerOf, ownerPredicate, type Owner } from '../principal';
import type {
  CaptureResponse,
  CreateCaptureJsonRequest,
  CreateCaptureMultipartFields,
  CreateCaptureResponse,
  SensorAssetRef,
} from '../schemas/captures';
import type { Focus, ReferenceSummary } from '../schemas/common';
import type { UploadResponse } from '../schemas/uploads';
import { iso } from '../util/time';
import { loadCards, resolveImage, type CardRecommendationContext } from './cards';
import { bumpTasteRevision, rebuildTasteProfile } from './taste';

/**
 * Capture Intake module.
 * Owner + grant rules: captures:write to create; selected-collection agents may
 * only read captures in granted collections or uploads created by that
 * connection; sensor_bridge tokens may only create captures for their own
 * sensor connection (dedupe connection_id + asset_id via sensor_imports).
 *
 * Storage layout (private): owners/<a|s>-<owner id>/uploads/<upload id>/derivative.jpg
 * and owners/<...>/captures/<capture id>/{derivative.jpg,original}.
 */

export interface UploadInput {
  bytes: Uint8Array;
  filename?: string;
  declaredContentType?: string;
}

export type CreateCaptureInput =
  | { kind: 'multipart'; image: UploadInput; fields: CreateCaptureMultipartFields }
  | { kind: 'json'; body: CreateCaptureJsonRequest };

const WHOLE: Focus = { kind: 'whole' };

function ownerDir(owner: Owner): string {
  return owner.kind === 'account' ? `owners/a-${owner.accountId}` : `owners/s-${owner.sessionId}`;
}

export function captureObjectPrefix(owner: Owner, captureId: string): string {
  return `${ownerDir(owner)}/captures/${captureId}`;
}

function imageLimits(ctx: ServiceContext) {
  return { maxBytes: ctx.config.UPLOAD_MAX_BYTES, maxPixels: ctx.config.UPLOAD_MAX_PIXELS, maxEdge: ctx.config.IMAGE_MAX_EDGE };
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Atomic daily quota (usage_counters). Returns false when the limit is
 * reached. Call inside the transaction that creates the work so a rollback
 * also releases the unit.
 */
export async function consumeDailyQuota(db: Queryable, bucket: string, metric: string, limit: number, now: Date): Promise<boolean> {
  const { rows } = await db.query<{ count: number }>(
    `INSERT INTO usage_counters (bucket, metric, day, count) VALUES ($1, $2, $3, 1)
     ON CONFLICT (bucket, metric, day) DO UPDATE SET count = usage_counters.count + 1
       WHERE usage_counters.count < $4
     RETURNING count`,
    [bucket, metric, utcDay(now), limit],
  );
  return rows.length === 1;
}

export async function consumeAnalysisQuota(ctx: ServiceContext, db: Queryable, owner: Owner): Promise<void> {
  const anonymous = owner.kind === 'session';
  const bucket = anonymous ? `session:${owner.sessionId}` : `account:${owner.accountId}`;
  const limit = anonymous ? ctx.config.ANON_DAILY_ANALYSES : ctx.config.ACCOUNT_DAILY_ANALYSES;
  if (!(await consumeDailyQuota(db, bucket, 'analyses', limit, ctx.now()))) {
    throw new AppError('quota_exceeded', { message: 'You have reached today’s photo limit. Try again tomorrow.', retryAfter: 3600 });
  }
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * POST /v1/uploads — validate + normalize bytes (media/image.ts), store the
 * derivative privately, create an `uploads` row (expires in 24h).
 */
export async function createUpload(ctx: ServiceContext, input: UploadInput): Promise<UploadResponse> {
  requireScopes(ctx.principal, 'captures:write');
  const owner = ownerOf(ctx.principal);
  const image = await normalizeImage(input.bytes, imageLimits(ctx));
  const id = randomUUID();
  const key = `${ownerDir(owner)}/uploads/${id}/derivative.jpg`;
  await ctx.providers.storage.put(key, image.derivative, { contentType: image.derivativeContentType });
  if (ctx.config.STORE_ORIGINALS) {
    await ctx.providers.storage.put(`${ownerDir(owner)}/uploads/${id}/original`, input.bytes, { contentType: image.originalContentType });
  }
  const { rows } = await ctx.db.query<{ expires_at: Date }>(
    `INSERT INTO uploads (id, owner_account_id, owner_session_id, agent_connection_id, object_key, content_type,
                          byte_size, sha256, width, height, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz + interval '24 hours')
     RETURNING expires_at`,
    [
      id,
      owner.kind === 'account' ? owner.accountId : null,
      owner.kind === 'session' ? owner.sessionId : null,
      ctx.principal.kind === 'agent' ? ctx.principal.connectionId : null,
      key,
      image.originalContentType,
      image.originalByteSize,
      image.sha256,
      image.width,
      image.height,
      ctx.now(),
    ],
  );
  return {
    upload_id: id,
    content_type: image.originalContentType,
    byte_size: image.originalByteSize,
    width: image.width,
    height: image.height,
    expires_at: iso(rows[0]!.expires_at),
  };
}

// ---------------------------------------------------------------------------
// Capture creation
// ---------------------------------------------------------------------------

interface ResolvedImage {
  derivative: Uint8Array;
  width: number;
  height: number;
  sha256: string;
  original?: { bytes: Uint8Array; contentType: string };
  uploadId: string | null;
}

interface UploadRow {
  id: string;
  object_key: string;
  sha256: string;
  width: number | null;
  height: number | null;
  agent_connection_id: string | null;
  expires_at: Date;
}

async function loadOwnedUpload(ctx: ServiceContext, uploadId: string): Promise<UploadRow> {
  const owner = ownerOf(ctx.principal);
  const own = ownerPredicate(owner, 'u', 2);
  const { rows } = await ctx.db.query<UploadRow>(
    `SELECT u.id, u.object_key, u.sha256, u.width, u.height, u.agent_connection_id, u.expires_at
       FROM uploads u WHERE u.id = $1 AND ${own.sql}`,
    [uploadId, ...own.params],
  );
  const row = rows[0];
  if (!row || row.expires_at.getTime() < ctx.now().getTime()) throw new AppError('not_found', { message: 'That upload was not found or has expired.' });
  // Selected-collection agents may only use uploads they created themselves.
  const p = ctx.principal;
  if (p.kind === 'agent' && p.libraryAccess !== 'all' && row.agent_connection_id !== p.connectionId) throw new AppError('not_found');
  return row;
}

const SAMPLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAMPLE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * Example photos ("Try an example"). Bytes come from object storage key
 * `samples/<id>.<ext>` or the public sample directory
 * (apps/web/public/samples/<id>.<ext>). Each visitor gets their own capture
 * and a real analysis.
 */
export async function loadSampleImage(ctx: ServiceContext, sampleId: string): Promise<Uint8Array> {
  if (!SAMPLE_ID.test(sampleId)) throw new AppError('not_found', { message: 'That example was not found.' });
  for (const ext of SAMPLE_EXTENSIONS) {
    const obj = await ctx.providers.storage.get(`samples/${sampleId}.${ext}`).catch(() => null);
    if (obj) return obj.body;
  }
  const dirs = [path.resolve('public/samples'), path.resolve('apps/web/public/samples'), path.resolve('../web/public/samples')];
  for (const dir of dirs) {
    for (const ext of SAMPLE_EXTENSIONS) {
      try {
        return new Uint8Array(await readFile(path.join(dir, `${sampleId}.${ext}`)));
      } catch {
        // try next
      }
    }
  }
  throw new AppError('not_found', { message: 'That example was not found.' });
}

async function resolveCaptureImage(ctx: ServiceContext, input: CreateCaptureInput): Promise<{ image: ResolvedImage; source: CaptureSource; focus: Focus; capturedAt: string | null; sampleId: string | null; sensor: SensorAssetRef | null }> {
  if (input.kind === 'multipart') {
    const n = await normalizeImage(input.image.bytes, imageLimits(ctx));
    return {
      image: {
        derivative: n.derivative,
        width: n.width,
        height: n.height,
        sha256: n.sha256,
        original: ctx.config.STORE_ORIGINALS ? { bytes: input.image.bytes, contentType: n.originalContentType } : undefined,
        uploadId: null,
      },
      source: input.fields.source,
      focus: input.fields.focus ?? WHOLE,
      capturedAt: input.fields.captured_at ?? null,
      sampleId: null,
      sensor: null,
    };
  }
  const body = input.body;
  const focus = body.focus ?? WHOLE;
  if (body.sample_id) {
    const bytes = await loadSampleImage(ctx, body.sample_id);
    const n = await normalizeImage(bytes, imageLimits(ctx));
    return { image: { derivative: n.derivative, width: n.width, height: n.height, sha256: n.sha256, uploadId: null }, source: 'sample', focus, capturedAt: null, sampleId: body.sample_id, sensor: null };
  }
  const upload = await loadOwnedUpload(ctx, body.upload_id!);
  const obj = await ctx.providers.storage.get(upload.object_key);
  if (!obj) throw new AppError('not_found', { message: 'That upload was not found or has expired.' });
  const source: CaptureSource = body.sensor ? 'sensor' : body.source === 'camera' ? 'camera' : 'upload';
  return {
    image: { derivative: obj.body, width: upload.width ?? 0, height: upload.height ?? 0, sha256: upload.sha256, uploadId: upload.id },
    source,
    focus,
    capturedAt: body.sensor?.captured_at ?? body.captured_at ?? null,
    sampleId: null,
    sensor: body.sensor ?? null,
  };
}

/** Sensor imports: only the bridge token for that connection (or an owning account) may import. */
async function checkSensorImport(ctx: ServiceContext, sensor: SensorAssetRef, sha256: string): Promise<void> {
  const p = ctx.principal;
  if (p.kind === 'agent' && (p.purpose !== 'sensor_bridge' || p.sensorConnectionId !== sensor.connection_id)) throw new AppError('scope_denied');
  if (p.kind === 'anonymous') throw new AppError('account_required');
  const owner = ownerOf(p);
  const own = ownerPredicate(owner, 's', 2);
  const { rows } = await ctx.db.query(`SELECT 1 FROM sensor_connections s WHERE s.id = $1 AND s.enabled AND ${own.sql}`, [sensor.connection_id, ...own.params]);
  if (rows.length === 0) throw new AppError('not_found');
  if (sensor.declared_sha256 && sensor.declared_sha256 !== sha256) {
    throw new AppError('invalid_input', { message: 'The photo bytes do not match the declared hash.' });
  }
}

class ReusedJob extends Error {
  constructor(readonly job: JobRecord) {
    super('reused');
  }
}

/**
 * POST /v1/captures — create the capture (+ its DiscoveryItem kind=capture,
 * canonical_key "capture:<id>"), enqueue `analyze_capture` with
 * analysisDedupeKey(owner, sha256, focus, COMPILER_VERSION) and return 202.
 * Same input reuses the existing capture/job (reused: true). Enforces
 * anonymous/account daily analysis quotas (429 quota_exceeded).
 * Uploading never changes taste.
 */
export async function createCapture(ctx: ServiceContext, input: CreateCaptureInput): Promise<CreateCaptureResponse> {
  requireScopes(ctx.principal, 'captures:write');
  const p = ctx.principal;
  const isBridge = p.kind === 'agent' && p.purpose === 'sensor_bridge';
  if (input.kind === 'json' && input.body.sensor) {
    // validated below once the hash is known
  } else if (isBridge) {
    throw new AppError('scope_denied', { message: 'This connection may only import sensor photos.' });
  }
  if (input.kind === 'json' && !input.body.sensor && input.body.source === 'sensor') {
    throw new AppError('invalid_input', { message: 'Sensor imports must include sensor details.' });
  }
  const owner = ownerOf(p);
  const resolved = await resolveCaptureImage(ctx, input);
  if (resolved.sensor) await checkSensorImport(ctx, resolved.sensor, resolved.image.sha256);

  const compilerVersion = ctx.config.COMPILER_VERSION;
  const dedupeKey = analysisDedupeKey({ owner, imageSha256: resolved.image.sha256, focus: resolved.focus, compilerVersion });

  // Sensor ledger: the same connection + asset never imports twice.
  if (resolved.sensor) {
    const { rows } = await ctx.db.query<{ capture_id: string | null; job_id: string | null }>(
      `SELECT si.capture_id,
              (SELECT j.id FROM jobs j WHERE j.result_type = 'capture' AND j.result_id = si.capture_id
                ORDER BY j.created_at DESC LIMIT 1) AS job_id
         FROM sensor_imports si WHERE si.sensor_connection_id = $1 AND si.asset_id = $2`,
      [resolved.sensor.connection_id, resolved.sensor.asset_id],
    );
    const existing = rows[0];
    if (existing) {
      if (existing.capture_id && existing.job_id) return { capture_id: existing.capture_id, job_id: existing.job_id, reused: true };
      throw new AppError('conflict', { message: 'This photo was already imported.' });
    }
  } else {
    const reused = await findReusableJob(ctx.db, dedupeKey);
    if (reused) return reused;
  }

  const captureId = randomUUID();
  const prefix = captureObjectPrefix(owner, captureId);
  const derivativeKey = `${prefix}/derivative.jpg`;
  const originalKey = resolved.image.original ? `${prefix}/original` : null;

  try {
    return await ctx.db.transaction(async (tx) => {
      await consumeAnalysisQuota(ctx, tx, owner);
      const expires = owner.kind === 'session' ? (p.kind === 'anonymous' ? p.expiresAt : null) : null;
      await tx.query(
        `INSERT INTO captures (id, owner_account_id, owner_session_id, source, upload_id, sample_id, private_object_key,
                               original_object_key, image_sha256, width, height, captured_at, focus, status,
                               sensor_connection_id, sensor_asset_id, created_by_agent_connection_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'pending', $14, $15, $16, $17)`,
        [
          captureId,
          owner.kind === 'account' ? owner.accountId : null,
          owner.kind === 'session' ? owner.sessionId : null,
          resolved.source,
          resolved.image.uploadId,
          resolved.sampleId,
          derivativeKey,
          originalKey,
          resolved.image.sha256,
          resolved.image.width || null,
          resolved.image.height || null,
          resolved.capturedAt,
          JSON.stringify(resolved.focus),
          resolved.sensor?.connection_id ?? null,
          resolved.sensor?.asset_id ?? null,
          p.kind === 'agent' ? p.connectionId : null,
          expires,
        ],
      );
      await tx.query(
        `INSERT INTO discovery_items (owner_account_id, owner_session_id, kind, category, canonical_key, capture_id, title, display_metadata)
         VALUES ($1, $2, 'capture', NULL, $3, $4, $5, $6::jsonb)`,
        [
          owner.kind === 'account' ? owner.accountId : null,
          owner.kind === 'session' ? owner.sessionId : null,
          `capture:${captureId}`,
          captureId,
          'Your photo',
          JSON.stringify({ image: { object_key: derivativeKey, width: resolved.image.width || null, height: resolved.image.height || null, alt: 'Your photo' } }),
        ],
      );
      if (resolved.sensor) {
        await tx.query(
          `INSERT INTO sensor_imports (sensor_connection_id, asset_id, capture_id, declared_sha256, verified_sha256, captured_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'imported')`,
          [resolved.sensor.connection_id, resolved.sensor.asset_id, captureId, resolved.sensor.declared_sha256 ?? null, resolved.image.sha256, resolved.sensor.captured_at ?? null],
        );
      }
      if (resolved.image.uploadId) await tx.query('UPDATE uploads SET consumed_at = COALESCE(consumed_at, now()) WHERE id = $1', [resolved.image.uploadId]);

      const { job, reused } = await enqueueJob(tx, {
        type: 'analyze_capture',
        owner,
        payload: { capture_id: captureId, analysis_version: 1, compiler_version: compilerVersion, focus: resolved.focus },
        dedupeKey: resolved.sensor ? undefined : dedupeKey,
        agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
        maxAttempts: ctx.config.JOB_MAX_ATTEMPTS,
        budget: {
          qloo_requests: ctx.config.JOB_MAX_QLOO_REQUESTS,
          research_refs: ctx.config.JOB_MAX_RESEARCH_REFS,
          provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES,
          deadline_ms: ctx.config.ANALYSIS_DEADLINE_MS,
        },
        traceId: randomUUID(),
        resultType: 'capture',
        resultId: captureId,
      });
      // A concurrent identical submission won the race: undo ours, reuse theirs.
      if (reused) throw new ReusedJob(job);

      await ctx.providers.storage.put(derivativeKey, resolved.image.derivative, { contentType: 'image/jpeg' });
      if (originalKey && resolved.image.original) {
        await ctx.providers.storage.put(originalKey, resolved.image.original.bytes, { contentType: resolved.image.original.contentType });
      }
      return { capture_id: captureId, job_id: job.id, reused: false };
    });
  } catch (err) {
    if (err instanceof ReusedJob && err.job.result_id) return { capture_id: err.job.result_id, job_id: err.job.id, reused: true };
    throw err;
  }
}

/** An existing non-failed job for the same owner+hash+focus+compiler version whose capture still exists. */
async function findReusableJob(db: Queryable, dedupeKey: string): Promise<CreateCaptureResponse | null> {
  const { rows } = await db.query<{ id: string; result_id: string }>(
    `SELECT j.id, j.result_id FROM jobs j
       JOIN captures c ON c.id = j.result_id AND c.deleted_at IS NULL
      WHERE j.dedupe_key = $1 AND j.state NOT IN ('failed', 'cancelled') AND j.result_type = 'capture'`,
    [dedupeKey],
  );
  const row = rows[0];
  return row ? { capture_id: row.result_id, job_id: row.id, reused: true } : null;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface CaptureRow {
  id: string;
  owner_account_id: string | null;
  owner_session_id: string | null;
  source: CaptureSource;
  sample_id: string | null;
  private_object_key: string | null;
  image_sha256: string;
  width: number | null;
  height: number | null;
  captured_at: Date | null;
  received_at: Date;
  focus: Focus;
  status: CaptureResponse['status'];
  active_analysis_id: string | null;
  created_by_agent_connection_id: string | null;
}

/** SQL fragment: capture `alias` is visible to a selected-collection agent. */
function agentCaptureGrantSql(alias: string, collectionsParam: number, connectionParam: number): string {
  return `(${alias}.created_by_agent_connection_id = $${connectionParam} OR EXISTS (
            SELECT 1 FROM discovery_items gdi
              JOIN saved_items gsi ON gsi.discovery_item_id = gdi.id
              JOIN collection_items gci ON gci.saved_item_id = gsi.id
             WHERE gdi.capture_id = ${alias}.id AND gci.collection_id = ANY($${collectionsParam}::uuid[])))`;
}

/**
 * Loads a live (not deleted) capture the principal may access, or throws 404.
 * Agents are checked against their CURRENT grant on every call.
 */
export async function loadAccessibleCapture(ctx: ServiceContext, id: string, options: { db?: Queryable; forUpdate?: boolean } = {}): Promise<CaptureRow> {
  const db = options.db ?? ctx.db;
  const p = ctx.principal;
  const owner = ownerOf(p);
  const own = ownerPredicate(owner, 'c', 2);
  const params: unknown[] = [id, ...own.params];
  let grant = '';
  if (p.kind === 'agent' && !hasWholeLibrary(p)) {
    params.push(p.libraryAccess === 'selected_collections' ? [...p.allowedCollectionIds] : [], p.connectionId);
    grant = ` AND ${agentCaptureGrantSql('c', params.length - 1, params.length)}`;
  }
  const { rows } = await db.query<CaptureRow>(
    `SELECT c.id, c.owner_account_id, c.owner_session_id, c.source, c.sample_id, c.private_object_key, c.image_sha256,
            c.width, c.height, c.captured_at, c.received_at, c.focus, c.status, c.active_analysis_id,
            c.created_by_agent_connection_id
       FROM captures c
      WHERE c.id = $1 AND ${own.sql} AND c.deleted_at IS NULL${grant}${options.forUpdate ? ' FOR UPDATE OF c' : ''}`,
    params,
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

interface AnalysisRow {
  id: string;
  version: number;
  title: string | null;
  interpretation: string | null;
  section_statuses: Record<string, string>;
  clarifying_question: NonNullable<CaptureResponse['analysis']>['question'];
  warnings: { code: string; message: string }[];
  created_at: Date;
}

const ANALYSIS_SECTION_NAMES = new Set(['observations', 'references', 'research', ...CATEGORIES]);
const SECTION_STATUS_NAMES = new Set(['pending', 'running', 'complete', 'partial', 'failed', 'skipped', 'unavailable']);

function exclusionFilterSql(owner: Owner, itemAlias: string, param: number): string {
  const col = owner.kind === 'account' ? 'owner_account_id' : 'owner_session_id';
  return `NOT EXISTS (SELECT 1 FROM item_exclusions x WHERE x.${col} = $${param}
            AND (x.discovery_item_id = ${itemAlias}.id OR x.canonical_key = ${itemAlias}.canonical_key))`;
}

/** References shown for an analysis (rejected ones excluded). */
export async function loadAnalysisReferences(db: Queryable, analysisId: string): Promise<ReferenceSummary[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    type: ReferenceSummary['type'];
    relation: NonNullable<ReferenceSummary['relation']>;
    certainty: number | null;
    resolution_status: string;
    has_page: boolean;
  }>(
    `SELECT r.id, r.canonical_name AS name, r.type, cr.relation, cr.certainty, cr.resolution_status,
            (r.research_status = 'complete' AND r.overview IS NOT NULL) AS has_page
       FROM capture_references cr JOIN cultural_references r ON r.id = cr.reference_id
      WHERE cr.analysis_id = $1 AND cr.resolution_status <> 'rejected'
      ORDER BY cr.is_anchor DESC, (cr.relation = 'user_selected') DESC, cr.certainty DESC NULLS LAST, r.canonical_name`,
    [analysisId],
  );
  const seen = new Set<string>();
  const out: ReferenceSummary[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const qualified =
      r.relation === 'resembles' || r.resolution_status === 'unmatched' || r.resolution_status === 'ambiguous' || (r.certainty ?? 0) < 0.7;
    out.push({ id: r.id, name: r.name, type: r.type, relation: r.relation, qualified: r.relation === 'user_selected' ? false : qualified, has_page: r.has_page });
  }
  return out;
}

/**
 * GET /v1/captures/{id} — active analysis summary, references and up to 12
 * recommendation cards (loadCards), available categories, active job id.
 * Not owned / not granted -> 404.
 */
export async function getCapture(ctx: ServiceContext, input: { id: string }): Promise<CaptureResponse> {
  requireScopes(ctx.principal, 'captures:read');
  const capture = await loadAccessibleCapture(ctx, input.id);
  const owner = ownerOf(ctx.principal);

  const [itemRes, jobRes] = await Promise.all([
    ctx.db.query<{ id: string; saved: boolean }>(
      `SELECT di.id, EXISTS (SELECT 1 FROM saved_items si WHERE si.discovery_item_id = di.id) AS saved
         FROM discovery_items di WHERE di.capture_id = $1 AND di.kind = 'capture'`,
      [capture.id],
    ),
    ctx.db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE result_type = 'capture' AND result_id = $1 AND state IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 1`,
      [capture.id],
    ),
  ]);

  let analysis: CaptureResponse['analysis'] = null;
  let references: ReferenceSummary[] = [];
  let recommendations: CaptureResponse['recommendations'] = [];
  if (capture.active_analysis_id) {
    const { rows } = await ctx.db.query<AnalysisRow>(
      `SELECT id, version, title, interpretation, section_statuses, clarifying_question, warnings, created_at
         FROM analyses WHERE id = $1`,
      [capture.active_analysis_id],
    );
    const a = rows[0];
    if (a) {
      const sections: Record<string, string> = {};
      for (const [k, v] of Object.entries(a.section_statuses ?? {})) if (ANALYSIS_SECTION_NAMES.has(k) && SECTION_STATUS_NAMES.has(v)) sections[k] = v;
      analysis = {
        id: a.id,
        version: a.version,
        title: a.title,
        interpretation: a.interpretation,
        sections: sections as NonNullable<CaptureResponse['analysis']>['sections'],
        question: capture.focus.kind === 'whole' ? (a.clarifying_question ?? null) : null,
        warnings: Array.isArray(a.warnings) ? a.warnings : [],
        created_at: iso(a.created_at),
      };
      references = await loadAnalysisReferences(ctx.db, a.id);
      const ownerParam = owner.kind === 'account' ? owner.accountId : owner.sessionId;
      const { rows: recs } = await ctx.db.query<{ id: string; discovery_item_id: string; origin: CardRecommendationContext['origin']; display_reason: string | null; rank: number }>(
        `SELECT DISTINCT ON (r.discovery_item_id) r.id, r.discovery_item_id, r.origin, r.display_reason, r.rank
           FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
          WHERE r.analysis_id = $1 AND ${exclusionFilterSql(owner, 'di', 2)}
          ORDER BY r.discovery_item_id, r.rank`,
        [a.id, ownerParam],
      );
      const ordered = [...recs].sort((x, y) => x.rank - y.rank).slice(0, LIMITS.recommendationsPerAnalysis);
      const context = new Map<string, CardRecommendationContext>(ordered.map((r) => [r.discovery_item_id, { id: r.id, origin: r.origin, display_reason: r.display_reason }]));
      recommendations = await loadCards(ctx, ordered.map((r) => r.discovery_item_id), { recommendations: context });
    }
  }

  const available = CATEGORIES.filter((c) => recommendations.some((r) => r.category === c)) as Category[];
  return {
    id: capture.id,
    source: capture.source,
    status: capture.status,
    received_at: iso(capture.received_at),
    captured_at: iso(capture.captured_at),
    image: capture.private_object_key
      ? await resolveImage(ctx, { object_key: capture.private_object_key, width: capture.width, height: capture.height, alt: 'Your photo' })
      : null,
    focus: capture.focus,
    is_example: capture.source === 'sample',
    discovery_item_id: itemRes.rows[0]?.id ?? null,
    saved: itemRes.rows[0]?.saved ?? false,
    analysis,
    references,
    recommendations,
    available_categories: available,
    job_id: jobRes.rows[0]?.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Privacy delete. Within one transaction (holding the capture row lock the
 * compiler also takes before publishing): cancel unfinished jobs and release
 * their dedupe keys, remove dependent plans, the capture's own item with its
 * saved state and memberships, personal recommendations and items that only
 * this capture supported, preference links, analyses (and with them private
 * reference associations and provider queries), then mark the capture deleted
 * with purge_after = now()+24h. Media objects are deleted right after commit.
 * Shared public reference facts remain. Taste is recomputed.
 */
export async function deleteCapture(ctx: ServiceContext, input: { id: string }): Promise<void> {
  requireScopes(ctx.principal, 'captures:write');
  requireNotSensorBridge(ctx.principal);
  requireWholeLibrary(ctx.principal);
  const owner = ownerOf(ctx.principal);
  const purged = await ctx.db.transaction((tx) => deleteCaptureTx(ctx, tx, owner, input.id));
  await removeCaptureMedia(ctx, owner, purged);
  try {
    await rebuildTasteProfile(ctx.db, owner);
  } catch (err) {
    // The taste module rebuilds lazily if its rebuild is not available yet.
    if (!(err instanceof AppError && err.code === 'not_implemented')) throw err;
  }
}

async function removeCaptureMedia(ctx: ServiceContext, owner: Owner, c: { id: string; keys: string[] }): Promise<void> {
  await ctx.providers.storage.deletePrefix(captureObjectPrefix(owner, c.id));
  for (const key of c.keys) await ctx.providers.storage.delete(key).catch(() => undefined);
}

async function deleteCaptureTx(ctx: ServiceContext, tx: Db, owner: Owner, captureId: string): Promise<{ id: string; keys: string[] }> {
  const capture = await loadAccessibleCapture(ctx, captureId, { db: tx, forUpdate: true });
  const keys = [capture.private_object_key].filter((k): k is string => !!k);
  const { rows: orig } = await tx.query<{ original_object_key: string | null }>('SELECT original_object_key FROM captures WHERE id = $1', [capture.id]);
  if (orig[0]?.original_object_key) keys.push(orig[0].original_object_key);

  await cancelJobsForResult(tx, 'capture', capture.id);
  // Release dedupe keys so the same photo can be analyzed again later.
  await tx.query(`UPDATE jobs SET dedupe_key = NULL, updated_at = now() WHERE result_type = 'capture' AND result_id = $1`, [capture.id]);

  const ownerCol = owner.kind === 'account' ? 'owner_account_id' : 'owner_session_id';
  const ownerVal = owner.kind === 'account' ? owner.accountId : owner.sessionId;
  const { rows: items } = await tx.query<{ id: string }>(`SELECT id FROM discovery_items WHERE capture_id = $1`, [capture.id]);
  const captureItemIds = items.map((i) => i.id);
  const { rows: analyses } = await tx.query<{ id: string }>('SELECT id FROM analyses WHERE capture_id = $1', [capture.id]);
  const analysisIds = analyses.map((a) => a.id);

  // Plans that depended on the capture are removed (initial release rule).
  if (owner.kind === 'account' && captureItemIds.length) {
    await tx.query(`DELETE FROM plans WHERE owner_account_id = $1 AND selected_item_ids && $2::uuid[]`, [owner.accountId, captureItemIds]);
  }

  // Personal recommendations from this capture, and items only they supported.
  const { rows: recItems } = await tx.query<{ discovery_item_id: string }>(
    `SELECT DISTINCT discovery_item_id FROM recommendations WHERE analysis_id = ANY($1::uuid[])`,
    [analysisIds],
  );
  await tx.query('DELETE FROM recommendations WHERE analysis_id = ANY($1::uuid[])', [analysisIds]);
  if (recItems.length) {
    await tx.query(
      `DELETE FROM discovery_items di
        WHERE di.id = ANY($1::uuid[]) AND di.${ownerCol} = $2 AND NOT di.is_sample
          AND NOT EXISTS (SELECT 1 FROM saved_items si WHERE si.discovery_item_id = di.id)
          AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.discovery_item_id = di.id)
          AND NOT EXISTS (SELECT 1 FROM discovery_jobs dj WHERE dj.origin_item_id = di.id)`,
      [recItems.map((r) => r.discovery_item_id), ownerVal],
    );
  }

  // Preference links to the capture, its item and its analyses.
  await tx.query(
    `DELETE FROM preference_events
      WHERE ${ownerCol} = $1
        AND ((target_type = 'capture' AND target_id = $2)
          OR (target_type = 'discovery_item' AND target_id = ANY($3::uuid[]))
          OR (target_type = 'analysis' AND target_id = ANY($4::uuid[])))`,
    [ownerVal, capture.id, captureItemIds, analysisIds],
  );

  // Collections whose membership changes get a new revision.
  if (captureItemIds.length) {
    await tx.query(
      `UPDATE collections c SET revision = revision + 1, updated_at = now()
        WHERE c.id IN (SELECT ci.collection_id FROM collection_items ci JOIN saved_items si ON si.id = ci.saved_item_id
                        WHERE si.discovery_item_id = ANY($1::uuid[]))`,
      [captureItemIds],
    );
    // Cascades to saved_items, collection_items, item_exclusions, discovery jobs.
    await tx.query('DELETE FROM discovery_items WHERE id = ANY($1::uuid[])', [captureItemIds]);
  }

  // Analyses cascade to capture_references, provider_queries and recommendations.
  await tx.query('UPDATE captures SET active_analysis_id = NULL WHERE id = $1', [capture.id]);
  await tx.query('DELETE FROM analyses WHERE capture_id = $1', [capture.id]);
  await tx.query(
    `UPDATE captures SET status = 'deleted', deleted_at = now(), purge_after = now() + interval '24 hours',
            private_object_key = NULL, original_object_key = NULL, updated_at = now()
      WHERE id = $1`,
    [capture.id],
  );
  await bumpTasteRevision(tx, owner);
  return { id: capture.id, keys };
}
