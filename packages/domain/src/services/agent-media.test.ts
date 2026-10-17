import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import { createCaptureV2Context } from '../capture-v2/context';
import type { CaptureIdentityAdapter } from '../capture-v2/types';
import { createServiceContext } from '../context';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testProviders } from '../testing';
import { beginUpload } from './agent-media';

/**
 * Integration of the p5 agent upload façade with the p1 agent fence schema
 * (055): an agent-created asset must carry the creator AND the grant version
 * it was created under, or the pairing check rejects the write.
 */
const db = getTestDb();
const unused = async (): Promise<never> => {
  throw new Error('Not used by agent uploads');
};
// The owner is treated as recoverable; native enrollment is not exercised here.
const identity: CaptureIdentityAdapter = {
  requireRecoverableAccount: async () => {},
  peekNativeEnrollmentGrant: unused,
  consumeNativeEnrollmentGrant: unused,
  issueNativeSession: unused,
  revokeInstallationSessions: async () => {},
};
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-agent-media-'));
});
afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

describe('agent media upload on the merged schema', () => {
  it('records the creating connection with its live authorization version', async () => {
    const account = await insertAccount(db);
    const agent = await insertAgentConnection(account, { scopes: ['media:read', 'media:write'] }, db);
    await db.query('UPDATE agent_connections SET authorization_version=3 WHERE id=$1', [agent.principal.connectionId]);
    const storage = new LocalMultipartStorage(join(root, randomUUID()), 'http://127.0.0.1:3301', 'local-test-signing-key');
    const ctx = createServiceContext(agent.principal, {
      db,
      providers: testProviders(),
      captureV2: createCaptureV2Context({ db, authority: account, storage, identity }),
    });
    const bytes = Buffer.from('not really a png, never verified here');

    const upload = await beginUpload(
      ctx,
      {
        client_capture_id: randomUUID(),
        kind: 'photo',
        source: 'upload',
        filename: 'photo.png',
        byte_size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content_type: 'image/png',
      },
      randomUUID(),
    );

    const { rows } = await db.query<{ created_by_agent_connection_id: string; authorization_version: string }>(
      'SELECT created_by_agent_connection_id, authorization_version FROM media_assets WHERE id=$1',
      [upload.asset_id],
    );
    expect(rows[0]!.created_by_agent_connection_id).toBe(agent.principal.connectionId);
    expect(Number(rows[0]!.authorization_version)).toBe(3);
    const recorded = await db.query<{ authorization_version: number }>(
      'SELECT authorization_version FROM agent_media_uploads WHERE upload_id=$1',
      [upload.upload_id],
    );
    expect(recorded.rows[0]!.authorization_version).toBe(3);
  });
});
