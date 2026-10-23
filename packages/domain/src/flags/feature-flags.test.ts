import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import {
  FEATURE_FLAG_DEFAULTS,
  KILLABLE_FLAGS,
  SERVICE_FEATURES,
  evaluateFeatureFlags,
  evaluateServiceFeature,
  requireServiceFeature,
  liftFeatureKill,
  resolveFeatureFlags,
  setFeatureKill,
  type FeatureFlagInputs,
} from './feature-flags';

const db = getTestDb();
afterAll(() => closeTestDb());
const root = new URL('../../../../', import.meta.url);

function inputs(over: Partial<FeatureFlagInputs> = {}): FeatureFlagInputs {
  return {
    killed: new Set(),
    mediaCreationEnabled: true,
    cameraVideoEnabled: true,
    videoDecoderQualified: true,
    glasses: {
      buildSupported: true,
      channelEligible: true,
      rolloutEligible: true,
      deviceCompatible: true,
      permissionGranted: true,
      locallyReady: true,
    },
    remote: { armedLocally: true, sameAccount: true, freshDeviceState: true },
    audio: { qualifiedAudio: true, microphonePermission: true, sourceSelected: true },
    analysis: {
      keyConfigured: true,
      profileQualified: true,
      qualityQualified: true,
      privacyVerified: true,
      budgetAvailable: true,
      providerReady: true,
      enrichReady: true,
      verifyReady: true,
    },
    agentApiConfigured: true,
    sharingConfigured: true,
    onboarding: { requiredConfigured: true, seedConfigured: true, whileWeLookConfigured: true },
    optIn: { automaticAnalysis: false, nativeVideoModelInput: false, agentRemoteCapture: false, analysisVerifier: false },
    ...over,
  };
}

describe('feature flag contract', () => {
  it('defaults are exactly the spec file', async () => {
    const spec = JSON.parse(
      await readFile(new URL('specs/capture-platform-v2/feature-flags.json', root), 'utf8'),
    );
    expect(FEATURE_FLAG_DEFAULTS).toEqual(spec.defaults);
    // Every rule-gated flag is in the killable set.
    for (const flag of Object.keys(spec.activation_rules)) expect(KILLABLE_FLAGS).toContain(flag);
  });

  it('killable flags match the latest database CHECK constraint', async () => {
    // The newest migration that (re)defines the feature_flag_kills flag list wins.
    const dir = new URL('db/migrations/', root);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    let sql = '';
    for (const file of files) {
      const text = await readFile(new URL(file, dir), 'utf8');
      if (/feature_flag_kills/.test(text) && /flag IN \(/.test(text)) sql = text;
    }
    const list = /flag IN \(([^)]*)\)/.exec(sql)![1]!;
    expect(
      list
        .match(/'([a-z_]+)'/g)!
        .map((s) => s.slice(1, -1))
        .sort(),
    ).toEqual([...KILLABLE_FLAGS].sort());
    expect(KILLABLE_FLAGS).not.toContain('media_library');
  });
});

