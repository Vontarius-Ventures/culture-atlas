import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';
import { openV22 } from './helpers';

test('anonymous example keeps every header action on screen at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openV22(page, '/', { pollsToComplete: 1 });
  await expect(page.locator('header').getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Try an example' }).click();
  await page.getByRole('button', { name: 'An outfit' }).click();
  await expect(page.getByRole('heading', { name: 'Vintage racing', exact: true })).toBeVisible();
  await expect(page.getByText('Example result', { exact: true }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  const header = page.locator('header');
  for (const name of ['Sign in', 'Capture', 'Settings']) {
    const action = header.getByRole('link', { name, exact: true });
    await expect(action).toBeVisible();
    const box = await action.boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x, name).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, name).toBeLessThanOrEqual(320);
    expect(box!.width, `${name} touch width`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `${name} touch height`).toBeGreaterThanOrEqual(44);
  }
  await header.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expectNoHorizontalScroll(page);
});
