import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ProviderError } from '@culture-atlas/providers';
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
    // Live Qloo entities returned prose and https images (the photo() fixtures):
    // none of it persists on the related picks (VAL-EVID-005).
    const pickMeta = await db.query<{ display_metadata: Record<string, unknown> }>(
      `SELECT di.display_metadata FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
        WHERE r.discovery_job_id = $1`,
      [discoveryJobId],
    );
    expect(pickMeta.rows.length).toBeGreaterThan(0);
    for (const row of pickMeta.rows) {
      expect(row.display_metadata.description ?? null).toBeNull();
      expect(row.display_metadata.image ?? null).toBeNull();
    }
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

  it('never re-propagates legacy restricted metadata from seeded interest cards', async () => {
    const owner = await insertAccount();
    const origin = await insertItem({ accountId: owner.accountId }, { kind: 'film', category: 'watch', title: 'Playtime', qloo: 'qloo-prop-origin' });
    // A legacy seeded interest card as a pre-boundary writer left it: Qloo
    // prose plus an uncleared image URL on a provider-backed discovery item.
    const legacy = await insertItem({ accountId: owner.accountId }, { kind: 'film', category: 'watch', title: 'Legacy Prose Film', qloo: 'qloo-prop-legacy' });
    await db.query(`UPDATE discovery_items SET display_metadata = $2::jsonb WHERE id = $1`, [
      legacy,
      JSON.stringify({
        subtitle: '1957',
        description: 'Legacy Qloo prose.',
        image: { url: 'https://images.invalid/legacy.jpg', alt: 'Legacy' },
      }),
    ]);
    const run = await db.query<{ id: string }>(
      `INSERT INTO taste_seed_runs (owner_account_id, taste_revision, state) VALUES ($1, 1, 'complete') RETURNING id`,
      [owner.accountId],
    );
    await db.query(
      `INSERT INTO recommendations (discovery_item_id, taste_seed_run_id, rank, title, origin, category, provider_query_ids)
       VALUES ($1, $2, 1, 'Legacy Prose Film', 'qloo', 'watch', ARRAY[$3::uuid])`,
      [legacy, run.rows[0]!.id, randomUUID()],
    );

    // Insights are down, so the related job falls back to the seeded interest
    // cards and re-upserts the legacy row as a related pick.
    const qloo = new FakeQloo(
      {
        search: () => [],
        insights: () => {
          throw new ProviderError('qloo', 'server', 'fixture insights down');
        },
      },
      { live: true },
    );
    const providers = testProviders({ qloo });
    const { discoveryJobId, jobId } = await relatedJob(owner.accountId, origin, 'item', null);
    expect((await runJob(jobId, { providers })).state).toMatch(/complete|partial/);

    const picks = await db.query<{ title: string; display_metadata: Record<string, unknown> }>(
      `SELECT r.title, di.display_metadata FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
        WHERE r.discovery_job_id = $1`,
      [discoveryJobId],
    );
    expect(picks.rows.map((r) => r.title)).toContain('Legacy Prose Film');
    // The pick re-used the legacy canonical row: its restricted metadata is
    // cleaned at the upsert boundary and nothing restricted re-propagates.
    for (const row of picks.rows) {
      expect(row.display_metadata.description ?? null).toBeNull();
      expect(row.display_metadata.image ?? null).toBeNull();
    }
  });
});
