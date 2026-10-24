import { describe, expect, it, vi } from 'vitest';
import { loadProviderConfig } from '../config';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import { catalogReservationMicros, createModelGateway, experimentalRoles, type RoleAccess } from './gateway';
import type { CatalogSnapshot, ModelProfile } from './profiles';
import { limits, profile, response, visionProfile } from './test-fixtures';

/**
 * Production experimental mode (style design §D.1): unqualified vision roles
 * run in any NODE_ENV under ANALYSIS_EXPERIMENTAL_ROLES, always marked
 * experimental; the demo override stays refused in production.
 */
const styleProfile: ModelProfile = {
  ...visionProfile,
  role: 'vision_style',
  version: 'style-1',
  promptVersion: 'vlm-style-v1',
  schemaVersion: 'atlas_style_reading_v1',
  maxOutputTokens: 1100,
  maxInputTokens: 17_000,
  maxInputBytes: 17_000,
  image: { maxBytes: 350_000, maxPixels: 1_048_576, maxDimension: 1024, maxCount: 1 },
  timeoutMs: 18_000,
};
const priced = (input: number, output: number): CatalogSnapshot => ({
  kind: 'concentrate-catalog-snapshot',
  fetched_at: profile.catalogSnapshotAt,
  pages: 1,
  models: [{ id: 'model-1', providers: { fixture: { pricing: [{ tokens: { input: { price: { USD: input }, units: 1_000_000 }, output: { price: { USD: output }, units: 1_000_000 } } }] } } }],
});

function gateway(env: Record<string, string>, opts: { catalog?: CatalogSnapshot | null; notices?: { role: string; access: RoleAccess }[] } = {}) {
  const notices = opts.notices ?? [];
  return createModelGateway(loadProviderConfig({ CONCENTRATE_API_KEY: 'synthetic', ...env }), {
    ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
    profiles: { vision_photo: visionProfile, vision_style: styleProfile },
    qualification: () => 'catalog-compatible',
    transport: vi.fn(async () => response),
    allowTestStore: true,
    catalog: opts.catalog === undefined ? priced(2, 10) : opts.catalog,
    onExperimental: (n) => notices.push(n),
  });
}

