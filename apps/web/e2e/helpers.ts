import path from 'node:path';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { installMockApi, type MockApi, type MockOptions } from './mock/api';

export const SCREENSHOT_DIR = path.join(import.meta.dirname, 'screenshots');
export const SAMPLE_JPEG = path.resolve(import.meta.dirname, '../public/samples/cafe.jpg');

/** Mock /v1 and open a path. */
export async function open(page: Page, url: string, opts: MockOptions = {}): Promise<MockApi> {
  const api = await installMockApi(page, opts);
  await page.goto(url);
  return api;
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'page must not scroll horizontally').toBeLessThanOrEqual(0);
}

/** Wait until images in the viewport have decoded pixels (stable screenshots). */
export async function settleImages(page: Page, fullPage = false) {
  // Pages that poll (e.g. live event streams) never go idle: cap the wait.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page
    .waitForFunction(
      (all) =>
        Array.from(document.images)
          .filter((img) => {
            if (all) return true;
            const r = img.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
          })
          .every((img) => img.complete && img.naturalWidth > 0),
      fullPage,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
}

export async function screenshot(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
  // The Next.js dev-mode indicator is not part of the app.
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  if (fullPage) {
    // Load lazy images below the fold before a full-page capture.
    await page.evaluate(() =>
      document
        .querySelectorAll('img[loading="lazy"]')
        .forEach((img) => img.setAttribute('loading', 'eager')),
    );
  }
  await settleImages(page, fullPage);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}-${testInfo.project.name}.png`),
    fullPage,
    animations: 'disabled',
  });
}

export const isMobile = (testInfo: TestInfo) => testInfo.project.name !== 'desktop';
