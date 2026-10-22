import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError } from '../errors';
import { hashRequest } from '../idempotency';
import {
  CreateAudioUploadRequest,
  KeepAudioRecordingRequest,
  type AudioDetailResponse,
} from '../schemas/audio';
import { CAPTURE_PART_SIZE, mediaObjectPrefix } from '../capture-v2/intake';
import { assertCaptureAuthority, captureMutation } from '../capture-v2/policy';
import { CaptureQueue } from '../capture-v2/queue';
import type { CaptureV2Context } from '../capture-v2/types';
import { authorizeCaptureAgent } from '../capture-v2/agent-fence';
import { AUDIO_LIMITS } from './limits';
import { parsePcmWav } from './wav';

export interface KeptAudio {
  media: AudioDetailResponse['media'];
  generation: number;
  revision: number;
  track_id: string;
  asset_id: string;
  analysis_status: 'not_requested';
}

function projectAudio(row: Record<string, unknown>, trackId: string | null): AudioDetailResponse {
  return {
    media: {
      schema_version: 2,
      id: row.id as string,
      kind: 'audio',
      source: row.source as AudioDetailResponse['media']['source'],
      capture_mode: 'music',
      duration_ms: row.duration_ms as number,
      sample_rate_hz: (row.sample_rate_hz as number | null) ?? undefined,
      channels: (row.channels as 1 | 2 | null) ?? undefined,
      codec: (row.codec as string | null) ?? undefined,
      source_route: (row.source_route as string | null) ?? undefined,
      audio_quality: (row.audio_quality as string | null) ?? undefined,
      status: row.status as AudioDetailResponse['media']['status'],
      analysis_status: row.analysis_status as AudioDetailResponse['media']['analysis_status'],
      camera_active: false,
      speech_analysis: 'off',
      created_at: (row.created_at as Date).toISOString(),
      title: (row.title as string | null) ?? null,
    },
    generation: row.generation as number,
    revision: row.revision as number,
    track_id: trackId,
    links: {
      original: row.original_key ? `/v2/media/${row.id as string}/content/original` : null,
      playback: row.original_key ? `/v2/media/${row.id as string}/content/original` : null,
      analysis: null,
    },
    error_code: (row.error_code as string | null) ?? null,
  };
}

export class AudioLibrary {
  readonly queue: CaptureQueue;
  constructor(private readonly ctx: CaptureV2Context) {
    this.queue = new CaptureQueue(ctx.db, ctx.now);
  }

  /**
   * Keep a Music Mode recording. Saves a private audio asset and never
   * enqueues analysis or taste updates.
   */
  async keepRecording(raw: unknown, bytes: Uint8Array, key: string): Promise<KeptAudio> {
    const input = KeepAudioRecordingRequest.parse(raw);
    const wav = parsePcmWav(bytes);
    if (wav.durationMs > AUDIO_LIMITS.captureMaxDurationMs) {
      throw new AppError('duration_exceeded', {
        message: 'Music Mode recordings can be up to 120 seconds.',
      });
    }
    return this.storeReadyAudio(
      {
        client_capture_id: input.client_capture_id,
        source: input.source,
        filename: input.filename,
        content_type: input.content_type,
        byte_size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        captured_at: input.captured_at,
        capture_session_id: input.capture_session_id,
        capture_mode: 'music',
        source_route: input.source_route,
        title: input.title ?? null,
        duration_ms: wav.durationMs,
        sample_rate_hz: wav.sampleRateHz,
        channels: wav.channels,
        codec: wav.codec,
      },
      bytes,
      key,
    );
  }

