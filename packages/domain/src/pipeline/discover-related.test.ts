import { afterAll, describe, expect, it } from 'vitest';
import type { QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { closeTestDb, getTestDb, insertAccount, testProviders } from '../testing';
import { insertItem, runJob } from '../test-support/library';
import { enqueueJob } from '../jobs/queue';
import { buildSavedPool } from '../services/discovery';
import { sameAsOrigin } from './discover-related';

const db = getTestDb();
afterAll(closeTestDb);

const entity = (id: string, name: string, extra: Partial<QlooEntity> = {}): QlooEntity => ({
  entity_id: id,
  name,
  types: [],
  properties: {},
  tags: [],
  ...extra,
});
const photo = (id: string) => ({ image: { url: `https://images.invalid/${id}.jpg` } });

async function relatedJob(accountId: string, originItemId: string, source: 'item' | 'music_mode', label: string | null) {
  const dj = await db.query<{ id: string }>(
    `INSERT INTO discovery_jobs (owner_account_id, origin_item_id, source, source_label) VALUES ($1, $2, $3, $4) RETURNING id`,
    [accountId, originItemId, source, label],
  );
  const { job } = await enqueueJob(db, {
    type: 'discover_related',
    owner: { kind: 'account', accountId },
    payload: { discovery_job_id: dj.rows[0]!.id, origin_item_id: originItemId, taste_revision: 0 },
    dedupeKey: `test:${dj.rows[0]!.id}`,
    budget: { qloo_requests: 10, provider_retries: 0 },
    resultType: 'discovery_job',
    resultId: dj.rows[0]!.id,
  });
  return { discoveryJobId: dj.rows[0]!.id, jobId: job.id };
}

describe('related discovery', () => {
  it('drops results that are the origin under another name', () => {
    expect(sameAsOrigin("Mulatu's Bar", 'Mulatu Astatke')).toBe(true);
    expect(sameAsOrigin('Mulatu Astatke Jazz Village', 'Mulatu Astatke')).toBe(true);
    expect(sameAsOrigin("Babette's Feast", "Babette's Feast")).toBe(true);
    expect(sameAsOrigin('Muelle Nuevo Sasardi', 'Mulatu Astatke')).toBe(false);
    expect(sameAsOrigin('Fela Kuti', 'Mulatu Astatke')).toBe(false);
  });

  it('Eat uses taste-based place insights from the origin, never a name search, and Music Mode results join the feed', async () => {
    const owner = await insertAccount();
    const origin = await insertItem({ accountId: owner.accountId }, { kind: 'artist', category: 'play', title: 'Mulatu Astatke', qloo: 'qloo-mulatu' });
    const searches: string[] = [];
    const placeSignals: string[][] = [];
    const qloo = new FakeQloo(
      {
        search: (q) => {
          searches.push(q);
          return [entity('venue-same-name', "Mulatu's Bar", { properties: photo('bar') })];
        },
        insights: (req) => {
          if (req.filterType === 'urn:entity:place') {
            placeSignals.push(req.signalEntities ?? []);
            return {
              entities: [
                entity('place-echo', 'Mulatu Astatke Jazz Village', { properties: photo('echo') }),
                entity('place-real', 'Addis in Dar', { properties: photo('addis') }),
              ],
              tags: [],
            };
          }
          if (req.filterType === 'urn:entity:artist')
            return {
              entities: [
                entity('artist-self-jp', 'ムラトゥ', { properties: { alternative_names: ['Mulatu Astatke'] } }),
                entity('artist-fela', 'Fela Kuti'),
              ],
              tags: [],
            };
          if (req.filterType === 'urn:entity:movie') return { entities: [entity('film-1', 'Broken Flowers', { properties: { release_year: 2005 } })], tags: [] };
          return { entities: [entity('brand-1', 'Some Label')], tags: [] };
        },
      },
      { live: true },
    );
    const providers = testProviders({ qloo });
    const { discoveryJobId, jobId } = await relatedJob(owner.accountId, origin, 'music_mode', 'Mulatu Astatke');
    expect((await runJob(jobId, { providers })).state).toMatch(/complete|partial/);
    expect(placeSignals).toEqual([['qloo-mulatu']]);
    expect(searches).toEqual([]);
    const recs = await db.query<{ title: string; category: string; display_reason: string }>(
      `SELECT r.title, r.category, r.display_reason FROM recommendations r WHERE r.discovery_job_id = $1 ORDER BY r.rank`,
      [discoveryJobId],
    );
    const titles = recs.rows.map((r) => r.title);
    expect(titles).toEqual(expect.arrayContaining(['Addis in Dar', 'Fela Kuti', 'Broken Flowers']));
    for (const bad of ["Mulatu's Bar", 'Mulatu Astatke Jazz Village', 'ムラトゥ']) expect(titles).not.toContain(bad);
    expect(new Set(recs.rows.map((r) => r.display_reason))).toEqual(new Set(['Because you heard Mulatu Astatke.']));
    // Music Mode suggestions enter the interest feed pool.
    const pool = await buildSavedPool(db, { kind: 'account', accountId: owner.accountId });
    const pooled = await db.query<{ title: string }>('SELECT title FROM discovery_items WHERE id = ANY($1::uuid[])', [pool.map((p) => p.id)]);
    expect(pooled.rows.map((r) => r.title)).toEqual(expect.arrayContaining(['Addis in Dar', 'Fela Kuti']));
    // The owner's own "Discover more" results join the feed too (agent-started runs do not).
    const other = await insertItem({ accountId: owner.accountId }, { kind: 'film', category: 'watch', title: 'Tampopo', qloo: 'qloo-tampopo' });
    const plain = await relatedJob(owner.accountId, other, 'item', null);
    await runJob(plain.jobId, { providers });
    const reasons = await db.query<{ display_reason: string }>('SELECT display_reason FROM recommendations WHERE discovery_job_id = $1', [plain.discoveryJobId]);
    expect(reasons.rows.every((r) => r.display_reason === 'Loved by fans of Tampopo.')).toBe(true);
    const after = await buildSavedPool(db, { kind: 'account', accountId: owner.accountId });
    expect(after.length).toBeGreaterThan(pool.length);
  });
});
