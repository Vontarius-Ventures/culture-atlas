import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { AccountPrincipal, InstallationPrincipal } from '../principal';
import * as captures from '../services/captures';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testContext, testProviders } from '../testing';
import { isNativeOwnerOperation, nativeOwnerPrincipal } from './native-owner';

const db = getTestDb();
afterAll(closeTestDb);

const GET_CAPTURE = { method: 'GET' as const, path: '/v1/captures/{id}' };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'other';
  }
}

async function phoneOf(account: AccountPrincipal): Promise<InstallationPrincipal> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version)
     VALUES($1,$2,'android','1') RETURNING id`,
    [account.accountId, randomUUID()],
  );
  return {
    kind: 'installation',
    accountId: account.accountId,
    installationId: rows[0]!.id,
    sessionId: randomUUID(),
    expiresAt: new Date(Date.now() + 600_000),
  };
}

async function photo(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 12, g: 140, b: 90 } } })
      .jpeg()
      .toBuffer(),
  );
}

describe('native owner bridge: GET /v1/captures/{id}', () => {
  it('is bridged read-only; the other capture routes still refuse a phone', async () => {
    expect(isNativeOwnerOperation(GET_CAPTURE)).toBe(true);
    const owner = await insertAccount();
    const phone = await phoneOf(owner);
    for (const op of [
      { method: 'DELETE', path: '/v1/captures/{id}' },
      { method: 'POST', path: '/v1/captures/{id}/corrections' },
      { method: 'GET', path: '/v1/captures' },
    ] as const) {
      expect(isNativeOwnerOperation(op), `${op.method} ${op.path}`).toBe(false);
      expect(await code(nativeOwnerPrincipal(db, phone, op, owner.accountId))).toBe('scope_denied');
    }
  });

  it("lets the owner's phone read its own capture result, and only its own", async () => {
    const providers = testProviders();
    const owner = await insertAccount();
    const stranger = await insertAccount();
    const created = await captures.createCapture(testContext(owner, { providers }), {
      kind: 'multipart',
      image: { bytes: await photo() },
      fields: { source: 'upload', focus: undefined },
    });

    const asOwner = await nativeOwnerPrincipal(db, await phoneOf(owner), GET_CAPTURE, null);
    expect(asOwner).toEqual({ kind: 'account', accountId: owner.accountId, sessionId: null, isDemoOwner: false });
    const view = await captures.getCapture(testContext(asOwner, { providers }), { id: created.capture_id });
    expect(view).toMatchObject({ id: created.capture_id, source: 'upload', job_id: created.job_id });
    expect(Array.isArray(view.references) && Array.isArray(view.recommendations)).toBe(true);

    // Another account's phone gets not_found, never the other library's capture.
    const asStranger = await nativeOwnerPrincipal(db, await phoneOf(stranger), GET_CAPTURE, null);
    expect(await code(captures.getCapture(testContext(asStranger, { providers }), { id: created.capture_id }))).toBe(
      'not_found',
    );
    // A GET that names a different expected account is refused too.
    expect(await code(nativeOwnerPrincipal(db, await phoneOf(owner), GET_CAPTURE, stranger.accountId))).toBe(
      'account_mismatch',
    );
  });

  it('a principal without captures:read is denied (scope stays enforced by the service)', async () => {
    const owner = await insertAccount();
    const created = await captures.createCapture(testContext(owner), {
      kind: 'multipart',
      image: { bytes: await photo() },
      fields: { source: 'upload', focus: undefined },
    });
    const { principal } = await insertAgentConnection(owner, { scopes: ['taste:read'] });
    expect(await code(captures.getCapture(testContext(principal), { id: created.capture_id }))).toBe('scope_denied');
  });

  it('a revoked phone cannot read', async () => {
    const owner = await insertAccount();
    const phone = await phoneOf(owner);
    await db.query('UPDATE mobile_installations SET revoked_at = now() WHERE id = $1', [phone.installationId]);
    expect(await code(nativeOwnerPrincipal(db, phone, GET_CAPTURE, null))).toBe('token_revoked');
  });
});
