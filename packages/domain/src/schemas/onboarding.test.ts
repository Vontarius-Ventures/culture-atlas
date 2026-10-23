import { describe, expect, it } from 'vitest';
import { authorizeOperation } from '../authz';
import { exclusionTerms } from '../composer/dietary';
import { JOB_TYPES } from '../enums';
import { JobPayloads, interestExpandDedupeKey, tasteSeedDedupeKey } from '../jobs';
import type { JobContext } from '../jobs/handler';
import { JOB_HANDLERS } from '../pipeline';
import type { AccountPrincipal, AgentPrincipal, AnonymousPrincipal } from '../principal';
import {
  CreatePickRequest,
  FOOD_EXCLUSION_SUGGESTIONS,
  FoodExclusions,
  OnboardingCatalogFile,
  OnboardingCatalogItem,
  OnboardingState,
  PutExclusionsRequest,
  TasteSeedStatus,
} from './onboarding';
import { ROUTES } from './routes';

const retrieved = '2026-10-18T12:00:00Z';
const tag = (id: string, name: string) => ({ type: 'tag' as const, id, name, subtype: 'urn:tag:style:qloo' });
const image = { url: '/onboarding/tea.jpg', width: 800, height: 1000, alt: 'A tea ceremony table', license: 'CC BY 4.0' };
const imageItem = {
  id: 'img-tea-ritual',
  kind: 'image' as const,
  category: 'eat' as const,
  label: 'Tea ritual',
  qloo: [tag('urn:tag:style:qloo:wabi_sabi', 'Wabi Sabi'), tag('urn:tag:genre:qloo:tea', 'Japanese Tea Ceremony')],
  image,
  retrieved_at: retrieved,
};
const chip = {
  id: 'chip-wear-japandi',
  kind: 'chip' as const,
  category: 'wear' as const,
  label: 'Japandi',
  qloo: [tag('urn:tag:style:qloo:japandi', 'Japandi')],
  retrieved_at: retrieved,
};

describe('onboarding catalog contract', () => {
  it('ties images to 1-3 real Qloo refs and chips to exactly one', () => {
    expect(OnboardingCatalogItem.parse(imageItem).qloo).toHaveLength(2);
    expect(OnboardingCatalogItem.parse(chip).kind).toBe('chip');
    expect(OnboardingCatalogItem.safeParse({ ...imageItem, image: undefined }).success).toBe(false);
    expect(OnboardingCatalogItem.safeParse({ ...chip, image }).success).toBe(false);
    expect(OnboardingCatalogItem.safeParse({ ...chip, qloo: [...chip.qloo, ...chip.qloo] }).success).toBe(false);
    expect(OnboardingCatalogItem.safeParse({ ...imageItem, qloo: [] }).success).toBe(false);
    const four = Array.from({ length: 4 }, (_, i) => tag(`urn:tag:x:${i}`, `t${i}`));
    expect(OnboardingCatalogItem.safeParse({ ...imageItem, qloo: four }).success).toBe(false);
    expect(OnboardingCatalogItem.safeParse({ ...chip, category: 'listen' }).success).toBe(false);
    expect(OnboardingCatalogItem.safeParse({ ...chip, retrieved_at: 'yesterday' }).success).toBe(false);
  });

  it('rejects duplicate ids in the catalog file', () => {
    const file = { kind: 'onboarding-catalog', catalog_version: '2026-10-18.1', retrieved_at: retrieved, items: [imageItem, chip] };
    expect(OnboardingCatalogFile.parse(file).items).toHaveLength(2);
    expect(OnboardingCatalogFile.safeParse({ ...file, items: [chip, chip] }).success).toBe(false);
  });
});