  async createUpload(raw: unknown, key: string) {
    const input = CreateAudioUploadRequest.parse(raw);
    const ctx = this.ctx;
    await authorizeCaptureAgent(ctx, ctx.db, 'upload.create', input.destination_collection_id ?? null);
    if (input.byte_size > AUDIO_LIMITS.uploadMaxBytes) {
      throw new AppError('payload_too_large', { message: 'This file exceeds the audio size limit.' });
    }
    return captureMutation(ctx, 'create-audio-upload', key, input, async (tx) => {
      await this.requireAccount(tx);
      const fingerprint = hashRequest(input);
      const existing = await tx.query(
        `SELECT u.id,u.request_hash FROM media_assets m JOIN upload_sessions u
         ON u.asset_id=m.id AND u.account_id=m.account_id WHERE m.account_id=$1 AND m.client_capture_id=$2`,
        [ctx.authority.accountId, input.client_capture_id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== fingerprint) throw new AppError('idempotency_conflict');
        return { asset_id: null as string | null, upload_id: existing.rows[0].id as string, reused: true };
      }
      await this.assertQuota(tx, input.byte_size + ctx.limits.derivativeAllowanceBytes);
      const assetId = randomUUID(),
        uploadId = randomUUID(),
        expires = new Date(ctx.now().getTime() + 86400000);
      const staging = `accounts/${ctx.authority.accountId}/staging/${assetId}/${uploadId}`;
      const installation = ctx.authority.kind === 'installation' ? ctx.authority.installationId : null;
      await tx.query(
        `INSERT INTO media_assets(id,account_id,installation_id,client_capture_id,capture_session_id,kind,source,
          byte_size,sha256,content_type,captured_at,created_at,created_by_agent_connection_id,authorization_version,
          schema_version,capture_mode,source_route,camera_active,speech_analysis,analysis_status)
         VALUES($1,$2,$3,$4,$5,'audio',$6,$7,$8,$9,$10,$11,$12,$13,2,'music',$14,false,'off','not_requested')`,
        [
          assetId,
          ctx.authority.accountId,
          installation,
          input.client_capture_id,
          input.capture_session_id ?? null,
          input.source,
          input.byte_size,
          input.sha256,
          input.content_type,
          input.captured_at ?? null,
          ctx.now(),
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
          input.source_route ?? null,
        ],
      );
      const providerId = await ctx.storage.begin(staging, input.content_type);
      await tx.query(
        `INSERT INTO upload_sessions(id,account_id,asset_id,installation_id,authority_session_id,staging_key,
          provider_multipart_id,expected_bytes,expected_sha256,reserved_bytes,request_hash,expires_at,
          created_by_agent_connection_id,authorization_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          uploadId,
          ctx.authority.accountId,
          assetId,
          installation,
          ctx.authority.sessionId,
          staging,
          providerId,
          input.byte_size,
          input.sha256,
          input.byte_size + ctx.limits.derivativeAllowanceBytes,
          fingerprint,
          expires,
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO usage_reservations(account_id,upload_id,amount,expires_at) VALUES($1,$2,$3,$4)`,
        [ctx.authority.accountId, uploadId, input.byte_size + ctx.limits.derivativeAllowanceBytes, expires],
      );
      return {
        asset_id: assetId,
        upload_id: uploadId,
        part_size: CAPTURE_PART_SIZE,
        reused: false,
      };
    });
  }

