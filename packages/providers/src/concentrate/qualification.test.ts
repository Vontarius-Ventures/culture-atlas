import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadProviderConfig } from '../config';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import { createModelGateway } from './gateway';
import {
  CATALOG_SNAPSHOT_FILE,
  profileHash,
  qualificationState,
  type QualificationArtifact,
} from './profiles';
import { limits, profile, response, visionProfile } from './test-fixtures';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function dir() {
  const d = await mkdtemp(path.join(os.tmpdir(), 'ca-qual-'));
  dirs.push(d);
  return d;
}
const snapshot = {
  kind: 'concentrate-catalog-snapshot',
  fetched_at: profile.catalogSnapshotAt,
  pages: 2,
  models: [
    { id: 'fixture/model-1', providers: [{ name: 'fixture', capabilities: ['text', 'vision'] }] },
    { id: 'other/model' },
  ],
};
function artifact(
  p = profile,
  overrides: Partial<QualificationArtifact> = {},
): QualificationArtifact {
  return {
    kind: 'concentrate-qualification',
    artifact_id: p.qualificationArtifactId,
    created_at: '2026-10-16T00:00:00Z',
    role: p.role,
    model: p.model,
    provider: p.provider,
    profile_hash: profileHash(p),
    catalog_snapshot_at: p.catalogSnapshotAt,
    result: 'pass',
    requests_sent: 12,
    spend_cap_micros: 2_000_000,
    fixtures: { total: 10, passed: 10, failed: 0, outcomes: { complete: 10 } },
    latency_ms: { p50: 900, p95: 2100 },
    usage: { input_tokens: 9000, output_tokens: 1500, unknown_usage_attempts: 0 },
    notes: [],
    ...overrides,
  };
}

describe('readiness without paid probes: configured -> catalog-compatible -> qualified', () => {
  it('derives each state from local evidence only', async () => {
    const d = await dir();
    expect(qualificationState(profile, undefined)).toBe('configured');
    expect(qualificationState(profile, d)).toBe('configured');
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    expect(qualificationState(profile, d)).toBe('catalog-compatible');
    await writeFile(
      path.join(d, `${profile.qualificationArtifactId}.json`),
      JSON.stringify(artifact()),
    );
    expect(qualificationState(profile, d)).toBe('qualified');
  });

  it.each([
    ['a different profile (hash mismatch)', { ...profile, maxOutputTokens: 999 }, artifact()],
    ['a failing run', profile, artifact(profile, { result: 'fail' })],
    [
      'any failed fixture',
      profile,
      artifact(profile, { fixtures: { total: 10, passed: 9, failed: 1, outcomes: {} } }),
    ],
    [
      'too few fixtures',
      profile,
      artifact(profile, { fixtures: { total: 2, passed: 2, failed: 0, outcomes: {} } }),
    ],
  ])('refuses qualification for %s', async (_, p, a) => {
    const d = await dir();
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    await writeFile(path.join(d, `${profile.qualificationArtifactId}.json`), JSON.stringify(a));
    expect(qualificationState(p, d)).toBe('catalog-compatible');
  });

  it('requires the model id and provider in the snapshot the profile names', async () => {
    const d = await dir();
    await writeFile(
      path.join(d, CATALOG_SNAPSHOT_FILE),
      JSON.stringify({ ...snapshot, fetched_at: '2026-10-01T00:00:00Z' }),
    );
    expect(qualificationState(profile, d)).toBe('configured');
    await writeFile(
      path.join(d, CATALOG_SNAPSHOT_FILE),
      JSON.stringify({
        ...snapshot,
        models: [{ id: 'fixture/model-1', providers: [{ name: 'someone-else' }] }],
      }),
    );
    expect(qualificationState(profile, d)).toBe('configured');
  });

  it('gateway dispatches only qualified roles and reports every role read-only', async () => {
    const d = await dir();
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    await writeFile(
      path.join(d, `${profile.qualificationArtifactId}.json`),
      JSON.stringify(artifact()),
    );
    const transport = vi.fn(async () => response);
    const gateway = createModelGateway(
      loadProviderConfig({ CONCENTRATE_API_KEY: 'synthetic', CONCENTRATE_QUALIFICATION_DIR: d }),
      {
        ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
        profiles: { research_text: profile, vision_photo: visionProfile },
        transport,
        allowTestStore: true,
      },
    );
    expect(gateway.runners.research_text).toBeDefined();
    // Same artifact id but a different profile hash: catalog-compatible, not dispatchable.
    expect(gateway.runners.vision_photo).toBeUndefined();
    expect(gateway.vlm.capability().status).toBe('unavailable');
    await expect(gateway.readiness()).resolves.toEqual({
      vision_photo: {
        role: 'vision_photo',
        model: 'fixture/model-1',
        state: 'catalog-compatible',
        reason: 'not_qualified',
      },
      vision_video_frame: {
        role: 'vision_video_frame',
        model: null,
        state: 'unavailable',
        reason: 'not_configured',
      },
      research_text: { role: 'research_text', model: 'fixture/model-1', state: 'qualified' },
      composer: { role: 'composer', model: null, state: 'unavailable', reason: 'not_configured' },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('accepts profiles inline from a hosted secret/parameter value', () => {
    const gateway = createModelGateway(
      loadProviderConfig({
        CONCENTRATE_API_KEY: 'synthetic',
        CONCENTRATE_PROFILES_JSON: JSON.stringify([profile]),
      }),
      {
        ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
        qualification: () => 'qualified',
        allowTestStore: true,
      },
    );
    expect(gateway.runners.research_text?.profile.model).toBe('fixture/model-1');
  });
});