describe('pick and exclusion requests', () => {
  it('accept a catalog id or a server-issued search token, nothing client-invented', () => {
    expect(CreatePickRequest.parse({ source: 'catalog', catalog_item_id: 'chip-wear-japandi' }).source).toBe('catalog');
    expect(CreatePickRequest.safeParse({ source: 'search', result_id: 'v1.' + 'a'.repeat(40) }).success).toBe(true);
    // A client cannot submit its own Qloo id/name.
    expect(CreatePickRequest.safeParse({ source: 'search', result_id: 'v1.' + 'a'.repeat(40), qloo_id: 'x' }).success).toBe(false);
    expect(CreatePickRequest.safeParse({ source: 'pending_save', catalog_item_id: 'chip-wear-japandi' }).success).toBe(false);
    expect(CreatePickRequest.safeParse({ source: 'catalog', catalog_item_id: '../etc' }).success).toBe(false);
  });

  it('use the plan-constraint limits and suggest only terms the composer understands', () => {
    expect(PutExclusionsRequest.parse({ food_exclusions: [' peanuts '] }).food_exclusions).toEqual(['peanuts']);
    expect(FoodExclusions.safeParse(Array.from({ length: 13 }, (_, i) => `x${i}`)).success).toBe(false);
    expect(FoodExclusions.safeParse(['x'.repeat(41)]).success).toBe(false);
    expect(FoodExclusions.safeParse([...FOOD_EXCLUSION_SUGGESTIONS]).success).toBe(true);
    for (const term of FOOD_EXCLUSION_SUGGESTIONS) expect(exclusionTerms(term).length, term).toBeGreaterThan(1);
  });

  it('keep the minimum at 3 and seed status honest', () => {
    const state = { required: true, picks_count: 1, min_picks: 3, started_at: retrieved, completed_at: null, catalog_version: '1' };
    expect(OnboardingState.parse(state).min_picks).toBe(3);
    expect(OnboardingState.safeParse({ ...state, min_picks: 2 }).success).toBe(false);
    const seed = {
      job_id: null, state: 'not_started', first_ready_at: null, poll_after_ms: null,
      categories: [{ category: 'wear', state: 'empty', card_count: 0, ready_at: null }],
    };
    expect(TasteSeedStatus.parse(seed).categories[0]!.state).toBe('empty');
    expect(TasteSeedStatus.safeParse({ ...seed, categories: [{ ...seed.categories[0], state: 'example' }] }).success).toBe(false);
  });
});

describe('onboarding routes', () => {
  const account: AccountPrincipal = { kind: 'account', accountId: 'a1', sessionId: 's1', isDemoOwner: false };
  const anon: AnonymousPrincipal = { kind: 'anonymous', sessionId: 's2', expiresAt: new Date() };
  const agent: AgentPrincipal = {
    kind: 'agent', accountId: 'a1', connectionId: 'c1', clientName: 'demo', purpose: 'agent',
    scopes: ['taste:read', 'taste:write', 'preferences:read', 'preferences:write'], libraryAccess: 'all',
    allowedCollectionIds: [], sensorConnectionId: null, expiresAt: new Date(Date.now() + 1e6),
  };
  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (err) {
      return (err as { code: string }).code;
    }
  };

  it('registers every /v1/onboarding/* and /v1/taste/picks route', () => {
    const have = new Set(Object.values(ROUTES).map((r) => `${r.method} ${r.path}`));
    for (const route of [
      'GET /v1/onboarding/catalog', 'GET /v1/onboarding/search', 'POST /v1/onboarding/picks',
      'DELETE /v1/onboarding/picks/{id}', 'PUT /v1/onboarding/exclusions', 'POST /v1/onboarding/complete',
      'GET /v1/onboarding/state', 'GET /v1/onboarding/seed', 'GET /v1/taste/picks', 'POST /v1/taste/picks',
      'DELETE /v1/taste/picks/{id}',
    ]) expect(have, route).toContain(route);
  });

  it('keeps the questionnaire to the account owner; agents only read picks with taste:read', () => {
    const owned = Object.entries(ROUTES).filter(([, r]) => r.path.startsWith('/v1/onboarding/'));
    expect(owned).toHaveLength(8);
    for (const [name, route] of [...owned, ['createTastePick', ROUTES.createTastePick], ['deleteTastePick', ROUTES.deleteTastePick]] as const) {
      expect(code(() => authorizeOperation(account, route)), name).toBeNull();
      expect(code(() => authorizeOperation(anon, route)), name).toBe('account_required');
      expect(code(() => authorizeOperation(agent, route)), name).toBe('scope_denied');
      if (route.method !== 'GET') expect(route.idempotent, name).toBe(true);
    }
    expect(code(() => authorizeOperation(account, ROUTES.listTastePicks))).toBeNull();
    expect(code(() => authorizeOperation(agent, ROUTES.listTastePicks))).toBeNull();
    expect(code(() => authorizeOperation({ ...agent, scopes: ['preferences:read'] }, ROUTES.listTastePicks))).toBe('scope_denied');
    expect(code(() => authorizeOperation(anon, ROUTES.listTastePicks))).toBe('account_required');
  });
});

