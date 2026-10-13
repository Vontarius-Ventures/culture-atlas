import { defineConfig } from 'vitest/config';

/**
 * Single root Vitest config.
 *  - Unit/integration tests: **\/*.test.ts(x) next to the code (node env).
 *  - Web component tests: name them *.dom.test.tsx and they run in jsdom.
 *  - Browser journeys live in apps/web/e2e and run with Playwright (pnpm test:e2e).
 *  - DB tests use a fresh database created per run by vitest.global-setup.ts;
 *    get a handle with `getTestDb()` from '@culture-atlas/domain/testing'.
 */
export default defineConfig({
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
          include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts', 'apps/web/**/*.test.ts', 'scripts/**/*.test.ts'],
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
