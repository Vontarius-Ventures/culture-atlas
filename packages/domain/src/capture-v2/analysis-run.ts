import { randomUUID } from 'node:crypto';
import { VlmAnalysis, type VlmCandidate } from '@culture-atlas/providers';
import { normalizeName } from '../compiler/text';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { enqueueJob } from '../jobs/queue';
import { MediaAnalysis } from './analysis';
import { CaptureQueue } from './queue';
import type { CaptureLease, CaptureV2Context } from './types';

/**
 * Analysis-media orchestration state (package 4): durable per-frame checkpoints,
 * frame aggregation with citations, AI-only pauses and publication into the
 * existing cultural compiler. Model dispatch itself lives in the worker; this
 * module never sends model requests.
 */

/** CONCENTRATE.md initial deadlines (media preparation excluded). */
export const MEDIA_ANALYSIS_DEADLINES = {
  photoMs: 90_000,
  videoMs: 180_000,
  frameAttemptMs: 30_000,
} as const;
/**
 * Dispatch rounds per frame. Round 0 allows the runner's single transient retry
 * (2 HTTP attempts); round 1 allows one more attempt without retry. Combined
 * cap: three HTTP attempts per frame/role.
 */
export const MAX_FRAME_ROUNDS = 2;
export const VIDEO_ANALYSIS_NOTE = 'We explore selected moments, not every frame.';

export interface FrameReading {
  frameKey: string;
  derivativeId: string | null;
  timestampMs: number | null;
  analysis: VlmAnalysis;
  model: string;
}
export interface FrameCitation {
  frame_id: string;
  timestamp_ms: number;
}
export interface CandidateCitation {
  name: string;
  type: VlmCandidate['type'];
  relation: VlmCandidate['relation'];
  cited_frames: FrameCitation[];
}

const UNCERTAINTY_RANK = { low: 0, medium: 1, high: 2 } as const;

/**
 * Merges independent frame readings into one validated reading. Duplicate
 * candidates (same normalized name + type) are aggregated and cite every frame
 * that showed them; nothing is invented beyond what sampled frames reported.
 * Frame-local boxes cannot be drawn on another image, so multi-frame readings
 * carry no regions; a single photo/frame keeps its own.
 */
