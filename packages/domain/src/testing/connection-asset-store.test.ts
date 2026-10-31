import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { profile as baseProfile, response } from '../../../providers/src/concentrate/test-fixtures';
import type { ModelProfile } from '../../../providers/src/concentrate/profiles';
import * as images from '../../../providers/src/connection-asset/image';
import { ConcentrateConnectionAsset } from '../../../providers/src/connection-asset/provider';
import {
  CONNECTION_ASSET_CHECKER_VERSION, CONNECTION_ASSET_PROMPT_VERSION, CONNECTION_ASSET_SCHEMA_VERSION,
  type ConnectionAssetEvidence,
} from '../../../providers/src/connection-asset/schema';
import {
  allocateConnectionAssetSlot, assertConnectionAssetCheckActive, finishConnectionAssetSlot,
} from '../../../providers/src/connection-asset/store';
import type { ConnectionAssetCheckContext } from '../../../providers/src/connection-asset/types';
import { ModelSpendLedger } from '../../../providers/src/model-gateway/budget';
import { PostgresSpendStore } from '../../../providers/src/model-gateway/postgres';
import { StructuredResponseRunner } from '../../../providers/src/model-gateway/runner';
import type { StructuredTransport } from '../../../providers/src/model-gateway/types';
import { createDb } from '../db/pool';
import { closeTestDb, getTestDb, insertAccount } from './index';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db';

/**
 * Real PostgreSQL store/ledger integration; all pixels and verdicts are SYNTHETIC.
 * Not an identity-quality evaluation, qualification artifact, or public projection test.
 * Run through root Vitest/global setup with explicit TEST_DATABASE_URL.
 */
const profile: ModelProfile = {
  ...baseProfile, role: 'vision_connection_asset', version: 'SYNTHETIC-NOT-QUALIFIED',
  promptVersion: CONNECTION_ASSET_PROMPT_VERSION, schemaVersion: CONNECTION_ASSET_SCHEMA_VERSION,
  timeoutMs: 5000, maxOutputTokens: 400,
  image: { maxCount: 1, maxDimension: 512, maxPixels: 262144, maxBytes: 200000 },
};
const metadata = { candidateId: 'synthetic:candidate', name: 'SYNTHETIC public name', actualType: 'brand' };
const url = 'https://images.qloo.com/i/synthetic-fixture.png';
const binding = images.connectionAssetSha256('SYNTHETIC request binding');
const storedReading = { rev: 1, observations: ['SYNTHETIC_PRIVATE_READING_ONLY'] };
const readingSnapshot = JSON.stringify(storedReading);
const wire = {
  identity: 'corroborated', image: 'available',
  identityRule: 'full_visible_name_type', imageRule: 'image_content',
};
let isolated: IsolatedDatabase;
let original: Buffer;
const png = (color: string) =>
  sharp({ create: { width: 20, height: 12, channels: 3, background: color } }).png().toBuffer();

beforeAll(async () => {
  // Prove root global setup supplied a generated DB; never use an ambient app DB.
  const providedName = new URL(inject('databaseUrl')).pathname.slice(1);
  expect(providedName).toMatch(/^ca_test_\d+_[a-f0-9]+$/);
  expect((await getTestDb().query('SELECT current_database() AS name')).rows[0]?.name).toBe(providedName);
  // Fetch/spend control rows are GLOBAL: use the existing private-DB helper, not
  // resets/TRUNCATE in the shared global-setup database.
  isolated = await createIsolatedDatabase('assetstore');
  original = await png('#aa4411');
}, 120_000);
afterAll(async () => { await closeTestDb(); await isolated?.drop(); }, 60_000);
beforeEach(async () => {
  // Only our private generated database. No live/global application control changes.
  await isolated.db.query('UPDATE connection_asset_fetch_control SET stop_status=NULL,last_started_at=NULL WHERE id=1');
  vi.spyOn(images, 'fetchPublicConnectionImage').mockResolvedValue({ bytes: original, status: 200 });
});
afterEach(() => { vi.restoreAllMocks(); });

