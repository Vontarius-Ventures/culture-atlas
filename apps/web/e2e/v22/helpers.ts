import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { CaptureCapabilitiesResponse } from '@culture-atlas/domain/schemas';
import { installMockApi, type MockApi, type MockOptions } from '../mock/api';

export const isDesktop = (testInfo: TestInfo) => testInfo.project.name === 'desktop';

/**
 * Mock /v1 (contract-validated) and /v2/capabilities, then open a path.
 * Capabilities answer 401 unless `capabilities` is given (anonymous visitors
 * cannot read them; the UI then falls back to its defaults).
 */
export async function openV22(
  page: Page,
  url: string,
  opts: MockOptions = {},
  capabilities?: { while_we_look_enabled: boolean },
): Promise<MockApi> {
  await page.route(/\/v2\/capabilities/, (route) =>
    capabilities
      ? route.fulfill({ status: 200, json: capabilitiesJson(capabilities.while_we_look_enabled) })
      : route.fulfill({
          status: 401,
          json: {
            error: {
              code: 'unauthenticated',
              message: 'Sign in.',
              retryable: false,
              request_id: 'mock',
            },
          },
        }),
  );
  const api = await installMockApi(page, opts);
  await page.goto(url);
  return api;
}

function capabilitiesJson(whileWeLook: boolean) {
  return CaptureCapabilitiesResponse.parse({
    contract_version: '2026-10-15.1',
    flags: {
      media_library: true,
      camera_photo: true,
      camera_video: true,
      file_photo_upload: true,
      file_video_upload: true,
      meta_glasses_entry_visible: true,
      meta_glasses_capture_enabled: false,
      concentrate_analysis_enabled: true,
      automatic_analysis: false,
      while_we_look_enabled: whileWeLook,
    },
    limits: {
      photo_max_bytes: 15 * 1024 * 1024,
      photo_max_pixels: 40_000_000,
      video_max_bytes: 250 * 1024 * 1024,
      video_max_duration_ms: 120_000,
      capture_video_max_duration_ms: 60_000,
      account_quota_bytes: 5 * 1024 ** 3,
      batch_max_files: 20,
      concurrent_transfers: 2,
      analysis_daily_limit: 50,
      video_analysis_max_frames: 8,
    },
    availability: {
      meta_glasses: { available: false, reasons: ['build_unsupported'] },
      analysis: { available: true, reasons: [] },
      video: { available: true, reasons: [] },
    },
  });
}

export async function noSeriousAxe(page: Page) {
  const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

/** Pretend the tab was hidden or shown (Playwright pages are always visible). */
export async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}
