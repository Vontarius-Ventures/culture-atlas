import { createHash, createPublicKey, verify } from 'node:crypto';
import type { Db } from '../db/pool';
import { AppError } from '../errors';
import { hashToken, randomToken } from '../services/auth';
import { hashRequest } from '../idempotency';
import {
  EnrollmentChallengeRequest,
  EnrollCaptureDeviceRequest,
  DeviceStatusRequest,
  RevokeCaptureDeviceRequest,
  CreateWearableRequest,
  CreateCaptureSessionRequest,
  ArmCaptureSessionRequest,
  EndCaptureSessionRequest,
} from '../schemas/capture-v2';
import { assertCaptureAuthority, captureMutation } from './policy';
import { CaptureQueue } from './queue';
import type { AuthorityEnded, CaptureV2Context, CaptureIdentityAdapter } from './types';

export function enrollmentSignaturePayload(
  nonce: string,
  installationPublicId: string,
  platform: string,
  grant?: string,
): string {
  return `culture-atlas-enroll-v1\n${nonce}\n${installationPublicId}\n${platform}\n${hashToken(grant ?? '')}`;
}
function deviceProjection(r: Record<string, unknown>) {
  return {
    id: r.id,
    platform: r.platform,
    app_version: r.app_version,
    revision: r.revision,
    last_seen_at: (r.last_seen_at as Date).toISOString(),
    revoked_at: r.revoked_at ? (r.revoked_at as Date).toISOString() : null,
    capabilities: r.capabilities,
    readiness: r.readiness,
    app_state: r.app_state,
  };
}
export class CaptureDevice {
  constructor(private readonly ctx: CaptureV2Context) {}
  private identity(): CaptureIdentityAdapter {
    if (!this.ctx.identity)
      throw new AppError('service_unavailable', {
        message: 'Verified device enrollment is not configured.',
      });
    return this.ctx.identity;
  }
  async challenge(raw: unknown) {
    const input = EnrollmentChallengeRequest.parse(raw),
      ctx = this.ctx;
    let accountId: string | null = null,
      session: string;
    const identity = this.identity();
    if (input.enrollment_grant) {
      await identity.peekNativeEnrollmentGrant(
        ctx.db,
        input.enrollment_grant,
        input.platform,
        ctx.now(),
      );
      session = `grant:${hashToken(input.enrollment_grant)}`;
    } else {
      if (ctx.authority.kind !== 'account') throw new AppError('scope_denied');
      await identity.requireRecoverableAccount(ctx.authority.accountId, ctx.authority.sessionId);
      accountId = ctx.authority.accountId;
      session = ctx.authority.sessionId ?? '';
    }
    // Validate the EC point, not merely JWK field lengths.
    try {
      createPublicKey({ key: input.public_key, format: 'jwk' });
    } catch {
      throw new AppError('invalid_input');
    }
    const nonce = randomToken(),
      expires = new Date(ctx.now().getTime() + 300000);
    await ctx.db.query(
      `INSERT INTO capture_enrollment_challenges(account_id,session_id,installation_public_id,proof_hash,
        expires_at,platform,public_key_jwk) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        accountId,
        session,
        input.installation_public_id,
        hashToken(nonce),
        expires,
        input.platform,
        JSON.stringify(input.public_key),
      ],
    );
    return { nonce, expires_at: expires.toISOString() };
  }

  /** Secret-bearing enrollment consumes proofs, never caches bearer responses. */
  async enroll(raw: unknown) {
    const input = EnrollCaptureDeviceRequest.parse(raw),
      ctx = this.ctx,
      identity = this.identity();
    return ctx.db.transaction(async (tx) => {
      const session = input.enrollment_grant
        ? `grant:${hashToken(input.enrollment_grant)}`
        : (ctx.authority.sessionId ?? '');
      const { rows } = await tx.query(
        `SELECT * FROM capture_enrollment_challenges WHERE proof_hash=$1 AND installation_public_id=$2
         AND platform=$3 AND session_id=$4 AND consumed_at IS NULL AND expires_at>$5 FOR UPDATE`,
        [
          hashToken(input.proof.nonce),
          input.installation_public_id,
          input.platform,
          session,
          ctx.now(),
        ],
      );
      const challenge = rows[0];
      if (
        !challenge ||
        hashRequest(challenge.public_key_jwk) !== hashRequest(input.proof.public_key)
      )
        throw new AppError('unauthenticated');
      let valid = false;
      try {
        valid = verify(
          'sha256',
          Buffer.from(
            enrollmentSignaturePayload(
              input.proof.nonce,
              input.installation_public_id,
              input.platform,
              input.enrollment_grant,
            ),
          ),
          {
            key: createPublicKey({ key: input.proof.public_key, format: 'jwk' }),
            dsaEncoding: 'ieee-p1363',
          },
          Buffer.from(input.proof.signature, 'base64url'),
        );
      } catch {
        /* Safe proof failure. */
      }
      if (!valid) throw new AppError('unauthenticated');
      let accountId: string,
        authenticatedAt = ctx.now();
      if (input.enrollment_grant) {
        const grant = await identity.consumeNativeEnrollmentGrant(
          tx,
          input.enrollment_grant,
          input.platform,
          ctx.now(),
        );
        accountId = grant.accountId;
        authenticatedAt = grant.authenticatedAt;
      } else {
        if (ctx.authority.kind !== 'account' || challenge.account_id !== ctx.authority.accountId)
          throw new AppError('scope_denied');
        await identity.requireRecoverableAccount(ctx.authority.accountId, ctx.authority.sessionId);
        accountId = ctx.authority.accountId;
      }
      await tx.query(`SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, [accountId]);
      const existing = await tx.query(
        `SELECT id,public_key_jwk,platform,revoked_at FROM mobile_installations
         WHERE account_id=$1 AND installation_public_id=$2 FOR UPDATE`,
        [accountId, input.installation_public_id],
      );
      if (existing.rows[0]) {
        const prior = existing.rows[0];
        if (prior.revoked_at)
          throw new AppError('token_revoked', {
            message: 'This phone was removed. Enroll a new installation.',
          });
        if (
          prior.platform !== input.platform ||
          hashRequest(prior.public_key_jwk) !== hashRequest(input.proof.public_key)
        ) {
          throw new AppError('conflict', {
            message: 'The installation key changed. Enroll with a new public installation ID.',
          });
        }
      }
      // A public id may be reused by a different account, but has no authority to old records.
      const result = await tx.query(
        `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version,capabilities,public_key_jwk)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(account_id,installation_public_id) DO UPDATE SET
          app_version=excluded.app_version,capabilities=excluded.capabilities,public_key_jwk=excluded.public_key_jwk,
          authority_ended_at=NULL,revision=mobile_installations.revision+1,last_seen_at=$7
         RETURNING *`,
        [
          accountId,
          input.installation_public_id,
          input.platform,
          input.app_version,
          JSON.stringify(input.capabilities),
          JSON.stringify(input.proof.public_key),
          ctx.now(),
        ],
      );
      const installation = result.rows[0]!;
      const nativeSession = await identity.issueNativeSession(
        tx,
        { accountId, installationId: installation.id, authenticatedAt },
        ctx.now(),
      );
      if (typeof nativeSession.session_id !== 'string') throw new AppError('service_unavailable');
      // Only the same key/account installation can unlock its paused bytes.
      await tx.query(
        `UPDATE upload_sessions u SET state=CASE WHEN u.paused_from_state='created' THEN 'created' ELSE 'uploading' END,
          authority_ended_at=NULL,pause_reason=NULL,paused_from_state=NULL,error_code=NULL,authority_session_id=$3
         FROM media_assets m WHERE u.account_id=$1 AND u.installation_id=$2
           AND u.authority_ended_at IS NOT NULL AND u.state='paused'
           AND u.expires_at>$4 AND m.account_id=u.account_id AND m.id=u.asset_id AND m.deleted_at IS NULL`,
        [accountId, installation.id, nativeSession.session_id, ctx.now()],
      );
      await tx.query(`UPDATE capture_enrollment_challenges SET consumed_at=$2 WHERE id=$1`, [
        challenge.id,
        ctx.now(),
      ]);
      return { installation: deviceProjection(installation), native_session: nativeSession };
    });
  }
  async list(cursor?: string, limit = 30) {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    if (limit < 1 || limit > 100) throw new AppError('invalid_input');
    if (cursor && !/^[a-f0-9-]{36}$/i.test(cursor)) throw new AppError('invalid_input');
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM mobile_installations WHERE account_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
      [this.ctx.authority.accountId, cursor ?? null, limit + 1],
    );
    const selected = rows.slice(0, limit);
    return {
      items: selected.map(deviceProjection),
      next_cursor: rows.length > limit ? selected.at(-1)!.id : null,
    };
  }
  async safeSetup() {
    await assertCaptureAuthority(this.ctx, this.ctx.db);
    const { rows } = await this.ctx.db.query(
      `SELECT * FROM mobile_installations WHERE account_id=$1 AND revoked_at IS NULL ORDER BY created_at`,
      [this.ctx.authority.accountId],
    );
    return rows.map((r, index) => {
      const stale = this.ctx.now().getTime() - r.last_seen_at.getTime() > 30000;
      return {
        alias: `${r.platform === 'ios' ? 'iOS' : 'Android'} phone ${index + 1}`,
        app_version: r.app_version,
        last_seen_at: r.last_seen_at.toISOString(),
        stale,
        capabilities: r.capabilities,
        unavailable_reasons: [
          ...(stale ? ['device_stale'] : []),
          ...(r.readiness !== 'ready' ? [r.readiness] : []),
          ...(r.app_state !== 'foreground' ? ['foreground_required'] : []),
        ],
      };
    });
  }
  async revoke(id: string, raw: unknown, key: string) {
    const input = RevokeCaptureDeviceRequest.parse(raw);
    if (this.ctx.authority.kind !== 'account') throw new AppError('scope_denied');
    return captureMutation(this.ctx, `revoke-device:${id}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM mobile_installations WHERE account_id=$1 AND id=$2 FOR UPDATE`,
        [this.ctx.authority.accountId, id],
      );
      const device = rows[0];
      if (!device) throw new AppError('not_found');
      if (!device.revoked_at) {
        if (device.revision !== input.expected_revision) throw new AppError('conflict');
        await tx.query(
          `UPDATE mobile_installations SET revoked_at=$3,revision=revision+1 WHERE account_id=$1 AND id=$2`,
          [device.account_id, id, this.ctx.now()],
        );
        await this.identity().revokeInstallationSessions(tx, device.account_id, id, this.ctx.now());
        await endCaptureAuthority(tx, {
          accountId: device.account_id,
          installationId: id,
          sessionId: null,
          reason: 'device_revoked',
          now: this.ctx.now(),
        });
      }
      return { id, revoked: true };
    });
  }
  private installationId(): string {
    if (this.ctx.authority.kind !== 'installation')
      throw new AppError('scope_denied', {
        message: 'This action requires the local enrolled phone.',
      });
    return this.ctx.authority.installationId;
  }
  async status(raw: unknown, key: string) {
    const input = DeviceStatusRequest.parse(raw),
      id = this.installationId();
    return captureMutation(this.ctx, 'device-status', key, input, async (tx) => {
      // Heartbeats merge capability keys: a heartbeat that omits a key enrolled
      // earlier (e.g. meta_glasses_sdk) must not erase it; send false to clear.
      const changed = await tx.query(
        `UPDATE mobile_installations SET capabilities=COALESCE(capabilities,'{}'::jsonb)||$3::jsonb,readiness=$4,app_state=$5,status_sequence=$6,last_seen_at=$7
         WHERE account_id=$1 AND id=$2 AND status_sequence<$6`,
        [
          this.ctx.authority.accountId,
          id,
          JSON.stringify(input.capabilities),
          input.readiness,
          input.app_state,
          input.sequence,
          this.ctx.now(),
        ],
      );
      const { rows } = await tx.query(
        `SELECT status_sequence FROM mobile_installations WHERE account_id=$1 AND id=$2`,
        [this.ctx.authority.accountId, id],
      );
      if (changed.rowCount)
        await tx.query(
          `INSERT INTO device_events(account_id,installation_id,sequence,event_type,safe_payload)
       VALUES($1,$2,$3,'status',$4) ON CONFLICT DO NOTHING`,
          [
            this.ctx.authority.accountId,
            id,
            input.sequence,
            JSON.stringify({ readiness: input.readiness, app_state: input.app_state }),
          ],
        );
      // Explicit lifecycle loss disarms immediately; reconnect cannot re-arm.
      if (changed.rowCount && (input.app_state !== 'foreground' || input.readiness !== 'ready')) {
        await tx.query(
          `UPDATE capture_sessions SET remote_arm_expires_at=NULL,allowed_agent_connection_ids='{}'
          WHERE account_id=$1 AND installation_id=$2`,
          [this.ctx.authority.accountId, id],
        );
      }
      return { accepted_sequence: rows[0]!.status_sequence };
    });
  }
  async wearable(raw: unknown, key: string) {
    const input = CreateWearableRequest.parse(raw),
      id = this.installationId();
    return captureMutation(this.ctx, 'create-wearable', key, input, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO wearable_connections(account_id,installation_id,sdk_reference_hash,display_name,capabilities,permission_state)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          this.ctx.authority.accountId,
          id,
          createHash('sha256').update(input.sdk_reference).digest('hex'),
          input.display_name,
          JSON.stringify(input.capabilities),
          input.permission_state,
        ],
      );
      return { connection_id: rows[0]!.id };
    });
  }
  async unlinkWearable(id: string, key: string) {
    const installation = this.installationId();
    return captureMutation(this.ctx, `unlink-wearable:${id}`, key, {}, async (tx) => {
      const r = await tx.query(
        `UPDATE wearable_connections SET disconnected_at=$4 WHERE account_id=$1 AND installation_id=$2 AND id=$3 RETURNING id`,
        [this.ctx.authority.accountId, installation, id, this.ctx.now()],
      );
      if (!r.rowCount) throw new AppError('not_found');
      await tx.query(
        `UPDATE capture_sessions SET state='ended',stopped_at=$4,remote_arm_expires_at=NULL,allowed_agent_connection_ids='{}',generation=generation+1
         WHERE account_id=$1 AND installation_id=$2 AND wearable_connection_id=$3 AND state='active'`,
        [this.ctx.authority.accountId, installation, id, this.ctx.now()],
      );
      return { unlinked: true };
    });
  }
  private sessionProjection(r: Record<string, unknown>) {
    return {
      session_id: r.id,
      generation: r.generation,
      state: r.state,
      remote_arm_expires_at: r.remote_arm_expires_at
        ? (r.remote_arm_expires_at as Date).toISOString()
        : null,
    };
  }
  async createSession(raw: unknown, key: string) {
    const input = CreateCaptureSessionRequest.parse(raw),
      id = this.installationId();
    return captureMutation(this.ctx, 'create-session', key, input, async (tx) => {
      if (input.source === 'meta_glasses') {
        if (!this.ctx.glassesEnabled)
          throw new AppError('scope_denied', {
            message: 'Experimental glasses capture is unavailable.',
          });
        const w = await tx.query(
          `SELECT id FROM wearable_connections WHERE account_id=$1 AND installation_id=$2 AND id=$3 AND disconnected_at IS NULL AND permission_state='granted'`,
          [this.ctx.authority.accountId, id, input.connection_id ?? null],
        );
        if (!w.rowCount) throw new AppError('not_found');
      } else if (input.connection_id) throw new AppError('invalid_input');
      if (input.local_session_id) {
        const existing = await tx.query(
          `SELECT * FROM capture_sessions WHERE account_id=$1 AND installation_id=$2 AND local_session_id=$3`,
          [this.ctx.authority.accountId, id, input.local_session_id],
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].source !== input.source ||
            existing.rows[0].media_mode !== input.mode
          )
            throw new AppError('idempotency_conflict');
          return this.sessionProjection(existing.rows[0]);
        }
      }
      const { rows } = await tx.query(
        `INSERT INTO capture_sessions(account_id,installation_id,wearable_connection_id,source,media_mode,local_session_id)
         VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          this.ctx.authority.accountId,
          id,
          input.connection_id ?? null,
          input.source,
          input.mode,
          input.local_session_id ?? null,
        ],
      );
      return this.sessionProjection(rows[0]!);
    });
  }
  async arm(id: string, raw: unknown, key: string) {
    const input = ArmCaptureSessionRequest.parse(raw),
      installation = this.installationId();
    return captureMutation(this.ctx, `arm:${id}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `SELECT s.*,i.last_seen_at,i.readiness,i.app_state FROM capture_sessions s JOIN mobile_installations i
         ON i.account_id=s.account_id AND i.id=s.installation_id
         WHERE s.account_id=$1 AND s.installation_id=$2 AND s.id=$3 AND s.state='active' FOR UPDATE OF s`,
        [this.ctx.authority.accountId, installation, id],
      );
      const session = rows[0];
      if (!session) throw new AppError('not_found');
      if (
        input.enabled &&
        (session.readiness !== 'ready' ||
          session.app_state !== 'foreground' ||
          this.ctx.now().getTime() - session.last_seen_at.getTime() > 30000)
      )
        throw new AppError('conflict', {
          message: 'Open the ready camera on your phone before arming.',
        });
      if (input.allowed_agent_connection_ids.length) {
        const agents = await tx.query(
          `SELECT id FROM agent_connections WHERE owner_account_id=$1 AND id=ANY($2::uuid[]) AND purpose='agent' AND revoked_at IS NULL AND expires_at>$3`,
          [this.ctx.authority.accountId, input.allowed_agent_connection_ids, this.ctx.now()],
        );
        if (agents.rowCount !== new Set(input.allowed_agent_connection_ids).size)
          throw new AppError('not_found');
      }
      const expiry = input.enabled
        ? new Date(this.ctx.now().getTime() + input.duration_seconds * 1000)
        : null;
      const updated = await tx.query(
        `UPDATE capture_sessions SET remote_arm_expires_at=$4,allowed_agent_connection_ids=$5
        WHERE account_id=$1 AND installation_id=$2 AND id=$3 RETURNING *`,
        [
          this.ctx.authority.accountId,
          installation,
          id,
          expiry,
          input.enabled ? input.allowed_agent_connection_ids : [],
        ],
      );
      return this.sessionProjection(updated.rows[0]!);
    });
  }
  async endSession(id: string, raw: unknown, key: string) {
    const input = EndCaptureSessionRequest.parse(raw),
      installation = this.installationId();
    return captureMutation(this.ctx, `end:${id}`, key, input, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE capture_sessions SET state='ended',stopped_at=COALESCE(stopped_at,$4),
       remote_arm_expires_at=NULL,allowed_agent_connection_ids='{}',generation=generation+CASE WHEN state='active' THEN 1 ELSE 0 END
       WHERE account_id=$1 AND installation_id=$2 AND id=$3 RETURNING *`,
        [this.ctx.authority.accountId, installation, id, this.ctx.now()],
      );
      if (!rows[0]) throw new AppError('not_found');
      return this.sessionProjection(rows[0]);
    });
  }
}

/** Install as identity's synchronous lifecycle hook before enabling enrollment. */
export async function endCaptureAuthority(tx: Db, event: AuthorityEnded): Promise<void> {
  await tx.query(`SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, [event.accountId]);
  await tx.query(
    `UPDATE mobile_installations SET authority_ended_at=$3,readiness='unavailable',app_state='terminated',
       push_provider=NULL,push_environment=NULL,push_token_ciphertext=NULL,push_token_key_id=NULL,push_updated_at=NULL
     WHERE account_id=$1 AND ($2::uuid IS NULL OR id=$2)`,
    [event.accountId, event.installationId, event.now],
  );
  await tx.query(
    `UPDATE capture_sessions SET state='ended',stopped_at=$3,remote_arm_expires_at=NULL,
      allowed_agent_connection_ids='{}',generation=generation+1
     WHERE account_id=$1 AND ($2::uuid IS NULL OR installation_id=$2) AND state='active'`,
    [event.accountId, event.installationId, event.now],
  );
  const { rows } = await tx.query(
    `UPDATE upload_sessions u SET
      state=CASE WHEN i.revoked_at IS NOT NULL THEN 'aborted' ELSE 'paused' END,
      paused_from_state=u.state,pause_reason=CASE WHEN i.revoked_at IS NOT NULL THEN NULL ELSE 'authority_ended' END,
      authority_ended_at=$4
     FROM (SELECT $1::uuid AS account_id) a
     LEFT JOIN mobile_installations i ON i.account_id=a.account_id AND ($2::uuid IS NOT NULL AND i.id=$2)
     WHERE u.account_id=a.account_id AND ($2::uuid IS NULL OR u.installation_id=$2)
       AND ($2::uuid IS NULL OR $3::text IS NULL OR u.authority_session_id=$3) AND u.state IN ('created','uploading','verifying','paused')
       AND (u.authority_ended_at IS NULL OR i.revoked_at IS NOT NULL)
     RETURNING u.id,u.asset_id,u.state`,
    [event.accountId, event.installationId, event.sessionId, event.now],
  );
  const queue = new CaptureQueue(tx, () => event.now);
  for (const upload of rows) {
    const updated = await tx.query(
      `UPDATE media_assets SET status=$4,deleted_at=CASE WHEN $4='deleted' THEN $3::timestamptz ELSE NULL END,
         generation=generation+1,revision=revision+1
       WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING generation`,
      [
        event.accountId,
        upload.asset_id,
        event.now,
        upload.state === 'aborted' ? 'deleted' : 'pending_upload',
      ],
    );
    await tx.query(
      `UPDATE capture_work SET state='cancelled' WHERE account_id=$1 AND asset_id=$2 AND state IN ('queued','running')`,
      [event.accountId, upload.asset_id],
    );
    if (updated.rows[0] && upload.state === 'aborted')
      await queue.enqueue(tx, {
        accountId: event.accountId,
        assetId: upload.asset_id,
        uploadId: upload.id,
        generation: updated.rows[0].generation,
        kind: 'purge_media',
      });
  }
}
