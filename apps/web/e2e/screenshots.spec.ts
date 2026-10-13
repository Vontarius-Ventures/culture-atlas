/**
 * Screenshots of the seven reference surfaces (plus key states) at 1440, 390
 * and 360 px, saved to e2e/screenshots/ for side-by-side comparison with
 * design/cultural-atlas-v1/mockups. Deliberate differences are recorded in
 * docs/design-deviations.md.
 */
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, isMobile, open, screenshot } from './helpers';

test.describe('reference surfaces', () => {
  test('01/04 discover', async ({ page }, testInfo) => {
    await open(page, '/', { account: true, seedCollections: true });
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Vintage racing' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, '01-discover');
  });

  test('05 save picker', async ({ page }, testInfo) => {
    await open(page, '/', { account: true, seedCollections: true });
    await page.getByRole('button', { name: 'Save Around the table' }).click();
    await expect(page.getByRole('dialog', { name: 'Save to a collection' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Slow Sunday' })).toBeChecked();
    await screenshot(page, testInfo, '05-save');
  });

  test('06 item detail', async ({ page }, testInfo) => {
    const api = await open(page, '/', { account: true, seedCollections: true });
    await page.goto(`/items/${api.feedCard('vintage-racing').id}?from=discover`);
    await expect(page.getByRole('heading', { level: 1, name: 'Vintage racing' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You might also like' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, '06-item');
  });

  test('07 collections index', async ({ page }, testInfo) => {
    await open(page, '/collections', { account: true, seedCollections: true });
    await expect(page.getByRole('link', { name: 'Slow Sunday' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, '07-collections');
  });

  test('02 collection detail with selection', async ({ page }, testInfo) => {
    const api = await open(page, '/collections', { account: true, seedCollections: true });
    const slow = [...api.collections.values()].find((c) => c.name === 'Slow Sunday')!;
    await page.goto(`/collections/${slow.id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Slow Sunday' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Sunday listening' }).check();
    await page.getByRole('checkbox', { name: 'Select Late-night cinema' }).check();
    await expect(page.getByText('2 selected')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, '02-collection');
  });

  test('03 movie night', async ({ page }, testInfo) => {
    const api = await open(page, '/plans', {
      account: true,
      seedCollections: true,
      seedPlan: true,
    });
    const plan = [...api.plans.values()][0]!;
    await page.goto(`/plans/${plan.id}`);
    await expect(page.getByRole('heading', { name: 'Your slow Sunday, planned.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'In the Mood for Love' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, '03-plan', isMobile(testInfo));
  });
});

test.describe('states', () => {
  test('first visit, capture and processing', async ({ page }, testInfo) => {
    await open(page, '/', { holdJobs: true });
    await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    await expect(page.getByText('Photos you submit are analyzed by AI services')).toBeVisible();
    await screenshot(page, testInfo, 'state-first-visit');
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page.getByRole('heading', { name: 'Finding your next favorites…' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, 'state-processing');
  });

  test('capture results with partial discoveries', async ({ page }, testInfo) => {
    await open(page, '/', { qlooUnavailable: true, pollsToComplete: 1 });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page.getByText('Related discoveries are taking longer.')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, 'state-partial', true);
  });

  test('empty collection and settings', async ({ page }, testInfo) => {
    const api = await open(page, '/collections', {
      account: true,
      emptyCollection: true,
      sensorOffline: true,
    });
    const c = [...api.collections.values()][0]!;
    await page.goto(`/collections/${c.id}`);
    await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
    await screenshot(page, testInfo, 'state-empty-collection');
    await page.goto('/settings');
    await expect(page.getByText(/Offline · last import/)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await screenshot(page, testInfo, 'state-settings', true);
  });
});
