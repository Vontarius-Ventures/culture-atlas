import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Single root Vitest config.
 *  - Unit/integration tests: **\/*.test.ts(x) next to the code (node env).
 *  - Web component tests: name them *.dom.test.tsx and they run in jsdom.
 *  - Browser journeys live in apps/web/e2e and run with Playwright (pnpm test:e2e).
 *  - DB tests use a fresh database created per run by vitest.global-setup.ts;
 *    get a handle with `getTestDb()` from '@culture-atlas/domain/testing'.
 */
// Tests are hermetic: live provider credentials and routing switches from the
// developer's shell or cloud environment must never change test behaviour or
// let a test reach a paid API. Tests that need a provider configure it explicitly.
for (const name of [
  'LLM_PROVIDER',
  'MODEL_FALLBACK',
  'ELORIAN_API_KEY',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_PROFILES_JSON',
  'CONCENTRATE_PROFILE_FILE',
  'CONCENTRATE_QUALIFICATION_DIR',
  'QLOO_API_KEY',
  'FEATHERLESS_API_KEY',
  'ANTHROPIC_API_KEY',
]) {
  delete process.env[name];
}

export default defineConfig({
  // apps/web imports use the `@/` path alias from apps/web/tsconfig.json.
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${fileURLToPath(new URL('./apps/web/', import.meta.url))}` },
    ],
  },
  // apps/web/tsconfig.json uses jsx: preserve (Next compiles JSX); tests compile it with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/**/src/**/*.test.ts',
            'apps/web/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/.next/**', 'apps/web/e2e/**', '**/*.dom.test.*'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['apps/web/**/*.dom.test.tsx', 'apps/web/**/*.dom.test.ts'],
          exclude: ['**/node_modules/**', '**/.next/**'],
        },
      },
    ],
  },
});