describe('evaluateFeatureFlags', () => {
  it('turns on glasses only when every activation input holds', () => {
    expect(evaluateFeatureFlags(inputs()).flags.meta_glasses_capture_enabled).toBe(true);
    for (const gate of Object.keys(inputs().glasses) as (keyof FeatureFlagInputs['glasses'])[]) {
      const result = evaluateFeatureFlags(
        inputs({ glasses: { ...inputs().glasses, [gate]: false } }),
      );
      expect(result.flags.meta_glasses_capture_enabled).toBe(false);
      expect(result.flags.remote_glasses_capture_enabled).toBe(false);
      expect(result.flags.meta_glasses_audio_enabled).toBe(false);
      expect(result.reasons.meta_glasses_capture_enabled).toHaveLength(1);
    }
  });

  it('remote capture needs local arming and fresh state; audio needs explicit microphone selection', () => {
    const unarmed = evaluateFeatureFlags(
      inputs({ remote: { armedLocally: false, sameAccount: true, freshDeviceState: true } }),
    );
    expect(unarmed.flags.remote_glasses_capture_enabled).toBe(false);
    expect(unarmed.reasons.remote_glasses_capture_enabled).toEqual(['arm_on_phone_required']);
    const silent = evaluateFeatureFlags(
      inputs({
        audio: { qualifiedAudio: true, microphonePermission: true, sourceSelected: false },
      }),
    );
    expect(silent.flags.meta_glasses_audio_enabled).toBe(false);
    expect(silent.flags.meta_glasses_capture_enabled).toBe(true);
  });

  it('kill switches only turn features off and never touch the library', () => {
    const result = evaluateFeatureFlags(
      inputs({
        killed: new Set(['meta_glasses_capture_enabled', 'camera_photo', 'media_library']),
      }),
    );
    expect(result.flags.meta_glasses_capture_enabled).toBe(false);
    expect(result.reasons.meta_glasses_capture_enabled).toEqual(['temporarily_disabled']);
    expect(result.flags.camera_photo).toBe(false);
    expect(result.flags.file_photo_upload).toBe(true);
    expect(result.flags.media_library).toBe(true);
    expect(result.killed).toEqual(['camera_photo', 'meta_glasses_capture_enabled']);
  });

  it('default-off flags without a written rule stay off until the operator opts in', () => {
    const off = evaluateFeatureFlags(inputs());
    expect(off.flags.automatic_analysis).toBe(false);
    expect(off.flags.native_video_model_input).toBe(false);
    expect(off.flags.agent_remote_capture_enabled).toBe(false);
    const on = evaluateFeatureFlags(
      inputs({
        optIn: { automaticAnalysis: true, nativeVideoModelInput: true, agentRemoteCapture: true, analysisVerifier: false },
      }),
    );
    expect(on.flags.automatic_analysis && on.flags.agent_remote_capture_enabled).toBe(true);
    const noAnalysis = evaluateFeatureFlags(
      inputs({
        optIn: { automaticAnalysis: true, nativeVideoModelInput: true, agentRemoteCapture: false, analysisVerifier: false },
        analysis: { ...inputs().analysis, budgetAvailable: false },
      }),
    );
    expect(noAnalysis.flags.concentrate_analysis_enabled).toBe(false);
    expect(noAnalysis.reasons.concentrate_analysis_enabled).toEqual(['budget_exhausted']);
    expect(noAnalysis.flags.automatic_analysis).toBe(false);
    const unqualified = evaluateFeatureFlags(
      inputs({
        analysis: {
          ...inputs().analysis,
          qualityQualified: false,
          budgetAvailable: false,
          providerReady: false,
        },
      }),
    );
    expect(unqualified.flags.concentrate_analysis_enabled).toBe(false);
    expect(unqualified.reasons.concentrate_analysis_enabled).toContain('model_unqualified');
  });

  it('video needs a qualified decoder; a creation pause stops every capture path', () => {
    const noDecoder = evaluateFeatureFlags(inputs({ videoDecoderQualified: false }));
    expect(noDecoder.flags.camera_video || noDecoder.flags.file_video_upload).toBe(false);
    expect(noDecoder.flags.camera_photo).toBe(true);
    const paused = evaluateFeatureFlags(inputs({ mediaCreationEnabled: false }));
    expect(
      paused.flags.camera_photo ||
        paused.flags.file_photo_upload ||
        paused.flags.meta_glasses_capture_enabled,
    ).toBe(false);
    expect(paused.flags.media_library).toBe(true);
  });
});