  async detail(id: string): Promise<AudioDetailResponse> {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'media.read', id);
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL AND kind='audio'`,
      [this.ctx.authority.accountId, id],
    );
    if (!rows[0]) throw new AppError('not_found');
    const track = await this.ctx.db.query(
      `SELECT id FROM media_tracks WHERE account_id=$1 AND asset_id=$2 AND generation=$3 AND role='primary'`,
      [this.ctx.authority.accountId, id, rows[0].generation],
    );
    return projectAudio(rows[0], track.rows[0]?.id ?? null);
  }

  private async storeReadyAudio(
    input: {
      client_capture_id: string;
      source: 'browser_microphone' | 'phone_microphone' | 'meta_glasses' | 'upload';
      filename: string;
      content_type: string;
      byte_size: number;
      sha256: string;
      captured_at?: string;
      capture_session_id?: string;
      capture_mode: 'music';
      source_route?: string;
      title: string | null;
      duration_ms: number;
      sample_rate_hz: number;
      channels: 1 | 2;
      codec: string;
    },
    bytes: Uint8Array,
    key: string,
  ): Promise<KeptAudio> {
    const ctx = this.ctx;
    await authorizeCaptureAgent(ctx, ctx.db, 'upload.create', null);
    return captureMutation(ctx, 'keep-audio', key, { ...input, sha256: input.sha256 }, async (tx) => {
      await this.requireAccount(tx);
      const existing = await tx.query(
        `SELECT id FROM media_assets WHERE account_id=$1 AND client_capture_id=$2`,
        [ctx.authority.accountId, input.client_capture_id],
      );
      if (existing.rows[0]) {
        return this.keptRow(tx, existing.rows[0].id as string);
      }
      await this.assertQuota(tx, bytes.byteLength);
      const assetId = randomUUID();
      const originalKey = `${mediaObjectPrefix(ctx.authority.accountId, assetId, 1)}/original.wav`;
      await ctx.storage.put(originalKey, Readable.from([bytes]), input.content_type, bytes.byteLength);
      const installation = ctx.authority.kind === 'installation' ? ctx.authority.installationId : null;
      await tx.query(
        `INSERT INTO media_assets(id,account_id,installation_id,client_capture_id,capture_session_id,kind,source,
          status,analysis_status,byte_size,sha256,content_type,duration_ms,original_key,captured_at,created_at,
          created_by_agent_connection_id,authorization_version,schema_version,capture_mode,sample_rate_hz,channels,
          codec,source_route,camera_active,speech_analysis,has_audio_track,audio_decodable,signal_detected,title)
         VALUES($1,$2,$3,$4,$5,'audio',$6,'ready','not_requested',$7,$8,$9,$10,$11,$12,$13,$14,$15,
          2,'music',$16,$17,$18,$19,false,'off',true,true,true,$20)`,
        [
          assetId,
          ctx.authority.accountId,
          installation,
          input.client_capture_id,
          input.capture_session_id ?? null,
          input.source,
          bytes.byteLength,
          input.sha256,
          input.content_type,
          input.duration_ms,
          originalKey,
          input.captured_at ?? null,
          ctx.now(),
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
          input.sample_rate_hz,
          input.channels,
          input.codec,
          input.source_route ?? null,
          input.title,
        ],
      );
      const trackId = randomUUID();
      await tx.query(
        `INSERT INTO media_tracks(id,account_id,asset_id,generation,role,codec,channels,sample_rate_hz,duration_ms)
         VALUES($1,$2,$3,1,'primary',$4,$5,$6,$7)`,
        [trackId, ctx.authority.accountId, assetId, input.codec, input.channels, input.sample_rate_hz, input.duration_ms],
      );
      return this.keptRow(tx, assetId);
    });
  }

  private async keptRow(tx: CaptureV2Context['db'], assetId: string): Promise<KeptAudio> {
    const { rows } = await tx.query(`SELECT * FROM media_assets WHERE account_id=$1 AND id=$2`, [
      this.ctx.authority.accountId,
      assetId,
    ]);
    const track = await tx.query(
      `SELECT id FROM media_tracks WHERE account_id=$1 AND asset_id=$2 AND role='primary'`,
      [this.ctx.authority.accountId, assetId],
    );
    const detail = projectAudio(rows[0]!, track.rows[0]?.id ?? null);
    return {
      media: detail.media,
      generation: detail.generation,
      revision: detail.revision,
      track_id: detail.track_id!,
      asset_id: assetId,
      analysis_status: 'not_requested',
    };
  }

  private async requireAccount(tx: CaptureV2Context['db']): Promise<void> {
    const ctx = this.ctx;
    if (!ctx.mediaCreationEnabled) {
      throw new AppError('service_unavailable', { message: 'New captures are temporarily paused.' });
    }
    if (ctx.authority.kind === 'account') {
      if (!ctx.identity) {
        throw new AppError('service_unavailable', {
          message: 'Recoverable account verification is not configured.',
        });
      }
      await ctx.identity.requireRecoverableAccount(ctx.authority.accountId, ctx.authority.sessionId);
    }
    await assertCaptureAuthority({ ...ctx, db: tx }, tx, true);
  }

  private async assertQuota(tx: CaptureV2Context['db'], reservation: number): Promise<void> {
    const usage = await tx.query<{ used: number }>(
      `SELECT (
         COALESCE((SELECT sum(amount) FROM usage_reservations WHERE account_id=$1 AND state IN ('reserved','settled','unknown')),0)
         +COALESCE((SELECT sum(byte_size) FROM media_assets WHERE account_id=$1 AND deleted_at IS NULL),0)
       )::bigint AS used`,
      [this.ctx.authority.accountId],
    );
    if (usage.rows[0]!.used + reservation > this.ctx.limits.accountQuotaBytes) {
      throw new AppError('quota_exceeded', {
        message: 'Your account does not have enough available storage.',
      });
    }
  }
}
