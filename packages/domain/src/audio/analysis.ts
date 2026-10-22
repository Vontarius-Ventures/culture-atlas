import { randomUUID } from 'node:crypto';
import { AppError } from '../errors';
import { hashRequest } from '../idempotency';
import { enqueueJob } from '../jobs/queue';
import { audioAnalysisDedupeKey } from '../jobs/dedupe';
import { AnalyzeAudioRequest, type AnalyzeAudioResponse } from '../schemas/audio';
import { assertCaptureAuthority, captureMutation } from '../capture-v2/policy';
import { authorizeCaptureAgent } from '../capture-v2/agent-fence';
import { consumeDailyQuota } from '../services/captures';
import type { CaptureV2Context } from '../capture-v2/types';
import { AUDIO_LIMITS } from './limits';

const MUSIC_ONLY = ['music_match'] as const;

function windowsFor(selection: {
  start_ms: number;
  end_ms: number;
  windows?: { start_ms: number; end_ms: number }[];
}): { start_ms: number; end_ms: number }[] {
  if (selection.windows?.length) return selection.windows;
  const start = selection.start_ms;
  const end = Math.min(selection.end_ms, start + AUDIO_LIMITS.musicWindowDefaultMs);
  return [{ start_ms: start, end_ms: end }];
}

export class AudioAnalysis {
  constructor(private readonly ctx: CaptureV2Context) {}

  /**
   * Explore authorizes analysis. Keep never calls this.
   * Music Mode defaults to music_match; speech stays off.
   */
  async request(assetId: string, raw: unknown, key: string): Promise<AnalyzeAudioResponse> {
    const input = AnalyzeAudioRequest.parse(raw);
    const ctx = this.ctx;
    await assertCaptureAuthority(ctx, ctx.db);
    await authorizeCaptureAgent(ctx, ctx.db, 'media.analyze', assetId);
    const unsupported = input.requested_components.filter((c) => c !== 'music_match');
    if (unsupported.length) {
      throw new AppError('invalid_input', {
        message: 'Music Mode explores music only. Spoken references are off.',
        details: { supported_components: [...MUSIC_ONLY] },
      });
    }
    return captureMutation(ctx, `analyze-audio:${assetId}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL AND kind='audio' FOR UPDATE`,
        [ctx.authority.accountId, assetId],
      );
      const media = rows[0];
      if (!media) throw new AppError('not_found');
      if (media.generation !== input.expected_generation) throw new AppError('conflict');
      if (media.status !== 'ready') {
        throw new AppError('conflict', { message: 'Wait for media preparation before exploring.' });
      }
      if (input.selection.end_ms > media.duration_ms || input.selection.start_ms >= media.duration_ms) {
        throw new AppError('invalid_input', { message: 'The selected range is outside this recording.' });
      }
      const windows = windowsFor(input.selection);
      if (windows.length > AUDIO_LIMITS.musicWindowsMax) throw new AppError('invalid_input');
      for (const window of windows) {
        if (window.end_ms > media.duration_ms || window.start_ms >= window.end_ms) {
          throw new AppError('invalid_input', { message: 'The selected range is outside this recording.' });
        }
      }
      const fingerprint = hashRequest({
        contract_version: 2,
        generation: media.generation,
        requested_components: input.requested_components,
        selection: { ...input.selection, windows },
      });
      const existing = await tx.query(
        `SELECT * FROM audio_analysis_requests
         WHERE account_id=$1 AND asset_id=$2 AND generation=$3 AND request_hash=$4
           AND state IN ('queued','running','complete','partial')
         ORDER BY created_at DESC LIMIT 1`,
        [ctx.authority.accountId, assetId, media.generation, fingerprint],
      );
      if (existing.rows[0]) {
        return {
          analysis_id: existing.rows[0].id,
          job_id: existing.rows[0].job_id,
          state: existing.rows[0].state,
          reused: true,
          result_url: `/v2/media/${assetId}/analysis/${existing.rows[0].id}`,
          error_code: existing.rows[0].error_code,
        };
      }
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
      const analysisId = randomUUID();
      const selection = { ...input.selection, windows };
      await tx.query(
        `INSERT INTO audio_analysis_requests(id,account_id,asset_id,generation,contract_version,requested_components,selection,request_hash,state)
         VALUES($1,$2,$3,$4,2,$5::jsonb,$6::jsonb,$7,'queued')`,
        [
          analysisId,
          ctx.authority.accountId,
          assetId,
          media.generation,
          JSON.stringify(input.requested_components),
          JSON.stringify(selection),
          fingerprint,
        ],
      );
      await tx.query(
        `INSERT INTO audio_analysis_components(account_id,analysis_id,asset_id,generation,component,state)
         VALUES($1,$2,$3,$4,'music_match','queued'),($1,$2,$3,$4,'speech_references','not_requested')`,
        [ctx.authority.accountId, analysisId, assetId, media.generation],
      );
      const { job } = await enqueueJob(tx, {
        type: 'analyze_audio',
        owner: { kind: 'account', accountId: ctx.authority.accountId },
        payload: {
          analysis_id: analysisId,
          asset_id: assetId,
          expected_generation: media.generation,
        },
        dedupeKey: audioAnalysisDedupeKey({
          owner: { kind: 'account', accountId: ctx.authority.accountId },
          analysisId,
        }),
        resultType: 'audio_analysis',
        resultId: analysisId,
        budget: { qloo_requests: 2, deadline_ms: 60_000 },
      });
      await tx.query(
        `UPDATE audio_analysis_requests SET job_id=$3 WHERE account_id=$1 AND id=$2`,
        [ctx.authority.accountId, analysisId, job.id],
      );
      await tx.query(
        `UPDATE media_assets SET analysis_status='queued' WHERE account_id=$1 AND id=$2`,
        [ctx.authority.accountId, assetId],
      );
      return {
        analysis_id: analysisId,
        job_id: job.id,
        state: 'queued' as const,
        reused: false,
        result_url: `/v2/media/${assetId}/analysis/${analysisId}`,
        error_code: null,
      };
    });
  }

  async get(assetId: string, analysisId: string): Promise<AnalyzeAudioResponse & { result: unknown }> {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'analysis.read', analysisId);
    const { rows } = await this.ctx.db.query(
      `SELECT a.* FROM audio_analysis_requests a
       JOIN media_assets m ON m.account_id=a.account_id AND m.id=a.asset_id AND m.deleted_at IS NULL
       WHERE a.account_id=$1 AND a.asset_id=$2 AND a.id=$3`,
      [this.ctx.authority.accountId, assetId, analysisId],
    );
    if (!rows[0]) throw new AppError('not_found');
    const row = rows[0];
    return {
      analysis_id: row.id,
      job_id: row.job_id,
      state: row.state,
      reused: true,
      result_url: `/v2/media/${assetId}/analysis/${analysisId}`,
      error_code: row.error_code,
      result: row.result,
    };
  }
}
