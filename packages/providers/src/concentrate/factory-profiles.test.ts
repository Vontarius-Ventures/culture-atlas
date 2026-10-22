import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, loadProviderConfig } from '../config';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import { resolveFromWorkspace } from '../paths';
import { PINNED_CONCENTRATE_ROUTES, selectPinnedConcentrateRoutes } from './catalog';
import { createModelGateway } from './gateway';
import {
  CatalogSnapshotSchema,
  catalogCompatible,
  catalogZdrListed,
  loadModelProfiles,
  parseModelProfiles,
  profileHash,
  qualificationState,
} from './profiles';
import { limits } from './test-fixtures';

const QUAL_DIR = resolveFromWorkspace('fixtures/concentrate');
const PINNED_VISION = 'anthropic/claude-haiku-5-5';
const PINNED_PROVIDER = 'anthropic';

describe('factory catalog-pinned Concentrate profiles (offline)', () => {
  const snapshot = CatalogSnapshotSchema.parse(
    JSON.parse(readFileSync(`${QUAL_DIR}/catalog-snapshot.json`, 'utf8')),
  );
  const profiles = loadModelProfiles(`${QUAL_DIR}/profiles.json`);

  it('keeps Concentrate default model ids empty', () => {
    expect(DEFAULT_MODELS.concentrate).toEqual({ vlm: '', text: '' });
    expect(loadProviderConfig({ LLM_PROVIDER: 'concentrate' }).VLM_MODEL).toBe('');
  });

  it('pins live catalog ids that list JPEG input, json_schema and ZDR', () => {
    expect(Object.keys(profiles).sort()).toEqual([
      'composer',
      'research_text',
      'vision_photo',
      'vision_photo_enrich',
      'vision_video_frame',
    ]);
    for (const profile of Object.values(profiles)) {
      expect(profile.model).toBe(PINNED_VISION);
      expect(profile.provider).toBe(PINNED_PROVIDER);
      expect(profile.requireZdr).toBe(true);
      expect(profile.providerZdrEligible).toBe(true);
      expect(profile.contentLoggingEnabled).toBe(false);
      expect(profile.structuredOutput).toBe(true);
      expect(profile.catalogSnapshotAt).toBe(snapshot.fetched_at);
      expect(catalogCompatible(profile, snapshot)).toBe(true);
      expect(catalogZdrListed(profile, snapshot)).toBe(true);
      expect(profileHash(profile)).toMatch(/^[0-9a-f]{64}$/);
    }
    const haiku = snapshot.models.find((m) => m.id === 'claude-haiku-5-5') as {
      capabilities?: { image_input?: { supported?: boolean }; structured_outputs?: { supported?: boolean } };
      providers?: Record<string, { supports?: { input?: { image?: unknown }; text?: { format?: { json_schema?: boolean } } } }>;
    };
    expect(haiku?.capabilities?.image_input?.supported).toBe(true);
    expect(haiku?.capabilities?.structured_outputs?.supported).toBe(true);
    expect(haiku?.providers?.[PINNED_PROVIDER]?.supports?.text?.format?.json_schema).toBe(true);
    const image = haiku?.providers?.[PINNED_PROVIDER]?.supports?.input?.image;
    expect(image).toMatchObject({ jpg: true });
    const pins = selectPinnedConcentrateRoutes(snapshot);
    expect(pins?.vision.model).toBe(PINNED_CONCENTRATE_ROUTES.vision.model);
    expect(pins?.text.model).toBe(PINNED_CONCENTRATE_ROUTES.text.model);
  });

  it('qualifies the text roles from live artifacts and keeps photo roles catalog-compatible', () => {
    expect(qualificationState(profiles.vision_photo!, QUAL_DIR)).toBe('catalog-compatible');
    expect(qualificationState(profiles.vision_photo_enrich!, QUAL_DIR)).toBe('catalog-compatible');
    expect(qualificationState(profiles.vision_video_frame!, QUAL_DIR)).toBe('catalog-compatible');
    expect(qualificationState(profiles.research_text!, QUAL_DIR)).toBe('qualified');
    expect(qualificationState(profiles.composer!, QUAL_DIR)).toBe('qualified');
    const gateway = createModelGateway(
      loadProviderConfig({
        LLM_PROVIDER: 'concentrate',
        CONCENTRATE_API_KEY: 'synthetic',
        CONCENTRATE_PROFILE_FILE: `${QUAL_DIR}/profiles.json`,
        CONCENTRATE_QUALIFICATION_DIR: QUAL_DIR,
      }),
      {
        ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
        allowTestStore: true,
      },
    );
    expect(gateway.runners.vision_photo).toBeUndefined();
    expect(gateway.runners.research_text).toBeDefined();
    expect(gateway.runners.composer).toBeDefined();
    expect(gateway.vlm.capability()).toMatchObject({
      status: 'unverified',
      reason: 'probe_pending',
      provider: `concentrate:${PINNED_VISION}`,
    });
    expect(gateway.text.capability()).toMatchObject({
      status: 'unverified',
      reason: 'probe_pending',
      provider: `concentrate:${PINNED_VISION}`,
    });
    expect(gateway.text.id).toBe(`text:concentrate:${PINNED_VISION}`);
  });

  it('rejects duplicate roles and empty model ids', () => {
    expect(() => parseModelProfiles([{ ...profiles.research_text!, role: 'composer' }, profiles.composer])).toThrow();
    expect(() =>
      parseModelProfiles([{ ...profiles.research_text!, model: '' }]),
    ).toThrow();
  });
});
