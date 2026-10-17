import { defineConfig, devices } from '@playwright/test';

/**
 * Design-fidelity screenshots against the REAL stack (production build, worker,
 * PostgreSQL) with the fixture account from scripts/seed-fidelity.ts. No /v1 or
 * /v2 mocks. Viewports match the references: 1440 (desktop mockups), 390
 * (mobile mockups) and 320 (SCREEN-CONTRACT minimum width).
 *
 *   pnpm db:migrate && pnpm exec tsx scripts/seed-fidelity.ts --out .data/fidelity-seed.json
 *   (cd apps/web && pnpm exec next build && pnpm exec next start --port 3410) & pnpm worker &
 *   cd apps/web && E2E_BASE_URL=http://localhost:3410 pnpm exec playwright test -c playwright.fidelity.config.ts
 *
 * See docs/design-fidelity-v1-and-account.md. Chromium comes from
 * PLAYWRIGHT_BROWSERS_PATH; never run `playwright install` here.
 */
export default defineConfig({
  testDir: './e2e/fidelity',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3410',
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 960 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow', use: { ...devices['Pixel 7'], viewport: { width: 320, height: 700 } } },
  ],
});