describe('ANALYSIS_EXPERIMENTAL_ROLES (style design §D.1)', () => {
  it('parses only known roles', () => {
    expect([...experimentalRoles({ ANALYSIS_EXPERIMENTAL_ROLES: 'vision_photo, vision_style,not_a_role' })]).toEqual(['vision_photo', 'vision_style']);
    expect(experimentalRoles({ ANALYSIS_EXPERIMENTAL_ROLES: undefined }).size).toBe(0);
  });

  it('grants runners under NODE_ENV=production, marked experimental, and logs each role', async () => {
    const notices: { role: string; access: RoleAccess }[] = [];
    const g = gateway({ NODE_ENV: 'production', ANALYSIS_EXPERIMENTAL_ROLES: 'vision_photo,vision_style' }, { notices });
    expect(g.runners.vision_photo).toBeDefined();
    expect(g.runners.vision_style).toBeDefined();
    expect([...g.experimentalRoles].sort()).toEqual(['vision_photo', 'vision_style']);
    const r = await g.readiness();
    expect(r.vision_photo).toMatchObject({ experimental: true, access: 'experimental_production', state: 'qualified' });
    expect(r.vision_style).toMatchObject({ experimental: true, access: 'experimental_production' });
    expect(notices.map((n) => `${n.role}:${n.access}`).sort()).toEqual(['vision_photo:experimental_production', 'vision_style:experimental_production']);
    expect(g.vlmStyle.id).toBe('vlm-style:concentrate:fixture/model-1');
  });

  it('still refuses the demo override in production', async () => {
    const g = gateway({ NODE_ENV: 'production', CONCENTRATE_DEMO_ALLOW_ROLES: 'vision_photo' });
    expect(g.runners.vision_photo).toBeUndefined();
    expect((await g.readiness()).vision_photo).toMatchObject({ reason: 'not_qualified', access: 'not_qualified' });
  });

  it('the static kill (ANALYSIS_EXPERIMENTAL_ENABLED=false) removes runners and readiness reports paused', async () => {
    const g = gateway({ NODE_ENV: 'production', ANALYSIS_EXPERIMENTAL_ROLES: 'vision_photo,vision_style', ANALYSIS_EXPERIMENTAL_ENABLED: 'false' });
    expect(g.runners.vision_photo).toBeUndefined();
    expect(g.runners.vision_style).toBeUndefined();
    const r = await g.readiness();
    expect(r.vision_photo).toMatchObject({ access: 'paused', experimental: true, state: 'unavailable' });
    expect(r.vision_style).toMatchObject({ access: 'paused' });
  });

  it('reports a catalog-incompatible role instead of dropping it silently', async () => {
    const notices: { role: string; access: RoleAccess }[] = [];
    const g = createModelGateway(loadProviderConfig({ CONCENTRATE_API_KEY: 'synthetic', NODE_ENV: 'production', ANALYSIS_EXPERIMENTAL_ROLES: 'vision_photo' }), {
      ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
      profiles: { vision_photo: visionProfile },
      qualification: () => 'configured',
      allowTestStore: true,
      onExperimental: (n) => notices.push(n),
    });
    expect(g.runners.vision_photo).toBeUndefined();
    expect((await g.readiness()).vision_photo).toMatchObject({ access: 'catalog_incompatible' });
    expect(notices).toEqual([{ role: 'vision_photo', access: 'catalog_incompatible' }]);
  });

  it('computes the style reservation from catalog prices and refuses a role over STYLE_MAX_CALL_USD (R-12)', async () => {
    // (17000 input + 1399 image tokens) x $2/M + 1100 x $10/M = $0.047798.
    expect(catalogReservationMicros(styleProfile, priced(2, 10), 1100)).toBe(47_798);
    expect(catalogReservationMicros(styleProfile, null)).toBeNull();
    const ok = gateway({ ANALYSIS_EXPERIMENTAL_ROLES: 'vision_style' });
    expect(ok.runners.vision_style?.profile.reservationMicros).toBe(47_798);
    const capped = gateway({ ANALYSIS_EXPERIMENTAL_ROLES: 'vision_style', STYLE_MAX_CALL_USD: '0.04' });
    expect(capped.runners.vision_style).toBeUndefined();
    expect((await capped.readiness()).vision_style).toMatchObject({ access: 'spend_cap', state: 'unavailable' });
    // No price in the catalog: never assumed.
    const unpriced = gateway({ ANALYSIS_EXPERIMENTAL_ROLES: 'vision_style' }, { catalog: null });
    expect((await unpriced.readiness()).vision_style).toMatchObject({ access: 'spend_cap' });
  });
});

describe('experimental spend bucket (style design §D.1)', () => {
  const identity = (job: string, n = 0) => ({ accountId: 'acct-1', jobId: job, attemptKey: `k${n}` });

  it('caps experimental roles per account per day and inside their own daily micros', async () => {
    const ledger = new ModelSpendLedger(new MemorySpendStore(), { ...limits, experimental: { dailyMicros: 250, accountDailyAnalyses: 2 } });
    ledger.experimentalRoles = new Set(['vision_style']);
    const style = { ...styleProfile, reservationMicros: 100 };
    await ledger.reserve(identity('j1'), style);
    await ledger.reserve(identity('j2'), style);
    // A third job for the account is refused (account daily cap) ...
    await expect(ledger.reserve(identity('j3'), style)).rejects.toMatchObject({ kind: 'budget_exhausted' });
    // ... and a second call in an existing job is refused by the daily bucket (300 > 250).
    await expect(ledger.reserve(identity('j2', 1), style)).rejects.toMatchObject({ kind: 'budget_exhausted' });
    // Qualified roles are not charged to the experimental bucket.
    await expect(ledger.reserve(identity('j3', 2), { ...profile, reservationMicros: 100 })).resolves.toBeTruthy();
    expect(await ledger.canReserveAll({ accountId: 'acct-1', jobId: 'j4' }, [style])).toBe(false);
  });
});
