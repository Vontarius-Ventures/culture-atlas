import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, open } from './helpers';

test.describe('Discover', () => {
  test('first visit shows the home copy, the three start actions, the AI notice and example labels', async ({
    page,
  }) => {
    await open(page, '/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Find more of what you love.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload a photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
    await expect(
      page.getByText('Photos you submit are analyzed by AI services to find related discoveries.'),
    ).toBeVisible();
    await expect(page.getByText('Example result').first()).toBeVisible();
    // No sign-in prerequisite and no questionnaire.
    await expect(page.getByText(/sign in/i)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('filters narrow the feed and only supported filters render', async ({ page }) => {
    await open(page, '/');
    const filters = page.getByRole('group', { name: 'Filter discoveries' });
    await expect(filters.getByRole('button')).toHaveText(['All', 'Wear', 'Play', 'Watch', 'Eat']);
    await expect(filters.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await filters.getByRole('button', { name: 'Eat' }).click();
    await expect(page.getByRole('link', { name: 'Around the table' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Vintage racing' })).toHaveCount(0);
  });

  // Reduce Motion: the feed is the static grid of every loaded card (the floating
  // conveyor is covered in feed-float.spec.ts).
  test.describe('static grid (Reduce Motion)', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('Load more appends the next page without starting any generation', async ({ page }) => {
      const api = await open(page, '/');
      const grid = page.getByRole('list', { name: 'Discoveries' });
      await expect(grid.getByRole('listitem')).toHaveCount(12);
      await page.getByRole('button', { name: 'Load more' }).click();
      await expect(grid.getByRole('listitem')).toHaveCount(17);
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
      const mutations = api.log.filter((r) => r.method !== 'GET');
      expect(mutations).toEqual([]);
      expect(api.log.filter((r) => r.path === '/v1/discoveries').map((r) => r.search)).toEqual([
        '?limit=12',
        '?limit=12&cursor=12',
      ]);
    });

    test('opening a card and going back restores the feed and scroll position', async ({
      page,
    }, testInfo) => {
      await open(page, '/');
      await page.getByRole('button', { name: 'Load more' }).click();
      const target = page.getByRole('link', { name: 'Spring light' });
      await target.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => window.scrollY);
      expect(before).toBeGreaterThan(200);
      await target.click();
      await expect(page.getByRole('heading', { level: 1, name: 'Spring light' })).toBeVisible();
      await page.getByRole('main').getByRole('link', { name: 'Discover' }).click();
      await expect(page.getByRole('link', { name: 'Spring light' })).toBeVisible();
      // The appended page is still there (no refetch) and we are back near where we were.
      await expect(
        page.getByRole('list', { name: 'Discoveries' }).getByRole('listitem'),
      ).toHaveCount(17);
      const after = await page.evaluate(() => window.scrollY);
      expect(Math.abs(after - before)).toBeLessThan(
        testInfo.project.name === 'desktop' ? 120 : 200,
      );
    });
  });

  test('keyboard: skip link, card link and Save are reachable in reading order', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'keyboard flow checked on desktop');
    await open(page, '/');
    await expect(page.getByRole('link', { name: 'Vintage racing' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
    await page.getByRole('link', { name: 'Vintage racing' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Save Vintage racing' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeFocused();
  });
});
