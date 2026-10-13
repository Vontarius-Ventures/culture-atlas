import { expect, test } from '@playwright/test';

test('home renders the wordmark and headline without horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('culture atlas', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});
