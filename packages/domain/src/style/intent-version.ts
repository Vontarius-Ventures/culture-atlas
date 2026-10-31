export const INTENT_COMPILER_VERSION = 'compiler-2026-10-27-intent-quality-v10';

/** Explicit historical versions retain their public contract when the default advances. */
const FEATURE_BOUND_VERSIONS: readonly string[] = ['compiler-2026-10-27-intent-quality-v10'];
export function isFeatureBoundConnectionsCompilerVersion(version: string): boolean {
  return FEATURE_BOUND_VERSIONS.includes(version);
}
export function hasDiscoveryIntents(version: string): boolean {
  return version === 'compiler-2026-10-27-intent-quality-v9' || isFeatureBoundConnectionsCompilerVersion(version);
}
