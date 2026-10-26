/**
 * The library's Audio filter (amendment 2.3): Music Mode recordings are kept
 * privately and are listed when the Audio chip asks for them. Like the
 * server, the default page and the Photos/Videos chips list photos and videos
 * only, so a client that never asks never meets an audio row.
 */
import { expect, test } from '@playwright/test';
import { LIBRARY_SEED, openV2, type SeedMedia } from './mock-v2';

const RECORDINGS: SeedMedia[] = [
  {
    title: 'Corner café song',
    kind: 'audio',
    source: 'phone_microphone',
    duration_ms: 42_000,
    minutesAgo: 3,
  },
  {
    title: 'Busker on the bridge',
    kind: 'audio',
    source: 'browser_microphone',
    duration_ms: 15_000,
    minutesAgo: 6,
  },
];

test.describe('library audio', () => {
  test('the Audio chip lists recordings with their duration; other filters stay without them', async ({
    page,
  }) => {
    await openV2(page, '/library', {
      media: [...LIBRARY_SEED.slice(0, 2), ...RECORDINGS],
    });
    // The default page mirrors the server: photos and videos only.
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeVisible();
    await expect(page.getByText('Corner café song')).toHaveCount(0);

    // The chip is a server query, not a client-side re-sort.
    const audioQuery = page.waitForRequest((r) => r.url().includes('/v2/library?kind=audio'));
    await page.getByRole('button', { name: 'Audio', exact: true }).click();
    expect((await audioQuery).method()).toBe('GET');

    await expect(page.getByText('Corner café song')).toBeVisible();
    await expect(page.getByText('Busker on the bridge')).toBeVisible();
    // Only what the API returned: each row shows the recording's own duration.
    await expect(page.locator('.media-card__duration', { hasText: '0:42' })).toBeVisible();
    await expect(page.locator('.media-card__duration', { hasText: '0:15' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Photos', exact: true }).click();
    await expect(page.getByText('Corner café song')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeVisible();
  });

  test('an empty audio filter says so honestly', async ({ page }) => {
    await openV2(page, '/library', { media: LIBRARY_SEED.slice(0, 1) });
    await page.getByRole('button', { name: 'Audio', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'No audio yet.' })).toBeVisible();
  });
});
