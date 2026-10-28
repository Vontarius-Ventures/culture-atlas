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
      result: await this.withRelated(row.result),
    };
  }

  /**
   * Music Mode suggestions: the related discovery the heard artist started.
   * Read live (the related job finishes after the audio job), so a client
   * polling the analysis sees the cards arrive ("Because you heard <artist>").
   */
  private async withRelated(result: unknown): Promise<unknown> {
    const r = result as { artist?: { discovery_job_id?: string } | null } | null;
    const djId = r?.artist?.discovery_job_id;
    if (!r || !djId) return result;
    const dj = await this.ctx.db.query<{ status: string }>(
      'SELECT status FROM discovery_jobs WHERE id = $1 AND owner_account_id = $2',
      [djId, this.ctx.authority.accountId],
    );
    if (!dj.rows[0]) return { ...r, related: [], related_state: 'none' };
    const cards = await this.ctx.db.query<{
      item_id: string; title: string; kind: string; category: string | null; reason: string | null; image_url: string | null;
    }>(
      `SELECT di.id AS item_id, di.title, di.kind, di.category, rec.display_reason AS reason,
              -- Only app-served display assets may serve (VAL-EVID-005); an
              -- uncleared external URL (e.g. a legacy provider image) never does.
              CASE WHEN di.display_metadata->'image'->>'url' LIKE '/%' AND di.display_metadata->'image'->>'url' NOT LIKE '//%'
                   THEN di.display_metadata->'image'->>'url' END AS image_url
         FROM recommendations rec JOIN discovery_items di ON di.id = rec.discovery_item_id
        WHERE rec.discovery_job_id = $1 ORDER BY rec.rank`,
      [djId],
    );
    const status = dj.rows[0].status;
    return {
      ...r,
      related: cards.rows,
      related_state: status === 'complete' || status === 'partial' ? 'ready' : status === 'failed' || status === 'cancelled' ? 'unavailable' : 'pending',
    };
  }

  private async liveAsset(assetId: string): Promise<{ generation: number }> {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'media.read', assetId);
    const { rows } = await this.ctx.db.query<{ generation: number }>(
      `SELECT generation FROM media_assets WHERE account_id=$1 AND id=$2 AND kind='audio' AND deleted_at IS NULL`,
      [this.ctx.authority.accountId, assetId],
    );
    if (!rows[0]) throw new AppError('not_found');
    return rows[0];
  }

  /** GET /v2/media/{id}/tracks */
  async tracks(assetId: string) {
    const { generation } = await this.liveAsset(assetId);
    const { rows } = await this.ctx.db.query(
      `SELECT id, role, codec, channels, sample_rate_hz, duration_ms FROM media_tracks
        WHERE account_id=$1 AND asset_id=$2 AND generation=$3 ORDER BY role, created_at`,
      [this.ctx.authority.accountId, assetId, generation],
    );
    return { items: rows };
  }

  /** GET /v2/media/{id}/evidence — what was heard, newest analysis first. */
  async evidence(assetId: string) {
    const { generation } = await this.liveAsset(assetId);
    const { rows } = await this.ctx.db.query(
      `SELECT e.id, e.modality, e.track_id, e.start_ms, e.end_ms, e.method, e.status, e.recognition_id,
              e.qloo_entity_id, e.relationship, e.analysis_id, r.artist_name, r.title
         FROM media_evidence e LEFT JOIN recognized_recordings r ON r.account_id=e.account_id AND r.id=e.recognition_id
        WHERE e.account_id=$1 AND e.asset_id=$2 AND e.generation=$3 ORDER BY e.created_at DESC`,
      [this.ctx.authority.accountId, assetId, generation],
    );
    return { items: rows };
  }

  /** GET /v2/media/{id}/transcript — the latest transcript Music Mode used (speech references stay off). */
  async transcript(assetId: string) {
    const { generation } = await this.liveAsset(assetId);
    if (this.ctx.agent) {
      // Transcripts are private speech: agents need an explicit transcripts grant (not offered yet).
      throw new AppError('not_found');
    }
    const { rows } = await this.ctx.db.query<{ analysis_id: string; text: string | null; created_at: Date }>(
      `SELECT analysis_id, vendor_evidence->>'transcript' AS text, created_at FROM media_evidence
        WHERE account_id=$1 AND asset_id=$2 AND generation=$3 AND vendor_evidence ? 'transcript'
          AND vendor_evidence->>'transcript' IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [this.ctx.authority.accountId, assetId, generation],
    );
    const row = rows[0];
    return {
      analysis_id: row?.analysis_id ?? null,
      text: row?.text ?? null,
      state: row ? 'available' : 'none',
      created_at: row ? row.created_at.toISOString() : null,
    };
  }
}
