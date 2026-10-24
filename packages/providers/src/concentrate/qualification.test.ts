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
  catalogFamily,
  catalogZdrListed,
  VERIFIER_EVAL_METRICS,
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
  const set = REQUIRED_GOLDEN_SET[role] ?? 'golden-v5';
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
    // A verifier artifact also records its independence and use (VERIFIER_EVAL_METRICS).
    metrics: role === 'vision_verify' ? { tune_M1: 0, holdout_M1: 0, verifier_independent_family: 1, verifier_checked_photos: 12 } : { tune_M1: 0, holdout_M1: 0 },
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
    expect(gateway.vlm.capability().status).toBe('unverified');
    await expect(gateway.readiness()).resolves.toEqual({
      vision_photo: {
        role: 'vision_photo',
        model: 'fixture/model-1',
        state: 'catalog-compatible',
        reason: 'not_qualified',
        access: 'not_qualified',
      },
      vision_video_frame: {
        role: 'vision_video_frame',
        model: null,
        state: 'unavailable',
        reason: 'not_configured',
        access: 'not_configured',
      },
      research_text: { role: 'research_text', model: 'fixture/model-1', state: 'qualified', access: 'qualified' },
      composer: { role: 'composer', model: null, state: 'unavailable', reason: 'not_configured', access: 'not_configured' },
      vision_photo_enrich: {
        role: 'vision_photo_enrich',
        model: null,
        state: 'unavailable',
        reason: 'not_configured',
        access: 'not_configured',
      },
      vision_verify: {
        role: 'vision_verify',
        model: null,
        state: 'unavailable',
        reason: 'not_configured',
        access: 'not_configured',
      },
      vision_style: {
        role: 'vision_style',
        model: null,
        state: 'unavailable',
        reason: 'not_configured',
        access: 'not_configured',
      },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ['development', true],
    ['production', false],
  ])('CONCENTRATE_DEMO_ALLOW_ROLES dispatches a catalog-compatible role as experimental (NODE_ENV=%s)', async (env, allowed) => {
    const d = await dir();
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    await writeFile(path.join(d, `${profile.qualificationArtifactId}.json`), JSON.stringify(artifact()));
    const gateway = createModelGateway(
      loadProviderConfig({
        CONCENTRATE_API_KEY: 'synthetic',
        CONCENTRATE_QUALIFICATION_DIR: d,
        CONCENTRATE_DEMO_ALLOW_ROLES: 'vision_photo, not_a_role',
        NODE_ENV: env,
      }),
      {
        ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
        profiles: { research_text: profile, vision_photo: visionProfile },
        transport: vi.fn(async () => response),
        allowTestStore: true,
      },
    );
    expect(!!gateway.runners.vision_photo).toBe(allowed);
    const readiness = await gateway.readiness();
    expect(readiness.vision_photo).toEqual(
      allowed
        ? { role: 'vision_photo', model: 'fixture/model-1', state: 'qualified', experimental: true, access: 'demo_override' }
        : { role: 'vision_photo', model: 'fixture/model-1', state: 'catalog-compatible', reason: 'not_qualified', access: 'not_qualified' },
    );
    expect(readiness.research_text.experimental).toBeUndefined();
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
 * The committed binding with the photo roles' set (golden-v5) NOT consumed:
 * what a fresh blind set looks like to the gate, whatever a later blind run
 * records in the committed binding. The photo-role gating tests run against it;
 * a consumed set refuses every photo artifact first (tested below).
 */
const FRESH_BLIND_BINDING = {
  ...EVAL_BINDING,
  sets: { ...EVAL_BINDING.sets, 'golden-v5': { ...EVAL_BINDING.sets['golden-v5'], blind_consumed: false } },
};
/** The same binding after a failed blind run of golden-v5 (its freeze.json blind_run record). */
const CONSUMED_BLIND_BINDING = {
  ...EVAL_BINDING,
  sets: { ...EVAL_BINDING.sets, 'golden-v5': { ...EVAL_BINDING.sets['golden-v5'], blind_consumed: true } },
};

describe('evaluation gating (docs/quality-plan.md §7.5)', () => {
  it('photo roles need a passing golden-v5 evaluation with the current guardrail version', async () => {
    const fresh = FRESH_BLIND_BINDING;
    // The verifier (vision_verify) is gated exactly like the photo roles it checks.
    for (const role of ['vision_photo', 'vision_photo_enrich', 'vision_verify'] as const) {
      expect(evalGateFailure(role, undefined, fresh)).toBe('missing_eval');
      expect(evalGateFailure(role, evalBlock(role), fresh)).toBeNull();
      expect(evalGateFailure(role, evalBlock(role, { guardrail_version: 'guard-v0' }), fresh)).toBe('stale_guardrail_version');
      expect(evalGateFailure(role, evalBlock(role, { guardrail_version: null }), fresh)).toBe('stale_guardrail_version');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'text-v1' }), fresh)).toBe('wrong_golden_set');
      // An artifact scored on golden-v1 (whose held-out split was used for tuning), golden-v2, golden-v3 or golden-v4
      // (whose blind splits failed blind runs consumed) no longer qualifies.
      expect(REQUIRED_GOLDEN_SET[role]).toBe('golden-v5');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'golden-v1' }), fresh)).toBe('wrong_golden_set');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'golden-v2' }), fresh)).toBe('wrong_golden_set');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'golden-v3' }), fresh)).toBe('wrong_golden_set');
      expect(evalGateFailure(role, evalBlock(role, { golden_set: 'golden-v4' }), fresh)).toBe('wrong_golden_set');
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

  it('round 4: golden-v5 has no held-out split yet, so no photo role qualifies on it until a frozen blind split exists', () => {
    // golden-v5 is every golden-v4 photo as tune (h50-h79 included); its blind split (h80+) is added and frozen later.
    expect(EVAL_BINDING.sets['golden-v5'].blind_consumed).toBe(false);
    for (const role of ['vision_photo', 'vision_photo_enrich', 'vision_verify'] as const) {
      // An artifact scored on the tune split alone cannot claim a blind held-out split: refused with the committed binding.
      expect(evalGateFailure(role, evalBlock(role, { holdout_blind: false }))).toBe('holdout_not_blind');
      expect(evalGateFailure(role, evalBlock(role, { holdout_blind: null }))).toBe('holdout_not_blind');
    }
  });

  it('after a failed blind run, no photo role qualifies on the consumed set, however its artifact scores', async () => {
    // fixtures/eval/golden-v2/, golden-v3/ and golden-v4/freeze.json record rounds 1 to 3's failed blind runs; the
    // committed binding carries them.
    expect(EVAL_BINDING.sets['golden-v2'].blind_consumed).toBe(true);
    expect(EVAL_BINDING.sets['golden-v3'].blind_consumed).toBe(true);
    expect(EVAL_BINDING.sets['golden-v4'].blind_consumed).toBe(true);
    for (const role of ['vision_photo', 'vision_photo_enrich', 'vision_verify'] as const) {
      for (const old of ['golden-v2', 'golden-v3', 'golden-v4'] as const) {
        // A passing, current artifact on a consumed earlier set (e.g. a lucky re-read of h30-h49) is refused.
        const onOld = evalBlock(role, { golden_set: old, golden_sha256: EVAL_BINDING.sets[old].golden_sha256 });
        expect(evalGateFailure(role, onOld)).toBe('wrong_golden_set');
        expect(evalGateFailure(role, onOld, FRESH_BLIND_BINDING)).toBe('wrong_golden_set');
      }
      // The same holds for golden-v5 once its blind run fails and is recorded: the gate refuses it before anything else.
      expect(evalGateFailure(role, evalBlock(role), CONSUMED_BLIND_BINDING)).toBe('blind_set_consumed');
      expect(evalGateFailure(role, evalBlock(role), FRESH_BLIND_BINDING)).toBeNull();
    }
    // Text roles are not photo sets: the photo set's blind run does not touch them.
    expect(evalGateFailure('composer', evalBlock('composer'), CONSUMED_BLIND_BINDING)).toBeNull();
    const d = await dir();
    const vision = { ...visionProfile, qualificationArtifactId: 'vision-photo-consumed' };
    await writeFile(path.join(d, CATALOG_SNAPSHOT_FILE), JSON.stringify(snapshot));
    await writeFile(path.join(d, `${vision.qualificationArtifactId}.json`), JSON.stringify(artifact(vision)));
    expect(qualificationState(vision, d, CONSUMED_BLIND_BINDING)).toBe('catalog-compatible');
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

describe('vision_verify: an independent model family, actually exercised (requalification round 3)', () => {
  it('needs the independence and use metrics in its eval block, whatever else passes', () => {
    const b = FRESH_BLIND_BINDING;
    const ok = evalBlock('vision_verify');
    expect(evalGateFailure('vision_verify', ok, b)).toBeNull();
    const without = (k: string) => ({ ...ok, metrics: Object.fromEntries(Object.entries(ok.metrics).filter(([m]) => m !== k)) });
    expect(evalGateFailure('vision_verify', without(VERIFIER_EVAL_METRICS.independentFamily), b)).toBe('verifier_same_family');
    expect(evalGateFailure('vision_verify', { ...ok, metrics: { ...ok.metrics, verifier_independent_family: 0 } }, b)).toBe('verifier_same_family');
    expect(evalGateFailure('vision_verify', without(VERIFIER_EVAL_METRICS.checkedPhotos), b)).toBe('verifier_unexercised');
    expect(evalGateFailure('vision_verify', { ...ok, metrics: { ...ok.metrics, verifier_checked_photos: 9 } }, b)).toBe('verifier_unexercised');
    // The photo roles carry no such metrics and need none.
    expect(evalGateFailure('vision_photo', evalBlock('vision_photo'), b)).toBeNull();
  });

  it('reads the family from the catalog author (who trained it, not who serves it) and the ZDR policy per route', () => {
    // FIXTURE entries in the live catalog shape (GET /v1/models): Claude served by Vertex is still Anthropic's.
    const snap = {
      kind: 'concentrate-catalog-snapshot' as const,
      fetched_at: profile.catalogSnapshotAt,
      pages: 1,
      models: [
        { id: 'claude-fixture', author: { slug: 'anthropic' }, providers: { anthropic: { zdr: { policy_url: 'x' } }, vertex: { zdr: null } } },
        { id: 'gemini-fixture', author: { slug: 'google' }, providers: { vertex: { zdr: { policy_url: 'y' } }, 'ai-studio': {} } },
        { id: 'unauthored-fixture', providers: { fixture: {} } },
      ],
    };
    const at = (model: string, provider: string) => ({ model: provider + '/' + model, provider });
    expect(catalogFamily(at('claude-fixture', 'anthropic'), snap)).toBe('anthropic');
    expect(catalogFamily(at('claude-fixture', 'vertex'), snap)).toBe('anthropic');
    expect(catalogFamily(at('gemini-fixture', 'vertex'), snap)).toBe('google');
    expect(catalogFamily(at('unauthored-fixture', 'fixture'), snap)).toBeNull();
    expect(catalogZdrListed(at('gemini-fixture', 'vertex'), snap)).toBe(true);
    expect(catalogZdrListed(at('gemini-fixture', 'ai-studio'), snap)).toBe(false);
    expect(catalogZdrListed(at('claude-fixture', 'vertex'), snap)).toBe(false);
    expect(catalogZdrListed(at('missing', 'vertex'), snap)).toBe(false);
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