async function fixture(accountId?: string): Promise<ConnectionAssetCheckContext> {
  accountId ??= (await insertAccount(isolated.db)).accountId;
  const captureId = randomUUID(), analysisId = randomUUID(), jobId = randomUUID();
  await isolated.db.query(
    `INSERT INTO captures(id,owner_account_id,source,image_sha256) VALUES($1,$2,'upload',$3)`,
    [captureId, accountId, images.connectionAssetSha256('SYNTHETIC source marker, not source pixels')],
  );
  await isolated.db.query(
    `INSERT INTO jobs(id,owner_account_id,type,state,lease_owner,lease_expiry,payload)
     VALUES($1,$2,'analyze_capture','running','asset-test-worker',now()+interval '1 hour',$3::jsonb)`,
    [jobId, accountId, JSON.stringify({ capture_id: captureId })],
  );
  await isolated.db.query(
    `INSERT INTO analyses(id,capture_id,version,compiler_version,job_id,style_reading)
     VALUES($1,$2,1,'SYNTHETIC-NOT-QUALIFIED',$3,$4::jsonb)`,
    [analysisId, captureId, jobId, readingSnapshot],
  );
  await isolated.db.query('UPDATE captures SET active_analysis_id=$2 WHERE id=$1', [captureId, analysisId]);
  return {
    db: isolated.db, captureId, analysisId, accountId, jobId, workerId: 'asset-test-worker',
    signal: new AbortController().signal, ensureActive: vi.fn(async () => {}),
    readingSnapshot,
  };
}
function evidence(candidateId = metadata.candidateId, imageUrl = url): ConnectionAssetEvidence {
  return {
    version: 'connection_asset_evidence_v1', candidateId, imageUrl,
    originalSha256: images.connectionAssetSha256(original), modelInputSha256: 'b'.repeat(64),
    identity: 'corroborated', image: 'available', checkerVersion: CONNECTION_ASSET_CHECKER_VERSION,
  };
}
async function slots(context: ConnectionAssetCheckContext) {
  return (await isolated.db.query(
    'SELECT * FROM connection_asset_checks WHERE capture_id=$1 ORDER BY slot', [context.captureId],
  )).rows;
}
function provider(p = profile, verdict: unknown = wire, max = 3) {
  const send = vi.fn<StructuredTransport>(async () => ({ ...response, text: JSON.stringify(verdict) }));
  const ledger = new ModelSpendLedger(new PostgresSpendStore(isolated.db), {
    dailyMicros: 1_000_000, accountDailyMicros: 100_000, maxUnknownMicros: 1_000_000, accountDailyAnalyses: 100,
  });
  const runner = new StructuredResponseRunner(p, send, ledger, { qualification: 'catalog-compatible' });
  return { send, ledger, runner, client: new ConcentrateConnectionAsset(runner, max) };
}
async function check(context: ConnectionAssetCheckContext, p = provider()) {
  return p.client.checkConnectionAsset(metadata, url, context);
}

