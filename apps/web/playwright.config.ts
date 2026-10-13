import { defineConfig, devices } from '@playwright/test';

/**
 * Browser journeys. Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH
 * (/opt/pw-browsers); never run `playwright install`. @playwright/test is
 * pinned to the version matching that Chromium build (1.56.1 -> chromium-1194).
 *
 * The consumer UI tests intercept /v1/** with a contract-validated mock API
 * (e2e/mock), so they need no database. Readiness is checked on `/`.
 * E2E_PORT picks the dev-server port (default 3000); E2E_BASE_URL reuses a running app.
 */
const port = Number(process.env.E2E_PORT ?? 3000);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  // e2e/real drives a running app + worker; see playwright.real.config.ts.
  testIgnore: ['real/**'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    {
      name: 'minimum',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 740 } },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm exec next dev --port ${port}`,
        url: `http://localhost:${port}/`,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
