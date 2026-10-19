import { randomUUID } from 'node:crypto';
import { ProviderError, type QlooEntity } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { getOnboardingCatalogFile } from '../onboarding/catalog';
import type { AccountPrincipal, Principal } from '../principal';
import { OnboardingCatalogResponse, OnboardingStateResponse, TastePicksResponse } from '../schemas/onboarding';
import {
  accountCtx,
  anonCtx,
  ctxFor,
  insertCaptureWithAnalysis,
  insertItem,
  insertReference,
} from '../test-support/library';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testConfig, testContext, testProviders } from '../testing';
import { createAccount, getSessionInfo, resolvePrincipal, signIn } from './auth';
import { addCollectionItem, createCollection } from './collections';
import { getDiscoveries } from './discovery';
import { hashPassword } from './passwords';
import { createPlan } from './plans';
import { listSaved, recordPreference } from './preferences';
import {
  complete,
  createPick,
  deletePick,
  getCatalog,
  getSeedStatus,
  getState,
  listTastePicks,
  putExclusions,
  search,
  signSearchResult,
} from './onboarding';
import { getPreferences, updatePreferences } from './agent-platform';
import { TASTE_SEED_MAX_QLOO_REQUESTS } from './taste-seed';

const db = getTestDb();
afterAll(closeTestDb);

const catalog = getOnboardingCatalogFile();
const chips = catalog.items.filter((i) => i.kind === 'chip');
const multiTagImage = catalog.items.find((i) => i.kind === 'image' && i.qloo.length >= 2)!;
const email = () => `onb-${randomUUID().slice(0, 8)}@example.com`;
const pick = (ctx: ReturnType<typeof ctxFor>, id: string) => createPick(ctx, { source: 'catalog', catalog_item_id: id });

async function newAccount(input: { pendingItem?: string } = {}) {
  const { ctx } = await anonCtx();
  const res = await createAccount(ctx, {
    email: email(),
    password: 'a long onboarding password',
    claim_session: true,
    ...(input.pendingItem ? { pending_save: { target_type: 'discovery_item' as const, target_id: input.pendingItem } } : {}),
  });
  const principal = (await resolvePrincipal(db, { sessionToken: res.sessionToken })) as AccountPrincipal;
  return { res, principal, ctx: ctxFor(principal) };
}

function searchQloo(entities: QlooEntity[] | Error, opts: { live?: boolean } = {}) {
  return new FakeQloo({ search: () => entities }, { live: opts.live ?? true });
}

const entity = (name: string, type: string): QlooEntity => ({ entity_id: `E-${randomUUID()}`, name, types: [type], properties: {}, tags: [] });