describe('connection asset PostgreSQL allocations (synthetic, not qualification)', () => {
  it('serializes concurrent capture reservations across independent pool objects: exactly three, fourth refused', async () => {
    const context = await fixture();
    const reopened = createDb(isolated.url, 2);
    try {
      const results = await Promise.allSettled(Array.from({ length: 9 }, (_, i) =>
        allocateConnectionAssetSlot({ ...context, db: i % 2 ? reopened : isolated.db }, `candidate-${i}`, url, binding, 3)));
      // No swallowed database/deadlock errors masquerading as quota refusal.
      expect(results.every(r => r.status === 'fulfilled')).toBe(true);
      const successes = results.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
      expect(successes).toHaveLength(3);
      expect(successes.map(r => r.slot.slot).sort()).toEqual([1, 2, 3]);
      expect((await slots(context)).map(r => r.state)).toEqual(['allocated', 'allocated', 'allocated']);
      expect(await allocateConnectionAssetSlot(context, 'fourth', url, binding, 3)).toBeNull();
    } finally { await reopened.end(); }
  });

  it('burns failures/crashes, appends after restart, reuses only completed exact bindings, never refills on reanalysis/deletion', async () => {
    const context = await fixture();
    expect(await allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3)).toMatchObject({ fresh: true, slot: { slot: 1 } });
    expect(await finishConnectionAssetSlot(context, 1, binding, null)).toBe(true);
    const reopened = createDb(isolated.url, 2);
    const restarted = { ...context, db: reopened };
    try {
      expect(await allocateConnectionAssetSlot(restarted, metadata.candidateId, url, binding, 3)).toBeNull();
      expect(await allocateConnectionAssetSlot(restarted, 'crashed', url, binding, 3)).toMatchObject({ slot: { slot: 2 } });
      // A second object cannot replay an unfinished/crashed durable allocation.
      expect(await allocateConnectionAssetSlot(context, 'crashed', url, binding, 3)).toBeNull();
      expect(await allocateConnectionAssetSlot(restarted, 'completed', url, binding, 3)).toMatchObject({ slot: { slot: 3 } });
      expect(await finishConnectionAssetSlot(restarted, 3, binding, evidence('completed'))).toBe(true);
      expect(await allocateConnectionAssetSlot(context, 'completed', url, binding, 3)).toMatchObject({ fresh: false, slot: { slot: 3 } });
      expect(await allocateConnectionAssetSlot(context, 'completed', url, 'c'.repeat(64), 3)).toBeNull();
      expect(await allocateConnectionAssetSlot(restarted, 'fourth', url, binding, 3)).toBeNull();
      const nextAnalysis = randomUUID(), nextJob = randomUUID();
      await isolated.db.query(
        `INSERT INTO jobs(id,owner_account_id,type,state,lease_owner,lease_expiry,payload)
         SELECT $1,owner_account_id,type,state,lease_owner,lease_expiry,payload FROM jobs WHERE id=$2`,
        [nextJob, context.jobId],
      );
      await isolated.db.query(
        `INSERT INTO analyses(id,capture_id,version,compiler_version,job_id,style_reading)
         VALUES($1,$2,2,'SYNTHETIC',$3,$4::jsonb)`,
        [nextAnalysis, context.captureId, nextJob, readingSnapshot],
      );
      await isolated.db.query('UPDATE captures SET active_analysis_id=$2 WHERE id=$1', [context.captureId, nextAnalysis]);
      await isolated.db.query('DELETE FROM analyses WHERE id=$1', [context.analysisId]);
      await isolated.db.query('DELETE FROM jobs WHERE id=$1', [context.jobId]);
      const active = { ...restarted, analysisId: nextAnalysis, jobId: nextJob };
      await assertConnectionAssetCheckActive(isolated.db, active);
      expect(await allocateConnectionAssetSlot(active, 'after-reanalysis', url, binding, 3)).toBeNull();
      expect((await slots(context)).map(r => [r.slot, r.state, r.analysis_id, r.job_id])).toEqual([
        [1, 'failed', null, null], [2, 'allocated', null, null], [3, 'complete', null, null],
      ]);
    } finally { await reopened.end(); }
  });

  it.each([
    'capture', 'analysis', 'owner', 'job', 'worker', 'abort', 'deleted capture',
    'active analysis', 'job owner', 'job state', 'expired lease', 'cancel request', 'global CDN stop',
    'wrong reading revision', 'same revision changed observation',
  ])('fences both allocation and completion on %s, preserving the burned slot', async fence => {
    const context = await fixture();
    const other = await fixture(context.accountId);
    await allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3);
    const stale = { ...context };
    switch (fence) {
      case 'capture': stale.captureId = other.captureId; break;
      case 'analysis': stale.analysisId = other.analysisId; break;
      case 'owner': stale.accountId = (await insertAccount(isolated.db)).accountId; break;
      case 'job': stale.jobId = other.jobId; break; // Same owner, unrelated job must NOT pass.
      case 'worker': stale.workerId = 'wrong-worker'; break;
      case 'abort': stale.signal = AbortSignal.abort(); break;
      case 'deleted capture':
        await isolated.db.query('UPDATE captures SET deleted_at=now() WHERE id=$1', [context.captureId]); break;
      case 'active analysis':
        await isolated.db.query('UPDATE captures SET active_analysis_id=NULL WHERE id=$1', [context.captureId]); break;
      case 'job owner':
        await isolated.db.query('UPDATE jobs SET owner_account_id=$2 WHERE id=$1',
          [context.jobId, (await insertAccount(isolated.db)).accountId]); break;
      case 'job state':
        await isolated.db.query(`UPDATE jobs SET state='complete' WHERE id=$1`, [context.jobId]); break;
      case 'expired lease':
        await isolated.db.query(`UPDATE jobs SET lease_expiry=now()-interval '1 second' WHERE id=$1`, [context.jobId]); break;
      case 'cancel request':
        await isolated.db.query('UPDATE jobs SET cancel_requested_at=now() WHERE id=$1', [context.jobId]); break;
      case 'global CDN stop':
        await isolated.db.query('UPDATE connection_asset_fetch_control SET stop_status=429 WHERE id=1'); break;
      case 'wrong reading revision':
        await isolated.db.query('UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1',
          [context.analysisId, JSON.stringify({ ...storedReading, rev: 2 })]); break;
      case 'same revision changed observation':
        await isolated.db.query('UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1',
          [context.analysisId, JSON.stringify({ ...storedReading, observations: [] })]); break;
    }
    await expect(allocateConnectionAssetSlot(stale, 'must-not-append', url, binding, 3)).rejects.toThrow('Inactive asset check');
    await expect(finishConnectionAssetSlot(stale, 1, binding, evidence())).rejects.toThrow('Inactive asset check');
    expect(await slots(context)).toMatchObject([{ slot: 1, state: 'allocated', evidence: null }]);
  });

  it('does not publish a slot into another active analysis/job or overwrite an already completed slot', async () => {
    const context = await fixture();
    await allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3);
    expect(await finishConnectionAssetSlot(context, 1, 'f'.repeat(64), evidence())).toBe(false);
    const other = await fixture(context.accountId);
    // Even an otherwise ACTIVE foreign capture cannot complete this capture's row.
    expect(await finishConnectionAssetSlot(other, 1, binding, evidence())).toBe(false);
    expect(await finishConnectionAssetSlot(context, 1, binding, evidence())).toBe(true);
    expect(await finishConnectionAssetSlot(context, 1, binding, null)).toBe(false);
    expect(await slots(context)).toMatchObject([{ state: 'complete', evidence: evidence() }]);
  });

  it('requires the stored job/analysis binding even when a replacement context is otherwise active', async () => {
    const context = await fixture(), nextJob = randomUUID(), nextAnalysis = randomUUID();
    await allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3);
    await isolated.db.query(
      `INSERT INTO jobs(id,owner_account_id,type,state,lease_owner,lease_expiry,payload)
       VALUES($1,$2,'analyze_capture','running',$3,now()+interval '1 hour',$4::jsonb)`,
      [nextJob, context.accountId, context.workerId, JSON.stringify({ capture_id: context.captureId })],
    );
    await isolated.db.query('UPDATE analyses SET job_id=$2 WHERE id=$1', [context.analysisId, nextJob]);
    const newJobContext = { ...context, jobId: nextJob };
    await assertConnectionAssetCheckActive(isolated.db, newJobContext);
    expect(await finishConnectionAssetSlot(newJobContext, 1, binding, evidence())).toBe(false);
    await isolated.db.query(
      `INSERT INTO analyses(id,capture_id,version,compiler_version,job_id,style_reading)
       VALUES($1,$2,2,'SYNTHETIC',$3,$4::jsonb)`,
      [nextAnalysis, context.captureId, nextJob, readingSnapshot],
    );
    await isolated.db.query('UPDATE captures SET active_analysis_id=$2 WHERE id=$1', [context.captureId, nextAnalysis]);
    const newAnalysisContext = { ...newJobContext, analysisId: nextAnalysis };
    await assertConnectionAssetCheckActive(isolated.db, newAnalysisContext);
    expect(await finishConnectionAssetSlot(newAnalysisContext, 1, binding, evidence())).toBe(false);
    expect(await slots(context)).toMatchObject([{ state: 'allocated', evidence: null }]);
  });

  it('locks the guarded analysis row until the allocation/completion transaction ends', async () => {
    const context = await fixture();
    await isolated.db.transaction(async tx => {
      await assertConnectionAssetCheckActive(tx, context, true);
      await expect(isolated.db.transaction(async writer => {
        await writer.query(`SET LOCAL lock_timeout='100ms'`);
        await writer.query(
          'UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1',
          [context.analysisId, JSON.stringify({ ...storedReading, observations: [] })],
        );
      })).rejects.toMatchObject({ code: '55P03' });
    });
    await assertConnectionAssetCheckActive(isolated.db, context);
  });

  it.each(['candidateId', 'imageUrl', 'checkerVersion', 'missing hash', 'corroborated placeholder'])(
    'enforces persisted evidence constraints: %s', async mismatch => {
      const context = await fixture();
      await allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3);
      const bad: Record<string, unknown> = { ...evidence() };
      if (mismatch === 'missing hash') delete bad.originalSha256;
      else if (mismatch === 'corroborated placeholder') bad.image = 'placeholder';
      else bad[mismatch] = mismatch === 'imageUrl' ? 'https://images.qloo.com/i/other.png' : 'wrong';
      await expect(finishConnectionAssetSlot(context, 1, binding, bad as ConnectionAssetEvidence)).rejects.toThrow('check constraint');
      expect(await slots(context)).toMatchObject([{ state: 'allocated', evidence: null }]);
    },
  );
});

