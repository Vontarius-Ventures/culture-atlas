import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FIDELITY_FEED, seedFidelity } from './seed-fidelity';
import { createServiceContext, loadDomainConfig, type Principal } from '../packages/domain/src';
import type { PoolDb } from '../packages/domain/src/db/pool';
import { signIn } from '../packages/domain/src/services/accounts';
import { getTasteRevision } from '../packages/domain/src/services/taste';
import { buildSavedPool, getDiscoveries } from '../packages/domain/src/services/discovery';
import { getItem } from '../packages/domain/src/services/items';
import { createIsolatedDatabase, insertAccount, insertAnonymousSession, testProviders, type IsolatedDatabase } from '../packages/domain/src/testing';

describe('truthful fidelity fixtures on the real feed/card contract', () => {
  let isolated: IsolatedDatabase;
  let db: PoolDb;
  let productionContext: (principal: Principal, now?: () => Date) => ReturnType<typeof createServiceContext>;
  let seed: Awaited<ReturnType<typeof seedFidelity>>;
  beforeAll(async () => {
    isolated = await createIsolatedDatabase('fidelity');
    db = isolated.db;
    // Exercise the actual production config loader/default compiler and web
    // service surface, not testConfig defaults. Only provider transports are
    // replaced; the database, auth/claim, taste and feed services are real.
    const config = loadDomainConfig({
      NODE_ENV: 'production',
      DATABASE_URL: isolated.url,
      APP_BASE_URL: 'https://127.0.0.1:4473',
      SESSION_SECRET: 'fixture-production-session-secret-not-a-live-secret',
    });
    const providers = testProviders();
    productionContext = (principal, now) => createServiceContext(principal, {
      db, config, providers, surface: 'web', now,
    });
  });
  beforeEach(async () => { seed = await seedFidelity(db, productionContext); });
  afterAll(async () => { await isolated?.drop(); });

  const ctx = () => productionContext({
    kind: 'account', accountId: seed.account_id, sessionId: null, isDemoOwner: false,
  });

  it('renders eight ordered example cards without claiming provider or personal-pool provenance', async () => {
    const result = await getDiscoveries(ctx(), { refresh: false });
    expect(result.feed_id).toBe(seed.feed_id);
    expect(result.is_example_feed).toBe(true);
    expect(result.items.map((item) => item.title)).toEqual(FIDELITY_FEED.map((item) => item.title));
    expect(result.items.every((item) => item.is_example && !item.saved && item.recommendation_id === null)).toBe(true);
    expect(await buildSavedPool(db, { kind: 'account', accountId: seed.account_id })).toEqual([]);
    const origins = await db.query<{ origin: string }>(
      `SELECT DISTINCT r.origin FROM recommendations r
       JOIN discovery_jobs dj ON dj.id = r.discovery_job_id WHERE dj.owner_account_id = $1`,
      [seed.account_id],
    );
    expect(origins.rows.map((r) => r.origin)).toEqual(['sample']);
    const queries = await db.query(
      `SELECT pq.id FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id
       JOIN captures c ON c.id = a.capture_id WHERE c.owner_account_id = $1`,
      [seed.account_id],
    );
    expect(queries.rows).toEqual([]);
  });

  it('serves honest category filters and stable cursor pagination from the same example fixture', async () => {
    for (const category of ['wear', 'play', 'watch', 'eat'] as const) {
      const result = await getDiscoveries(ctx(), { refresh: false, category });
      expect(result.is_example_feed).toBe(true);
      expect(result.items.map((item) => item.title)).toEqual(FIDELITY_FEED.filter((item) => item.category === category).map((item) => item.title));
    }
    const first = await getDiscoveries(ctx(), { refresh: false, limit: 3 });
    expect(first.next_cursor).not.toBeNull();
    const next = await getDiscoveries(ctx(), { refresh: false, limit: 5, cursor: first.next_cursor! });
    expect([...first.items, ...next.items].map((item) => item.title)).toEqual(FIDELITY_FEED.map((item) => item.title));
    expect(next.next_cursor).toBeNull();
  });

  it('keeps item detail and related examples usable without relabeling them as Qloo results', async () => {
    const item = await getItem(ctx(), { id: seed.items.vintage_racing, query: {} });
    expect(item.item.is_example).toBe(true);
    expect(item.item.saved).toBe(false);
    expect(item.related.map((card) => card.title)).toEqual(['Sunday listening', 'Night on film', 'A softer silhouette']);
    expect(item.related.every((card) => card.is_example)).toBe(true);
  });

  it('does not leak the account-scoped snapshot to another owner', async () => {
    const other = await insertAccount(db);
    const result = await getDiscoveries(productionContext(other), { refresh: false });
    expect(result.feed_id).not.toBe(seed.feed_id);
    expect(result.items.some((item) => item.id === seed.items.vintage_racing)).toBe(false);
  });

  it('expires rather than admitting fixture cards into the generated personal pool', async () => {
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const result = await getDiscoveries(productionContext(ctx().principal, () => later), { refresh: false });
    expect(result.feed_id).not.toBe(seed.feed_id);
    expect(result.is_example_feed).toBe(true);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.some((item) => item.id === seed.items.vintage_racing)).toBe(false);
  });

  it('preserves the curated snapshot across real fixture sign-ins; default anonymous claiming invalidates it', async () => {
    const owner = { kind: 'account' as const, accountId: seed.account_id };
    const revision = await getTasteRevision(db, owner);
    expect(seed.sign_in).toEqual({ claim_session: false });
    for (let i = 0; i < 3; i++) {
      const anonymous = await insertAnonymousSession(db);
      const signedIn = await signIn(productionContext(anonymous), {
        email: seed.email, password: seed.password, ...seed.sign_in,
      });
      expect(await getTasteRevision(db, owner)).toBe(revision);
      const principal = {
        kind: 'account' as const, accountId: seed.account_id,
        sessionId: signedIn.principal.session_id, isDemoOwner: false,
      };
      const result = await getDiscoveries(productionContext(principal), { refresh: false });
      expect(result.feed_id).toBe(seed.feed_id);
      expect(result.items.map((item) => item.title)).toEqual(FIDELITY_FEED.map((item) => item.title));
      expect(result.items.every((item) => item.is_example && item.recommendation_id === null)).toBe(true);
    }
    // Prove the original live failure mode, without changing production's
    // correct cache invalidation or mutating taste revisions behind its back.
    const anonymous = await insertAnonymousSession(db);
    await signIn(productionContext(anonymous), {
      email: seed.email, password: seed.password, claim_session: true,
    });
    expect(await getTasteRevision(db, owner)).toBe(revision + 1);
    const claimedFeed = await getDiscoveries(ctx(), { refresh: false });
    expect(claimedFeed.feed_id).not.toBe(seed.feed_id);
    expect(claimedFeed.items.some((item) => item.id === seed.items.vintage_racing)).toBe(false);
  });
});
