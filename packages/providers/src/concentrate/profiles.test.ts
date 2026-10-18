import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MODEL_ROLES } from './gateway';
import {
  MODEL_ROLE_VALUES,
  ModelProfileSchema,
  QUALIFICATION_MINIMUM_FIXTURES,
  QualificationArtifactSchema,
  parseModelProfiles,
  profileHash,
  type ModelProfile,
} from './profiles';
import { profile, visionProfile } from './test-fixtures';

const enrichProfile: ModelProfile = {
  ...visionProfile,
  role: 'vision_photo_enrich',
  maxOutputTokens: 1200,
  timeoutMs: 20_000,
  reasoningEffort: 'none',
};

describe('model profile amendment 2.2 contract', () => {
  it('accepts an optional reasoning effort from the fixed set only', () => {
    expect(ModelProfileSchema.parse(profile).reasoningEffort).toBeUndefined();
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high'] as const)
      expect(ModelProfileSchema.parse({ ...profile, reasoningEffort: effort }).reasoningEffort).toBe(
        effort,
      );
    expect(ModelProfileSchema.safeParse({ ...profile, reasoningEffort: 'max' }).success).toBe(false);
    expect(ModelProfileSchema.safeParse({ ...profile, reasoningEffort: null }).success).toBe(false);
  });

  it('binds the effort into the profile hash, so an artifact never qualifies another effort', () => {
    const none = { ...profile, reasoningEffort: 'none' as const };
    const low = { ...profile, reasoningEffort: 'low' as const };
    expect(profileHash(none)).not.toBe(profileHash(profile));
    expect(profileHash(none)).not.toBe(profileHash(low));
    expect(profileHash({ ...none })).toBe(profileHash(none));
  });

  it('adds the vision_photo_enrich role with vision image rules', () => {
    expect(ModelProfileSchema.parse(enrichProfile).role).toBe('vision_photo_enrich');
    expect(
      ModelProfileSchema.safeParse({
        ...enrichProfile,
        image: { maxBytes: 0, maxPixels: 0, maxDimension: 0, maxCount: 0 },
      }).success,
    ).toBe(false);
    expect(QUALIFICATION_MINIMUM_FIXTURES.vision_photo_enrich).toBe(10);
    expect(
      QualificationArtifactSchema.shape.role.safeParse('vision_photo_enrich').success,
    ).toBe(true);
    expect([...MODEL_ROLES].sort()).toEqual([...MODEL_ROLE_VALUES].sort());
  });

  it('parses one profile per role, at most five', () => {
    const five = MODEL_ROLE_VALUES.map((role) =>
      role.startsWith('vision_') ? { ...visionProfile, role } : { ...profile, role },
    );
    expect(Object.keys(parseModelProfiles(five)).sort()).toEqual([...MODEL_ROLE_VALUES].sort());
    expect(() => parseModelProfiles([...five, profile])).toThrow();
    expect(() => parseModelProfiles([profile, profile])).toThrow('Duplicate model role');
  });

  it('every ledger role CHECK (latest migration) lists exactly the model roles', async () => {
    const dir = new URL('../../../../db/migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const latest: Record<string, string[]> = {};
    for (const file of files) {
      const sql = await readFile(new URL(file, dir), 'utf8');
      for (const table of ['inference_attempts', 'model_gateway_attempts']) {
        const re = new RegExp(
          `(?:CREATE TABLE ${table}|ALTER TABLE ${table} ADD CONSTRAINT ${table}_role_check)[\\s\\S]*?role IN \\(([^)]*)\\)`,
        );
        const m = re.exec(sql);
        if (m) latest[table] = m[1]!.match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
      }
    }
    expect(Object.keys(latest).sort()).toEqual(['inference_attempts', 'model_gateway_attempts']);
    for (const roles of Object.values(latest))
      expect([...roles].sort()).toEqual([...MODEL_ROLE_VALUES].sort());
  });
});
