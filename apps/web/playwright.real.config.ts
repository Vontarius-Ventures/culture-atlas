import { defineConfig, devices } from '@playwright/test';

/**
 * Main consumer journey against the REAL stack: no /v1 mocks. Start the app
 * and the worker first against a migrated database, e.g.
 *
 *   pnpm db:migrate && pnpm build
 *   (cd apps/web && pnpm exec next start --port 3200) & pnpm worker &
 *   E2E_BASE_URL=http://localhost:3200 pnpm --filter @culture-atlas/web test:e2e:real
 *
 * Without provider keys the journey still passes: example photos replay their
 * reviewed reading ("Example result"), uploads show the honest "can't look at
 * this photo yet" state, and plans show their unavailable sections.
 *
 * e2e/real/v2-journey.spec.ts (capture platform v2) also needs the media worker
 * and V2_MAIL_DIR; it is skipped without it. See docs/v2-real-stack.md. Chromium
 * comes from PLAYWRIGHT_BROWSERS_PATH; never run `playwright install` here.
 */
export default defineConfig({
  testDir: './e2e/real',
  // Amendment 2.2 journeys need the fake providers: playwright.real-v22.config.ts.
  testIgnore: /v22-.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3200',
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'minimum', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 } } },
  ],
});
