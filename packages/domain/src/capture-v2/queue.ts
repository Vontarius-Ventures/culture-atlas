import { randomUUID } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import type { CaptureLease, CaptureWorkKind } from './types';

export class CaptureQueue {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  async enqueue(tx: Db, input: {
    accountId: string; assetId: string; uploadId?: string; generation: number; kind: CaptureWorkKind;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO capture_work(account_id,asset_id,upload_id,generation,kind)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,asset_id,generation,kind) DO NOTHING`,
      [input.accountId,input.assetId,input.uploadId ?? null,input.generation,input.kind],
    );
  }

  async claim(kinds: CaptureWorkKind[], leaseSeconds = 60): Promise<CaptureLease | null> {
    const now = this.now();
    const token = randomUUID(), attempt = randomUUID();
    const { rows } = await this.db.query(
      `WITH candidate AS (
        SELECT w.id FROM capture_work w
        WHERE w.kind = ANY($1) AND w.available_at <= $2
          AND (w.state='queued' OR (w.state='running' AND w.lease_expires_at <= $2))
        ORDER BY
          (SELECT count(*) FROM capture_work r WHERE r.account_id=w.account_id AND r.state='running' AND r.lease_expires_at > $2),
          w.created_at,w.id
        FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE capture_work w SET state='running',lease_token=$3,attempt_id=$4,
         lease_expires_at=$5,attempts=attempts+1
       FROM candidate c WHERE w.id=c.id
       RETURNING w.id AS job_id,w.account_id,w.asset_id,w.upload_id,w.generation,w.kind,
         w.attempt_id,w.lease_token,w.lease_expires_at,w.attempts`,
      [kinds,now,token,attempt,new Date(now.getTime()+Math.min(Math.max(leaseSeconds,1),300)*1000)],
    );
    return (rows[0] as CaptureLease | undefined) ?? null;
  }

  async assertLease(tx: Db, lease: CaptureLease): Promise<void> {
    const r = await tx.query(
      `SELECT id FROM capture_work WHERE id=$1 AND account_id=$2 AND attempt_id=$3
        AND lease_token=$4 AND state='running' AND lease_expires_at > $5 FOR UPDATE`,
      [lease.job_id,lease.account_id,lease.attempt_id,lease.lease_token,this.now()],
    );
    if (!r.rowCount) throw new AppError('conflict', { message: 'Worker lease is no longer valid.' });
  }

  async heartbeat(lease: CaptureLease, seconds = 60): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE capture_work SET lease_expires_at=$6 WHERE id=$1 AND account_id=$2
       AND attempt_id=$3 AND lease_token=$4 AND state='running' AND lease_expires_at > $5`,
      [lease.job_id,lease.account_id,lease.attempt_id,lease.lease_token,this.now(),
        new Date(this.now().getTime()+Math.min(Math.max(seconds,1),300)*1000)],
    );
    return !!r.rowCount;
  }

  async complete(lease: CaptureLease, tx: Db = this.db): Promise<void> {
    await this.assertLease(tx,lease);
    await tx.query(`UPDATE capture_work SET state='complete',completed_at=$2,lease_expires_at=NULL WHERE id=$1`,
      [lease.job_id,this.now()]);
  }

  async fail(lease: CaptureLease, errorCode: string, retry = true): Promise<void> {
    await this.db.transaction(async tx => {
      await this.assertLease(tx,lease);
      await tx.query(
        `UPDATE capture_work SET state=$2,error_code=$3,available_at=$4,lease_expires_at=NULL WHERE id=$1`,
        [lease.job_id,retry && lease.attempts<5 ? 'queued':'failed',errorCode,
          new Date(this.now().getTime()+Math.min(300,2**lease.attempts)*1000)],
      );
    });
  }
}