describe('amendment 2.2 flags', () => {
  it('default to the spec values and are evaluated server-side', () => {
    expect(FEATURE_FLAG_DEFAULTS).toMatchObject({
      onboarding_required: true,
      taste_seed_enabled: true,
      fast_analysis_two_stage: false,
      while_we_look_enabled: true,
    });
    const on = evaluateFeatureFlags(inputs());
    expect(on.flags.onboarding_required && on.flags.taste_seed_enabled).toBe(true);
    expect(on.flags.while_we_look_enabled && on.flags.fast_analysis_two_stage).toBe(true);
  });

  it('two-stage analysis needs the analysis path and a ready enrichment profile', () => {
    const noEnrich = evaluateFeatureFlags(
      inputs({ analysis: { ...inputs().analysis, enrichReady: false } }),
    );
    expect(noEnrich.flags.fast_analysis_two_stage).toBe(false);
    expect(noEnrich.reasons.fast_analysis_two_stage).toEqual(['model_unqualified']);
    expect(noEnrich.flags.concentrate_analysis_enabled).toBe(true);
    const noAnalysis = evaluateFeatureFlags(
      inputs({ analysis: { ...inputs().analysis, privacyVerified: false } }),
    );
    expect(noAnalysis.flags.fast_analysis_two_stage).toBe(false);
    expect(noAnalysis.reasons.fast_analysis_two_stage).toEqual(['analysis_unavailable']);
    const killed = evaluateFeatureFlags(inputs({ killed: new Set(['fast_analysis_two_stage']) }));
    expect(killed.flags.fast_analysis_two_stage).toBe(false);
    expect(killed.flags.concentrate_analysis_enabled).toBe(true);
  });

  it('the verifier is off by default and needs the opt-in, the two-stage reading and a ready vision_verify profile', () => {
    expect(FEATURE_FLAG_DEFAULTS.analysis_verifier_enabled).toBe(false);
    expect(KILLABLE_FLAGS).toContain('analysis_verifier_enabled');
    const off = evaluateFeatureFlags(inputs());
    expect(off.flags.analysis_verifier_enabled).toBe(false);
    expect(off.reasons.analysis_verifier_enabled).toEqual(['not_enabled']);
    const optIn = { ...inputs().optIn, analysisVerifier: true };
    expect(evaluateFeatureFlags(inputs({ optIn })).flags.analysis_verifier_enabled).toBe(true);
    const noModel = evaluateFeatureFlags(inputs({ optIn, analysis: { ...inputs().analysis, verifyReady: false } }));
    expect(noModel.reasons.analysis_verifier_enabled).toEqual(['model_unqualified']);
    const noTwoStage = evaluateFeatureFlags(inputs({ optIn, analysis: { ...inputs().analysis, enrichReady: false } }));
    expect(noTwoStage.reasons.analysis_verifier_enabled).toEqual(['two_stage_unavailable']);
    // A kill turns only the verifier off; killing two-stage reading turns it off too.
    const killed = evaluateFeatureFlags(inputs({ optIn, killed: new Set(['analysis_verifier_enabled']) }));
    expect([killed.flags.analysis_verifier_enabled, killed.flags.fast_analysis_two_stage]).toEqual([false, true]);
    expect(evaluateFeatureFlags(inputs({ optIn, killed: new Set(['fast_analysis_two_stage']) })).flags.analysis_verifier_enabled).toBe(false);
  });

  it('onboarding, seed and While-we-look turn off by env or kill, independently', () => {
    const off = evaluateFeatureFlags(
      inputs({
        onboarding: { requiredConfigured: false, seedConfigured: true, whileWeLookConfigured: true },
        killed: new Set(['while_we_look_enabled']),
      }),
    );
    expect(off.flags.onboarding_required).toBe(false);
    expect(off.reasons.onboarding_required).toEqual(['not_enabled']);
    expect(off.flags.taste_seed_enabled).toBe(true);
    expect(off.flags.while_we_look_enabled).toBe(false);
    expect(off.reasons.while_we_look_enabled).toEqual(['temporarily_disabled']);
    expect(off.killed).toEqual(['while_we_look_enabled']);
  });
});

