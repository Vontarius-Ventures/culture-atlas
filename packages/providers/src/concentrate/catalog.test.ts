import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveFromWorkspace } from '../paths';
import {
  PINNED_CONCENTRATE_ROUTES,
  listEligibleConcentrateRoutes,
  selectPinnedConcentrateRoutes,
} from './catalog';
import { CatalogSnapshotSchema } from './profiles';

const fixture = CatalogSnapshotSchema.parse(
  JSON.parse(
    readFileSync(new URL('./fixtures/catalog-eligible.json', import.meta.url), 'utf8'),
  ),
);

describe('Concentrate catalog route selection (offline fixture)', () => {
  it('lists only ZDR-object routes with structured output, and JPEG for vision', () => {
    const eligible = listEligibleConcentrateRoutes(fixture);
    expect(eligible.map((r) => r.model).sort()).toEqual([
      'anthropic/claude-haiku-5-5',
      'fixture/fixture-text-only',
      'fixture/fixture-vision-no-jpeg',
      'vertex/gemini-2.5-flash',
    ]);
    expect(eligible.find((r) => r.model === 'anthropic/claude-haiku-5-5')).toMatchObject({
      vision: true,
      structured: true,
    });
    expect(eligible.find((r) => r.model === 'vertex/gemini-2.5-flash')?.vision).toBe(true);
    expect(eligible.find((r) => r.model === 'fixture/fixture-text-only')?.vision).toBe(false);
    expect(eligible.find((r) => r.model === 'fixture/fixture-vision-no-jpeg')?.vision).toBe(false);
    expect(eligible.some((r) => r.id === 'claude-fable-5-1')).toBe(false);
    expect(eligible.some((r) => r.provider === 'ai-studio')).toBe(false);
    expect(eligible.some((r) => r.provider === 'vertex' && r.id === 'claude-haiku-5-5')).toBe(false);
  });

  it('pins the live-qualified haiku route when it is still eligible', () => {
    const pins = selectPinnedConcentrateRoutes(fixture);
    expect(pins).toEqual({
      vision: {
        model: PINNED_CONCENTRATE_ROUTES.vision.model,
        provider: PINNED_CONCENTRATE_ROUTES.vision.provider,
        id: PINNED_CONCENTRATE_ROUTES.vision.id,
        vision: true,
        structured: true,
      },
      text: {
        model: PINNED_CONCENTRATE_ROUTES.text.model,
        provider: PINNED_CONCENTRATE_ROUTES.text.provider,
        id: PINNED_CONCENTRATE_ROUTES.text.id,
        vision: true,
        structured: true,
      },
    });
  });

  it('fails closed when no ZDR-eligible vision route exists', () => {
    const noVision = {
      ...fixture,
      models: fixture.models.filter((m) => m.id === 'fixture-text-only' || m.id === 'claude-fable-5-1'),
    };
    expect(selectPinnedConcentrateRoutes(noVision)).toBeNull();
    expect(listEligibleConcentrateRoutes({ ...fixture, models: [] })).toEqual([]);
  });

  it('selects the same pin from the committed live catalog snapshot', () => {
    const live = CatalogSnapshotSchema.parse(
      JSON.parse(readFileSync(resolveFromWorkspace('fixtures/concentrate/catalog-snapshot.json'), 'utf8')),
    );
    expect(live.fetched_at).toBe(PINNED_CONCENTRATE_ROUTES.catalogFetchedAt);
    const pins = selectPinnedConcentrateRoutes(live);
    expect(pins?.vision.model).toBe(PINNED_CONCENTRATE_ROUTES.vision.model);
    expect(pins?.text.model).toBe(PINNED_CONCENTRATE_ROUTES.text.model);
    expect(pins?.vision.vision).toBe(true);
  });

  it('falls back to another eligible vision route when the preferred pin is absent', () => {
    const withoutHaiku = {
      ...fixture,
      models: fixture.models.filter((m) => m.id !== 'claude-haiku-5-5'),
    };
    const pins = selectPinnedConcentrateRoutes(withoutHaiku);
    expect(pins?.vision.model).toBe('vertex/gemini-2.5-flash');
    expect(pins?.text.model).toBe('vertex/gemini-2.5-flash');
  });
});
