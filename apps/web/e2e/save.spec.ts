import { expect, test } from '@playwright/test';
import { open } from './helpers';

// Clicks cards in the feed; Reduce Motion keeps the floating feed still
// (the conveyor itself is covered in feed-float.spec.ts).
test.use({ contextOptions: { reducedMotion: 'reduce' } });

test.describe('Saving', () => {
  test('anonymous save prompts account creation, claims the save, then files it into a new collection with Undo', async ({
    page,
  }) => {
    // The taste questionnaire that follows sign-up (amendment 2.2) is covered in
    // e2e/v22/onboarding.spec.ts; here it is switched off (ONBOARDING_REQUIRED=false).
    const api = await open(page, '/', { onboardingOnSignUp: false });
    const trigger = page.getByRole('button', { name: 'Save Vintage racing' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await expect(
      dialog.getByText('Create an account to keep this and build private collections.'),
    ).toBeVisible();
    await dialog.getByLabel(/Your name/).fill('Ada');
    await dialog.getByRole('button', { name: 'Create account' }).click();
    // Account created; the intended save was claimed; picker now offers collections.
    // The click only starts the request: wait for it instead of reading the log at once.
    await expect.poll(() => api.log.some((r) => r.path === '/v1/accounts')).toBe(true);
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill('Slow Sunday');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Saved to Slow Sunday');
    await expect(page.getByRole('status').filter({ hasText: 'Saved to Slow Sunday' })).toHaveCount(
      1,
    );
    await expect(page.getByRole('button', { name: 'Saved Vintage racing' })).toBeFocused();
    const slow = [...api.collections.values()].find((c) => c.name === 'Slow Sunday')!;
    expect(slow.members).toHaveLength(1);
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => slow.members.length).toBe(0);
  });

  test('picker: remembered destination is preselected, Escape closes and focus returns to Save', async ({
    page,
  }) => {
    const api = await open(page, '/', { account: true, seedCollections: true });
    const trigger = page.getByRole('button', { name: 'Save Around the table' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('radio', { name: 'Slow Sunday' })).toBeChecked();
    await expect(dialog.getByRole('radio', { name: 'Slow Sunday' })).toBeFocused();
    // Focus is trapped inside the dialog.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Save for later, then the next picker remembers it.
    await trigger.click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Saved for later');
    expect(api.saved.has(api.feedCard('around-the-table').id)).toBe(true);
    await page
      .getByRole('button', { name: 'Save Sculptural forms' })
      .or(page.getByRole('button', { name: 'Saved Sculptural forms' }))
      .click();
    await expect(dialog.getByRole('radio', { name: 'Save for later' })).toBeChecked();
  });

  test('saved item offers Unsave everywhere, with Undo', async ({ page }) => {
    const api = await open(page, '/', { account: true, seedCollections: true });
    await page.getByRole('button', { name: 'Saved Vintage racing' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await dialog.getByRole('button', { name: 'Unsave everywhere' }).click();
    await expect(page.locator('.toast')).toContainText('Removed from your saves');
    const id = api.feedCard('vintage-racing').id;
    expect(api.saved.has(id)).toBe(false);
    expect([...api.collections.values()].some((c) => c.members.some((m) => m.item_id === id))).toBe(
      false,
    );
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => api.saved.has(id)).toBe(true);
  });

  test('Save this inspiration saves the whole capture', async ({ page }) => {
    const api = await open(page, '/', { account: true, seedCollections: true, pollsToComplete: 1 });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await page.getByRole('button', { name: 'Save this inspiration' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast')).toContainText('Saved to Slow Sunday');
    await expect(page.getByRole('button', { name: 'Inspiration saved' })).toBeVisible();
    const capture = [...api.captures.values()][0]!;
    expect(api.saved.has(capture.itemId)).toBe(true);
  });
});
