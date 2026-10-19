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
import { EVAL_BINDING } from './eval-binding';

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
  const photo = role === 'vision_photo' || role === 'vision_photo_enrich' || role === 'vision_verify';
  const set = REQUIRED_GOLDEN_SET[role] ?? 'golden-v2';
  // Scored on exactly the committed inputs (EVAL_BINDING), as a fresh qualification would be.
  const bound = EVAL_BINDING.sets[set as keyof typeof EVAL_BINDING.sets];
  return {
    golden_set: set,
    golden_sha256: bound.golden_sha256,
    thresholds_sha256: EVAL_BINDING.thresholds_sha256,
    guardrail_version: photo ? REQUIRED_GUARDRAIL_VERSION : null,
    grounding_version: null,
    scorer_version: bound.scorer_version,
    code_sha256: bound.code_sha256,
    holdout_blind: photo ? true : null,
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
      vision_verify: {
        role: 'vision_verify',
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

/**
 * The committed binding with golden-v2's blind split NOT consumed: what a fresh
 * blind set looks like to the gate. The photo-role gating tests run against it,
 * since the committed golden-v2 is consumed (its failed blind run is recorded)
 * and refuses every photo artifact first (tested below).
 */
const FRESH_BLIND_BINDING = {
  ...EVAL_BINDING,
  sets: { ...EVAL_BINDING.sets, 'golden-v2': { ...EVAL_BINDING.sets['golden-v2'], blind_consumed: false } },
};

describe('evaluation gating (docs/quality-plan.md §7.5)', () => {
  it('photo roles need a passing golden-v2 evaluation with the current guardrail version', async () => {
    const fresh = FRESH_BLIND_BINDING;
    // The verifier (vision_verify) is gated exactly like the photo roles it checks.
    for (const role of ['vision_photo', 'vision_photo_enrich', 'vision_verify'] as const) {
      expect(evalGateFailure(role, undefined, fresh)).toBe('missing_eval');
      expect(evalGateFailure(role, evalBlock(role), fresh)).toBeNull();
      expect(evalGateFailure(role, evalBlock(role, { guardrail_version: 'guard-v0' }), fresh)).toBe('stale_guardrail_version');
      expect(evalGateFailure(role, evalBlock(role, { guardrail_version: null }), fresh)).toBe('stale_guardrail_version');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'text-v1' }), fresh)).toBe('wrong_golden_set');
      // An artifact scored on golden-v1 (whose held-out split was used for tuning) no longer qualifies.
      expect(REQUIRED_GOLDEN_SET[role]).toBe('golden-v2');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'golden-v1' }), fresh)).toBe('wrong_golden_set');
      expect(evalGateFailure(role, evalBlock(role, { pass: false }), fresh)).toBe('eval_failed');
    }
    const d = await dir();
    const vision = { ...visionProfile, qualificationArtifactId: 'vision-photo-eval' };
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    const write = (a: QualificationArtifact) =>
      writeFile(path.join(d, `${vision.qualificationArtifactId}.json`), JSON.stringify(a));
    await write(artifact(vision));
    expect(qualificationState(vision, d, fresh)).toBe('qualified');
    // A guard rule change bumps the version and un-qualifies the role until it is re-evaluated.
    await write(artifact(vision, { eval: evalBlock('vision_photo', { guardrail_version: 'guard-v0' }) }));
    expect(qualificationState(vision, d, fresh)).toBe('catalog-compatible');
    await write(artifact(vision, { eval: undefined }));
    expect(qualificationState(vision, d, fresh)).toBe('catalog-compatible');
    await write(artifact(vision, { eval: evalBlock('vision_photo', { pass: false }) }));
    expect(qualificationState(vision, d, fresh)).toBe('catalog-compatible');
  });

  it('after the failed golden-v2 blind run, no photo role qualifies on golden-v2, however its artifact scores', async () => {
    // fixtures/eval/golden-v2/freeze.json records the failed blind run; the committed binding carries it.
    expect(EVAL_BINDING.sets['golden-v2'].blind_consumed).toBe(true);
    for (const role of ['vision_photo', 'vision_photo_enrich', 'vision_verify'] as const) {
      // A passing, current, "blind" artifact (e.g. a lucky re-read of h14-h29) is still refused.
      expect(evalGateFailure(role, evalBlock(role))).toBe('blind_set_consumed');
      expect(evalGateFailure(role, evalBlock(role), FRESH_BLIND_BINDING)).toBeNull();
    }
    // Text roles are not photo sets: the photo set's blind run does not touch them.
    expect(evalGateFailure('composer', evalBlock('composer'))).toBeNull();
    const d = await dir();
    const vision = { ...visionProfile, qualificationArtifactId: 'vision-photo-consumed' };
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    await writeFile(path.join(d, `${vision.qualificationArtifactId}.json`), JSON.stringify(artifact(vision)));
    expect(qualificationState(vision, d)).toBe('catalog-compatible');
    expect(qualificationState(vision, d, FRESH_BLIND_BINDING)).toBe('qualified');
  });

  it('binds every evaluation input: a changed golden set, thresholds file, scorer or measured code un-qualifies the role', async () => {
    for (const role of ['vision_photo', 'research_text', 'composer'] as const) {
      const b = FRESH_BLIND_BINDING;
      expect(evalGateFailure(role, evalBlock(role, { golden_sha256: '0'.repeat(64) }), b)).toBe('stale_golden_set');
      expect(evalGateFailure(role, evalBlock(role, { thresholds_sha256: '1'.repeat(64) }), b)).toBe('stale_thresholds');
      expect(evalGateFailure(role, evalBlock(role, { scorer_version: 'score-v0' }), b)).toBe('stale_scorer');
      expect(evalGateFailure(role, evalBlock(role, { code_sha256: '2'.repeat(64) }), b)).toBe('stale_code');
    }
    // The review probe: an otherwise passing text artifact with zeroed golden and thresholds digests.
    const d = await dir();
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    const write = (a: QualificationArtifact) => writeFile(path.join(d, `${profile.qualificationArtifactId}.json`), JSON.stringify(a));
    await write(artifact(profile));
    expect(qualificationState(profile, d)).toBe('qualified');
    await write(artifact(profile, { eval: evalBlock(profile.role, { golden_sha256: '0'.repeat(64), thresholds_sha256: '1'.repeat(64) }) }));
    expect(qualificationState(profile, d)).toBe('catalog-compatible');
    // A binding regenerated after a code change makes the same artifact stale.
    await write(artifact(profile));
    const moved = { ...EVAL_BINDING, sets: { ...EVAL_BINDING.sets, 'text-v1': { ...EVAL_BINDING.sets['text-v1'], code_sha256: '3'.repeat(64) } } };
    expect(qualificationState(profile, d, moved)).toBe('catalog-compatible');
  });

  it('photo roles need a blind held-out split (a split used for tuning is not a generalization gate)', () => {
    expect(evalGateFailure('vision_photo', evalBlock('vision_photo', { holdout_blind: false }), FRESH_BLIND_BINDING)).toBe('holdout_not_blind');
    expect(evalGateFailure('vision_photo_enrich', evalBlock('vision_photo_enrich', { holdout_blind: null }), FRESH_BLIND_BINDING)).toBe('holdout_not_blind');
    // An artifact from before the binding (no code digest, no held-out flag) no longer parses: never qualified.
    const { code_sha256: _c, holdout_blind: _h, ...legacy } = evalBlock('vision_photo');
    expect(QualificationArtifactSchema.safeParse({ ...artifact(visionProfile), eval: legacy }).success).toBe(false);
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
