import { randomUUID } from 'node:crypto';
import { FakeQloo, FakeTextModel } from '@culture-atlas/providers/testing';
import { ProviderError, type QlooEntity } from '@culture-atlas/providers';
import { afterAll, describe, expect, it } from 'vitest';
import { accountCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference, runJob, saveDirect } from '../test-support/library';
import { closeTestDb, getTestDb, insertAgentConnection, testProviders } from '../testing';
import { addCollectionItem, createCollection, deleteCollection, removeCollectionItem, updateCollection } from './collections';
import { getJob } from './jobs';
import { getItem } from './items';
import { createPlan, deletePlan, getPlan, listPlans, replacePlanSection } from './plans';

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

/** Live-mode fake Qloo: deterministic insights per filter type, explainability pointing at the first signal. */
function liveQloo(prefix = randomUUID().slice(0, 6), live = true) {
  return new FakeQloo(
    {
      search: (q) => [entity(`ent-${q.toLowerCase().replace(/\W+/g, '-')}`, q)],
      insights: (req) => {
        const signals = req.signalEntities ?? [];
        if (req.filterType === 'urn:entity:movie') {
          return {
            entities: Array.from({ length: 6 }, (_, i) =>
              entity(`${prefix}-movie-${i}`, `Film ${prefix} ${i}`, {
                properties: { release_year: 1960 + i },
                query: { affinity: 0.9 - i / 10, explainability: signals.map((id) => ({ entity_id: id, score: 0.5 })) },
              }),
            ),
            tags: [],
          };
        }
        if (req.filterType === 'urn:entity:artist') {
          return { entities: Array.from({ length: 6 }, (_, i) => entity(`${prefix}-artist-${i}`, `Artist ${prefix} ${i}`)), tags: [] };
        }
        return {
          entities: [entity(`${prefix}-place`, 'Some place', { tags: [{ id: 'urn:tag:genre:place:restaurant:japanese', name: 'Japanese', type: 'urn:tag:cuisine' }] })],
          tags: [{ id: 'urn:tag:cuisine:japanese', name: 'Japanese', type: 'urn:tag:cuisine' }],
        };
      },
    },
    { live },
  );
}

function composerModel(opts: { failProse?: boolean } = {}) {
  return new FakeTextModel((req) => {
    switch (req.schemaName) {
      case 'film_ideas':
        return {
          films: [
            { title: 'Creative Film One', year: 1999, inputs: ['i1'], reason: 'Echoes the warm light of your photo.' },
            { title: 'Creative Film Two', year: 2004, inputs: ['i2'], reason: 'Pairs with the artist you saved.' },
            { title: 'Creative Film Three', year: 2010, inputs: ['i1', 'i2'], reason: 'A creative pairing of both.' },
          ],
        };
      case 'artist_ideas':
        return {
          artists: [
            { name: 'Creative Artist A', inputs: ['i2'], reason: 'Close to your saved artist.' },
            { name: 'Creative Artist B', inputs: ['i1'], reason: 'Matches the mood.' },
          ],
        };
      case 'dish_ideas':
        return {
          dishes: [
            { title: 'Peanut noodles', description: 'Cold noodles with peanut sauce.', cuisine: 'Chinese', ingredients: ['noodles', 'peanut'], inputs: ['i1'], reason: 'Easy to share.' },
            { title: 'Miso glazed eggplant', description: 'Roasted eggplant. It is completely nut-free.', cuisine: 'Japanese', ingredients: ['eggplant', 'miso'], inputs: ['i1'], reason: 'Echoes the café.' },
            { title: 'Onigiri', description: 'Rice balls with pickled plum.', cuisine: 'Japanese', ingredients: ['rice', 'umeboshi'], inputs: ['i2'], reason: 'Simple finger food.' },
            { title: 'Citrus salad', description: 'Oranges and fennel.', cuisine: null, ingredients: ['orange', 'fennel'], inputs: [], reason: 'Fresh.' },
          ],
        };
      case 'plan_prose':
        if (opts.failProse) return new ProviderError('text', 'server', 'boom');
        return { title: 'A warm night in', summary: 'A creative pairing of your café photo and a saved artist.', rationale: null };
      default:
        return new Error(`unexpected schema ${req.schemaName}`);
    }
  });
}

