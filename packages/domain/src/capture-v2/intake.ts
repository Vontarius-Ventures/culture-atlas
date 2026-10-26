import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { hashRequest } from '../idempotency';
import {
  CreateMediaUploadRequest,
  CompleteMediaUploadRequest,
  UploadPartsRequest,
  MediaLibraryQuery,
  UpdateMediaRequest,
  DeleteMediaRequest,
  BatchDeleteMediaRequest,
  type MediaUploadResponse,
} from '../schemas/capture-v2';
import { assertCaptureAuthority, captureMutation } from './policy';
import { CaptureQueue } from './queue';
import type { CaptureV2Context } from './types';
import { MEDIA_RANGE_MAX_BYTES, multipartPartSize } from '@culture-atlas/providers';
import { authorizeCaptureAgent } from './agent-fence';

export const CAPTURE_PART_SIZE = 8388608;
export interface UploadRecord {
  id: string;
  account_id: string;
  asset_id: string;
  installation_id: string | null;
  state: string;
  staging_key: string;
  provider_multipart_id: string | null;
  expected_bytes: number;
  expected_sha256: string;
  reserved_bytes: number;
  expires_at: Date;
  request_hash: string;
  error_code: string | null;
  part_receipts: { part_number: number; etag: string }[];
  generation: number;
  deleted_at: Date | null;
  source: string;
  kind: 'photo' | 'video';
  content_type: string;
  authority_ended_at: Date | null;
  pause_reason: 'authority_ended' | null;
  paused_from_state: string | null;
  created_by_agent_connection_id: string | null;
  authorization_version: number | null;
}
export async function loadCaptureUpload(
  ctx: CaptureV2Context,
  tx: Db,
  id: string,
  lock = false,
): Promise<UploadRecord> {
  const { rows } = await tx.query(
    `SELECT u.*,m.generation,m.deleted_at,m.source,m.kind,m.content_type FROM upload_sessions u
     JOIN media_assets m ON m.account_id=u.account_id AND m.id=u.asset_id
     WHERE u.id=$1 AND u.account_id=$2${lock ? ' FOR UPDATE OF u,m' : ''}`,
    [id, ctx.authority.accountId],
  );
  const row = rows[0] as UploadRecord | undefined;
  if (
    !row ||
    (ctx.authority.kind === 'installation' && row.installation_id !== ctx.authority.installationId)
  ) {
    throw new AppError('not_found');
  }
  return row;
}
export function mediaObjectPrefix(accountId: string, assetId: string, generation: number): string {
  return `accounts/${accountId}/media/${assetId}/${generation}`;
}
/** Parsed `Range: bytes=` request. `suffix` is the `bytes=-N` form. */
export type ByteRangeRequest = { start: number; end?: number } | { suffix: number };
export interface MediaContent {
  body: AsyncIterable<Uint8Array>;
  contentType: string;
  /** Bytes in this response body. */
  byteSize: number;
  totalSize: number;
  start: number;
  end: number;
  partial: boolean;
}
export const MEDIA_RANGE_WINDOW_BYTES = MEDIA_RANGE_MAX_BYTES;
export class MediaRangeNotSatisfiable extends Error {
  constructor(readonly totalSize: number) {
    super('Range not satisfiable');
  }
}
export function parseByteRange(header: string | null): ByteRangeRequest | undefined | 'invalid' {
  if (!header) return undefined;
  const parsed = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!parsed || (!parsed[1] && !parsed[2])) return 'invalid';
  if (!parsed[1]) return { suffix: Number(parsed[2]) };
  return { start: Number(parsed[1]), ...(parsed[2] ? { end: Number(parsed[2]) } : {}) };
}
export function resolveByteRange(
  range: ByteRangeRequest,
  totalSize: number,
): { start: number; end: number } {
  let start: number, end: number;
  if ('suffix' in range) {
    if (range.suffix <= 0) throw new MediaRangeNotSatisfiable(totalSize);
    start = Math.max(0, totalSize - range.suffix);
    end = totalSize - 1;
  } else {
    start = range.start;
    end = Math.min(range.end ?? totalSize - 1, totalSize - 1);
  }
  if (start > end || start >= totalSize) throw new MediaRangeNotSatisfiable(totalSize);
  return { start, end };
}
/** Small legacy photos have no ranged reader; slice a bounded stream. */
async function sliceObject(
  object: { body: AsyncIterable<Uint8Array>; contentType: string; byteSize: number },
  range: ByteRangeRequest | undefined,
): Promise<MediaContent> {
  const total = object.byteSize;
  if (!range)
    return {
      body: object.body,
      contentType: object.contentType,
      byteSize: total,
      totalSize: total,
      start: 0,
      end: total - 1,
      partial: false,
    };
  const { start, end } = resolveByteRange(range, total);
  async function* slices() {
    let offset = 0;
    for await (const chunk of object.body) {
      if (offset + chunk.length > start && offset <= end)
        yield chunk.subarray(Math.max(0, start - offset), Math.min(chunk.length, end - offset + 1));
      offset += chunk.length;
      if (offset > end) break;
    }
  }
  return {
    body: slices(),
    contentType: object.contentType,
    byteSize: end - start + 1,
    totalSize: total,
    start,
    end,
    partial: true,
  };
}
export class MediaIntake {
  readonly queue: CaptureQueue;
  constructor(private readonly ctx: CaptureV2Context) {
    this.queue = new CaptureQueue(ctx.db, ctx.now);
  }

