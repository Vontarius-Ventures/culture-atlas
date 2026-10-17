import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createIsolatedDatabase, insertAccount, type IsolatedDatabase } from '../testing';
import { collectOpsSnapshot, toEmbeddedMetricLine } from './metrics';

let isolated: IsolatedDatabase;
beforeAll(async () => {
  isolated = await createIsolatedDatabase();
}, 60_000);
afterAll(() => isolated?.drop());

describe('ops snapshot', () => {
  it('is all zeros on an idle database', async () => {
    expect(await collectOpsSnapshot(isolated.db)).toEqual({
      CaptureQueueOldestSeconds: 0,
      JobQueueOldestSeconds: 0,
      WorkFailedLastHour: 0,
      ExpiredLeases: 0,
      UploadsStuckVerifying: 0,
      ReservationsUnsettled: 0,
      PurgeOverdue: 0,
      ModelAttemptsUnknown: 0,
    });
  });

  it('reports queue age, failures, expired leases, stuck uploads, unsettled reservations and overdue purges', async () => {
    const db = isolated.db;
    const now = new Date('2026-10-17T12:00:00Z');
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    const { accountId } = await insertAccount(db);
    const asset = async (deletedAt: Date | null = null) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO media_assets(account_id,client_capture_id,kind,source,byte_size,content_type,deleted_at)
           VALUES($1,$2,'photo','upload',10,'image/jpeg',$3) RETURNING id`,
          [accountId, randomUUID(), deletedAt],
        )
      ).rows[0]!.id;
    // Runnable queued work for 400s; a future item is not "waiting".
    await db.query(
      `INSERT INTO capture_work(account_id,asset_id,generation,kind,state,available_at,created_at)
       VALUES($1,$2,1,'verify_upload','queued',$3,$3),($1,$4,1,'verify_upload','queued',$5,$5)`,
      [accountId, await asset(), ago(400), await asset(), new Date(now.getTime() + 60_000)],
    );
    await db.query(
      `INSERT INTO capture_work(account_id,asset_id,generation,kind,state,lease_expires_at,lease_token,attempt_id)
       VALUES($1,$2,1,'prepare_media','running',$3,gen_random_uuid(),gen_random_uuid())`,
      [accountId, await asset(), ago(5)],
    );
    await db.query(
      `INSERT INTO capture_work(account_id,asset_id,generation,kind,state,completed_at,error_code)
       VALUES($1,$2,1,'prepare_media','failed',$3,'decoder_failed')`,
      [accountId, await asset(), ago(60)],
    );
    await db.query(
      `INSERT INTO jobs(owner_account_id,type,state,available_at) VALUES($1,'analysis','queued',$2)`,
      [accountId, ago(90)],
    );
    const deleted = await asset(ago(2 * 86400));
    await db.query(
      `INSERT INTO capture_work(account_id,asset_id,generation,kind,state) VALUES($1,$2,2,'purge_media','failed')`,
      [accountId, deleted],
    );
    const stuck = await asset();
    const upload = await db.query<{ id: string }>(
      `INSERT INTO upload_sessions(account_id,asset_id,state,staging_key,expected_bytes,expected_sha256,reserved_bytes,
         request_hash,expires_at,created_at)
       VALUES($1,$2,'verifying',$3,10,'x',10,'h',$4,$5) RETURNING id`,
      [accountId, stuck, `staging/${randomUUID()}`, new Date(now.getTime() + 3600_000), ago(3600)],
    );
    await db.query(
      `INSERT INTO usage_reservations(account_id,upload_id,amount,expires_at,state) VALUES($1,$2,10,$3,'reserved')`,
      [accountId, upload.rows[0]!.id, ago(2 * 86400)],
    );
    expect(await collectOpsSnapshot(db, now)).toEqual({
      CaptureQueueOldestSeconds: 400,
      JobQueueOldestSeconds: 90,
      WorkFailedLastHour: 1,
      ExpiredLeases: 1,
      UploadsStuckVerifying: 1,
      ReservationsUnsettled: 1,
      PurgeOverdue: 1,
      ModelAttemptsUnknown: 0,
    });
  });

  it('formats an Embedded Metric Format line with counts only', () => {
    const line = JSON.parse(
      toEmbeddedMetricLine(
        {
          CaptureQueueOldestSeconds: 12,
          JobQueueOldestSeconds: 0,
          WorkFailedLastHour: 0,
          ExpiredLeases: 0,
          UploadsStuckVerifying: 0,
          ReservationsUnsettled: 0,
          PurgeOverdue: 0,
          ModelAttemptsUnknown: 3,
        },
        { namespace: 'CultureAtlas', environment: 'staging', now: new Date(0) },
      ),
    );
    expect(line._aws.Timestamp).toBe(0);
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe('CultureAtlas');
    expect(line._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Environment']]);
    expect(line._aws.CloudWatchMetrics[0].Metrics).toHaveLength(8);
    expect(line._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({
      Name: 'CaptureQueueOldestSeconds',
      Unit: 'Seconds',
    });
    expect(line).toMatchObject({
      Environment: 'staging',
      CaptureQueueOldestSeconds: 12,
      ModelAttemptsUnknown: 3,
    });
  });
});