async function setupCollection(options: { anchorsOnCapture?: boolean } = {}) {
  const { principal, ctx } = await accountCtx();
  const owner = { accountId: principal.accountId };
  const ref = await insertReference({ name: 'Kissaten coffee culture', type: 'tradition' });
  const cap = await insertCaptureWithAnalysis(owner, { anchorIds: options.anchorsOnCapture === false ? [] : [ref], title: 'Café table' });
  const artist = await insertItem(owner, { kind: 'artist', title: 'Haruomi Hosono', qloo: `artist-${randomUUID()}` });
  const film = await insertItem(owner, { kind: 'film', title: 'Tampopo', year: 1985, qloo: `film-${randomUUID()}` });
  const dish = await insertItem(owner, { kind: 'food', title: 'Satay skewers' });
  const col = await createCollection(ctx, { name: 'Tokyo evenings' });
  for (const id of [cap.itemId, artist, film, dish]) await addCollectionItem(ctx, { id: col.id, item_id: id, body: {} });
  const revision = 5;
  return { principal, ctx, owner, ref, cap, artist, film, dish, col, revision };
}

describe('createPlan validation and snapshots', () => {
  it('validates revision, membership, fixed film and usable anchors', async () => {
    const s = await setupCollection({ anchorsOnCapture: false });
    const base = { collection_id: s.col.id, template: 'movie_night' as const, exploration: 'balanced' as const };
    await expect(createPlan(s.ctx, { ...base, expected_revision: 2, item_ids: [s.artist, s.film] })).rejects.toMatchObject({
      code: 'revision_conflict',
      status: 409,
    });
    const outsider = await insertItem(s.owner, { kind: 'film' });
    await expect(createPlan(s.ctx, { ...base, expected_revision: s.revision, item_ids: [s.artist, outsider] })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { not_in_collection: [outsider] },
    });
    await expect(
      createPlan(s.ctx, { ...base, expected_revision: s.revision, item_ids: [s.artist, s.film], fixed_film_item_id: s.artist }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createPlan(s.ctx, { ...base, expected_revision: s.revision, item_ids: [s.cap.itemId, s.artist] })).rejects.toMatchObject({
      code: 'invalid_input',
      details: { weak_item_ids: [s.cap.itemId] },
    });
  });

  it('a photo whose references stayed unmatched (no Qloo) still counts, using those named references; rejected ones never do', async () => {
    const s = await setupCollection({ anchorsOnCapture: false });
    const unmatched = await insertReference({ name: 'Racing stripes', type: 'style' });
    const rejected = await insertReference({ name: 'Something wrong', type: 'style' });
    await db.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, is_anchor, resolution_status)
       VALUES ($1, $2, 'resembles', 0.7, false, 'unmatched'), ($1, $3, 'resembles', 0.7, false, 'rejected')`,
      [s.cap.analysisId, unmatched, rejected],
    );
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.cap.itemId, s.artist],
      template: 'movie_night',
      exploration: 'balanced',
    });
    const { rows } = await db.query<{ input_snapshot: { items: { item_id: string; anchors: { reference_id: string }[] }[] } }>(
      'SELECT input_snapshot FROM plan_versions WHERE plan_id = $1',
      [res.plan_id],
    );
    const capItem = rows[0]!.input_snapshot.items.find((i) => i.item_id === s.cap.itemId)!;
    expect(capItem.anchors.map((a) => a.reference_id)).toEqual([unmatched]);
  });

  it('a photo plus an artist is a valid input; the snapshot survives later collection edits and deletion', async () => {
    const s = await setupCollection();
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.cap.itemId, s.artist],
      template: 'movie_night',
      constraints: { dietary_exclusions: ['peanuts'], instruction: 'A relaxed evening' },
      exploration: 'balanced',
    });
    const plan = await getPlan(s.ctx, { id: res.plan_id });
    expect(plan.status).toBe('queued');
    expect(plan.active_version?.sections).toEqual({ film: 'pending', food: 'pending', music: 'pending' });
    expect(plan.active_version?.collection_revision).toBe(s.revision);
    expect(plan.constraints).toEqual({ dietary_exclusions: ['peanuts'], instruction: 'A relaxed evening' });
    const job = await getJob(s.ctx, { id: res.job_id });
    expect(job).toMatchObject({ state: 'queued', type: 'generate_plan', poll_after_ms: 1500 });

    await removeCollectionItem(s.ctx, { id: s.col.id, item_id: s.artist });
    await updateCollection(s.ctx, { id: s.col.id, body: { expected_revision: s.revision + 1, name: 'Renamed' } });
    const snap = await db.query<{ input_snapshot: { items: { item_id: string }[]; collection: { name: string } } }>(
      'SELECT input_snapshot FROM plan_versions WHERE plan_id = $1',
      [res.plan_id],
    );
    expect(snap.rows[0]!.input_snapshot.items.map((i) => i.item_id)).toEqual([s.cap.itemId, s.artist]);
    expect(snap.rows[0]!.input_snapshot.collection.name).toBe('Tokyo evenings');

    await deleteCollection(s.ctx, { id: s.col.id });
    const after = await getPlan(s.ctx, { id: res.plan_id });
    expect(after.source_collection_id).toBeNull();
    expect(after.active_version?.inputs.map((i) => i.item_id)).toEqual([s.cap.itemId, s.artist]);
    expect((await listPlans(s.ctx, {})).plans.map((p) => p.id)).toContain(res.plan_id);
  });
});

describe('movie-night composition', () => {
  it('uses real Qloo results with provenance, enforces exclusions and discloses nothing fabricated', async () => {
    const s = await setupCollection();
    const providers = testProviders({ qloo: liveQloo(), composer: composerModel() });
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.cap.itemId, s.artist, s.film],
      template: 'movie_night',
      constraints: { dietary_exclusions: ['peanuts'] },
      exploration: 'familiar',
    });
    expect((await runJob(res.job_id, { providers })).state).toBe('complete');
    const plan = await getPlan(ctxFor(s.principal, { providers }), { id: res.plan_id });
    const v = plan.active_version!;
    expect(plan.status).toBe('complete');
    expect(v.sections).toEqual({ film: 'complete', food: 'complete', music: 'complete' });
    expect(v.film!.feature!.title).toMatch(/^Film /);
    expect(v.film!.alternates).toHaveLength(2);
    expect(v.film!.feature!.year).toBe(1960);
    expect(v.music!.before.length + v.music!.after.length).toBe(4);
    expect(v.music!.before.every((m) => m.kind === 'artist' && !m.verified)).toBe(true);
    // Exclusions: the peanut dish and the selected satay are dropped; no "nut-free" claim survives.
    const dishTitles = v.food!.dishes.map((d) => d.title);
    expect(dishTitles).not.toContain('Peanut noodles');
    expect(dishTitles).not.toContain('Satay skewers');
    expect(v.food!.dishes.length).toBeLessThanOrEqual(3);
    expect(v.food!.dishes.find((d) => d.title === 'Miso glazed eggplant')!.description).toBe('Roasted eggplant.');
    expect(v.title).toBe('A warm night in');
    expect(v.inputs.map((i) => i.contribution)).toEqual(['strong', 'strong', 'strong']);
    // Live Qloo picks are not examples.
    expect(v.film!.feature!.is_example).toBe(false);
    expect([...v.music!.before, ...v.music!.after].some((m) => m.is_example)).toBe(false);

    // Every Qloo-origin recommendation cites a real stored provider query.
    const recs = await db.query<{ origin: string; provider_query_ids: string[]; section: string }>(
      'SELECT origin, provider_query_ids, section FROM recommendations WHERE plan_id = $1',
      [res.plan_id],
    );
    const qlooRecs = recs.rows.filter((r) => r.origin === 'qloo');
    expect(qlooRecs.length).toBe(7);
    const queryIds = new Set(
      (await db.query<{ id: string }>(`SELECT id FROM provider_queries WHERE plan_id = $1 AND provider = 'qloo' AND status = 'ok'`, [res.plan_id])).rows.map(
        (r) => r.id,
      ),
    );
    for (const r of qlooRecs) expect(r.provider_query_ids.every((id) => queryIds.has(id))).toBe(true);
    expect(recs.rows.filter((r) => r.section === 'food').every((r) => r.origin === 'vlm_creative')).toBe(true);
    const budget = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM provider_queries WHERE plan_id = $1 AND provider = 'qloo'`, [res.plan_id]);
    expect(budget.rows[0]!.n).toBeLessThanOrEqual(12);
    const job = await getJob(s.ctx, { id: res.job_id });
    expect(job).toMatchObject({ state: 'complete', poll_after_ms: null, result: { type: 'plan', id: res.plan_id } });
  });

  it('replayed Qloo picks are labeled "Example result" in the plan and when opened later', async () => {
    const s = await setupCollection();
    const providers = testProviders({ qloo: liveQloo(randomUUID().slice(0, 6), false), composer: composerModel() });
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.cap.itemId, s.artist, s.film],
      template: 'movie_night',
      constraints: { dietary_exclusions: [] },
      exploration: 'familiar',
    });
    await runJob(res.job_id, { providers });
    const v = (await getPlan(ctxFor(s.principal, { providers }), { id: res.plan_id })).active_version!;
    const feature = v.film!.feature!;
    expect(feature.title).toMatch(/^Film /);
    expect(feature.is_example).toBe(true);
    expect(v.film!.alternates.every((a) => a.is_example)).toBe(true);
    const music = [...v.music!.before, ...v.music!.after];
    expect(music.filter((m) => m.title.startsWith('Artist ')).every((m) => m.is_example)).toBe(true);
    // Creative dish ideas are not provider results, so they carry no example label.
    expect(v.food!.dishes.every((d) => !d.is_example)).toBe(true);
    // The film opened on its own keeps the label.
    expect((await getItem(s.ctx, { id: feature.item_id, query: {} })).item.is_example).toBe(true);
  });

  it('without Qloo, falls back to creative suggestions flagged internally (never Qloo-labeled)', async () => {
    const s = await setupCollection();
    const providers = testProviders({ composer: composerModel({ failProse: true }) });
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.cap.itemId, s.artist],
      template: 'movie_night',
      exploration: 'adventurous',
    });
    await runJob(res.job_id, { providers });
    const plan = await getPlan(s.ctx, { id: res.plan_id });
    const v = plan.active_version!;
    expect(v.film!.feature!.title).toBe('Creative Film One');
    expect(v.music!.before.length + v.music!.after.length).toBe(2);
    expect(v.title).toBe('Movie night: Creative Film One');
    const origins = await db.query<{ origin: string }>('SELECT DISTINCT origin FROM recommendations WHERE plan_id = $1', [res.plan_id]);
    expect(origins.rows.map((r) => r.origin)).toEqual(['vlm_creative']);
    const qlooQueries = await db.query(`SELECT 1 FROM provider_queries WHERE plan_id = $1 AND provider = 'qloo'`, [res.plan_id]);
    expect(qlooQueries.rowCount).toBe(0);
    expect(plan.status).toBe('complete');
  });

  it('with no providers at all, keeps the fixed film and marks the rest unavailable instead of inventing', async () => {
    const s = await setupCollection();
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.film, s.artist, s.dish],
      fixed_film_item_id: s.film,
      template: 'movie_night',
      exploration: 'balanced',
    });
    expect((await runJob(res.job_id)).state).toBe('partial');
    const v = (await getPlan(s.ctx, { id: res.plan_id })).active_version!;
    expect(v.film!.feature).toMatchObject({ item_id: s.film, is_fixed: true, title: 'Tampopo' });
    expect(v.film!.alternates).toEqual([]);
    expect(v.sections).toEqual({ film: 'partial', food: 'partial', music: 'unavailable' });
    // The only dish is the user's own selected dish idea (no exclusions stated).
    expect(v.food!.dishes.map((d) => d.item_id)).toEqual([s.dish]);
    expect(v.music).toEqual({ before: [], after: [] });
    expect(v.rationale).toMatch(/contributed little/);
    expect(v.inputs.find((i) => i.item_id === s.artist)!.contribution).toBe('weak');
  });

  it('replaces one section while preserving the others, and never repeats earlier picks', async () => {
    const s = await setupCollection();
    const providers = testProviders({ qloo: liveQloo(), composer: composerModel() });
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.cap.itemId, s.artist],
      template: 'movie_night',
      exploration: 'balanced',
    });
    await runJob(res.job_id, { providers });
    const v1 = (await getPlan(s.ctx, { id: res.plan_id })).active_version!;
    const rep = await replacePlanSection(s.ctx, { id: res.plan_id, body: { section: 'film', instruction: 'Something older' } });
    await expect(replacePlanSection(s.ctx, { id: res.plan_id, body: { section: 'music' } })).rejects.toMatchObject({ code: 'conflict' });
    const pending = (await getPlan(s.ctx, { id: res.plan_id })).active_version!;
    expect(pending.version).toBe(2);
    expect(pending.sections.film).toBe('pending');
    await runJob(rep.job_id, { providers });
    const plan = await getPlan(s.ctx, { id: res.plan_id });
    const v2 = plan.active_version!;
    expect(plan.versions.map((x) => x.version)).toEqual([1, 2]);
    expect(v2.music).toEqual(v1.music);
    expect(v2.food).toEqual(v1.food);
    expect(v2.title).toBe(v1.title);
    const before = [v1.film!.feature!, ...v1.film!.alternates].map((f) => f.item_id);
    const after = [v2.film!.feature!, ...v2.film!.alternates].map((f) => f.item_id);
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect(v2.sections.film).toBe('complete');
    // Version 1 is retained unchanged.
    const old = await db.query<{ film: { feature: { item_id: string } } }>('SELECT film FROM plan_versions WHERE plan_id = $1 AND version = 1', [res.plan_id]);
    expect(old.rows[0]!.film.feature.item_id).toBe(v1.film!.feature!.item_id);
  });

  it('a delete during a running job prevents publication', async () => {
    const s = await setupCollection();
    const providers = testProviders({ qloo: liveQloo(), composer: composerModel() });
    const res = await createPlan(s.ctx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.artist, s.film],
      template: 'movie_night',
      exploration: 'balanced',
    });
    const outcome = await runJob(res.job_id, { providers, beforePublish: () => deletePlan(s.ctx, { id: res.plan_id }) });
    expect(outcome.state).toBe('cancelled');
    const recs = await db.query('SELECT 1 FROM recommendations WHERE plan_id = $1', [res.plan_id]);
    expect(recs.rowCount).toBe(0);
    await expect(getPlan(s.ctx, { id: res.plan_id })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('plans and agent grants', () => {
  it('agents need plans:write + collections:read and lose access when an input leaves the grant', async () => {
    const s = await setupCollection();
    const { principal: agent } = await insertAgentConnection(s.principal, {
      scopes: ['collections:read', 'plans:read', 'plans:write'],
      libraryAccess: 'selected_collections',
      collectionIds: [s.col.id],
    });
    const actx = ctxFor(agent);
    const res = await createPlan(actx, {
      collection_id: s.col.id,
      expected_revision: s.revision,
      item_ids: [s.artist, s.film],
      template: 'movie_night',
      exploration: 'balanced',
    });
    expect((await getPlan(actx, { id: res.plan_id })).id).toBe(res.plan_id);
    expect((await getJob(actx, { id: res.job_id })).id).toBe(res.job_id);
    expect((await listPlans(actx, {})).plans.map((p) => p.id)).toEqual([res.plan_id]);

    await removeCollectionItem(s.ctx, { id: s.col.id, item_id: s.film });
    await expect(getPlan(actx, { id: res.plan_id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(getJob(actx, { id: res.job_id })).rejects.toMatchObject({ code: 'not_found' });
    expect((await listPlans(actx, {})).plans).toEqual([]);
    expect((await getPlan(s.ctx, { id: res.plan_id })).id).toBe(res.plan_id);

    const { principal: readOnly } = await insertAgentConnection(s.principal, {
      scopes: ['collections:read', 'plans:read'],
      libraryAccess: 'all',
    });
    await expect(
      createPlan(ctxFor(readOnly), {
        collection_id: s.col.id,
        expected_revision: 1,
        item_ids: [s.artist, s.cap.itemId],
        template: 'movie_night',
        exploration: 'balanced',
      }),
    ).rejects.toMatchObject({ code: 'scope_denied' });
    void saveDirect;
  });
});