  private async response(row: UploadRecord, sign = false): Promise<MediaUploadResponse> {
    const active =
      ['created', 'uploading'].includes(row.state) &&
      !row.deleted_at &&
      !row.authority_ended_at &&
      row.expires_at > this.ctx.now();
    const partCount = Math.ceil(row.expected_bytes / CAPTURE_PART_SIZE);
    return {
      asset_id: row.asset_id,
      upload_id: row.id,
      state: row.state as MediaUploadResponse['state'],
      expires_at: row.expires_at.toISOString(),
      part_size: CAPTURE_PART_SIZE,
      part_count: partCount,
      parts:
        sign && active && row.provider_multipart_id
          ? await Promise.all(
              Array.from({ length: Math.min(partCount, 100) }, (_, i) =>
                this.ctx.storage.signPart(
                  row.staging_key,
                  row.provider_multipart_id!,
                  i + 1,
                  Math.min(
                    900,
                    Math.max(
                      1,
                      Math.floor((row.expires_at.getTime() - this.ctx.now().getTime()) / 1000),
                    ),
                  ),
                  multipartPartSize(row.expected_bytes, i + 1, CAPTURE_PART_SIZE),
                ),
              ),
            )
          : [],
      verified_parts:
        (active || row.state === 'paused') && row.provider_multipart_id
          ? (await this.ctx.storage.listParts(row.staging_key, row.provider_multipart_id)).map(
              (p) => ({ part_number: p.part_number, etag: p.etag }),
            )
          : row.part_receipts,
      error_code: row.error_code,
      pause_reason: row.pause_reason,
    };
  }