describe('catalog file', () => {
  it('holds 12-16 images and 6-10 chips per category, each backed by real Qloo tag ids with retrieval dates', () => {
    const images = catalog.items.filter((i) => i.kind === 'image');
    expect(images.length).toBeGreaterThanOrEqual(12);
    expect(images.length).toBeLessThanOrEqual(16);
    for (const c of ['wear', 'play', 'watch', 'eat'] as const) {
      const n = chips.filter((i) => i.category === c).length;
      expect(n).toBeGreaterThanOrEqual(6);
      expect(n).toBeLessThanOrEqual(10);
    }
    for (const item of catalog.items) {
      expect(item.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      for (const ref of item.qloo) expect(ref.id).toMatch(/^urn:tag:[a-z_]+:[a-z_]+(:[a-z0-9_]+)+$/);
      if (item.image) expect(item.image.url).toMatch(/^\/samples\/.+\.jpg$/);
    }
  });
});

describe('ONB-01 the questionnaire gates a new account, never anonymous visitors', () => {
  it('a new account is required until it completes with at least 3 picks', async () => {
    const { res, principal, ctx } = await newAccount();
    expect(res.onboarding_required).toBe(true);
    expect((await getSessionInfo(ctx)).onboarding_required).toBe(true);
    expect((await getState(ctx)).state).toMatchObject({ required: true, picks_count: 0, min_picks: 3, completed_at: null });

    await expect(complete(ctx)).rejects.toMatchObject({ code: 'conflict', status: 409, details: { picks_count: 0, min_picks: 3 } });
    await pick(ctx, chips[0]!.id);
    await pick(ctx, chips[1]!.id);
    await expect(complete(ctx)).rejects.toMatchObject({ code: 'conflict', details: { picks_count: 2 } });
    const third = await pick(ctx, chips[2]!.id);
    expect(third.state).toMatchObject({ required: true, picks_count: 3 });

    const done = await complete(ctx);
    expect(done.state).toMatchObject({ required: false, picks_count: 3 });
    expect(done.state.completed_at).not.toBeNull();
    expect((await getSessionInfo(ctx)).onboarding_required).toBe(false);
    // Idempotent.
    expect((await complete(ctx)).state.completed_at).toBe(done.state.completed_at);
    const signedIn = ctxFor({ ...principal });
    expect((await getState(signedIn)).state.required).toBe(false);
  });

  it('anonymous visitors never see it and cannot use the onboarding routes', async () => {
    const { ctx } = await anonCtx();
    const session = await getSessionInfo(ctx);
    expect(session.onboarding_required).toBeUndefined();
    await expect(getCatalog(ctx)).rejects.toMatchObject({ code: 'account_required' });
    await expect(getState(ctx)).rejects.toMatchObject({ code: 'account_required' });
    await expect(pick(ctx, chips[0]!.id)).rejects.toMatchObject({ code: 'account_required' });
    await expect(search(ctx, { q: 'nina' })).rejects.toMatchObject({ code: 'account_required' });
  });

  it('with onboarding_required off (env or kill switch) nothing blocks, and completing still works', async () => {
    const { ctx: anon } = await anonCtx();
    const off = testConfig({ ONBOARDING_REQUIRED: 'false' });
    const res = await createAccount({ ...anon, config: off }, { claim_session: true });
    expect(res.onboarding_required).toBe(false);

    const { res: res2, principal } = await newAccount();
    expect(res2.onboarding_required).toBe(true);
    await db.query(`INSERT INTO feature_flag_kills (flag, account_id, reason, created_by) VALUES ('onboarding_required', $1, 'test', 'test')`, [principal.accountId]);
    expect((await getState(ctxFor(principal))).state.required).toBe(false);
  });

  it('serves the catalog without provider ids and records the catalog version', async () => {
    const { ctx } = await newAccount();
    await pick(ctx, multiTagImage.id);
    const body = OnboardingCatalogResponse.parse(await getCatalog(ctx));
    expect(JSON.stringify(body)).not.toMatch(/urn:tag|qloo/i);
    expect(body.images.find((i) => i.id === multiTagImage.id)).toMatchObject({ picked: true });
    expect(body.exclusion_suggestions).toContain('peanuts');
    expect((await getState(ctx)).state.catalog_version).toBe(catalog.catalog_version);
  });
});

describe('ONB-02 every pick is a real, unsavable explicit save, counted once', () => {
  it('an image standing for several tags is one pick backed by several saves of real Qloo ids', async () => {
    const { principal, ctx } = await accountCtx();
    const res = await pick(ctx, multiTagImage.id);
    expect(res.already_picked).toBe(false);
    expect(res.pick.saved_item_ids).toHaveLength(multiTagImage.qloo.length);
    expect(res.state.picks_count).toBe(1);

    const { rows } = await db.query<{ external_ids: Record<string, string>; canonical_key: string }>(
      'SELECT external_ids, canonical_key FROM discovery_items WHERE id = ANY($1::uuid[]) ORDER BY canonical_key',
      [res.pick.discovery_item_ids],
    );
    expect(rows.map((r) => r.external_ids.qloo_tag).sort()).toEqual(multiTagImage.qloo.map((q) => q.id).sort());
    const events = await db.query<{ payload: { source?: string } }>(
      `SELECT payload FROM preference_events WHERE owner_account_id = $1 AND action = 'save'`,
      [principal.accountId],
    );
    expect(events.rows).toHaveLength(multiTagImage.qloo.length);
    expect(events.rows.every((e) => e.payload.source === 'onboarding')).toBe(true);

    // Visible in Saved for later.
    const saved = await listSaved(ctx, { filter: 'unfiled' });
    expect(saved.items.map((s) => s.saved_item_id).sort()).toEqual([...res.pick.saved_item_ids].sort());

    // Picking again is idempotent.
    const again = await pick(ctx, multiTagImage.id);
    expect(again).toMatchObject({ already_picked: true, pick: { id: res.pick.id } });
    expect((await getState(ctx)).state.picks_count).toBe(1);

    // Unsaving one of its saves keeps the pick; unsaving all removes it.
    const [first, ...rest] = res.pick.discovery_item_ids;
    await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: first! });
    expect((await getState(ctx)).picks[0]!.saved_item_ids).toHaveLength(rest.length);
    for (const id of rest) await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: id });
    expect((await getState(ctx)).state.picks_count).toBe(0);
    // ...and it can be picked afresh.
    expect((await pick(ctx, multiTagImage.id)).already_picked).toBe(false);
  });

  it('removing a pick unsaves what it saved, but keeps saves the account already had', async () => {
    const { principal, ctx } = await accountCtx();
    const chip = chips.find((c) => c.category === 'play')!;
    // The account saved this tag before onboarding (e.g. from a photo's references).
    const before = await insertItem({ accountId: principal.accountId }, { kind: 'style', key: `qloo:${chip.qloo[0]!.id}`, title: chip.label });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: before });
    const other = await pick(ctx, chips.find((c) => c.category === 'watch')!.id);
    const mine = await pick(ctx, chip.id);
    expect(mine.pick.discovery_item_ids).toEqual([before]);

    const del = await deletePick(ctx, mine.pick.id);
    expect(del.state.picks_count).toBe(1);
    const saved = (await listSaved(ctx, { filter: 'all' })).items.map((s) => s.item.id);
    expect(saved).toContain(before);

    await deletePick(ctx, other.pick.id);
    const after = (await listSaved(ctx, { filter: 'all' })).items.map((s) => s.item.id);
    expect(after).not.toContain(other.pick.discovery_item_ids[0]);
    await expect(deletePick(ctx, other.pick.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('search picks save only what Qloo returned, through a signed result id', async () => {
    const { principal, ctx: base } = await accountCtx();
    const film = entity('Nina Wu', 'urn:entity:movie');
    const artist = entity('Nina Simone', 'urn:entity:artist');
    const ctx = testContext(principal, { providers: testProviders({ qloo: searchQloo([artist, film, entity('', 'urn:entity:artist')]) }) });
    const res = await search(ctx, { q: 'nina' });
    expect(res.status).toBe('ok');
    expect(res.results.map((r) => [r.name, r.type_label, r.category])).toEqual([
      ['Nina Simone', 'Artist', 'play'],
      ['Nina Wu', 'Film', 'watch'],
    ]);
    expect(JSON.stringify(res)).not.toContain(artist.entity_id);

    const created = await createPick(base, { source: 'search', result_id: res.results[1]!.result_id });
    expect(created.pick).toMatchObject({ source: 'search', label: 'Nina Wu', category: 'watch', item_kind: 'film' });
    const item = await db.query<{ external_ids: { qloo: string }; kind: string }>('SELECT external_ids, kind FROM discovery_items WHERE id = $1', [created.pick.discovery_item_ids[0]]);
    expect(item.rows[0]).toMatchObject({ kind: 'film', external_ids: { qloo: film.entity_id } });
    expect((await search(ctx, { q: 'nina' })).results.find((r) => r.name === 'Nina Wu')!.picked).toBe(true);

    // A forged or altered token is refused.
    const [body, mac] = res.results[0]!.result_id.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), i: 'made-up' })).toString('base64url');
    await expect(createPick(base, { source: 'search', result_id: `${forged}.${mac}` })).rejects.toMatchObject({ code: 'invalid_input' });
    const expired = signSearchResult(base.config.SESSION_SECRET, {
      accountId: principal.accountId,
      ref: { type: 'entity', id: 'x', name: 'Old', subtype: 'urn:entity:artist' },
      now: new Date(Date.now() - 2 * 3600_000),
    });
    await expect(createPick(base, { source: 'search', result_id: expired })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('the save that prompted sign-up is kept and counts as one pick', async () => {
    const sample = await insertItem(null, { kind: 'film', title: 'Playtime' });
    const { res, ctx } = await newAccount({ pendingItem: sample });
    expect(res.pending_save).not.toBeNull();
    const state = OnboardingStateResponse.parse(await getState(ctx));
    expect(state.state.picks_count).toBe(1);
    expect(state.picks[0]).toMatchObject({ source: 'pending_save', label: 'Playtime', saved_item_ids: [res.pending_save!.saved_item_id] });
    await pick(ctx, chips[0]!.id);
    await pick(ctx, chips[1]!.id);
    expect((await complete(ctx)).state.required).toBe(false);
  });
});

