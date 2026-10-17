import { randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import type { Db } from '../db/pool';
import { hashRequest } from '../idempotency';
import { consumeDailyQuota } from '../services/captures';
import { AnalyzeMediaRequest } from '../schemas/capture-v2';
import { assertCaptureAuthority, captureMutation } from './policy';
import { CaptureQueue } from './queue';
import type { CaptureLease, CaptureV2Context } from './types';
import { authorizeCaptureAgent, assertCaptureWorkAgent } from './agent-fence';

/** User intent/allowance and worker publication; P4 owns inference orchestration. */
export class MediaAnalysis {
  private readonly queue: CaptureQueue;
  constructor(private readonly ctx: CaptureV2Context) {
    this.queue = new CaptureQueue(ctx.db, ctx.now);
  }
  private projection(row: Record<string, unknown>, reused: boolean) {
    return {
      analysis_id: row.id,
      job_id: row.job_id,
      state: row.state,
      reused,
      capture_id: row.capture_id ?? null,
      result_url: row.capture_id ? `/captures/${row.capture_id}` : null,
    };
  }
  async request(id: string, raw: unknown, key: string) {
    const input = AnalyzeMediaRequest.parse(raw),
      ctx = this.ctx;
    await assertCaptureAuthority(ctx, ctx.db);
    await authorizeCaptureAgent(ctx, ctx.db, 'media.analyze', id);
    return captureMutation(ctx, `analyze:${id}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [ctx.authority.accountId, id],
      );
      const media = rows[0];
      if (!media) throw new AppError('not_found');
      if (media.generation !== input.expected_generation) throw new AppError('conflict');
      if (media.status !== 'ready')
        throw new AppError('conflict', { message: 'Wait for media preparation before exploring.' });
      if ((media.kind === 'photo') !== (input.mode === 'photo'))
        throw new AppError('invalid_input');
      const frameQuery = await tx.query(
        `SELECT d.id,d.object_key,s.timestamp_ms,s.extraction_version FROM media_derivatives d JOIN media_segments s
         ON s.account_id=d.account_id AND s.frame_derivative_id=d.id AND s.asset_id=d.asset_id
         WHERE d.account_id=$1 AND d.asset_id=$2 AND d.generation=$3 AND d.kind='frame'
         ORDER BY s.timestamp_ms,d.id`,
        [ctx.authority.accountId, id, media.generation],
      );
      let frames = frameQuery.rows;
      if (input.mode === 'selected_frame') {
        if (input.frame_id) frames = frames.filter((f) => f.id === input.frame_id);
        else if (input.timestamp_ms !== undefined && input.timestamp_ms < media.duration_ms) {
          frames = frames
            .sort(
              (a, b) =>
                Math.abs(a.timestamp_ms - input.timestamp_ms!) -
                Math.abs(b.timestamp_ms - input.timestamp_ms!),
            )
            .slice(0, 1);
        } else throw new AppError('invalid_input');
        if (frames.length !== 1) throw new AppError('not_found');
      }
      if (media.kind === 'video' && !frames.length)
        throw new AppError('conflict', { message: 'Video moments are not ready yet.' });
      if (frames.length > 8) frames = frames.slice(0, 8);
      // Do not persist object keys in the public response; worker resolves them by same-owner IDs.
      const selection = frames.map((f) => ({
        id: f.id,
        timestamp_ms: f.timestamp_ms,
        extraction_version: f.extraction_version,
      }));
      const fingerprint = hashRequest({
        mode: input.mode,
        focus: input.focus,
        selection,
        generation: media.generation,
      });
      const existing = await tx.query(
        `SELECT a.*,w.id AS job_id FROM media_analysis_requests a JOIN capture_work w ON w.account_id=a.account_id AND w.analysis_id=a.id
         WHERE a.account_id=$1 AND a.asset_id=$2 AND a.generation=$3 AND a.request_hash=$4
           AND a.state IN ('queued','running','complete','partial') ORDER BY a.created_at DESC LIMIT 1`,
        [ctx.authority.accountId, id, media.generation, fingerprint],
      );
      if (existing.rows[0]) return this.projection(existing.rows[0], true);
      if (
        !(await consumeDailyQuota(
          tx,
          `account:${ctx.authority.accountId}`,
          'media_analyses',
          ctx.limits.analysisDailyLimit,
          ctx.now(),
        ))
      ) {
        throw new AppError('quota_exceeded', {
          message: 'You have reached today’s media analysis allowance.',
        });
      }
      const analysisId = randomUUID(),
        jobId = randomUUID();
      await tx.query(
        `INSERT INTO media_analysis_requests(id,account_id,asset_id,generation,mode,focus,selected_frames,extraction_version,request_hash,
          created_by_agent_connection_id,authorization_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          analysisId,
          ctx.authority.accountId,
          id,
          media.generation,
          input.mode,
          input.focus,
          JSON.stringify(selection),
          frames[0]?.extraction_version ?? null,
          fingerprint,
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO capture_work(id,account_id,asset_id,generation,kind,analysis_id,available_at,created_at,
          created_by_agent_connection_id,authorization_version) VALUES($1,$2,$3,$4,'analyze_media',$5,$6,$6,$7,$8)`,
        [
          jobId,
          ctx.authority.accountId,
          id,
          media.generation,
          analysisId,
          ctx.now(),
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
        ],
      );
      await tx.query(
        `UPDATE media_assets SET analysis_status='queued' WHERE account_id=$1 AND id=$2`,
        [ctx.authority.accountId, id],
      );
      return this.projection({ id: analysisId, job_id: jobId, state: 'queued' }, false);
    });
  }
  async get(assetId: string, analysisId: string) {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'analysis.read', analysisId);
    const { rows } = await this.ctx.db.query(
      `SELECT a.*,w.id AS job_id FROM media_analysis_requests a
       JOIN media_assets m ON m.account_id=a.account_id AND m.id=a.asset_id AND m.deleted_at IS NULL
       JOIN capture_work w ON w.account_id=a.account_id AND w.analysis_id=a.id
       WHERE a.account_id=$1 AND a.asset_id=$2 AND a.id=$3`,
      [this.ctx.authority.accountId, assetId, analysisId],
    );
    if (!rows[0]) throw new AppError('not_found');
    return this.projection(rows[0], true);
  }
  private async workerRow(tx: Db, lease: CaptureLease) {
    if (lease.kind !== 'analyze_media' || !lease.analysis_id) throw new AppError('invalid_input');
    await tx.query(`SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, [lease.account_id]);
    const { rows } = await tx.query(
      `SELECT a.*,m.kind,m.original_key,m.status AS media_status FROM media_analysis_requests a JOIN media_assets m
       ON m.account_id=a.account_id AND m.id=a.asset_id AND m.generation=a.generation AND m.deleted_at IS NULL
       WHERE a.account_id=$1 AND a.id=$2 AND a.asset_id=$3 AND a.generation=$4 FOR UPDATE OF a,m`,
      [lease.account_id, lease.analysis_id, lease.asset_id, lease.generation],
    );
    if (!rows[0]) throw new AppError('conflict');
    await this.queue.assertLease(tx, lease);
    await assertCaptureWorkAgent(tx, lease, this.ctx.agentAuthorization);
    return rows[0];
  }
  /** P4 receives stable media/frame ownership and effective timestamps for gateway/compiler. */
  async loadWork(lease: CaptureLease) {
    return this.ctx.db.transaction(async (tx) => {
      const row = await this.workerRow(tx, lease);
      const selected = row.selected_frames as {
        id: string;
        timestamp_ms: number;
        extraction_version: string;
      }[];
      const frames = await tx.query(
        `SELECT id,object_key FROM media_derivatives WHERE account_id=$1 AND asset_id=$2 AND generation=$3 AND id=ANY($4::uuid[])`,
        [lease.account_id, lease.asset_id, lease.generation, selected.map((f) => f.id)],
      );
      if (frames.rows.length !== selected.length) throw new AppError('conflict');
      await tx.query(
        `UPDATE media_analysis_requests SET state='running' WHERE account_id=$1 AND id=$2`,
        [lease.account_id, lease.analysis_id],
      );
      await tx.query(
        `UPDATE media_assets SET analysis_status='running' WHERE account_id=$1 AND id=$2`,
        [lease.account_id, lease.asset_id],
      );
      return {
        accountId: lease.account_id,
        jobId: lease.job_id,
        attemptId: lease.attempt_id,
        analysisId: lease.analysis_id,
        assetId: lease.asset_id,
        generation: lease.generation,
        kind: row.kind,
        mode: row.mode,
        focus: row.focus,
        originalKey: row.original_key,
        frames: selected.map((f) => ({
          ...f,
          objectKey: frames.rows.find((d) => d.id === f.id)!.object_key,
        })),
      };
    });
  }
  async publish(
    lease: CaptureLease,
    result: { state: 'complete' | 'partial' | 'failed'; captureId?: string; errorCode?: string },
  ) {
    await this.ctx.db.transaction(async (tx) => {
      await this.workerRow(tx, lease);
      if (result.captureId) {
        const r = await tx.query(
          `UPDATE captures SET media_asset_id=$3 WHERE owner_account_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id`,
          [lease.account_id, result.captureId, lease.asset_id],
        );
        if (!r.rowCount) throw new AppError('not_found');
      }
      if (['complete', 'partial'].includes(result.state) && !result.captureId)
        throw new AppError('invalid_input');
      await tx.query(
        `UPDATE media_analysis_requests SET state=$3,capture_id=$4,error_code=$5 WHERE account_id=$1 AND id=$2`,
        [
          lease.account_id,
          lease.analysis_id,
          result.state,
          result.captureId ?? null,
          result.errorCode ?? null,
        ],
      );
      await tx.query(
        `UPDATE media_assets SET analysis_status=$3,legacy_capture_id=COALESCE($4,legacy_capture_id) WHERE account_id=$1 AND id=$2`,
        [
          lease.account_id,
          lease.asset_id,
          result.state === 'partial' ? 'complete' : result.state,
          result.captureId ?? null,
        ],
      );
      await this.queue.complete(lease, tx);
    });
  }
}
