import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { hashRequest } from '../idempotency';
import type { CaptureAuthority, CaptureV2Context } from './types';

/** Must run before CSRF, rate limits, idempotency or any request-side write. */
export function assertExpectedCaptureAccount(authority: CaptureAuthority, expected: string | null, mutation: boolean): void {
  if (!mutation) return;
  if ((authority.kind==='account' && !expected) || (expected!==null && expected!==authority.accountId)) {
    throw new AppError('account_mismatch');
  }
}

/** Rechecks device revocation on every operation/replay, not only token resolution. */
export async function assertCaptureAuthority(ctx: CaptureV2Context, tx: Db, lock = false): Promise<void> {
  if(ctx.authority.kind==='installation') {
    if(ctx.authority.expiresAt<=ctx.now()) throw new AppError('token_expired');
    const r=await tx.query(
      `SELECT id FROM mobile_installations WHERE account_id=$1 AND id=$2 AND revoked_at IS NULL${lock?' FOR UPDATE':''}`,
      [ctx.authority.accountId,ctx.authority.installationId],
    );
    if(!r.rowCount) throw new AppError('token_revoked');
  }
}

export async function captureMutation<T>(
  ctx: CaptureV2Context,operation: string,key: string,payload: unknown,
  run: (tx: Db)=>Promise<T>,
): Promise<T> {
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new AppError('invalid_input',{message:'Idempotency-Key must be a UUID.'});
  }
  return ctx.db.transaction(async tx=>{
    // Serializes per-account quota reservations and idempotency without global contention.
    await tx.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE',[ctx.authority.accountId]);
    await assertCaptureAuthority(ctx,tx,true);
    const authority=ctx.authority.kind==='installation'?ctx.authority.installationId:'account';
    const fingerprint=hashRequest(payload);
    const {rows}=await tx.query(
      `SELECT request_hash,response FROM capture_v2_idempotency
       WHERE account_id=$1 AND authority=$2 AND operation=$3 AND key=$4 AND expires_at>$5`,
      [ctx.authority.accountId,authority,operation,key,ctx.now()],
    );
    if(rows[0]) {
      if(rows[0].request_hash!==fingerprint) throw new AppError('idempotency_conflict');
      return rows[0].response as T;
    }
    const result=await run(tx);
    await tx.query(
      `INSERT INTO capture_v2_idempotency(account_id,authority,operation,key,request_hash,response,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(account_id,authority,operation,key) DO UPDATE SET
         request_hash=excluded.request_hash,response=excluded.response,expires_at=excluded.expires_at`,
      [ctx.authority.accountId,authority,operation,key,fingerprint,JSON.stringify(result),
        new Date(ctx.now().getTime()+7*86400000)],
    );
    return result;
  });
}