describe('ONB-03 Qloo unavailable: search reports it, catalog completion still works, nothing fabricated', () => {
  it('search is unavailable when Qloo fails, throttles or only replay data exists', async () => {
    const { principal } = await accountCtx();
    for (const qloo of [
      searchQloo(new ProviderError('qloo', 'server', 'down')),
      searchQloo(new ProviderError('qloo', 'rate_limited', 'slow down', { status: 429 })),
      searchQloo([entity('Nina Simone', 'urn:entity:artist')], { live: false }),
    ]) {
      const ctx = testContext(principal, { providers: testProviders({ qloo }) });
      expect(await search(ctx, { q: 'nina' })).toEqual({ status: 'unavailable', results: [] });
    }
  });

  it('completes from the cached catalog and queues one bounded, retryable seed job', async () => {
    const { principal } = await newAccount();
    const ctx = testContext(principal, { providers: testProviders({ qloo: searchQloo(new ProviderError('qloo', 'server', 'down')) }) });
    for (const c of chips.slice(0, 3)) await pick(ctx, c.id);
    const before = await db.query('SELECT count(*)::int AS n FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id WHERE di.owner_account_id = $1', [principal.accountId]);
    const done = await complete(ctx);
    expect(done.seed).toMatchObject({ state: 'queued', first_ready_at: null });
    expect(done.seed.categories.map((c) => [c.category, c.state, c.card_count])).toEqual([
      ['wear', 'pending', 0], ['play', 'pending', 0], ['watch', 'pending', 0], ['eat', 'pending', 0],
    ]);
    const job = await db.query<{ type: string; max_attempts: number; budget: { qloo_requests: number }; payload: { categories: string[] } }>(
      'SELECT type, max_attempts, budget, payload FROM jobs WHERE id = $1',
      [done.seed.job_id],
    );
    expect(job.rows[0]).toMatchObject({ type: 'taste_seed', budget: { qloo_requests: TASTE_SEED_MAX_QLOO_REQUESTS } });
    expect(job.rows[0]!.max_attempts).toBeGreaterThan(1);
    expect(TASTE_SEED_MAX_QLOO_REQUESTS).toBeLessThanOrEqual(6);
    // Completing again reuses the same job.
    expect((await complete(ctx)).seed.job_id).toBe(done.seed.job_id);
    // No cards were invented.
    const after = await db.query('SELECT count(*)::int AS n FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id WHERE di.owner_account_id = $1', [principal.accountId]);
    expect(after.rows[0]).toEqual(before.rows[0]);

    // Retrying after a Qloo outage, then category progress as the job reports it.
    await db.query(`UPDATE jobs SET attempt = 1, error_code = 'provider_unavailable', error_retryable = true WHERE id = $1`, [done.seed.job_id]);
    expect((await getSeedStatus(ctx)).state).toBe('retrying');
    await db.query(`UPDATE jobs SET state = 'running' WHERE id = $1`, [done.seed.job_id]);
    // The seed job (pipeline/taste-seed.ts) records category progress on its run.
    await db.query(
      `UPDATE taste_seed_categories c SET state = v.state, card_count = v.n, ready_at = v.ready
         FROM taste_seed_runs r,
              (VALUES ('play', 'ready', 4, now()), ('eat', 'empty', 0, NULL::timestamptz)) AS v(category, state, n, ready)
        WHERE r.job_id = $1 AND c.run_id = r.id AND c.category = v.category`,
      [done.seed.job_id],
    );
    await db.query(`UPDATE taste_seed_runs SET first_ready_at = now() WHERE job_id = $1`, [done.seed.job_id]);
    const progress = await getSeedStatus(ctx);
    expect(progress).toMatchObject({ state: 'running', poll_after_ms: 1000 });
    expect(progress.first_ready_at).not.toBeNull();
    expect(progress.categories.find((c) => c.category === 'play')).toMatchObject({ state: 'ready', card_count: 4 });
    expect(progress.categories.find((c) => c.category === 'eat')).toMatchObject({ state: 'empty', card_count: 0 });
    await db.query(`UPDATE jobs SET state = 'failed' WHERE id = $1`, [done.seed.job_id]);
    const failed = await getSeedStatus(ctx);
    expect(failed.categories.find((c) => c.category === 'wear')).toMatchObject({ state: 'unavailable', card_count: 0 });
    expect(failed.poll_after_ms).toBeNull();
  });

  it('with taste_seed_enabled off, completion queues nothing', async () => {
    const { principal } = await accountCtx();
    const ctx = testContext(principal, { config: testConfig({ TASTE_SEED_ENABLED: 'false' }) });
    for (const c of chips.slice(3, 6)) await pick(ctx, c.id);
    const done = await complete(ctx);
    expect(done.seed).toEqual({ job_id: null, state: 'not_started', categories: [], first_ready_at: null, poll_after_ms: null });
  });

  it('Settings -> Taste changes after completion queue one fresh seed, not one per edit', async () => {
    const { principal } = await newAccount();
    const ctx = testContext(principal);
    for (const c of chips.slice(0, 3)) await pick(ctx, c.id);
    expect(await seedJobs(principal.accountId)).toHaveLength(0); // nothing before completion
    const done = await complete(ctx);
    expect(await seedJobs(principal.accountId)).toHaveLength(1);
    // A queued, not yet started seed reads the current saves when it runs: no second job.
    await pick(ctx, chips[3]!.id);
    expect(await seedJobs(principal.accountId)).toHaveLength(1);
    // Once that seed has run, a change queues a new one for the new revision.
    await db.query(`UPDATE jobs SET state = 'complete', attempt = 1 WHERE id = $1`, [done.seed.job_id]);
    const added = await pick(ctx, chips[4]!.id);
    const jobs = await seedJobs(principal.accountId);
    expect(jobs).toHaveLength(2);
    expect(jobs[1]!.payload.taste_revision).toBe(added.taste_revision);
    await db.query(`UPDATE jobs SET state = 'complete', attempt = 1 WHERE id = $1`, [jobs[1]!.id]);
    await deletePick(ctx, added.pick.id);
    expect(await seedJobs(principal.accountId)).toHaveLength(3);
    expect((await getSeedStatus(ctx)).job_id).toBe((await seedJobs(principal.accountId))[2]!.id);
  });
});