  async createUpload(raw: unknown, key: string): Promise<MediaUploadResponse> {
    const input = CreateMediaUploadRequest.parse(raw);
    const ctx = this.ctx;
    await authorizeCaptureAgent(
      ctx,
      ctx.db,
      'upload.create',
      input.destination_collection_id ?? null,
    );
    return captureMutation(ctx, 'create-upload', key, input, async (tx) => {
      const fingerprint = hashRequest(input);
      const existing = await tx.query(
        `SELECT u.id,u.request_hash FROM media_assets m JOIN upload_sessions u
         ON u.asset_id=m.id AND u.account_id=m.account_id WHERE m.account_id=$1 AND m.client_capture_id=$2`,
        [ctx.authority.accountId, input.client_capture_id],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== fingerprint)
          throw new AppError('idempotency_conflict');
        const owned = await loadCaptureUpload(ctx, tx, existing.rows[0].id);
        if (ctx.agent && owned.created_by_agent_connection_id !== ctx.agent.connectionId)
          throw new AppError('not_found');
        return this.response(owned, true);
      }
      if (!ctx.mediaCreationEnabled || (input.kind === 'video' && !ctx.videoEnabled))
        throw new AppError('service_unavailable', {
          message:
            input.kind === 'video'
              ? 'Video uploads are not qualified on this server.'
              : 'New captures are temporarily paused.',
        });
      if (ctx.authority.kind === 'account') {
        if (!ctx.identity)
          throw new AppError('service_unavailable', {
            message: 'Recoverable account verification is not configured.',
          });
        await ctx.identity.requireRecoverableAccount(
          ctx.authority.accountId,
          ctx.authority.sessionId,
        );
      }
      const max = input.kind === 'photo' ? ctx.limits.photoMaxBytes : ctx.limits.videoMaxBytes;
      if (input.byte_size > max)
        throw new AppError('payload_too_large', {
          message: 'This file exceeds the media size limit.',
        });
      if ((input.kind === 'photo') !== input.content_type.startsWith('image/'))
        throw new AppError('invalid_input');
      if (
        input.source === 'meta_glasses' &&
        (!ctx.glassesEnabled || ctx.authority.kind !== 'installation')
      ) {
        throw new AppError('scope_denied', {
          message: 'Experimental glasses capture is unavailable.',
        });
      }
      const installation =
        ctx.authority.kind === 'installation' ? ctx.authority.installationId : null;
      if (input.destination_collection_id) {
        const destination = await tx.query(
          `SELECT id FROM collections WHERE owner_account_id=$1 AND id=$2`,
          [ctx.authority.accountId, input.destination_collection_id],
        );
        if (!destination.rowCount) throw new AppError('not_found');
      }
      if (input.capture_session_id) {
        const r = await tx.query(
          `SELECT id FROM capture_sessions WHERE account_id=$1 AND id=$2 AND installation_id=$3
           AND source=$4 AND media_mode=$5 AND state='active'`,
          [
            ctx.authority.accountId,
            input.capture_session_id,
            installation,
            input.source,
            input.kind,
          ],
        );
        if (!r.rowCount) throw new AppError('not_found');
      }
      const reservation = input.byte_size + ctx.limits.derivativeAllowanceBytes;
      const usage = await tx.query<{ used: number }>(
        `SELECT (
           COALESCE((SELECT sum(amount) FROM usage_reservations WHERE account_id=$1 AND state IN ('reserved','settled','unknown')),0)
           +COALESCE((SELECT sum(byte_size) FROM media_assets WHERE account_id=$1 AND legacy_imported AND deleted_at IS NULL),0)
         )::bigint AS used`,
        [ctx.authority.accountId],
      );
      if (usage.rows[0]!.used + reservation > ctx.limits.accountQuotaBytes) {
        throw new AppError('quota_exceeded', {
          message: 'Your account does not have enough available storage.',
        });
      }
      const assetId = randomUUID(),
        uploadId = randomUUID(),
        expires = new Date(ctx.now().getTime() + 86400000);
      const staging = `accounts/${ctx.authority.accountId}/staging/${assetId}/${uploadId}`;
      await tx.query(
        `INSERT INTO media_assets(id,account_id,installation_id,client_capture_id,capture_session_id,kind,source,
          byte_size,sha256,content_type,captured_at,created_at,created_by_agent_connection_id,authorization_version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          assetId,
          ctx.authority.accountId,
          installation,
          input.client_capture_id,
          input.capture_session_id ?? null,
          input.kind,
          input.source,
          input.byte_size,
          input.sha256,
          input.content_type,
          input.captured_at ?? null,
          ctx.now(),
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
        ],
      );
      const providerId = await ctx.storage.begin(staging, input.content_type);
      // A crash between begin and DB commit leaves only a staging multipart; bucket lifecycle bounds it.
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
          reservation,
          fingerprint,
          expires,
          ctx.agent?.connectionId ?? null,
          ctx.agent?.authorizationVersion ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO usage_reservations(account_id,upload_id,amount,expires_at) VALUES($1,$2,$3,$4)`,
        [ctx.authority.accountId, uploadId, reservation, expires],
      );
      return this.response(await loadCaptureUpload(ctx, tx, uploadId), true);
    });
  }

  async getUpload(id: string): Promise<MediaUploadResponse> {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await this.authorizeUpload(id, 'upload.read');
    return this.response(await loadCaptureUpload(this.ctx, this.ctx.db, id));
  }
  private async authorizeUpload(
    id: string,
    operation: 'upload.read' | 'upload.part' | 'upload.complete' | 'upload.abort',
  ) {
    if (!this.ctx.agent) return;
    const u = await loadCaptureUpload(this.ctx, this.ctx.db, id);
    if (u.created_by_agent_connection_id !== this.ctx.agent.connectionId)
      throw new AppError('not_found');
    await authorizeCaptureAgent(this.ctx, this.ctx.db, operation, id);
  }
  private async resumeBrowserUpload(tx: Db, u: UploadRecord): Promise<UploadRecord> {
    if (!u.authority_ended_at) return u;
    if (
      u.installation_id ||
      this.ctx.authority.kind !== 'account' ||
      this.ctx.agent ||
      !this.ctx.identity
    )
      throw new AppError('conflict', {
        message: 'Sign in again on the original phone to resume this upload.',
      });
    await this.ctx.identity.requireRecoverableAccount(
      this.ctx.authority.accountId,
      this.ctx.authority.sessionId,
    );
    await tx.query(
      `UPDATE upload_sessions SET state=CASE WHEN paused_from_state='created' THEN 'created' ELSE 'uploading' END,
      authority_ended_at=NULL,pause_reason=NULL,paused_from_state=NULL,error_code=NULL,authority_session_id=$2 WHERE id=$1`,
      [u.id, this.ctx.authority.sessionId],
    );
    return {
      ...u,
      state: u.paused_from_state === 'created' ? 'created' : 'uploading',
      authority_ended_at: null,
      error_code: null,
      pause_reason: null,
      paused_from_state: null,
    };
  }
  async resumeUpload(id: string, key: string) {
    return captureMutation(this.ctx, `resume:${id}`, key, {}, async (tx) => {
      const u = await loadCaptureUpload(this.ctx, tx, id, true);
      if (
        u.deleted_at ||
        u.expires_at <= this.ctx.now() ||
        ['aborted', 'expired', 'rejected'].includes(u.state)
      )
        throw new AppError('conflict');
      return this.response(await this.resumeBrowserUpload(tx, u));
    });
  }
  async parts(id: string, raw: unknown, key: string) {
    const input = UploadPartsRequest.parse(raw);
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await this.authorizeUpload(id, 'upload.part');
    if ((await loadCaptureUpload(this.ctx, this.ctx.db, id)).state === 'paused')
      throw new AppError('conflict', { message: 'Reauthenticate the original account to resume.' });
    return captureMutation(this.ctx, `parts:${id}`, key, input, async (tx) => {
      const u = await loadCaptureUpload(this.ctx, tx, id, true);
      if (
        u.deleted_at ||
        !['created', 'uploading'].includes(u.state) ||
        u.expires_at <= this.ctx.now()
      ) {
        throw new AppError('conflict', { message: 'This upload is no longer active.' });
      }
      const partCount = Math.ceil(u.expected_bytes / CAPTURE_PART_SIZE);
      if (
        new Set(input.part_numbers).size !== input.part_numbers.length ||
        input.part_numbers.some((n) => n > partCount)
      ) {
        throw new AppError('invalid_input');
      }
      await tx.query(`UPDATE upload_sessions SET state='uploading' WHERE id=$1`, [id]);
      return {
        parts: await Promise.all(
          input.part_numbers.map((p) =>
            this.ctx.storage.signPart(
              u.staging_key,
              u.provider_multipart_id!,
              p,
              Math.min(900, Math.floor((u.expires_at.getTime() - this.ctx.now().getTime()) / 1000)),
              multipartPartSize(u.expected_bytes, p, CAPTURE_PART_SIZE),
            ),
          ),
        ),
      };
    });
  }
  async completeUpload(id: string, raw: unknown, key: string): Promise<MediaUploadResponse> {
    const input = CompleteMediaUploadRequest.parse(raw);
    // Recheck tombstone even if an old completion response is in the idempotency store.
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await this.authorizeUpload(id, 'upload.complete');
    const before = await loadCaptureUpload(this.ctx, this.ctx.db, id);
    if (before.deleted_at || ['aborted', 'expired', 'rejected', 'paused'].includes(before.state))
      throw new AppError('conflict');
    return captureMutation(this.ctx, `complete:${id}`, key, input, async (tx) => {
      const u = await loadCaptureUpload(this.ctx, tx, id, true);
      if (
        u.deleted_at ||
        ['aborted', 'expired', 'rejected', 'paused'].includes(u.state) ||
        (u.state !== 'committed' && u.expires_at <= this.ctx.now())
      ) {
        throw new AppError('conflict');
      }
      const count = Math.ceil(u.expected_bytes / CAPTURE_PART_SIZE);
      if (input.parts.length !== count || input.parts.some((p, i) => p.part_number !== i + 1))
        throw new AppError('invalid_input');
      if (['committed', 'verifying'].includes(u.state)) {
        if (hashRequest(u.part_receipts) !== hashRequest(input.parts))
          throw new AppError('idempotency_conflict');
        return this.response(u);
      }
      await tx.query(`UPDATE upload_sessions SET state='verifying',part_receipts=$2 WHERE id=$1`, [
        id,
        JSON.stringify(input.parts),
      ]);
      await tx.query(`UPDATE media_assets SET status='verifying' WHERE account_id=$1 AND id=$2`, [
        u.account_id,
        u.asset_id,
      ]);
      await this.queue.enqueue(tx, {
        accountId: u.account_id,
        assetId: u.asset_id,
        uploadId: id,
        generation: u.generation,
        kind: 'verify_upload',
      });
      return this.response({ ...u, state: 'verifying', part_receipts: input.parts });
    });
  }
  async abortUpload(id: string, key: string) {
    await this.authorizeUpload(id, 'upload.abort');
    return captureMutation(this.ctx, `abort:${id}`, key, {}, async (tx) => {
      const u = await loadCaptureUpload(this.ctx, tx, id, true);
      if (u.state === 'committed')
        throw new AppError('conflict', {
          message: 'Delete the media item to remove committed media.',
        });
      if (!['aborted', 'expired', 'rejected'].includes(u.state)) {
        await this.tombstone(tx, u.asset_id, u.generation);
        await tx.query(`UPDATE upload_sessions SET state='aborted' WHERE id=$1`, [id]);
      }
      return { upload_id: id, state: 'aborted' as const };
    });
  }

  private async tombstone(tx: Db, id: string, generation: number): Promise<void> {
    const a = this.ctx.authority.accountId;
    await tx.query(
      `UPDATE media_assets SET status='deleted',deleted_at=$3,generation=generation+1,revision=revision+1
       WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,
      [a, id, this.ctx.now()],
    );
    await tx.query(
      `UPDATE upload_sessions SET state='aborted',pause_reason=NULL WHERE account_id=$1 AND asset_id=$2 AND state IN ('created','uploading','verifying','paused')`,
      [a, id],
    );
    await tx.query(
      `UPDATE usage_reservations SET state='released' WHERE account_id=$1 AND upload_id IN
       (SELECT id FROM upload_sessions WHERE account_id=$1 AND asset_id=$2) AND state!='released'`,
      [a, id],
    );
    await tx.query(
      `UPDATE capture_work SET state='cancelled' WHERE account_id=$1 AND asset_id=$2 AND state IN ('queued','running')`,
      [a, id],
    );
    await tx.query(
      `UPDATE media_analysis_requests SET state='cancelled' WHERE account_id=$1 AND asset_id=$2 AND state IN ('queued','running')`,
      [a, id],
    );
    const captures = await tx.query(
      `SELECT id FROM captures WHERE owner_account_id=$1 AND media_asset_id=$2 AND deleted_at IS NULL`,
      [a, id],
    );
    for (const capture of captures.rows) {
      if (!this.ctx.deleteAnalysisCapture)
        throw new AppError('service_unavailable', {
          message: 'Legacy media deletion is not configured.',
        });
      await this.ctx.deleteAnalysisCapture(tx, a, capture.id);
    }
    await this.queue.enqueue(tx, {
      accountId: a,
      assetId: id,
      generation: generation + 1,
      kind: 'purge_media',
    });
  }

  async deleteMedia(id: string, raw: unknown, key: string) {
    const input = DeleteMediaRequest.parse(raw);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'media.delete', id);
    return captureMutation(this.ctx, `delete-media:${id}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `SELECT generation,deleted_at FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`,
        [this.ctx.authority.accountId, id],
      );
      const m = rows[0];
      if (!m) throw new AppError('not_found');
      if (!m.deleted_at && m.generation !== input.expected_generation)
        throw new AppError('conflict');
      if (!m.deleted_at) await this.tombstone(tx, id, m.generation);
      return {
        id,
        generation: m.deleted_at ? m.generation : m.generation + 1,
        status: 'deleted' as const,
      };
    });
  }
  async batchDelete(raw: unknown, key: string) {
    const input = BatchDeleteMediaRequest.parse(raw);
    return captureMutation(this.ctx, 'batch-delete', key, input, async (tx) => {
      const intake = new MediaIntake({ ...this.ctx, db: tx }),
        items = [];
      for (const item of input.items) {
        try {
          await intake.deleteMedia(item.id, { expected_generation: item.expected_generation }, key);
          items.push({ id: item.id, deleted: true, error_code: null });
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          items.push({ id: item.id, deleted: false, error_code: error.code });
        }
      }
      return { items };
    });
  }

  async detail(id: string) {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'media.read', id);
    const { rows } = await this.ctx.db.query(
      `SELECT m.*,c.private_object_key AS legacy_private_key FROM media_assets m LEFT JOIN captures c
       ON c.id=m.legacy_capture_id AND c.owner_account_id=m.account_id AND c.deleted_at IS NULL
       WHERE m.account_id=$1 AND m.id=$2 AND m.deleted_at IS NULL`,
      [this.ctx.authority.accountId, id],
    );
    if (!rows[0]) throw new AppError('not_found');
    const m = rows[0];
    const derivatives = await this.ctx.db.query(
      `SELECT d.*,s.timestamp_ms,s.extraction_version FROM media_derivatives d LEFT JOIN media_segments s
       ON s.account_id=d.account_id AND s.frame_derivative_id=d.id
       WHERE d.account_id=$1 AND d.asset_id=$2 AND d.generation=$3
       ORDER BY s.timestamp_ms NULLS FIRST, d.id`,
      [m.account_id, id, m.generation],
    );
    const link = (variant: string) => `/v2/media/${id}/content/${variant}`;
    const find = (kind: string) => derivatives.rows.find((d) => d.kind === kind);
    return {
      media: {
        schema_version: 1 as const,
        id,
        kind: m.kind as 'photo' | 'video' | 'audio',
        source: m.source,
        status: m.status,
        analysis_status: m.analysis_status,
        created_at: m.created_at.toISOString(),
        title: m.title,
        ...(m.width ? { width: m.width, height: m.height } : {}),
        ...(m.duration_ms ? { duration_ms: m.duration_ms } : {}),
        // A video row states whether it carries sound; audio rows have no such
        // flag (their detail is schema_version 2), so null is simply omitted.
        ...(m.audio_present !== null && m.audio_present !== undefined
          ? { audio_present: m.audio_present }
          : {}),
      },
      generation: m.generation,
      revision: m.revision,
      error_code: m.error_code,
      links: {
        original:
          m.original_key && ['processing', 'ready', 'failed'].includes(m.status)
            ? link('original')
            : null,
        playback: find(m.kind === 'photo' ? 'normalized' : 'playback')
          ? link(find(m.kind === 'photo' ? 'normalized' : 'playback')!.id)
          : m.legacy_private_key
            ? link('legacy')
            : null,
        poster: find('poster') ? link(find('poster')!.id) : null,
        analysis: m.legacy_capture_id ? `/captures/${m.legacy_capture_id}` : null,
      },
      frames: derivatives.rows
        .filter((d) => d.kind === 'frame' && d.timestamp_ms !== null)
        .map((d) => ({
          id: d.id,
          timestamp_ms: d.timestamp_ms,
          extraction_version: d.extraction_version,
          thumbnail_url: link(d.id),
        })),
    };
  }

  async library(raw: unknown) {
    const input = MediaLibraryQuery.parse(raw);
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    if (this.ctx.agent)
      throw new AppError('scope_denied', {
        message: 'Agent lists require the grant-filtered media façade.',
      });
    let cursor: { at: string; id: string } | null = null;
    if (input.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      } catch {
        throw new AppError('invalid_input');
      }
      if (
        !cursor ||
        typeof cursor.at !== 'string' ||
        typeof cursor.id !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(cursor.id) ||
        !Number.isFinite(Date.parse(cursor.at))
      )
        throw new AppError('invalid_input');
    }
    const { rows } = await this.ctx.db.query(
      // Amendment 2.3: the page lists photos and videos only, unless the client
      // asks for a kind (audio = Music Mode recordings); legacy clients never
      // meet a row they do not know.
      `SELECT id,created_at FROM media_assets WHERE account_id=$1 AND deleted_at IS NULL
       AND (($2::text IS NULL AND kind IN ('photo','video')) OR kind=$2)
       AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR source=$4)
       AND ($5::timestamptz IS NULL OR (created_at,id)<($5,$6::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $7`,
      [
        this.ctx.authority.accountId,
        input.kind ?? null,
        input.status ?? null,
        input.source ?? null,
        cursor?.at ?? null,
        cursor?.id ?? null,
        input.limit + 1,
      ],
    );
    const selected = rows.slice(0, input.limit),
      last = selected.at(-1);
    return {
      items: await Promise.all(selected.map((r) => this.detail(r.id))),
      next_cursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({ at: last.created_at.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }
  /** Failed preparation of a safely stored original can be retried; rejected uploads cannot. */
  async retryPreparation(id: string, raw: unknown, key: string) {
    const input = DeleteMediaRequest.parse(raw);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'media.prepare', id);
    await captureMutation(this.ctx, `retry-preparation:${id}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `SELECT generation,status,original_key FROM media_assets WHERE account_id=$1 AND id=$2
         AND deleted_at IS NULL FOR UPDATE`,
        [this.ctx.authority.accountId, id],
      );
      const m = rows[0];
      if (!m) throw new AppError('not_found');
      if (m.generation !== input.expected_generation) throw new AppError('conflict');
      if (m.status !== 'failed' || !m.original_key)
        throw new AppError('conflict', {
          message: 'Only media that failed preparation after upload can be retried.',
        });
      if (!this.ctx.mediaCreationEnabled)
        throw new AppError('service_unavailable', {
          message: 'Media preparation is temporarily paused.',
        });
      await tx.query(
        `UPDATE media_assets SET status='processing',error_code=NULL WHERE account_id=$1 AND id=$2`,
        [this.ctx.authority.accountId, id],
      );
      const reset = await tx.query(
        `UPDATE capture_work SET state='queued',attempts=0,error_code=NULL,lease_token=NULL,
           lease_expires_at=NULL,available_at=$4,completed_at=NULL
         WHERE account_id=$1 AND asset_id=$2 AND generation=$3 AND kind='prepare_media'
           AND analysis_id IS NULL AND state IN ('failed','cancelled')`,
        [this.ctx.authority.accountId, id, m.generation, this.ctx.now()],
      );
      if (!reset.rowCount)
        await this.queue.enqueue(tx, {
          accountId: this.ctx.authority.accountId,
          assetId: id,
          generation: m.generation,
          kind: 'prepare_media',
        });
      return { id };
    });
    return this.detail(id);
  }
  async updateMedia(id: string, raw: unknown, key: string) {
    const input = UpdateMediaRequest.parse(raw);
    await authorizeCaptureAgent(this.ctx, this.ctx.db, 'media.update', id);
    await captureMutation(this.ctx, `update-media:${id}`, key, input, async (tx) => {
      const r = await tx.query(
        `UPDATE media_assets SET title=$3,revision=revision+1 WHERE account_id=$1 AND id=$2
         AND deleted_at IS NULL AND revision=$4 RETURNING id`,
        [this.ctx.authority.accountId, id, input.title, input.expected_revision],
      );
      if (!r.rowCount) {
        const existing = await tx.query(
          `SELECT id FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`,
          [this.ctx.authority.accountId, id],
        );
        throw new AppError(existing.rowCount ? 'conflict' : 'not_found');
      }
      return { id };
    });
    return this.detail(id);
  }
  /**
   * Owner/installation/agent-authorized media gateway. Every call (and every range)
   * rechecks ownership and tombstones, so deletion takes effect for links already issued.
   */
  async content(id: string, variant: string, range?: ByteRangeRequest): Promise<MediaContent> {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    await authorizeCaptureAgent(
      this.ctx,
      this.ctx.db,
      variant === 'original' ? 'media.download' : 'media.read',
      id,
    );
    const { rows } = await this.ctx.db.query(
      `SELECT m.original_key,m.legacy_imported,m.byte_size AS original_size,d.object_key,d.byte_size AS derivative_size,
         c.private_object_key AS legacy_private_key FROM media_assets m
       LEFT JOIN media_derivatives d ON d.account_id=m.account_id AND d.asset_id=m.id AND d.generation=m.generation AND d.id::text=$3
       LEFT JOIN captures c ON c.id=m.legacy_capture_id AND c.owner_account_id=m.account_id AND c.deleted_at IS NULL
       WHERE m.account_id=$1 AND m.id=$2 AND m.deleted_at IS NULL AND m.status IN ('processing','ready','failed')`,
      [this.ctx.authority.accountId, id, variant],
    );
    const legacyKey = variant === 'legacy' ? rows[0]?.legacy_private_key : null;
    if (legacyKey && this.ctx.readLegacyObject)
      return sliceObject(await this.ctx.readLegacyObject(legacyKey), range);
    const objectKey = variant === 'original' ? rows[0]?.original_key : rows[0]?.object_key;
    if (!objectKey) throw new AppError('not_found');
    if (variant === 'original' && rows[0]?.legacy_imported && this.ctx.readLegacyObject)
      return sliceObject(await this.ctx.readLegacyObject(objectKey), range);
    const totalSize = Number(
      variant === 'original' ? rows[0]!.original_size : rows[0]!.derivative_size,
    );
    if (!range || !Number.isSafeInteger(totalSize) || totalSize < 1) {
      const object = await this.ctx.storage.read(objectKey);
      return sliceObject(object, range);
    }
    const bounds = resolveByteRange(range, totalSize);
    // Each authorized range is bounded server-side; media elements request the next window.
    const end = Math.min(bounds.end, bounds.start + MEDIA_RANGE_WINDOW_BYTES - 1);
    const part = await this.ctx.storage.getRange(objectKey, { start: bounds.start, end });
    return {
      body: part.body,
      contentType: part.contentType,
      byteSize: part.byteSize,
      totalSize: part.totalSize,
      start: part.start,
      end: part.end,
      partial: true,
    };
  }
}
