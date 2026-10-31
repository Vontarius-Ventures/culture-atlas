import { defineConfig } from 'vitest/config';

// Intentionally does NOT extend the root's PostgreSQL-creating global setup.
// No ambient DB, services, live credentials or provider probes.
for (const name of [
  'CONCENTRATE_API_KEY', 'CONCENTRATE_PROFILE_FILE', 'CONCENTRATE_PROFILES_JSON',
  'CONCENTRATE_QUALIFICATION_DIR', 'QLOO_API_KEY', 'ANTHROPIC_API_KEY',
  'FEATHERLESS_API_KEY', 'ELORIAN_API_KEY', 'MODEL_FALLBACK', 'LLM_PROVIDER',
]) delete process.env[name];
export default defineConfig({
  test: {
    environment: 'node', globalSetup: [], testTimeout: 20_000,
    setupFiles: ['packages/providers/offline.setup.ts'],
    include: ['packages/providers/src/**/*.test.ts', 'packages/domain/src/config.test.ts'],
    exclude: [
      '**/node_modules/**', '**/model-gateway/postgres.test.ts',
      '**/model-gateway/inference-attempts.test.ts', '**/qloo/rate-gate.test.ts',
      '**/mail/identity-mail.test.ts', '**/push/push.test.ts',
    ],
  },
});