async function seedJobs(accountId: string) {
  const { rows } = await db.query<{ id: string; payload: { taste_revision: number } }>(
    `SELECT id, payload FROM jobs WHERE owner_account_id = $1 AND type = 'taste_seed' ORDER BY created_at, id`,
    [accountId],
  );
  return rows;
}

describe('ONB-05 exclusions are preferences: plan defaults and Eat filtering, never picks', () => {
  it('stores normalized exclusions without counting them as picks', async () => {
    const { ctx } = await accountCtx();
    const res = await putExclusions(ctx, { food_exclusions: [' peanuts ', 'Peanuts', 'shellfish', 'raw  onion'] });
    expect(res.food_exclusions).toEqual(['peanuts', 'shellfish', 'raw onion']);
    const state = await getState(ctx);
    expect(state.food_exclusions).toEqual(['peanuts', 'shellfish', 'raw onion']);
    expect(state.state.picks_count).toBe(0);
    await expect(complete(ctx)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('defaults a movie-night plan to the account exclusions when the request states none', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    await putExclusions(ctx, { food_exclusions: ['peanuts', 'dairy'] });
    const ref = await insertReference({ name: 'Kissaten coffee culture', type: 'tradition' });
    const cap = await insertCaptureWithAnalysis(owner, { anchorIds: [ref], title: 'Café table' });
    const artist = await insertItem(owner, { kind: 'artist', title: 'Haruomi Hosono', qloo: `artist-${randomUUID()}` });
    const col = await createCollection(ctx, { name: 'Evenings' });
    for (const id of [cap.itemId, artist]) await addCollectionItem(ctx, { id: col.id, item_id: id, body: {} });
    const base = { collection_id: col.id, expected_revision: 3, item_ids: [cap.itemId, artist], template: 'movie_night' as const, exploration: 'balanced' as const };
    const plan = await createPlan(ctx, base);
    const stored = await db.query<{ constraints: { dietary_exclusions: string[] } }>('SELECT constraints FROM plans WHERE id = $1', [plan.plan_id]);
    expect(stored.rows[0]!.constraints.dietary_exclusions).toEqual(['peanuts', 'dairy']);
    // An explicit list (even empty) wins.
    const explicit = await createPlan(ctx, { ...base, constraints: { dietary_exclusions: [] } });
    const stored2 = await db.query<{ constraints: { dietary_exclusions: string[] } }>('SELECT constraints FROM plans WHERE id = $1', [explicit.plan_id]);
    expect(stored2.rows[0]!.constraints.dietary_exclusions).toEqual([]);
  });

  it('filters Eat suggestions in the feed', async () => {
    const { principal, ctx } = await accountCtx();
    const owner = { accountId: principal.accountId };
    const satay = await insertItem(owner, { kind: 'food', category: 'eat', title: 'Peanut satay skewers' });
    const salad = await insertItem(owner, { kind: 'food', category: 'eat', title: 'Cucumber salad' });
    const film = await insertItem(owner, { kind: 'film', title: 'Tampopo' });
    const cap = await insertCaptureWithAnalysis(owner, { recommendItemIds: [satay, salad, film] });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: cap.itemId });
    const ids = async () => (await getDiscoveries(ctx, { refresh: true })).items.map((c) => c.id);
    expect(await ids()).toEqual(expect.arrayContaining([satay, salad, film]));
    await putExclusions(ctx, { food_exclusions: ['peanuts'] });
    const after = await ids();
    expect(after).toEqual(expect.arrayContaining([salad, film]));
    expect(after).not.toContain(satay);
  });
});