describe('real SQL cache/public provider boundary (synthetic transport, NO network/model qualification)', () => {
  it('restarts with new provider/runner/pool objects and exactly reuses candidate, URL, metadata/profile and both hashes', async () => {
    const context = await fixture(), first = provider();
    const result = await check(context, first);
    const prepared = await images.prepareConnectionAssetImage(original);
    expect(result).toEqual({ ...evidence(), modelInputSha256: prepared.modelInputSha256 });
    const reopened = createDb(isolated.url, 2);
    const second = provider();
    try {
      expect(await check({ ...context, db: reopened }, second)).toEqual(result);
      expect(first.send).toHaveBeenCalledTimes(1);
      expect(second.send).not.toHaveBeenCalled();
      expect(images.fetchPublicConnectionImage).toHaveBeenCalledTimes(2); // Re-GET, never trust URL immutability.
      expect(await slots(context)).toHaveLength(1);
      const attempts = await isolated.db.query(
        `SELECT role,attempt_key FROM inference_attempts WHERE account_id=$1`, [context.accountId],
      );
      expect(attempts.rows).toEqual([{
        role: 'vision_connection_asset', attempt_key: expect.stringContaining(`connection-asset:${context.captureId}:1:`),
      }]);
    } finally { await reopened.end(); }
  });

  it.each(['candidate', 'URL', 'metadata', 'profile', 'checker', 'original hash', 'model-input hash', 'changed URL bytes'])(
    'refuses a non-exact cache binding: %s (no second model dispatch)', async mismatch => {
      const context = await fixture(), p = provider(profile, wire, 1);
      expect(await check(context, p)).not.toBeNull();
      let candidate = metadata, imageUrl = url, client = p.client;
      switch (mismatch) {
        case 'candidate': candidate = { ...metadata, candidateId: 'other-candidate' }; break;
        case 'URL': imageUrl = 'https://images.qloo.com/i/other.png'; break;
        case 'metadata': candidate = { ...metadata, name: 'Different public name' }; break;
        case 'profile': client = provider({ ...profile, version: 'SYNTHETIC-CHANGED-PROFILE' }, wire, 1).client; break;
        case 'checker':
          await isolated.db.query(
            `UPDATE connection_asset_checks SET checker_version='older-checker',
             evidence=jsonb_set(evidence,'{checkerVersion}','"older-checker"'::jsonb) WHERE capture_id=$1`, [context.captureId],
          ); break;
        case 'original hash':
        case 'model-input hash':
          await isolated.db.query(
            `UPDATE connection_asset_checks SET evidence=jsonb_set(evidence,$2::text[],to_jsonb($3::text)) WHERE capture_id=$1`,
            [context.captureId, [mismatch === 'original hash' ? 'originalSha256' : 'modelInputSha256'], 'f'.repeat(64)],
          ); break;
        case 'changed URL bytes':
          vi.mocked(images.fetchPublicConnectionImage).mockResolvedValue({ bytes: await png('#0000ff'), status: 200 }); break;
      }
      expect(await client.checkConnectionAsset(candidate, imageUrl, context)).toBeNull();
      expect(p.send).toHaveBeenCalledTimes(1);
      expect(await slots(context)).toHaveLength(1);
      expect((await isolated.db.query('SELECT id FROM inference_attempts WHERE account_id=$1', [context.accountId])).rows).toHaveLength(1);
    },
  );

  it.each([
    { identity: 'unknown', image: 'available', identityRule: 'portrait_not_identity', imageRule: 'image_content' },
    { identity: 'contradicted', image: 'available', identityRule: 'conflicting_name_or_type', imageRule: 'image_content' },
    { identity: 'unknown', image: 'placeholder', identityRule: 'ambiguous_or_unreadable', imageRule: 'generic_placeholder' },
    { identity: 'unknown', image: 'unavailable', identityRule: 'ambiguous_or_unreadable', imageRule: 'missing_content' },
  ])('preserves synthetic $identity/$image as negative or unknown, including cached results', async verdict => {
    const context = await fixture(), p = provider(profile, verdict);
    const result = await check(context, p);
    expect(result).toMatchObject({ identity: verdict.identity, image: verdict.image });
    expect(result?.identity).not.toBe('corroborated');
    expect(await check(context, p)).toEqual(result);
    expect(await slots(context)).toMatchObject([{ state: 'complete', evidence: { identity: verdict.identity, image: verdict.image } }]);
    // "complete" means a completed check, NOT accepted identity or a useful recommendation.
    expect(p.send).toHaveBeenCalledTimes(1);
  });

  it('failed downloads burn all three slots across provider restart; a fourth and a retry never dispatch', async () => {
    const context = await fixture(), p = provider();
    vi.mocked(images.fetchPublicConnectionImage).mockResolvedValue({ bytes: null, status: 404 });
    for (let i = 0; i < 3; i++) {
      expect(await p.client.checkConnectionAsset({ ...metadata, candidateId: `failed-${i}` }, url, context)).toBeNull();
    }
    const restarted = provider();
    expect(await restarted.client.checkConnectionAsset({ ...metadata, candidateId: 'fourth' }, url, context)).toBeNull();
    expect(await restarted.client.checkConnectionAsset({ ...metadata, candidateId: 'failed-0' }, url, context)).toBeNull();
    expect((await slots(context)).map(r => r.state)).toEqual(['failed', 'failed', 'failed']);
    expect(images.fetchPublicConnectionImage).toHaveBeenCalledTimes(3);
    expect(p.send).not.toHaveBeenCalled();
    expect(restarted.send).not.toHaveBeenCalled();
  });

  it.each(['before check', 'after image fetch', 'after model response'])(
    'enforces the native exact-reading SQL fence %s with a no-op caller guard', async stage => {
      const context = await fixture(), p = provider();
      const changeReading = () => isolated.db.query(
        `UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1`,
        [context.analysisId, JSON.stringify({ ...storedReading, observations: [] })],
      );
      if (stage === 'before check') await changeReading();
      if (stage === 'after image fetch') vi.mocked(images.fetchPublicConnectionImage).mockImplementation(async () => {
        await changeReading();
        return { bytes: original, status: 200 };
      });
      if (stage === 'after model response') p.send.mockImplementation(async () => {
        await changeReading();
        return { ...response, text: JSON.stringify(wire) };
      });
      expect(await check(context, p)).toBeNull();
      expect(p.send).toHaveBeenCalledTimes(stage === 'after model response' ? 1 : 0);
      expect((await slots(context)).every(r => r.evidence === null)).toBe(true);
      if (stage === 'before check') expect(await slots(context)).toHaveLength(0);
      else expect(await slots(context)).toHaveLength(1); // The reservation is still burned.
  });

  it('enforces the snapshot inside transactions even though ensureActive is bypassed', async () => {
    const context = await fixture();
    await allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3);
    await isolated.db.query(
      `UPDATE analyses SET style_reading=$2::jsonb WHERE id=$1`,
      [context.analysisId, JSON.stringify({ ...storedReading, observations: [] })],
    );
    await expect(allocateConnectionAssetSlot(context, 'must-not-append', url, binding, 3)).rejects.toThrow('Inactive asset check');
    await expect(finishConnectionAssetSlot(context, 1, binding, evidence())).rejects.toThrow('Inactive asset check');
    expect(context.ensureActive).not.toHaveBeenCalled();
    expect(await slots(context)).toMatchObject([{ state: 'allocated', evidence: null }]);
  });

  it.each([
    undefined, null, '', '{', 'null', '[]', '{}', '{"rev":0}', '{"rev":-1}',
    '{"rev":1.5}', '{"rev":"1"}',
    JSON.stringify({ rev: 1, text: 'x'.repeat(256 * 1024) }),
    JSON.stringify({ rev: 1, text: 'é'.repeat(128 * 1024) }),
  ])('refuses malformed/missing/oversize snapshot case %# before allocation/GET/dispatch', async snapshot => {
    const context = { ...await fixture(), readingSnapshot: snapshot } as ConnectionAssetCheckContext;
    const p = provider();
    expect(await check(context, p)).toBeNull();
    await expect(allocateConnectionAssetSlot(context, metadata.candidateId, url, binding, 3)).rejects.toThrow('Invalid asset reading snapshot');
    expect(await slots(context)).toHaveLength(0);
    expect(images.fetchPublicConnectionImage).not.toHaveBeenCalled();
    expect(p.send).not.toHaveBeenCalled();
    expect(context.ensureActive).not.toHaveBeenCalled();
  });

  it('reuses source-independent cached evidence after a new active analysis/reading, but refuses the stale snapshot', async () => {
    const context = await fixture(), p = provider();
    const result = await check(context, p);
    expect(result).not.toBeNull();
    const initialBinding = (await slots(context))[0]!.request_binding;
    const nextSnapshot = JSON.stringify({ rev: 2, observations: ['DIFFERENT_PRIVATE_READING_ONLY'] });
    const nextAnalysis = randomUUID();
    await isolated.db.query(
      `INSERT INTO analyses(id,capture_id,version,compiler_version,job_id,style_reading)
       VALUES($1,$2,2,'SYNTHETIC',$3,$4::jsonb)`,
      [nextAnalysis, context.captureId, context.jobId, nextSnapshot],
    );
    await isolated.db.query('UPDATE captures SET active_analysis_id=$2 WHERE id=$1', [context.captureId, nextAnalysis]);
    const stale = { ...context, analysisId: nextAnalysis };
    expect(await check(stale, p)).toBeNull();
    expect(images.fetchPublicConnectionImage).toHaveBeenCalledTimes(1); // Stale snapshot refused before re-GET.
    const current = { ...stale, readingSnapshot: nextSnapshot };
    expect(await check(current, p)).toEqual(result);
    expect(images.fetchPublicConnectionImage).toHaveBeenCalledTimes(2);
    expect(p.send).toHaveBeenCalledTimes(1);
    expect(await slots(context)).toHaveLength(1);
    expect((await slots(context))[0]!.request_binding).toBe(initialBinding);
    expect(JSON.stringify(p.send.mock.calls)).not.toContain('PRIVATE_READING');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_READING');
    expect(JSON.stringify((await isolated.db.query(
      'SELECT * FROM inference_attempts WHERE account_id=$1', [context.accountId],
    )).rows)).not.toContain('PRIVATE_READING');
  });

  it('compares JSONB contents rather than serialization whitespace/key order', async () => {
    const context = await fixture();
    const reordered = { ...context, readingSnapshot: JSON.stringify({ observations: storedReading.observations, rev: 1 }, null, 2) };
    await assertConnectionAssetCheckActive(isolated.db, reordered);
    expect(await allocateConnectionAssetSlot(reordered, metadata.candidateId, url, binding, 3)).toMatchObject({ fresh: true });
  });
});
