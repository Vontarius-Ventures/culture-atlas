import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, open, waitForSettledSurface } from '../helpers';
import type { MockOptions } from '../mock/api';
import { COMMONS_FIXTURE_CARD } from '../mock/discovery-intents';

async function example(page: Page, options: MockOptions) {
  const api = await open(page, '/', { style: 'ready', ...options });
  await page.route('**/v1/visual-references/images/*', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  );
  await page.getByRole('button', { name: 'Try an example' }).click();
  await page.getByRole('button', { name: 'An outfit' }).click();
  await expect(page.getByRole('region', { name: 'Brands to explore' }).first()).toBeVisible();
  return api;
}
const visualRegion = (page: Page) =>
  page.getByRole('region', { name: 'Visual references', exact: true });

for (const width of [320, 390, 1440]) {
  test(`Connections and visual references are accessible without overflow at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const api = await example(page, { visual: 'ready' });
    const connections = page.getByRole('button', { name: 'Connections', exact: true });
    const visual = page.getByRole('button', { name: 'Visual references', exact: true });
    await expect(connections).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' })).toBeVisible();
    await connections.focus();
    await page.keyboard.press('Tab');
    await expect(visual).toBeFocused();
    const before = api.log.length;
    await page.keyboard.press('Enter');
    const region = visualRegion(page);
    await expect(region.getByRole('list', { name: 'Attributed reference images' })).toBeVisible();
    await expect(region.getByText('Model-suggested · Experimental')).toBeVisible();
    await expect(region.getByText(/not authentication/)).toBeVisible();
    await expect(region.getByRole('link', { name: /View at The Metropolitan/ })).toHaveAttribute(
      'href',
      'https://www.metmuseum.org/art/collection/search/1',
    );
    await expect(region.getByRole('button', { name: /save|buy/i })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' })).toBeHidden();
    await expectNoHorizontalScroll(page);
    await waitForSettledSurface(page.locator('.capture-result'));
    // Palette labels use ink at rest; their staggered style-enter opacity is
    // not a final contrast color. Assert full opacity before the unchanged Axe.
    for (const item of await page.locator('.style-palette__item').all())
      await expect(item).toHaveCSS('opacity', '1');
    const axe = await new AxeBuilder({ page }).include('.capture-result').analyze();
    expect(axe.violations).toEqual([]);
    for (let n = 0; n < 4; n++) {
      await connections.click();
      await visual.click();
    }
    // UI switches only: no API call and no paid mutation.
    expect(api.log.length).toBe(before);
    await connections.click();
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}

test('visual work can finish after the main capture is ready without re-analysis', async ({
  page,
}) => {
  const api = await example(page, { visual: 'ready', visualPollsToReady: 6 });
  await page.getByRole('button', { name: 'Visual references', exact: true }).click();
  await expect(visualRegion(page).getByText('Comparing reference images…')).toBeVisible();
  await expect(
    visualRegion(page).getByRole('list', { name: 'Attributed reference images' }),
  ).toBeVisible({ timeout: 20_000 });
  const mutations = api.log.filter((r) => r.method !== 'GET').length;
  const reads = api.log.filter(
    (r) => /^\/v1\/captures\/[^/]+$/.test(r.path) && r.method === 'GET',
  ).length;
  await page.waitForTimeout(2500);
  expect(
    api.log.filter((r) => /^\/v1\/captures\/[^/]+$/.test(r.path) && r.method === 'GET'),
  ).toHaveLength(reads);
  expect(api.log.filter((r) => r.method !== 'GET')).toHaveLength(mutations);
});

for (const [mode, copy] of [
  ['unavailable', 'not available for this photo'],
  ['pending', 'waiting for comparison'],
  ['empty', 'No reference images passed'],
  ['failed', 'could not complete the visual comparison'],
  ['missing-image', 'No displayable reference images'],
  ['commons-missing-credit', 'No displayable reference images'],
  ['missing-profile', 'Visual comparison is not available right now'],
  ['malformed', 'not available for this photo'],
] as const) {
  test(`visual ${mode} never backfills from connections`, async ({ page }) => {
    await example(page, { visual: mode });
    await page.getByRole('button', { name: 'Visual references', exact: true }).click();
    const region = visualRegion(page);
    await expect(region.getByRole('status')).toContainText(copy);
    await expect(region.getByRole('list')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Brands to explore' }).first()).toBeHidden();
    await expectNoHorizontalScroll(page);
  });
}

test('older API payload keeps connections and honestly reports visual unavailability', async ({
  page,
}) => {
  await example(page, {});
  await page.getByRole('button', { name: 'Visual references', exact: true }).click();
  await expect(visualRegion(page).getByRole('status')).toContainText(
    'not available for this photo',
  );
  await expect(visualRegion(page).getByRole('list')).toHaveCount(0);
});

for (const width of [320, 390, 1440]) {
  for (const mode of ['commons-by', 'commons-sa'] as const) {
    test(`${mode} exposes adjacent text credit and safe keyboard links at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const api = await example(page, { visual: mode });
      const connections = page.getByRole('button', { name: 'Connections', exact: true });
      const button = page.getByRole('button', { name: 'Visual references', exact: true });
      await expect(connections).toHaveAttribute('aria-pressed', 'true');
      const before = api.log.length;
      await connections.focus();
      await page.keyboard.press('Tab');
      await expect(button).toBeFocused();
      await page.keyboard.press('Space');
      const region = visualRegion(page);
      const list = region.getByRole('list', { name: 'Attributed reference images' });
      await expect(list.getByRole('listitem')).toHaveCount(1);
      const figure = list.getByRole('figure');
      await expect(figure.getByRole('img')).toBeVisible();
      await expect(figure.locator('figcaption')).toContainText(
        COMMONS_FIXTURE_CARD.credit.attribution,
      );
      await expect(figure.locator('figcaption')).toContainText(COMMONS_FIXTURE_CARD.credit.changes);
      await expect(figure.locator('em, script')).toHaveCount(0);
      const license = figure.getByRole('link', { name: /^CC-BY/ });
      await expect(license).toHaveAttribute(
        'href',
        mode === 'commons-by'
          ? 'https://creativecommons.org/licenses/by/4.0/'
          : 'https://creativecommons.org/licenses/by-sa/4.0/',
      );
      await expect(license).toHaveAttribute('rel', 'noopener noreferrer');
      await page.keyboard.press('Tab');
      await expect(license).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(region.getByRole('link', { name: /View at Wikimedia Commons/ })).toBeFocused();
      await expect(region.getByRole('link', { name: /View at Wikimedia Commons/ })).toHaveAttribute(
        'href',
        'https://commons.wikimedia.org/?curid=2',
      );
      await expect(list).not.toContainText(/museum|public domain/i);
      await expect(region.getByText('Model-suggested · Experimental')).toBeVisible();
      await expect(region.getByText(/not authentication/)).toBeVisible();
      await expect(region.getByRole('button', { name: /save|buy/i })).toHaveCount(0);
      await expectNoHorizontalScroll(page);
      await waitForSettledSurface(page.locator('.capture-result'));
      for (const item of await page.locator('.style-palette__item').all())
        await expect(item).toHaveCSS('opacity', '1');
      expect(
        (await new AxeBuilder({ page }).include('.capture-result').analyze()).violations,
      ).toEqual([]);
      await connections.click();
      await expect(page.getByRole('list', { name: 'Discoveries from your photo' })).toBeVisible();
      expect(api.log.length).toBe(before);
    });
  }
}

test('invalid Commons credit drops only that card and retains legacy Met', async ({ page }) => {
  await example(page, { visual: 'commons-invalid-credit' });
  await page.getByRole('button', { name: 'Visual references', exact: true }).click();
  const list = visualRegion(page).getByRole('list', { name: 'Attributed reference images' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByText('Synthetic museum reference')).toBeVisible();
  await expect(list.getByText('Synthetic Commons reference')).toHaveCount(0);
  await expect(list.getByRole('link', { name: /^CC-BY/ })).toHaveCount(0);
});

test('a missing cached reference asset shows a fallback without substituting another image', async ({
  page,
}) => {
  await example(page, { visual: 'ready' });
  await page.route('**/v1/visual-references/images/*', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' }),
  );
  await page.getByRole('button', { name: 'Visual references', exact: true }).click();
  const region = visualRegion(page);
  await expect(region.getByText('Reference image unavailable')).toBeVisible();
  await expect(region.getByRole('img')).toHaveCount(0);
  await expect(region.getByRole('link', { name: /View at/ })).toBeVisible();
  await expect(region.getByRole('button', { name: /save|buy/i })).toHaveCount(0);
});