describe('ONB-06 existing accounts see the questionnaire once at sign-in', () => {
  async function existingAccount(saves: number) {
    const principal = await insertAccount();
    const mail = email();
    await db.query('INSERT INTO account_credentials (account_id, email, password_hash) VALUES ($1, $2, $3)', [principal.accountId, mail, await hashPassword('existing password')]);
    for (let i = 0; i < saves; i++) {
      const item = await insertItem({ accountId: principal.accountId }, { kind: 'film' });
      await recordPreference(ctxFor(principal), { action: 'save', target_type: 'discovery_item', target_id: item });
    }
    return { principal, mail };
  }
  const signInAs = async (mail: string) => {
    const { ctx } = await anonCtx();
    return signIn(ctx, { email: mail, password: 'existing password', claim_session: false });
  };

  it('fewer than 3 explicit saves: required at the next sign-in, resumed until completed, then never again', async () => {
    const { principal, mail } = await existingAccount(2);
    expect((await getState(ctxFor(principal))).state.required).toBe(false); // not before signing in
    const first = await signInAs(mail);
    expect(first.onboarding_required).toBe(true);
    const ctx = ctxFor(principal);
    await pick(ctx, chips[0]!.id);
    expect((await signInAs(mail)).onboarding_required).toBe(true); // left mid-way: resumes
    await pick(ctx, chips[1]!.id);
    await pick(ctx, chips[2]!.id);
    await complete(ctx);
    expect((await signInAs(mail)).onboarding_required).toBe(false);
  });

  it('3 or more explicit saves: never shown, even after removing saves later', async () => {
    const { principal, mail } = await existingAccount(3);
    expect((await signInAs(mail)).onboarding_required).toBe(false);
    await db.query('DELETE FROM saved_items WHERE owner_account_id = $1', [principal.accountId]);
    expect((await signInAs(mail)).onboarding_required).toBe(false);
  });
});

