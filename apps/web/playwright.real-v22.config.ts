import { defineConfig, devices } from '@playwright/test';

/**
 * Spec amendment 2.2 journeys against the REAL stack (no /v1 mocks), at 1440,
 * 390 and 320 px. Start the fake Qloo, the production build, the worker (with
 * the e2e fake model transport) and the media worker first; see
 * docs/v22-real-stack.md. Chromium comes from PLAYWRIGHT_BROWSERS_PATH; never
 * run `playwright install` here.
 */
export default defineConfig({
  testDir: './e2e/real',
  testMatch: /v22-.*\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3220',
    trace: 'retain-on-failure',
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'narrow', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 700 } } },
  ],
});
