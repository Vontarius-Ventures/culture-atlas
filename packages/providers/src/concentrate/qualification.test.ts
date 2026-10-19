import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadProviderConfig } from '../config';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import { createModelGateway } from './gateway';
import {
  CATALOG_SNAPSHOT_FILE,
  REQUIRED_GOLDEN_SET,
  REQUIRED_GUARDRAIL_VERSION,
  catalogCompatible,
  evalGateFailure,
  profileHash,
  qualificationState,
  QualificationArtifactSchema,
  type EvalBlock,
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
/** A passing aggregate eval block on the role's required golden set (docs/quality-plan.md §7.5). */
function evalBlock(role: QualificationArtifact['role'], overrides: Partial<EvalBlock> = {}): EvalBlock {
  const photo = role === 'vision_photo' || role === 'vision_photo_enrich';
  return {
    golden_set: REQUIRED_GOLDEN_SET[role] ?? 'golden-v1',
    golden_sha256: 'a'.repeat(64),
    thresholds_sha256: 'b'.repeat(64),
    guardrail_version: photo ? REQUIRED_GUARDRAIL_VERSION : null,
    grounding_version: null,
    scorer_version: 'score-v1',
    metrics: { tune_M1: 0, holdout_M1: 0 },
    pass: true,
    ...overrides,
  };
}
function artifact(
  p = profile,
  overrides: Partial<QualificationArtifact> = {},
): QualificationArtifact {
  return {
    eval: evalBlock(p.role),
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
    ['a missing eval block', profile, artifact(profile, { eval: undefined })],
    ['a failing evaluation', profile, artifact(profile, { eval: evalBlock(profile.role, { pass: false }) })],
    [
      'an evaluation on another golden set',
      profile,
      artifact(profile, { eval: evalBlock(profile.role, { golden_set: 'golden-v1' }) }),
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
      vision_photo_enrich: {
        role: 'vision_photo_enrich',
        model: null,
        state: 'unavailable',
        reason: 'not_configured',
      },
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

describe('evaluation gating (docs/quality-plan.md §7.5)', () => {
  it('photo roles need a passing golden-v1 evaluation with the current guardrail version', async () => {
    for (const role of ['vision_photo', 'vision_photo_enrich'] as const) {
      expect(evalGateFailure(role, undefined)).toBe('missing_eval');
      expect(evalGateFailure(role, evalBlock(role))).toBeNull();
      expect(evalGateFailure(role, evalBlock(role, { guardrail_version: 'guard-v0' }))).toBe('stale_guardrail_version');
      expect(evalGateFailure(role, evalBlock(role, { guardrail_version: null }))).toBe('stale_guardrail_version');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'text-v1' }))).toBe('wrong_golden_set');
      expect(evalGateFailure(role, evalBlock(role, { pass: false }))).toBe('eval_failed');
    }
    const d = await dir();
    const vision = { ...visionProfile, qualificationArtifactId: 'vision-photo-eval' };
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    const write = (a: QualificationArtifact) =>
      writeFile(path.join(d, `${vision.qualificationArtifactId}.json`), JSON.stringify(a));
    await write(artifact(vision));
    expect(qualificationState(vision, d)).toBe('qualified');
    // A guard rule change bumps the version and un-qualifies the role until it is re-evaluated.
    await write(artifact(vision, { eval: evalBlock('vision_photo', { guardrail_version: 'guard-v0' }) }));
    expect(qualificationState(vision, d)).toBe('catalog-compatible');
    await write(artifact(vision, { eval: undefined }));
    expect(qualificationState(vision, d)).toBe('catalog-compatible');
    await write(artifact(vision, { eval: evalBlock('vision_photo', { pass: false }) }));
    expect(qualificationState(vision, d)).toBe('catalog-compatible');
  });

  it('text roles need text-v1; vision_video_frame keeps transport-only qualification', () => {
    expect(REQUIRED_GOLDEN_SET.research_text).toBe('text-v1');
    expect(REQUIRED_GOLDEN_SET.composer).toBe('text-v1');
    expect(evalGateFailure('composer', evalBlock('composer'))).toBeNull();
    expect(evalGateFailure('research_text', undefined)).toBe('missing_eval');
    expect(evalGateFailure('vision_video_frame', undefined)).toBeNull();
  });

  it('the eval block holds aggregates only: strict keys and numeric metrics', () => {
    const a = artifact(visionProfile);
    expect(QualificationArtifactSchema.safeParse(a).success).toBe(true);
    expect(QualificationArtifactSchema.safeParse({ ...a, eval: { ...a.eval, outputs: ['raw'] } }).success).toBe(false);
    expect(QualificationArtifactSchema.safeParse({ ...a, eval: { ...a.eval, metrics: { M1: 'zero' } } }).success).toBe(false);
  });
});

describe('catalogCompatible against the live catalog shape', () => {
  // GET /v1/models lists bare model ids with providers keyed by slug.
  const live = {
    kind: 'concentrate-catalog-snapshot' as const,
    fetched_at: profile.catalogSnapshotAt,
    pages: 1,
    models: [{ id: 'gpt-5-nano', slug: 'gpt-5-nano', providers: { openai: { provider_slug: 'openai' }, azure: { provider_slug: 'azure' } } }],
  };
  const pinned = { ...profile, model: 'openai/gpt-5-nano', provider: 'openai' };

  it('matches a provider/model pin to the bare catalog id and its provider key', () => {
    expect(catalogCompatible(pinned, live)).toBe(true);
  });

  it('rejects a provider the model is not served by, and an unlisted model', () => {
    expect(catalogCompatible({ ...pinned, model: 'bedrock/gpt-5-nano', provider: 'bedrock' }, live)).toBe(false);
    expect(catalogCompatible({ ...pinned, model: 'openai/gpt-9' }, live)).toBe(false);
  });
});
