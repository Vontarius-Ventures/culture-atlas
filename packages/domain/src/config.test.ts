import { describe, expect, it } from 'vitest';
import { DomainConfigSchema } from './config';
import { analysisDedupeKey } from './jobs/dedupe';

describe('Qloo-native compiler cache version', () => {
  it('does not reuse analyses compiled under the previous discovery contract', () => {
    const current = DomainConfigSchema.parse({}).COMPILER_VERSION;
    expect(current).toBe('compiler-2026-10-27-intent-quality-v10');
    const input = {
      owner: { kind: 'account' as const, accountId: 'account-fixture' },
      imageSha256: 'image-fixture',
      focus: { kind: 'whole' },
    };
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-13' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-26-qloo-native' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-26-qloo-native-v2' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-26-qloo-native-v3' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-26-qloo-native-v4' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-27-qloo-native-v5' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-27-qloo-native-v6' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-27-intent-visual-v7' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-27-intent-quality-v8' }));
    expect(analysisDedupeKey({ ...input, compilerVersion: current }))
      .not.toBe(analysisDedupeKey({ ...input, compilerVersion: 'compiler-2026-10-27-intent-quality-v9' }));
  });

  it('preserves an explicitly configured deployment version', () => {
    expect(DomainConfigSchema.parse({ COMPILER_VERSION: 'deployment-fixture' }).COMPILER_VERSION)
      .toBe('deployment-fixture');
  });

  it('defaults visual comparisons off and hard bounds opt-in work to two', () => {
    expect(DomainConfigSchema.parse({}).VISUAL_MAX_COMPARISONS_PER_CAPTURE).toBe(0);
    for (const value of [-1, 3, 1.5]) expect(DomainConfigSchema.safeParse({ VISUAL_MAX_COMPARISONS_PER_CAPTURE: value }).success).toBe(false);
  });

  it('permits disabling provider retries without changing the default allowance', () => {
    expect(DomainConfigSchema.parse({ JOB_MAX_PROVIDER_RETRIES: '0' }).JOB_MAX_PROVIDER_RETRIES).toBe(0);
    expect(DomainConfigSchema.parse({}).JOB_MAX_PROVIDER_RETRIES).toBeGreaterThan(0);
    for (const value of [-1, 0.5]) expect(DomainConfigSchema.safeParse({ JOB_MAX_PROVIDER_RETRIES: value }).success).toBe(false);
  });
});

it('connection asset checks are independently default-off with at most three allocated slots', () => {
  expect(DomainConfigSchema.parse({}).CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE).toBe(0);
  expect(DomainConfigSchema.parse({ CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE: '3' }).CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE).toBe(3);
  for (const value of [-1, 4, 1.5]) expect(DomainConfigSchema.safeParse({ CONNECTION_MAX_ASSET_CHECKS_PER_CAPTURE: value }).success).toBe(false);
});