describe('taste_seed job type', () => {
  it('is registered with a payload schema, a dedupe key and a handler', () => {
    expect(JOB_TYPES).toContain('taste_seed');
    const payload = JobPayloads.taste_seed.parse({ taste_revision: 4, catalog_version: '2026-10-18.1' });
    expect(payload.categories).toEqual(['wear', 'play', 'watch', 'eat']);
    expect(JobPayloads.taste_seed.safeParse({ taste_revision: 4, catalog_version: null, categories: [] }).success).toBe(false);
    const owner = { kind: 'account' as const, accountId: 'a1' };
    const key = tasteSeedDedupeKey({ owner, tasteRevision: 4 });
    expect(key).toMatch(/^taste_seed:[0-9a-f]{64}$/);
    expect(tasteSeedDedupeKey({ owner, tasteRevision: 4 })).toBe(key);
    expect(tasteSeedDedupeKey({ owner, tasteRevision: 5 })).not.toBe(key);
    expect(tasteSeedDedupeKey({ owner: { kind: 'account', accountId: 'a2' }, tasteRevision: 4 })).not.toBe(key);
    expect(JOB_HANDLERS.taste_seed).toBeTypeOf('function');
  });

  it('refuses, without retry, a seed that has no account to seed (nothing is ever pretended)', async () => {
    // Behavioural coverage of the real handler (request caps, 429/empty/timeouts,
    // no fabrication) is in apps/worker/src/taste-seed.test.ts.
    const ctx = { job: { owner_account_id: null } } as unknown as JobContext<'taste_seed'>;
    await expect(JOB_HANDLERS.taste_seed(ctx)).rejects.toMatchObject({ code: 'invalid_input', retryable: false });
  });
});

describe('interest_expand job type', () => {
  it('is registered with a payload schema, a wave-bucketed dedupe key and a handler', () => {
    expect(JOB_TYPES).toContain('interest_expand');
    const payload = JobPayloads.interest_expand.parse({ wave: 12, category: 'play' });
    expect(payload).toEqual({ wave: 12, category: 'play' });
    expect(JobPayloads.interest_expand.safeParse({ wave: -1, category: 'play' }).success).toBe(false);
    const owner = { kind: 'account' as const, accountId: 'a1' };
    const key = interestExpandDedupeKey({ owner, wave: 12 });
    expect(key).toMatch(/^interest_expand:[0-9a-f]{64}$/);
    expect(interestExpandDedupeKey({ owner, wave: 12 })).toBe(key);
    expect(interestExpandDedupeKey({ owner, wave: 13 })).not.toBe(key);
    expect(JOB_HANDLERS.interest_expand).toBeTypeOf('function');
  });

  it('refuses, without retry, an expand that has no account (nothing is ever pretended)', async () => {
    const ctx = { job: { owner_account_id: null } } as unknown as JobContext<'interest_expand'>;
    await expect(JOB_HANDLERS.interest_expand(ctx)).rejects.toMatchObject({ code: 'invalid_input', retryable: false });
  });
});
