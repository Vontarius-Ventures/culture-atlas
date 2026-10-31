import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/pool';
import { closeTestDb, getTestDb, insertAccount, testContext } from '../testing';
import { admitDiscovery } from '../style/discovery-evidence';
import { INTENT_COMPILER_VERSION } from '../style/intent-version';
import type { StyleMatch } from '../style/reasons';
import { storedSubject } from '../style/test-support';
import type { StoredStyleReading } from '../style/types';
import { createCapture, deleteCapture, getCapture } from './captures';

const db = getTestDb();
afterAll(closeTestDb);

// Synthetic mechanism fixtures only. No actual provider queries, image GETs,
// model verdicts, or identities are represented as independently verified.
async function fixture(version = INTENT_COMPILER_VERSION) {
  const account = await insertAccount();
  const ctx = testContext(account);
  const bytes = new Uint8Array(await sharp({ create: {
    width: 32, height: 32, channels: 3, background: '#506070',
  } }).jpeg().toBuffer());
  const capture = await createCapture(ctx, {
    kind: 'multipart', image: { bytes }, fields: { source: 'upload', focus: undefined },
  });
  const subject = storedSubject({
    label: 'Breton striped top',
    observations: [{ id: 'o1', kind: 'pattern', text: 'Horizontal navy and white stripes',
      certainty: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }],
  });
  const reading: StoredStyleReading = {
    schema: 'atlas_style_reading_v1', wording_version: 'synthetic-test',
    guard_version: 'synthetic-test', vocab_version: 'synthetic-test', rev: 10,
    model: { role: 'vision_style', profile: null, model: 'synthetic-test', experimental: false, ms: 0 },
    image: { width: 32, height: 32, frame_index: null }, swatches: [],
    summary: 'Unverified Breton provenance', subjects: [subject], dropped: [], held: [], retracted: [],
  };
  const analysisId = randomUUID();
  await db.query(`INSERT INTO analyses
    (id, capture_id, version, compiler_version, title, interpretation, style_reading, section_statuses)
    VALUES ($1, $2, 1, $3, 'Unverified Breton provenance', 'Unverified Breton provenance',
      $4::jsonb, '{"style":"ready","wear":"ready","more_like_this:s1":"ready"}'::jsonb)`,
  [analysisId, capture.capture_id, version, JSON.stringify(reading)]);
  await db.query('UPDATE captures SET active_analysis_id = $2 WHERE id = $1', [capture.capture_id, analysisId]);
  const candidateId = `synthetic-brand-${randomUUID()}`;
  const imageUrl = 'https://images.qloo.com/i/synthetic-mechanism-fixture.jpg';
  const proof = admitDiscovery([subject], {
    entity_id: candidateId, types: ['urn:entity:brand'],
    tags: [{ id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual' },
      { id: 'urn:tag:aesthetic_property:qloo:stripes', name: 'Striped patterns' }],
  }, 'urn:entity:brand', { readingRev: reading.rev, queryId: randomUUID() })!;
  expect(proof?.relation).toBe('shared_design');
  proof.assetEvidence = {
    version: 'connection_asset_evidence_v1', candidateId, imageUrl,
    originalSha256: 'a'.repeat(64), modelInputSha256: 'b'.repeat(64),
    identity: 'corroborated', image: 'available', checkerVersion: 'synthetic-test-v1',
  };
  const match: StyleMatch = {
    subject_id: subject.id, discovery_proof: proof, claims: [], palette: [],
    actual_candidate_types: ['urn:entity:brand'],
    via_entity: null, via: 'overlap', rail: 'more_like_this',
  };
  const { rows: items } = await db.query<{ id: string }>(`INSERT INTO discovery_items
    (owner_account_id, kind, category, canonical_key, title, display_metadata, external_ids)
    VALUES ($1, 'brand', 'wear', $2, 'Synthetic brand',
      $3::jsonb, $4::jsonb) RETURNING id`,
  [account.accountId, `qloo:${candidateId}`, JSON.stringify({ image: { url: imageUrl, alt: 'Synthetic fixture' } }),
    JSON.stringify({ qloo: candidateId })]);
  const itemId = items[0]!.id;
  async function insert(rank = 0, styleMatch: StyleMatch | null = match, origin = 'qloo') {
    const { rows } = await db.query<{ id: string }>(`INSERT INTO recommendations
      (analysis_id, discovery_item_id, category, rank, title, origin, provider_query_ids,
       display_reason, rail, subject_id, style_match, reading_rev)
      VALUES ($1, $2, 'wear', $3, 'Synthetic brand', $4, $5::uuid[],
       'A synthetic striped-design connection', 'more_like_this', 's1', $6::jsonb, 10) RETURNING id`,
    [analysisId, itemId, rank, origin, [proof.sourceQueryId], JSON.stringify(styleMatch)]);
    return rows[0]!.id;
  }
  return { ctx, accountId: account.accountId, jobId: capture.job_id, captureId: capture.capture_id, analysisId, itemId, reading, match, insert };
}

const shown = (view: Awaited<ReturnType<typeof getCapture>>) =>
  view.discovery_intents?.connections.rails.flatMap(rail => rail.cards) ?? [];

describe('v10 persisted proof projection, without a mocked validator', () => {
  it('publishes a real domain-admitted bound synthetic proof through getCapture', async () => {
    const f = await fixture();
    const recommendationId = await f.insert();
    const view = await getCapture(f.ctx, { id: f.captureId });
    expect(shown(view)).toHaveLength(1);
    expect(shown(view)[0]).toMatchObject({ id: f.itemId, recommendation_id: recommendationId, evidence_available: true });
    expect(view.analysis).toMatchObject({ title: 'Top', interpretation: 'Top' });
    expect(view.style_reading?.subjects[0]?.label).toBe('Top');
    expect(JSON.stringify(view)).not.toContain('Breton');
    expect(view.recommendations).toEqual([]); // More Like This never backfills the cross-domain wire.
  });

  it.each(['missing_asset', 'unknown_identity', 'wrong_revision', 'changed_image', 'changed_external_id', 'inactive_observation', 'creative_origin'] as const)(
    'withholds persisted %s and marks its empty ready rail empty', async (failure) => {
      const f = await fixture();
      if (failure === 'missing_asset') delete f.match.discovery_proof!.assetEvidence;
      if (failure === 'unknown_identity') f.match.discovery_proof!.assetEvidence!.identity = 'unknown';
      if (failure === 'wrong_revision') f.match.discovery_proof!.readingRev = 9;
      if (failure === 'changed_image') await db.query(`UPDATE discovery_items SET display_metadata =
        '{"image":{"url":"https://images.qloo.com/different-synthetic-fixture.jpg"}}'::jsonb WHERE id = $1`, [f.itemId]);
      if (failure === 'changed_external_id') await db.query(`UPDATE discovery_items SET external_ids = '{"qloo":"different"}'::jsonb WHERE id = $1`, [f.itemId]);
      if (failure === 'inactive_observation') {
        f.reading.subjects[0]!.observations = [];
        await db.query('UPDATE analyses SET style_reading = $2::jsonb WHERE id = $1', [f.analysisId, JSON.stringify(f.reading)]);
      }
      await f.insert(0, f.match, failure === 'creative_origin' ? 'vlm_creative' : 'qloo');
      const view = await getCapture(f.ctx, { id: f.captureId });
      expect(shown(view)).toEqual([]);
      expect(view.recommendations).toEqual([]);
      expect(view.rails?.find(r => r.subject_id === 's1')?.status).toBe('empty');
      expect(view.discovery_intents?.visual.status).toBe('unavailable');
    },
  );

  it('does not let an invalid first duplicate suppress a later valid persisted proof', async () => {
    const f = await fixture();
    await f.insert(0, null);
    const valid = await f.insert(1);
    const view = await getCapture(f.ctx, { id: f.captureId });
    expect(shown(view)).toHaveLength(1);
    expect(shown(view)[0]?.recommendation_id).toBe(valid);
  });

  it.each(['revision', 'same_revision_retraction', 'active_analysis', 'section'] as const)(
    'withholds a proof when %s changes during projection', async (change) => {
      const f = await fixture();
      await f.insert();
      let changed = false;
      const guardedDb: Db = {
        inTransaction: false, transaction: db.transaction.bind(db),
        async query(sql, params) {
          if (!changed && sql.includes('AS reading_matches')) {
            changed = true;
            if (change === 'active_analysis') await db.query('UPDATE captures SET active_analysis_id = NULL WHERE id = $1', [f.captureId]);
            else if (change === 'section') await db.query(`UPDATE analyses SET section_statuses = '{"style":"failed"}'::jsonb WHERE id = $1`, [f.analysisId]);
            else {
              if (change === 'revision') f.reading.rev++;
              else f.reading.subjects[0]!.observations = [];
              await db.query('UPDATE analyses SET style_reading = $2::jsonb WHERE id = $1', [f.analysisId, JSON.stringify(f.reading)]);
            }
          }
          return db.query(sql, params);
        },
      };
      const view = await getCapture({ ...f.ctx, db: guardedDb }, { id: f.captureId });
      expect(changed).toBe(true);
      expect(shown(view)).toEqual([]);
      expect(view.recommendations).toEqual([]);
      expect(view.style_reading).toBeNull();
      expect(view.analysis?.title).toBe('Exploring your photo');
    },
  );

  it('preserves the historical v9 envelope rather than retroactively qualifying it', async () => {
    const f = await fixture('compiler-2026-10-27-intent-quality-v9');
    await f.insert(0, null, 'vlm_creative');
    const view = await getCapture(f.ctx, { id: f.captureId });
    expect(view.analysis?.title).toBe('Unverified Breton provenance');
    expect(shown(view)).toHaveLength(1);
  });

  it('privacy deletion removes private asset checks without blocking analysis deletion', async () => {
    const f = await fixture();
    const asset = f.match.discovery_proof!.assetEvidence!;
    await db.query(`INSERT INTO connection_asset_checks
      (capture_id, slot, analysis_id, owner_account_id, job_id, candidate_id, image_url,
       checker_version, request_binding, state, evidence)
      VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, 'complete', $9::jsonb)`,
    [f.captureId, f.analysisId, f.accountId, f.jobId, asset.candidateId, asset.imageUrl,
      asset.checkerVersion, 'c'.repeat(64), JSON.stringify(asset)]);
    await deleteCapture(f.ctx, { id: f.captureId });
    expect((await db.query('SELECT 1 FROM connection_asset_checks WHERE capture_id = $1', [f.captureId])).rows).toEqual([]);
    expect((await db.query('SELECT 1 FROM analyses WHERE capture_id = $1', [f.captureId])).rows).toEqual([]);
  });
});
