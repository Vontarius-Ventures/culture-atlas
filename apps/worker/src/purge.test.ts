import { afterAll, describe, expect, it } from 'vitest';
import { captures, enqueueJob, getJobById } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, testConfig } from '@culture-atlas/domain/testing';
import { accountCtx, anonCtx, runJobs, testJpeg, world } from './test-world';
import { purgeDedupeKey } from './worker';

const db = getTestDb();
afterAll(closeTestDb);

describe('purge_deleted job', () => {
  it('physically purges deleted captures, expired anonymous sessions and expired uploads with their media', async () => {
    const { providers } = world();
    // A deleted account capture past purge_after.
    const owner = await accountCtx(providers);
    const del = await captures.createCapture(owner, { kind: 'multipart', image: { bytes: await testJpeg() }, fields: { source: 'upload', focus: undefined } });
    await captures.deleteCapture(owner, { id: del.capture_id });
    await db.query(`UPDATE captures SET purge_after = now() - interval '1 minute' WHERE id = $1`, [del.capture_id]);

    // An expired anonymous session with a capture and an upload.
    const anon = await anonCtx(providers);
    const sessionId = (anon.principal as { sessionId: string }).sessionId;
    const anonCap = await captures.createCapture(anon, { kind: 'multipart', image: { bytes: await testJpeg() }, fields: { source: 'upload', focus: undefined } });
    const anonKey = (await db.query<{ private_object_key: string }>('SELECT private_object_key FROM captures WHERE id = $1', [anonCap.capture_id])).rows[0]!.private_object_key;
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [sessionId]);

    // An expired upload of a live account.
    const up = await captures.createUpload(owner, { bytes: await testJpeg() });
    const upKey = (await db.query<{ object_key: string }>('SELECT object_key FROM uploads WHERE id = $1', [up.upload_id])).rows[0]!.object_key;
    await db.query(`UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE id = $1`, [up.upload_id]);

    // A live capture of the same account must survive.
    const live = await captures.createCapture(owner, { kind: 'multipart', image: { bytes: await testJpeg() }, fields: { source: 'upload', focus: undefined } });

    const { job } = await enqueueJob(db, { type: 'purge_deleted', owner: null, payload: {} });
    await runJobs({ ...owner, config: testConfig() }, [job.id]);
    expect((await getJobById(db, job.id))?.state).toBe('complete');

    expect((await db.query('SELECT 1 FROM captures WHERE id = $1', [del.capture_id])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM sessions WHERE id = $1', [sessionId])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM captures WHERE id = $1', [anonCap.capture_id])).rows).toHaveLength(0);
    expect(await providers.storage.get(anonKey)).toBeNull();
    expect((await db.query('SELECT 1 FROM uploads WHERE id = $1', [up.upload_id])).rows).toHaveLength(0);
    expect(await providers.storage.get(upKey)).toBeNull();
    expect((await captures.getCapture(owner, { id: live.capture_id })).id).toBe(live.capture_id);
  });

  it('uses an hourly dedupe key so concurrent workers schedule one purge', () => {
    expect(purgeDedupeKey(new Date('2026-10-13T05:59:00Z'))).toBe(purgeDedupeKey(new Date('2026-10-13T05:01:00Z')));
    expect(purgeDedupeKey(new Date('2026-10-13T06:00:00Z'))).not.toBe(purgeDedupeKey(new Date('2026-10-13T05:59:59Z')));
  });
});
