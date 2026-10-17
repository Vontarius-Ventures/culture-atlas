import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, insertAccount } from '../testing';
import {
  FEATURE_FLAG_DEFAULTS,
  KILLABLE_FLAGS,
  evaluateFeatureFlags,
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
      privacyVerified: true,
      budgetAvailable: true,
      providerReady: true,
    },
    agentApiConfigured: true,
    sharingConfigured: true,
    optIn: { automaticAnalysis: false, nativeVideoModelInput: false, agentRemoteCapture: false },
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

  it('killable flags match the database CHECK constraint', async () => {
    const sql = await readFile(
      new URL('db/migrations/085_feature_kills_and_push.sql', root),
      'utf8',
    );
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
        optIn: { automaticAnalysis: true, nativeVideoModelInput: true, agentRemoteCapture: true },
      }),
    );
    expect(on.flags.automatic_analysis && on.flags.agent_remote_capture_enabled).toBe(true);
    const noAnalysis = evaluateFeatureFlags(
      inputs({
        optIn: { automaticAnalysis: true, nativeVideoModelInput: true, agentRemoteCapture: false },
        analysis: { ...inputs().analysis, budgetAvailable: false },
      }),
    );
    expect(noAnalysis.flags.concentrate_analysis_enabled).toBe(false);
    expect(noAnalysis.reasons.concentrate_analysis_enabled).toEqual(['budget_exhausted']);
    expect(noAnalysis.flags.automatic_analysis).toBe(false);
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
    await liftFeatureKill(db, { flag: 'meta_glasses_capture_enabled', accountId: a.accountId });
    expect((await flagsFor(a.accountId, ia)).meta_glasses_capture_enabled).toBe(true);
    await expect(
      setFeatureKill(db, { flag: 'media_library', accountId: null, reason: 'x', actor: 'vitest' }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
