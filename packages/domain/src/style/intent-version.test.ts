import { describe, expect, it } from 'vitest';
import { hasDiscoveryIntents, INTENT_COMPILER_VERSION, isFeatureBoundConnectionsCompilerVersion } from './intent-version';

describe('versioned Connections publication contracts', () => {
  it('requires feature-bound validation for the new compiler', () => {
    expect(isFeatureBoundConnectionsCompilerVersion(INTENT_COMPILER_VERSION)).toBe(true);
    expect(hasDiscoveryIntents(INTENT_COMPILER_VERSION)).toBe(true);
  });
  it('preserves the historical v9 intent envelope without relabeling it as validated', () => {
    expect(hasDiscoveryIntents('compiler-2026-10-27-intent-quality-v9')).toBe(true);
    expect(isFeatureBoundConnectionsCompilerVersion('compiler-2026-10-27-intent-quality-v9')).toBe(false);
  });
  it('does not opt arbitrary deployment overrides into a different public contract', () => {
    expect(hasDiscoveryIntents('deployment-fixture')).toBe(false);
    expect(isFeatureBoundConnectionsCompilerVersion('deployment-fixture')).toBe(false);
  });
});
