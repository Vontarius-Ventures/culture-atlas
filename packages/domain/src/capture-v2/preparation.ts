import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { MediaIntake, loadCaptureUpload, mediaObjectPrefix } from './intake';
import { CaptureQueue } from './queue';
import type {
  CaptureLease,
  CaptureV2Context,
  MediaPreparer,
  PreparedMedia,
  VerifiedMedia,
} from './types';
import { assertCaptureWorkAgent } from './agent-fence';

/** Trusted worker module. Persisted job owner replaces ambient request authority. */
export class MediaPreparation {
  readonly queue: CaptureQueue;
  constructor(private readonly ctx: CaptureV2Context) {
    this.queue = new CaptureQueue(ctx.db, ctx.now);
  }

  private owned(lease: CaptureLease): CaptureV2Context {
    return {
      ...this.ctx,
      authority: { kind: 'account', accountId: lease.account_id, sessionId: null },
    };
  }
  private async live(tx: Db, lease: CaptureLease) {
    // Same account→asset→lease lock order as intake/delete.
    await tx.query(`SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, [lease.account_id]);
    const { rows } = await tx.query(
      `SELECT * FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`,
      [lease.account_id, lease.asset_id],
    );
    const media = rows[0];
    if (!media || media.deleted_at || media.generation !== lease.generation)
      throw new AppError('conflict');
    await this.queue.assertLease(tx, lease);
    await assertCaptureWorkAgent(tx, lease, this.ctx.agentAuthorization);
    return media;
  }
  async assertLive(lease: CaptureLease): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      await this.live(tx, lease);
    });
  }

  async verifyUpload(lease: CaptureLease): Promise<void> {
    if (lease.kind !== 'verify_upload' || !lease.upload_id || !lease.asset_id)
      throw new AppError('invalid_input');
    const ctx = this.owned(lease);
    let sealedKey: string | null = null;
    try {
      await this.assertLive(lease);
      const u = await loadCaptureUpload(ctx, ctx.db, lease.upload_id);
      if (u.authority_ended_at) throw new AppError('conflict');
      if (u.state !== 'verifying' || u.expires_at <= ctx.now())
        throw new AppError('invalid_input', { message: 'Upload expired.' });
      await ctx.storage.finish(u.staging_key, u.provider_multipart_id!, u.part_receipts);
      const stored = await ctx.storage.read(u.staging_key);
      if (stored.byteSize !== u.expected_bytes)
        throw new AppError('invalid_input', { message: 'The uploaded file size does not match.' });
      const hash = createHash('sha256');
      let actual = 0,
        consumed = false;
      async function* checked() {
        for await (const chunk of stored.body) {
          actual += chunk.byteLength;
          if (actual > u.expected_bytes) throw new AppError('payload_too_large');
          hash.update(chunk);
          yield chunk;
        }
        consumed = true;
      }
      const metadata = await ctx.verifier.verify({
        body: checked(),
        kind: u.kind,
        contentType: u.content_type,
        byteSize: u.expected_bytes,
        limits: ctx.limits,
      });
      if (!consumed || actual !== u.expected_bytes || hash.digest('hex') !== u.expected_sha256) {
        throw new AppError('invalid_input', {
          message: 'The uploaded file checksum does not match.',
        });
      }
      this.validateMetadata(metadata, u.kind, u.source, u.content_type);
      sealedKey = `${mediaObjectPrefix(u.account_id, u.asset_id, u.generation)}/original`;
      await this.assertLive(lease);
      await ctx.storage.seal(u.staging_key, sealedKey);
      await ctx.db.transaction(async (tx) => {
        await this.live(tx, lease);
        const current = await loadCaptureUpload(ctx, tx, u.id, true);
        if (current.state !== 'verifying') throw new AppError('conflict');
        await tx.query(
          `UPDATE media_assets SET original_key=$3,status='processing',received_at=$4,width=$5,height=$6,
           duration_ms=$7,audio_present=$8,container=$9,codecs=$10 WHERE account_id=$1 AND id=$2`,
          [
            u.account_id,
            u.asset_id,
            sealedKey,
            ctx.now(),
            metadata.width,
            metadata.height,
            metadata.durationMs ?? null,
            metadata.audioPresent ?? false,
            metadata.container ?? null,
            JSON.stringify(metadata.codecs ?? []),
          ],
        );
        await tx.query(
          `UPDATE upload_sessions SET state='committed',committed_version=$2 WHERE id=$1`,
          [u.id, `${u.generation}`],
        );
        await tx.query(
          `UPDATE usage_reservations SET state='settled' WHERE account_id=$1 AND upload_id=$2 AND state='reserved'`,
          [u.account_id, u.id],
        );
        await this.queue.enqueue(tx, {
          accountId: u.account_id,
          assetId: u.asset_id,
          generation: u.generation,
          kind: 'prepare_media',
        });
        await this.queue.complete(lease, tx);
      });
      await ctx.storage.delete(u.staging_key);
      await ctx.storage.abort(u.staging_key, u.provider_multipart_id!);
    } catch (error) {
      if (sealedKey) {
        const visible = await ctx.db.query(
          `SELECT id FROM media_assets WHERE account_id=$1 AND id=$2 AND original_key=$3 AND deleted_at IS NULL`,
          [lease.account_id, lease.asset_id, sealedKey],
        );
        if (!visible.rowCount) await ctx.storage.delete(sealedKey);
      }
      await this.rejectOrRetry(lease, error);
    }
  }
  private validateMetadata(
    m: VerifiedMedia,
    kind: 'photo' | 'video',
    source: string,
    contentType: string,
  ): void {
    const validDimension = (n: number) => Number.isSafeInteger(n) && n > 0;
    if (
      m.contentType !== contentType ||
      !validDimension(m.width) ||
      !validDimension(m.height) ||
      m.width * m.height > this.ctx.limits.photoMaxPixels
    )
      throw new AppError('invalid_input', { message: 'Invalid media dimensions or format.' });
    if (kind === 'video') {
      const duration = m.durationMs ?? 0;
      const max =
        source === 'upload'
          ? this.ctx.limits.videoMaxDurationMs
          : this.ctx.limits.captureVideoMaxDurationMs;
      if (Number.isSafeInteger(duration) && duration > max)
        throw new AppError('duration_exceeded', {
          message: 'This video is longer than the allowed duration.',
        });
      if (
        !Number.isSafeInteger(duration) ||
        duration <= 0 ||
        duration > max ||
        typeof m.audioPresent !== 'boolean'
      ) {
        throw new AppError('invalid_input', {
          message: 'This video exceeds the duration limit or could not be decoded.',
        });
      }
    }
  }

  async prepareMedia(lease: CaptureLease, preparer: MediaPreparer): Promise<void> {
    if (lease.kind !== 'prepare_media' || !lease.asset_id) throw new AppError('invalid_input');
    let output: PreparedMedia | undefined;
    const attemptPrefix = `${mediaObjectPrefix(lease.account_id, lease.asset_id, lease.generation)}/derived/${lease.attempt_id}`;
    try {
      const m = await this.ctx.db.transaction((tx) => this.live(tx, lease));
      if (!m.original_key) throw new AppError('invalid_input');
      const prefix = attemptPrefix;
      output = await preparer.prepare({
        lease,
        originalKey: m.original_key,
        storage: this.ctx.storage,
        media: {
          kind: m.kind,
          byteSize: m.byte_size,
          contentType: m.content_type,
          width: m.width,
          height: m.height,
          durationMs: m.duration_ms ?? undefined,
          audioPresent: m.audio_present ?? false,
          container: m.container ?? undefined,
          codecs: m.codecs ?? [],
        },
        assertLive: () => this.assertLive(lease),
        derivativeKey: (kind, suffix = '') => {
          if (!/^[a-zA-Z0-9._-]{0,100}$/.test(suffix)) throw new AppError('invalid_input');
          return `${prefix}/${kind}${suffix ? `-${suffix}` : ''}`;
        },
      });
      await this.ctx.db.transaction(async (tx) => {
        const current = await this.live(tx, lease);
        const kinds = output!.derivatives.map((d) => d.kind);
        if (current.kind === 'video' && (!kinds.includes('playback') || !kinds.includes('poster')))
          throw new AppError('invalid_input');
        if (current.kind === 'photo' && !kinds.includes('normalized'))
          throw new AppError('invalid_input');
        if (output!.derivatives.filter((d) => d.kind === 'frame').length > 8)
          throw new AppError('invalid_input');
        let derivativeBytes = 0;
        for (const d of output!.derivatives) {
          if (
            !d.objectKey.startsWith(`${prefix}/`) ||
            !/^[a-f0-9]{64}$/.test(d.checksum) ||
            !Number.isSafeInteger(d.byteSize) ||
            d.byteSize < 1 ||
            !Number.isSafeInteger(d.width) ||
            d.width < 1 ||
            !Number.isSafeInteger(d.height) ||
            d.height < 1
          )
            throw new AppError('invalid_input');
          derivativeBytes += d.byteSize;
          const { rows } = await tx.query(
            `INSERT INTO media_derivatives(account_id,asset_id,generation,kind,processing_version,object_key,
             checksum,byte_size,width,height,duration_ms,share_safe)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
            [
              lease.account_id,
              lease.asset_id,
              lease.generation,
              d.kind,
              d.processingVersion,
              d.objectKey,
              d.checksum,
              d.byteSize,
              d.width,
              d.height,
              d.durationMs ?? null,
              d.shareSafe ?? false,
            ],
          );
          if (d.kind === 'frame') {
            if (
              !Number.isSafeInteger(d.timestampMs) ||
              d.timestampMs! < 0 ||
              d.timestampMs! >= current.duration_ms ||
              !output!.extractionVersion
            ) {
              throw new AppError('invalid_input');
            }
            await tx.query(
              `INSERT INTO media_segments(account_id,asset_id,frame_derivative_id,timestamp_ms,extraction_version)
               VALUES($1,$2,$3,$4,$5)`,
              [
                lease.account_id,
                lease.asset_id,
                rows[0]!.id,
                d.timestampMs,
                output!.extractionVersion,
              ],
            );
          }
        }
        if (derivativeBytes > this.ctx.limits.derivativeAllowanceBytes)
          throw new AppError('quota_exceeded', {
            message: 'Prepared media exceeds its reserved storage allowance.',
          });
        await tx.query(
          `UPDATE media_assets SET status='ready',error_code=NULL WHERE account_id=$1 AND id=$2`,
          [lease.account_id, lease.asset_id],
        );
        await tx.query(
          `UPDATE usage_reservations SET amount=$3 WHERE account_id=$1 AND upload_id IN
           (SELECT id FROM upload_sessions WHERE account_id=$1 AND asset_id=$2) AND state='settled'`,
          [lease.account_id, lease.asset_id, current.byte_size + derivativeBytes],
        );
        await this.queue.complete(lease, tx);
      });
    } catch (error) {
      // Also covers an adapter that throws after writing but before returning its manifest.
      await this.ctx.storage.deletePrefix(attemptPrefix);
      await this.rejectOrRetry(lease, error);
    }
  }

  private async rejectOrRetry(lease: CaptureLease, error: unknown): Promise<void> {
    const permanent = error instanceof AppError && !error.retryable && error.code !== 'conflict';
    try {
      await this.ctx.db.transaction(async (tx) => {
        await this.live(tx, lease);
        if (permanent) {
          const code = error.code;
          await tx.query(
            `UPDATE media_assets SET status='failed',error_code=$3 WHERE account_id=$1 AND id=$2`,
            [lease.account_id, lease.asset_id, code],
          );
          if (lease.kind === 'verify_upload') {
            await tx.query(
              `UPDATE upload_sessions SET state='rejected',error_code=$3 WHERE account_id=$1 AND id=$2`,
              [lease.account_id, lease.upload_id, code],
            );
            // Reservation remains charged until physical cleanup succeeds.
            await this.queue.enqueue(tx, {
              accountId: lease.account_id,
              assetId: lease.asset_id!,
              uploadId: lease.upload_id!,
              generation: lease.generation,
              kind: 'cleanup_upload',
            });
          }
          await tx.query(
            `UPDATE capture_work SET state='failed',error_code=$2,lease_expires_at=NULL WHERE id=$1`,
            [lease.job_id, code],
          );
        } else {
          await tx.query(
            `UPDATE capture_work SET state=$2,error_code='preparation_unavailable',lease_expires_at=NULL,available_at=$3 WHERE id=$1`,
            [
              lease.job_id,
              lease.attempts < 5 ? 'queued' : 'failed',
              new Date(this.ctx.now().getTime() + Math.min(300, 2 ** lease.attempts) * 1000),
            ],
          );
        }
      });
    } catch (fenceError) {
      if (!(fenceError instanceof AppError && fenceError.code === 'conflict')) throw fenceError;
    }
  }

  async cleanup(lease: CaptureLease): Promise<void> {
    if (!['purge_media', 'cleanup_upload'].includes(lease.kind) || !lease.asset_id)
      throw new AppError('invalid_input');
    await this.queue.assertLease(this.ctx.db, lease);
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM upload_sessions WHERE account_id=$1 AND asset_id=$2`,
      [lease.account_id, lease.asset_id],
    );
    for (const u of rows) {
      if (u.provider_multipart_id)
        await this.ctx.storage.abort(u.staging_key, u.provider_multipart_id);
      await this.ctx.storage.delete(u.staging_key);
    }
    if (lease.kind === 'purge_media') {
      const media = await this.ctx.db.query(
        `SELECT original_key FROM media_assets WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL`,
        [lease.account_id, lease.asset_id],
      );
      if (!media.rowCount) throw new AppError('conflict');
      if (media.rows[0]!.original_key) await this.ctx.storage.delete(media.rows[0]!.original_key);
      const ds = await this.ctx.db.query(
        `SELECT object_key FROM media_derivatives WHERE account_id=$1 AND asset_id=$2`,
        [lease.account_id, lease.asset_id],
      );
      for (const d of ds.rows) await this.ctx.storage.delete(d.object_key);
      // Includes unregistered output left by a crashed/fenced preparer.
      await this.ctx.storage.deletePrefix(`accounts/${lease.account_id}/media/${lease.asset_id}`);
    }
    await this.ctx.db.transaction(async (tx) => {
      await this.queue.assertLease(tx, lease);
      await tx.query(
        `UPDATE usage_reservations SET state='released' WHERE account_id=$1 AND upload_id IN
         (SELECT id FROM upload_sessions WHERE account_id=$1 AND asset_id=$2)
         AND ($3='purge_media' OR state='reserved')`,
        [lease.account_id, lease.asset_id, lease.kind],
      );
      if (lease.kind === 'purge_media') {
        const { rows } = await tx.query(
          `SELECT deleted_at FROM media_assets WHERE account_id=$1 AND id=$2`,
          [lease.account_id, lease.asset_id],
        );
        const safety = new Date(rows[0]!.deleted_at.getTime() + 600000);
        if (safety > this.ctx.now()) {
          // One delayed pass catches writes finishing after the first purge; max lease is5min.
          await tx.query(
            `UPDATE capture_work SET state='queued',lease_expires_at=NULL,available_at=$2 WHERE id=$1`,
            [lease.job_id, safety],
          );
          return;
        }
      }
      await this.queue.complete(lease, tx);
    });
  }

  /** Periodic durable expiry. Never touches another account's record via ambient authority. */
  async expireUploads(accountId?: string): Promise<number> {
    const { rows } = await this.ctx.db.query(
      `SELECT id,account_id FROM upload_sessions WHERE expires_at<=$1 AND state IN ('created','uploading','verifying','paused')
       AND ($2::uuid IS NULL OR account_id=$2) LIMIT 100`,
      [this.ctx.now(), accountId ?? null],
    );
    let expired = 0;
    for (const u of rows) {
      const ctx = {
        ...this.ctx,
        authority: { kind: 'account' as const, accountId: u.account_id, sessionId: null },
      };
      try {
        await new MediaIntake(ctx).abortUpload(u.id, randomUUID());
        const result = await this.ctx.db.query(
          `UPDATE upload_sessions SET state='expired' WHERE id=$1 AND account_id=$2 AND state='aborted'`,
          [u.id, u.account_id],
        );
        expired += result.rowCount ?? 0;
      } catch (error) {
        // Completion may commit between the candidate scan and its account lock.
        if (!(error instanceof AppError && error.code === 'conflict')) throw error;
      }
    }
    return expired;
  }
}