export function aggregateFrameReadings(
  readings: readonly FrameReading[],
  options: { maxCandidates?: number } = {},
): {
  observation: VlmAnalysis;
  citations: CandidateCitation[];
  model: string;
  displayFrameKey: string;
} {
  if (!readings.length)
    throw new AppError('invalid_input', { message: 'No frame readings to aggregate.' });
  const max = Math.min(Math.max(options.maxCandidates ?? 8, 1), 12);
  const ordered = [...readings].sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  const cite = (r: FrameReading): FrameCitation[] =>
    r.derivativeId !== null && r.timestampMs !== null
      ? [{ frame_id: r.derivativeId, timestamp_ms: r.timestampMs }]
      : [];
  if (ordered.length === 1) {
    const only = ordered[0]!;
    const observation = VlmAnalysis.parse(only.analysis);
    observation.candidates = observation.candidates.slice(0, max);
    return {
      observation,
      model: only.model,
      displayFrameKey: only.frameKey,
      citations: observation.candidates.map((c) => ({
        name: c.name,
        type: c.type,
        relation: c.relation,
        cited_frames: cite(only),
      })),
    };
  }
  const merged = new Map<
    string,
    { candidate: VlmCandidate; frames: FrameCitation[]; frameKeys: Set<string>; first: number }
  >();
  const observations = new Map<string, VlmAnalysis['observations'][number]>();
  const texts = new Map<string, string>();
  const subjects = new Map<string, string>();
  const notes = new Set<string>();
  let order = 0;
  for (const r of ordered) {
    for (const c of r.analysis.candidates) {
      const key = `${normalizeName(c.name)}|${c.type}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          candidate: {
            ...c,
            region_ids: [],
            suggested_categories: [...c.suggested_categories],
            tag_queries: [...c.tag_queries],
          },
          frames: [...cite(r)],
          frameKeys: new Set([r.frameKey]),
          first: order++,
        });
        continue;
      }
      if (!existing.frameKeys.has(r.frameKey)) {
        existing.frameKeys.add(r.frameKey);
        existing.frames.push(...cite(r));
      }
      const e = existing.candidate;
      if (c.certainty > e.certainty) {
        e.certainty = c.certainty;
        e.rationale = c.rationale;
        e.name = c.name;
      }
      // "depicted" needs strong evidence in at least one frame; never upgraded otherwise.
      if (c.relation === 'depicted') e.relation = 'depicted';
      e.suggested_categories = [...new Set([...e.suggested_categories, ...c.suggested_categories])];
      e.tag_queries = [...new Set([...e.tag_queries, ...c.tag_queries])].slice(0, 5);
    }
    for (const o of r.analysis.observations) {
      const key = `${o.kind}|${normalizeName(o.text)}`;
      if (!observations.has(key)) observations.set(key, { ...o, region_ids: [] });
    }
    for (const t of r.analysis.visible_text)
      if (!texts.has(t.text.trim())) texts.set(t.text.trim(), t.text);
    for (const s of r.analysis.competing_subjects) {
      const key = normalizeName(s.label);
      if (!subjects.has(key)) subjects.set(key, s.label);
    }
    for (const n of r.analysis.uncertainty.notes) notes.add(n);
  }
  const ranked = [...merged.values()].sort(
    (a, b) =>
      b.frameKeys.size - a.frameKeys.size ||
      b.candidate.certainty - a.candidate.certainty ||
      a.first - b.first,
  );
  const kept = ranked
    .slice(0, max)
    .map((m, i) => ({ ...m, candidate: { ...m.candidate, id: `c${i + 1}` } }));
  const usable = ordered.filter((r) => r.analysis.quality.usable);
  // The display frame is the one most candidates cite (ties: earliest).
  const counts = new Map<string, number>();
  for (const m of kept) for (const k of m.frameKeys) counts.set(k, (counts.get(k) ?? 0) + 1);
  const display = [...(usable.length ? usable : ordered)].sort(
    (a, b) => (counts.get(b.frameKey) ?? 0) - (counts.get(a.frameKey) ?? 0),
  )[0]!;
  const lead = usable[0] ?? ordered[0]!;
  const overall = (usable.length ? usable : ordered)
    .map((r) => r.analysis.uncertainty.overall)
    .reduce(
      (worst, u) => (UNCERTAINTY_RANK[u] > UNCERTAINTY_RANK[worst] ? u : worst),
      'low' as VlmAnalysis['uncertainty']['overall'],
    );
  const observation = VlmAnalysis.parse({
    title: lead.analysis.title,
    interpretation: lead.analysis.interpretation,
    observations: [...observations.values()]
      .slice(0, 20)
      .map((o, i) => ({ ...o, id: `o${i + 1}` })),
    visible_text: [...texts.values()].slice(0, 20).map((text) => ({ text, region_id: null })),
    candidates: kept.map((m) => m.candidate),
    regions: [],
    uncertainty: { overall, notes: [...notes].slice(0, 5) },
    competing_subjects: [...subjects.values()]
      .slice(0, 3)
      .map((label, i) => ({ id: `s${i + 1}`, label, region_ids: [] })),
    quality: usable.length
      ? { usable: true, issue: null }
      : { usable: false, issue: ordered[0]!.analysis.quality.issue },
  });
  return {
    observation,
    model: lead.model,
    displayFrameKey: display.frameKey,
    citations: kept.map((m) => ({
      name: m.candidate.name,
      type: m.candidate.type,
      relation: m.candidate.relation,
      cited_frames: [...m.frames].sort((a, b) => a.timestamp_ms - b.timestamp_ms),
    })),
  };
}

export interface FrameCheckpoint {
  frameKey: string;
  derivativeId: string | null;
  timestampMs: number | null;
  state: 'complete' | 'failed' | 'unknown';
  errorCode: string | null;
  retryable: boolean;
  rounds: number;
  deferrals: number;
  reading: VlmAnalysis | null;
  model: string | null;
}

export type AnalysisAssetKind = 'photo' | 'video';

function v1Source(source: string): 'camera' | 'upload' {
  return ['browser_camera', 'phone_camera', 'meta_glasses'].includes(source) ? 'camera' : 'upload';
}

export class MediaAnalysisRun {
  private readonly queue: CaptureQueue;
  private readonly analysis: MediaAnalysis;
  constructor(private readonly ctx: CaptureV2Context) {
    this.queue = new CaptureQueue(ctx.db, ctx.now);
    this.analysis = new MediaAnalysis(ctx);
  }

  /**
   * Leases one queued analysis for photos or videos (role-specific concurrency:
   * interactive photo work is never stuck behind large video batches). Accounts
   * with fewer running jobs go first.
   */
  async claim(
    kind: AnalysisAssetKind,
    leaseSeconds = 60,
    accountId?: string,
  ): Promise<CaptureLease | null> {
    const now = this.ctx.now();
    const { rows } = await this.ctx.db.query(
      `WITH candidate AS (
        SELECT w.id FROM capture_work w
        JOIN media_assets m ON m.account_id=w.account_id AND m.id=w.asset_id
        WHERE w.kind='analyze_media' AND m.kind=$1 AND w.available_at <= $2
          AND ($5::uuid IS NULL OR w.account_id=$5)
          AND w.attempts < 5
          AND (w.state='queued' OR (w.state='running' AND w.lease_expires_at <= $2))
        ORDER BY
          (SELECT count(*) FROM capture_work r WHERE r.account_id=w.account_id AND r.state='running' AND r.lease_expires_at > $2),
          w.created_at,w.id
        FOR NO KEY UPDATE OF w SKIP LOCKED LIMIT 1
       )
       UPDATE capture_work w SET state='running',lease_token=$3,attempt_id=$4,
         lease_expires_at=$6,attempts=attempts+1
       FROM candidate c WHERE w.id=c.id
       RETURNING w.id AS job_id,w.account_id,w.asset_id,w.upload_id,w.analysis_id,
         w.created_by_agent_connection_id,w.authorization_version,w.generation,w.kind,
         w.attempt_id,w.lease_token,w.lease_expires_at,w.attempts`,
      [
        kind,
        now,
        randomUUID(),
        randomUUID(),
        accountId ?? null,
        new Date(now.getTime() + Math.min(Math.max(leaseSeconds, 1), 300) * 1000),
      ],
    );
    return (rows[0] as CaptureLease | undefined) ?? null;
  }

  heartbeat(lease: CaptureLease, seconds = 60): Promise<boolean> {
    return this.queue.heartbeat(lease, seconds);
  }

  loadWork(lease: CaptureLease) {
    return this.analysis.loadWork(lease);
  }

  async checkpoints(lease: CaptureLease): Promise<Map<string, FrameCheckpoint>> {
    const { rows } = await this.ctx.db.query(
      `SELECT frame_key,derivative_id,timestamp_ms,state,error_code,retryable,rounds,deferrals,reading,model
         FROM media_analysis_frames WHERE account_id=$1 AND analysis_id=$2`,
      [lease.account_id, lease.analysis_id],
    );
    return new Map(
      rows.map((r) => [
        r.frame_key as string,
        {
          frameKey: r.frame_key,
          derivativeId: r.derivative_id,
          timestampMs: r.timestamp_ms,
          state: r.state,
          errorCode: r.error_code,
          retryable: r.retryable,
          rounds: r.rounds,
          deferrals: r.deferrals,
          reading: r.reading ? VlmAnalysis.parse(r.reading) : null,
          model: r.model,
        } satisfies FrameCheckpoint,
      ]),
    );
  }

  /**
   * Persists one frame outcome under the live lease. A completed reading is
   * written once and never replaced; repeated failures increment the round.
   */
  async recordFrame(
    lease: CaptureLease,
    frame: {
      frameKey: string;
      derivativeId: string | null;
      timestampMs: number | null;
      state: FrameCheckpoint['state'];
      errorCode?: string | null;
      retryable?: boolean;
      reading?: VlmAnalysis | null;
      model?: string | null;
      inferenceAttemptId?: string | null;
      /** A dispatch refused by an AI-wide pause: counts as a deferral, not a failed round. */
      deferral?: boolean;
    },
  ): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      await this.analysis.workerRow(tx, lease);
      await tx.query(
        `INSERT INTO media_analysis_frames(account_id,analysis_id,frame_key,derivative_id,timestamp_ms,state,error_code,
           retryable,reading,model,inference_attempt_id,updated_at,rounds,deferrals)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,
           CASE WHEN $13 OR $6='complete' THEN 0 ELSE 1 END, CASE WHEN $13 THEN 1 ELSE 0 END)
         ON CONFLICT (account_id,analysis_id,frame_key) DO UPDATE SET state=EXCLUDED.state,
           error_code=EXCLUDED.error_code,retryable=EXCLUDED.retryable,reading=EXCLUDED.reading,
           model=EXCLUDED.model,inference_attempt_id=EXCLUDED.inference_attempt_id,
           rounds=CASE WHEN $13 OR EXCLUDED.state='complete' THEN media_analysis_frames.rounds
                       ELSE LEAST(media_analysis_frames.rounds+1,3) END,
           deferrals=media_analysis_frames.deferrals + CASE WHEN $13 THEN 1 ELSE 0 END,
           updated_at=EXCLUDED.updated_at
         WHERE media_analysis_frames.state <> 'complete'`,
        [
          lease.account_id,
          lease.analysis_id,
          frame.frameKey,
          frame.derivativeId,
          frame.timestampMs,
          frame.state,
          frame.errorCode ?? null,
          frame.retryable ?? false,
          frame.reading ? JSON.stringify(frame.reading) : null,
          frame.model ?? null,
          frame.inferenceAttemptId ?? null,
          this.ctx.now(),
          frame.deferral ?? false,
        ],
      );
    });
  }

  /**
   * AI-only pause (credits, throttling): return the work to the queue WITHOUT
   * consuming a worker attempt, so an outage of any length never fails or loses
   * the request. Media, library and uploads are untouched.
   */
  async defer(
    lease: CaptureLease,
    input: { reason: 'ai_paused' | 'rate_limited'; until: Date },
  ): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      await this.analysis.workerRow(tx, lease);
      await tx.query(
        `UPDATE capture_work SET state='queued',attempts=GREATEST(attempts-1,0),available_at=$2,
           lease_expires_at=NULL,error_code=NULL WHERE id=$1`,
        [lease.job_id, input.until],
      );
      await tx.query(
        `UPDATE media_analysis_requests SET state='queued',waiting_reason=$3 WHERE account_id=$1 AND id=$2`,
        [lease.account_id, lease.analysis_id, input.reason],
      );
      await tx.query(
        `UPDATE media_assets SET analysis_status='queued' WHERE account_id=$1 AND id=$2`,
        [lease.account_id, lease.asset_id],
      );
    });
  }

  /** Transient frame failures: requeue with backoff, consuming one worker attempt. */
  async retryLater(lease: CaptureLease, errorCode: string): Promise<void> {
    if (!/^[a-z0-9_]{1,64}$/.test(errorCode)) throw new AppError('invalid_input');
    await this.ctx.db.transaction(async (tx) => {
      await this.analysis.workerRow(tx, lease);
      await tx.query(
        `UPDATE capture_work SET state=$2,error_code=$3,available_at=$4,lease_expires_at=NULL WHERE id=$1`,
        [
          lease.job_id,
          lease.attempts < 5 ? 'queued' : 'failed',
          errorCode,
          new Date(this.ctx.now().getTime() + Math.min(300, 2 ** lease.attempts) * 1000),
        ],
      );
      await tx.query(
        `UPDATE media_analysis_requests SET state=$3,error_code=$4 WHERE account_id=$1 AND id=$2`,
        [lease.account_id, lease.analysis_id, lease.attempts < 5 ? 'queued' : 'failed', errorCode],
      );
    });
  }

  /** Requests whose queue row was reaped as failed must not stay "running" forever. */
  async reconcileAbandoned(): Promise<number> {
    const r = await this.ctx.db.query(
      `UPDATE media_analysis_requests a SET state='failed',error_code=COALESCE(w.error_code,'analysis_failed'),completed_at=$1
         FROM capture_work w
        WHERE w.account_id=a.account_id AND w.analysis_id=a.id AND w.state='failed' AND a.state IN ('queued','running')`,
      [this.ctx.now()],
    );
    await this.ctx.db.query(
      `UPDATE media_assets m SET analysis_status='failed' FROM media_analysis_requests a
        WHERE a.account_id=m.account_id AND a.asset_id=m.id AND a.state='failed' AND m.analysis_status IN ('queued','running')
          AND NOT EXISTS (SELECT 1 FROM media_analysis_requests o WHERE o.account_id=m.account_id AND o.asset_id=m.id AND o.state IN ('queued','running'))`,
    );
    return r.rowCount ?? 0;
  }

  /**
   * Publishes the vision stage. complete/partial create a capture linked to the
   * asset and enqueue the existing cultural compiler (Qloo resolution, research,
   * recommendations) with this reading, instead of a second VLM call. Every
   * write re-checks lease, owner, generation and tombstone in one transaction.
   */
  async publishVision(
    lease: CaptureLease,
    input: {
      state: 'complete' | 'partial' | 'failed';
      errorCode?: string;
      observation?: VlmAnalysis;
      model?: string;
      result: Record<string, unknown>;
      /** Capture-owned display image already written by the worker under `captureId`'s prefix. */
      captureId?: string;
      display?: { objectKey: string; sha256: string; width: number; height: number };
      compile?: {
        compilerVersion: string;
        maxAttempts: number;
        budget: {
          qloo_requests: number;
          research_refs: number;
          provider_retries: number;
          deadline_ms: number;
        };
      };
    },
  ): Promise<{ captureId: string | null; compileJobId: string | null }> {
    if (
      input.state !== 'failed' &&
      (!input.observation || !input.model || !input.display || !input.compile || !input.captureId)
    )
      throw new AppError('invalid_input');
    if (input.errorCode && !/^[a-z0-9_]{1,64}$/.test(input.errorCode))
      throw new AppError('invalid_input');
    return this.ctx.db.transaction(async (tx: Db) => {
      await this.analysis.workerRow(tx, lease);
      let captureId: string | null = null;
      let compileJobId: string | null = null;
      if (input.state !== 'failed') {
        const media = await tx.query(
          `SELECT source,kind,captured_at FROM media_assets WHERE account_id=$1 AND id=$2`,
          [lease.account_id, lease.asset_id],
        );
        const m = media.rows[0]!;
        captureId = input.captureId!;
        const agent = lease.created_by_agent_connection_id;
        await tx.query(
          `INSERT INTO captures (id, owner_account_id, source, private_object_key, image_sha256, width, height,
             captured_at, focus, status, media_asset_id, created_by_agent_connection_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{"kind":"whole"}'::jsonb,'pending',$9,$10)`,
          [
            captureId,
            lease.account_id,
            v1Source(m.source),
            input.display!.objectKey,
            input.display!.sha256,
            input.display!.width,
            input.display!.height,
            m.captured_at ?? null,
            lease.asset_id,
            agent,
          ],
        );
        const title = m.kind === 'video' ? 'Your video' : 'Your photo';
        await tx.query(
          `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, capture_id, title, display_metadata)
           VALUES ($1, 'capture', NULL, $2, $3, $4, $5::jsonb)`,
          [
            lease.account_id,
            `capture:${captureId}`,
            captureId,
            title,
            JSON.stringify({
              image: {
                object_key: input.display!.objectKey,
                width: input.display!.width,
                height: input.display!.height,
                alt: title,
              },
            }),
          ],
        );
        const { job } = await enqueueJob(tx, {
          type: 'analyze_capture',
          owner: { kind: 'account', accountId: lease.account_id },
          payload: {
            capture_id: captureId,
            analysis_version: 1,
            compiler_version: input.compile!.compilerVersion,
            focus: { kind: 'whole' },
            media_analysis_id: lease.analysis_id!,
          },
          agentConnectionId: agent,
          maxAttempts: input.compile!.maxAttempts,
          budget: input.compile!.budget,
          traceId: randomUUID(),
          resultType: 'capture',
          resultId: captureId,
        });
        compileJobId = job.id;
      }
      await tx.query(
        `UPDATE media_analysis_requests SET state=$3,capture_id=$4,error_code=$5,observation=$6::jsonb,
           observation_model=$7,result=$8::jsonb,waiting_reason=NULL,completed_at=$9
         WHERE account_id=$1 AND id=$2`,
        [
          lease.account_id,
          lease.analysis_id,
          input.state,
          captureId,
          input.errorCode ?? null,
          input.observation ? JSON.stringify(input.observation) : null,
          input.model ?? null,
          JSON.stringify(input.result),
          this.ctx.now(),
        ],
      );
      await tx.query(
        `UPDATE media_assets SET analysis_status=$3,legacy_capture_id=COALESCE($4,legacy_capture_id) WHERE account_id=$1 AND id=$2`,
        [
          lease.account_id,
          lease.asset_id,
          input.state === 'partial' ? 'complete' : input.state,
          captureId,
        ],
      );
      await this.queue.complete(lease, tx);
      return { captureId, compileJobId };
    });
  }
}