describe('isolation across accounts', () => {
  it('picks, search results and exclusions never cross accounts', async () => {
    const a = await accountCtx();
    const b = await accountCtx();
    const res = await pick(a.ctx, multiTagImage.id);
    await putExclusions(a.ctx, { food_exclusions: ['sesame'] });

    await expect(deletePick(b.ctx, res.pick.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await getState(b.ctx))).toMatchObject({ picks: [], food_exclusions: [], state: { picks_count: 0 } });
    expect((await getCatalog(b.ctx)).images.find((i) => i.id === multiTagImage.id)).toMatchObject({ picked: false, pick_id: null });
    expect((await listTastePicks(b.ctx)).picks_count).toBe(0);
    // B picking the same image gets its own items and saves.
    const bPick = await pick(b.ctx, multiTagImage.id);
    expect(bPick.already_picked).toBe(false);
    expect(bPick.pick.discovery_item_ids.some((id) => res.pick.discovery_item_ids.includes(id))).toBe(false);

    // A search result signed for A cannot be redeemed by B.
    const token = signSearchResult(a.ctx.config.SESSION_SECRET, {
      accountId: a.principal.accountId,
      ref: { type: 'entity', id: 'E-1', name: 'Someone', subtype: 'urn:entity:artist' },
      now: new Date(),
    });
    await expect(createPick(b.ctx, { source: 'search', result_id: token })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('deleting the account deletes its onboarding data', async () => {
    const { principal, ctx } = await newAccount();
    await pick(ctx, chips[0]!.id);
    await db.query('DELETE FROM accounts WHERE id = $1', [principal.accountId]);
    const left = await db.query(
      `SELECT (SELECT count(*) FROM onboarding_states WHERE account_id = $1)::int AS s,
              (SELECT count(*) FROM onboarding_picks WHERE account_id = $1)::int AS p,
              (SELECT count(*) FROM onboarding_pick_items WHERE account_id = $1)::int AS i`,
      [principal.accountId],
    );
    expect(left.rows[0]).toEqual({ s: 0, p: 0, i: 0 });
  });
});

describe('agent scopes', () => {
  type AgentOptions = NonNullable<Parameters<typeof insertAgentConnection>[1]>;
  async function agent(account: AccountPrincipal, scopes: AgentOptions['scopes'], extra: AgentOptions = {}) {
    const { principal } = await insertAgentConnection(account, { scopes, ...extra });
    return ctxFor(principal as Principal);
  }

  it('onboarding itself is the owner’s browser step: agents are refused', async () => {
    const { principal } = await accountCtx();
    const a = await agent(principal, ['taste:read', 'taste:write', 'preferences:read', 'preferences:write']);
    for (const call of [
      () => getCatalog(a),
      () => getState(a),
      () => pick(a, chips[0]!.id),
      () => complete(a),
      () => putExclusions(a, { food_exclusions: [] }),
      () => search(a, { q: 'nina' }),
      () => getSeedStatus(a),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'scope_denied' });
    }
  });

  it('picks are readable with taste:read (whole library); exclusions only with preferences:read', async () => {
    const { principal, ctx } = await accountCtx();
    await pick(ctx, multiTagImage.id);
    await pick(ctx, chips.find((c) => c.category === 'eat')!.id);
    await putExclusions(ctx, { food_exclusions: ['pork'] });

    const owner = TastePicksResponse.parse(await listTastePicks(ctx));
    expect(owner.picks_count).toBe(2);
    expect(owner.food_exclusions).toEqual(['pork']);
    expect(owner.picks.eat).toHaveLength(multiTagImage.category === 'eat' ? 2 : 1);

    const tasteOnly = TastePicksResponse.parse(await listTastePicks(await agent(principal, ['taste:read'])));
    expect(tasteOnly.picks_count).toBe(2);
    expect(tasteOnly.food_exclusions).toBeNull();

    const both = await listTastePicks(await agent(principal, ['taste:read', 'preferences:read']));
    expect(both.food_exclusions).toEqual(['pork']);

    await expect(listTastePicks(await agent(principal, ['preferences:read']))).rejects.toMatchObject({ code: 'scope_denied' });
    const col = await createCollection(ctx, { name: 'Shared' });
    await expect(
      listTastePicks(await agent(principal, ['taste:read'], { libraryAccess: 'selected_collections', collectionIds: [col.id] })),
    ).rejects.toMatchObject({ code: 'scope_denied' });
  });

  it('exclusions are an allowlisted ordinary preference for v2 agents', async () => {
    const owner = await insertAccount();
    const ctx = testContext(owner);
    await putExclusions(ctx, { food_exclusions: ['gluten'] });
    const { createConnection } = await import('./agent-platform');
    const created = await createConnection(ctx, { client_name: 'Meal planner', scopes: ['preferences:read', 'preferences:write'] });
    const agentPrincipal = (await resolvePrincipal(db, { authorization: `Bearer ${created.credential}` }))!;
    const a = testContext(agentPrincipal);
    const prefs = await getPreferences(a);
    expect(prefs.user_set).toEqual({ food: { exclusions: ['gluten'] } });
    expect(prefs.effective.food).toEqual({ exclusions: ['gluten'] });
    const updated = await updatePreferences(a, { food: { exclusions: ['gluten', 'eggs'] } }, prefs.version);
    expect(updated.user_set.food).toEqual({ exclusions: ['gluten', 'eggs'] });
    expect((await getState(ctx)).food_exclusions).toEqual(['gluten', 'eggs']);
    // Picks stay taste: a preferences-only agent cannot read them.
    await expect(listTastePicks(a)).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(updatePreferences(a, { food: { exclusions: Array.from({ length: 13 }, (_, i) => `x${i}`) } }, updated.version)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