describe('resolveFeatureFlags (server state)', () => {
  const now = new Date();
  async function phone(accountId: string, over: { lastSeen?: Date; build?: string } = {}) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version,capabilities,readiness,app_state,last_seen_at)
       VALUES($1,$2,'ios',$3,$4,'ready','foreground',$5) RETURNING id`,
      [
        accountId,
        randomUUID(),
        over.build ?? '1.4.0',
        JSON.stringify({
          meta_wearables_sdk: true,
          meta_wearables_supported_os: true,
          photo: true,
        }),
        over.lastSeen ?? now,
      ],
    );
    await db.query(
      `INSERT INTO wearable_connections(account_id,installation_id,sdk_reference_hash,display_name,capabilities,permission_state)
       VALUES($1,$2,'hash','Glasses','{"photo":true}','granted')`,
      [accountId, rows[0]!.id],
    );
    return rows[0]!.id;
  }
  const env = {
    META_GLASSES_QUALIFIED_BUILDS: 'ios@1.4.0',
    META_GLASSES_ENTITLED_PLATFORMS: 'ios',
    META_GLASSES_ROLLOUT: 'all',
  };

  it('enables glasses for a qualified, entitled, fresh, permitted installation only', async () => {
    const account = await insertAccount();
    const installationId = await phone(account.accountId);
    const resolve = (overrides: Record<string, string | undefined> = {}, id = installationId) =>
      resolveFeatureFlags(db, {
        accountId: account.accountId,
        installationId: id,
        env: { ...env, ...overrides },
        now,
        videoDecoderQualified: false,
      });
    expect((await resolve()).flags.meta_glasses_capture_enabled).toBe(true);
    expect(
      (await resolve({ META_GLASSES_QUALIFIED_BUILDS: 'ios@1.3.0' })).reasons
        .meta_glasses_capture_enabled,
    ).toEqual(['build_unsupported']);
    expect(
      (await resolve({ META_GLASSES_ROLLOUT: undefined })).reasons.meta_glasses_capture_enabled,
    ).toEqual(['rollout_unavailable']);
    expect(
      (
        await resolve({
          META_GLASSES_ROLLOUT: 'allowlist',
          META_GLASSES_ROLLOUT_ACCOUNT_IDS: account.accountId,
        })
      ).flags.meta_glasses_capture_enabled,
    ).toBe(true);
    // A browser (no installation) never qualifies.
    expect((await resolve({}, null as unknown as string)).flags.meta_glasses_capture_enabled).toBe(
      false,
    );
    // ...but it is told the release is entitled (so it can hand setup off to
    // the phone) only when the operator entitled a native platform.
    expect(
      (await resolve({}, null as unknown as string)).reasons.meta_glasses_capture_enabled,
    ).not.toContain('release_channel_ineligible');
    expect(
      (await resolve({ META_GLASSES_ENTITLED_PLATFORMS: undefined }, null as unknown as string))
        .reasons.meta_glasses_capture_enabled,
    ).toContain('release_channel_ineligible');
    // An unknown or revoked installation id is not treated as a browser.
    expect((await resolve({}, randomUUID())).reasons.meta_glasses_capture_enabled).toContain(
      'release_channel_ineligible',
    );
    // Remote capture additionally needs a locally armed glasses session.
    expect((await resolve()).flags.remote_glasses_capture_enabled).toBe(false);
    await db.query(
      `INSERT INTO capture_sessions(account_id,installation_id,wearable_connection_id,source,media_mode,remote_arm_expires_at)
       SELECT account_id,installation_id,id,'meta_glasses','photo',$2 FROM wearable_connections WHERE installation_id=$1`,
      [installationId, new Date(now.getTime() + 60_000)],
    );
    expect((await resolve()).flags.remote_glasses_capture_enabled).toBe(true);
  });

  it('stale heartbeat or another account’s installation id yields no glasses authority', async () => {
    const a = await insertAccount();
    const b = await insertAccount();
    const stale = await phone(a.accountId, { lastSeen: new Date(now.getTime() - 31_000) });
    const result = await resolveFeatureFlags(db, {
      accountId: a.accountId,
      installationId: stale,
      env,
      now,
      videoDecoderQualified: false,
    });
    expect(result.reasons.meta_glasses_capture_enabled).toEqual(['user_action_required']);
    const foreign = await phone(b.accountId);
    const cross = await resolveFeatureFlags(db, {
      accountId: a.accountId,
      installationId: foreign,
      env,
      now,
      videoDecoderQualified: false,
    });
    expect(cross.flags.meta_glasses_capture_enabled).toBe(false);
  });

  it('account and global kills from the database and env apply; lifting restores the rule', async () => {
    const a = await insertAccount();
    const b = await insertAccount();
    const ia = await phone(a.accountId);
    const ib = await phone(b.accountId);
    const flagsFor = async (accountId: string, installationId: string, extra = {}) =>
      (
        await resolveFeatureFlags(db, {
          accountId,
          installationId,
          env: { ...env, ...extra },
          now,
          videoDecoderQualified: true,
        })
      ).flags;
    await setFeatureKill(db, {
      flag: 'meta_glasses_capture_enabled',
      accountId: a.accountId,
      reason: 'test',
      actor: 'vitest',
    });
    expect(
      (
        await setFeatureKill(db, {
          flag: 'meta_glasses_capture_enabled',
          accountId: a.accountId,
          reason: 'again',
          actor: 'vitest',
        })
      ).created,
    ).toBe(false);
    expect((await flagsFor(a.accountId, ia)).meta_glasses_capture_enabled).toBe(false);
    expect((await flagsFor(b.accountId, ib)).meta_glasses_capture_enabled).toBe(true);
    expect(
      (await flagsFor(b.accountId, ib, { FEATURE_KILL_SWITCHES: 'camera_video, bogus' }))
        .camera_video,
    ).toBe(false);
    // Amendment 2.2: the onboarding gate can be killed per account (database CHECK allows it).
    await setFeatureKill(db, {
      flag: 'onboarding_required',
      accountId: a.accountId,
      reason: 'test',
      actor: 'vitest',
    });
    expect((await flagsFor(a.accountId, ia)).onboarding_required).toBe(false);
    expect((await flagsFor(b.accountId, ib)).onboarding_required).toBe(true);
    expect((await flagsFor(b.accountId, ib, { ONBOARDING_REQUIRED: 'false' })).onboarding_required).toBe(
      false,
    );
    await liftFeatureKill(db, { flag: 'onboarding_required', accountId: a.accountId });
    await liftFeatureKill(db, { flag: 'meta_glasses_capture_enabled', accountId: a.accountId });
    expect((await flagsFor(a.accountId, ia)).meta_glasses_capture_enabled).toBe(true);
    await expect(
      setFeatureKill(db, { flag: 'media_library', accountId: null, reason: 'x', actor: 'vitest' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('fast_analysis_two_stage readiness', () => {
  it('stays off unless the injected readiness reports a ready enrichment role', async () => {
    const account = await insertAccount();
    const env = {
      CONCENTRATE_API_KEY: 'k',
      CONCENTRATE_PROFILES_JSON: '[]',
      MODEL_DAILY_SPEND_LIMIT_USD: '5',
    };
    const resolve = (analysisReadiness?: Parameters<typeof resolveFeatureFlags>[1]['analysisReadiness']) =>
      resolveFeatureFlags(db, {
        accountId: account.accountId,
        installationId: null,
        env,
        now: new Date(),
        videoDecoderQualified: false,
        analysisReadiness,
      });
    const ready = { budgetAvailable: true, providerReady: true };
    expect((await resolve(ready)).flags.concentrate_analysis_enabled).toBe(true);
    expect((await resolve(ready)).flags.fast_analysis_two_stage).toBe(false);
    expect((await resolve({ ...ready, enrichReady: true })).flags.fast_analysis_two_stage).toBe(true);
    expect((await resolve()).flags.fast_analysis_two_stage).toBe(false);
  });
});

describe('service-enforced flags', () => {
  it('evaluate exactly like the capabilities evaluation for every env and kill combination', () => {
    const values = [undefined, 'true', 'false'];
    const kills = [[], ['agent_api_enabled'], ['collection_sharing_enabled'], ['agent_remote_capture_enabled'],
      ['agent_api_enabled', 'agent_remote_capture_enabled'], ['onboarding_required', 'while_we_look_enabled'],
      ['taste_seed_enabled']];
    const onboardingEnvs = values.flatMap((required) =>
      values.flatMap((seed) => values.map((look) => ({ required, seed, look }))));
    for (const api of values)
      for (const sharing of values)
        for (const remote of values)
          for (const o of onboardingEnvs)
          for (const killedList of kills) {
            const killed = new Set(killedList);
            const env = {
              AGENT_API_ENABLED: api, COLLECTION_SHARING_ENABLED: sharing, AGENT_REMOTE_CAPTURE_ENABLED: remote,
              ONBOARDING_REQUIRED: o.required, TASTE_SEED_ENABLED: o.seed, WHILE_WE_LOOK_ENABLED: o.look,
            };
            const full = evaluateFeatureFlags(inputs({
              killed,
              agentApiConfigured: api !== 'false',
              sharingConfigured: sharing !== 'false',
              optIn: { automaticAnalysis: false, nativeVideoModelInput: false, agentRemoteCapture: remote === 'true', analysisVerifier: false },
              onboarding: {
                requiredConfigured: o.required !== 'false',
                seedConfigured: o.seed !== 'false',
                whileWeLookConfigured: o.look !== 'false',
              },
            }));
            for (const flag of SERVICE_FEATURES) {
              const service = evaluateServiceFeature(flag, { killed, env });
              expect(service.enabled, `${flag} ${JSON.stringify(env)} ${killedList}`).toBe(full.flags[flag]);
              expect(service.reasons).toEqual(full.reasons[flag] ?? []);
            }
          }
  });

  it('requireServiceFeature reads account kills and env, and fails closed with a 503', async () => {
    const owner = await insertAccount();
    const ctx = { db, config: {} };
    await expect(requireServiceFeature(ctx, owner.accountId, 'agent_api_enabled')).resolves.toBeUndefined();
    await expect(requireServiceFeature(ctx, owner.accountId, 'agent_remote_capture_enabled')).rejects.toMatchObject({
      code: 'service_unavailable', status: 503, retryable: false,
    });
    await setFeatureKill(db, { flag: 'collection_sharing_enabled', accountId: owner.accountId, reason: 't', actor: 't' });
    await expect(requireServiceFeature(ctx, owner.accountId, 'collection_sharing_enabled')).rejects.toMatchObject({
      code: 'service_unavailable', retryable: true, details: { reasons: ['temporarily_disabled'] },
    });
    // Another account is unaffected by this account's kill.
    const other = await insertAccount();
    await expect(requireServiceFeature(ctx, other.accountId, 'collection_sharing_enabled')).resolves.toBeUndefined();
    await expect(requireServiceFeature({ db, config: { COLLECTION_SHARING_ENABLED: 'false' } }, other.accountId,
      'collection_sharing_enabled')).rejects.toMatchObject({ code: 'service_unavailable', retryable: false });
  });
});
