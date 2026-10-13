import { expect, test } from '@playwright/test';
import { open } from './helpers';

test.describe('Collections and plans', () => {
  test('select mixed items → Make a movie night → plan form → plan; Change music replaces only music', async ({
    page,
  }) => {
    const api = await open(page, '/collections', { account: true, seedCollections: true });
    await page.getByRole('link', { name: 'Slow Sunday' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Slow Sunday' })).toBeVisible();
    // Selection bar only after selection.
    await expect(page.getByRole('region', { name: 'Selection' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Select Quiet corners' }).check();
    await expect(page.getByRole('button', { name: 'Make a movie night' })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Select Bill Evans' }).check();
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Make a movie night' }).click();

    await expect(page.getByRole('heading', { name: 'Make a movie night' })).toBeVisible();
    await expect(page.getByText('Quiet corners')).toBeVisible();
    await page.getByLabel(/Anything in mind/).fill('A relaxed evening');
    const leaveOut = page.getByLabel(/Leave out of the food/);
    await leaveOut.fill('peanuts');
    await leaveOut.press('Enter');
    await expect(page.getByRole('list', { name: 'Foods to leave out' })).toContainText('peanuts');
    await expect(page.getByRole('radio', { name: /Balanced/ })).toBeChecked();
    await page.getByText('Adventurous', { exact: true }).click();
    const create = page.waitForRequest(
      (r) => r.url().endsWith('/v1/plans') && r.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create movie night' }).click();
    const body = (await create).postDataJSON();
    expect(body).toMatchObject({
      template: 'movie_night',
      exploration: 'adventurous',
      constraints: { dietary_exclusions: ['peanuts'], instruction: 'A relaxed evening' },
    });
    expect(body.item_ids).toHaveLength(2);

    await expect(page.getByRole('heading', { name: 'Your slow Sunday, planned.' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('link', { name: 'In the Mood for Love' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'For the table' })).toBeVisible();
    await expect(page.getByText('Bill Evans').last()).toBeVisible();
    await page.getByRole('button', { name: 'Change music' }).click();
    await expect(page.getByText('Alice Coltrane')).toBeVisible({ timeout: 15_000 });
    // Film and food are untouched.
    await expect(page.getByRole('link', { name: 'In the Mood for Love' })).toBeVisible();
    await expect(page.getByText('Sesame noodles')).toBeVisible();
    const replacement = api.log.find((r) => r.path.endsWith('/replacements'));
    expect(replacement).toBeTruthy();
  });

  test('Make something suggests a diverse default selection', async ({ page }) => {
    const api = await open(page, '/collections', { account: true, seedCollections: true });
    const slow = [...api.collections.values()].find((c) => c.name === 'Slow Sunday')!;
    await page.goto(`/collections/${slow.id}`);
    await page.getByRole('button', { name: 'Make something' }).click();
    await page
      .getByRole('dialog', { name: 'Make something' })
      .getByRole('button', { name: /Movie night/ })
      .click();
    await expect(page.getByText(/\d selected/)).toBeVisible();
    const checked = await page.getByRole('checkbox', { checked: true }).count();
    expect(checked).toBeGreaterThanOrEqual(2);
    expect(checked).toBeLessThanOrEqual(5);
    await expect(page.getByRole('button', { name: 'Make a movie night' })).toBeEnabled();
  });

  test('rename, reorder, remove membership with Undo, delete collection', async ({ page }) => {
    const api = await open(page, '/collections', { account: true, seedCollections: true });
    const slow = [...api.collections.values()].find((c) => c.name === 'Slow Sunday')!;
    await page.goto(`/collections/${slow.id}`);
    await page.getByRole('button', { name: 'More options for Slow Sunday' }).click();
    await page.getByRole('button', { name: 'Rename or edit description' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit collection' });
    await edit.getByLabel('Name').fill('Slower Sunday');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Slower Sunday' })).toBeVisible();

    const firstTwo = () => slow.members.slice(0, 2).map((m) => api.cards.get(m.item_id)!.title);
    expect(firstTwo()).toEqual(['Quiet corners', 'Sunday listening']);
    await page.getByRole('button', { name: 'More options for Sunday listening' }).click();
    await page.getByRole('button', { name: 'Move earlier' }).click();
    await expect.poll(firstTwo).toEqual(['Sunday listening', 'Quiet corners']);

    await page.getByRole('button', { name: 'More options for Tea rituals' }).click();
    await page.getByRole('button', { name: 'Remove from collection' }).click();
    await expect(page.locator('.toast')).toContainText('Removed from Slower Sunday');
    await expect(page.getByRole('link', { name: 'Tea rituals' })).toHaveCount(0);
    // Membership removal keeps the saved item and other memberships.
    const tea = api.feedCard('tea-rituals').id;
    expect(api.saved.has(tea)).toBe(true);
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('link', { name: 'Tea rituals' })).toBeVisible();

    await page.getByRole('button', { name: 'More options for Slower Sunday' }).click();
    await page.getByRole('button', { name: 'Delete collection' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete collection' }).click();
    await expect(page).toHaveURL(/\/collections$/);
    await expect(page.getByRole('link', { name: 'Slower Sunday' })).toHaveCount(0);
  });

  test('empty collection offers Add saved items and Discover; plan creation is disabled', async ({
    page,
  }) => {
    const api = await open(page, '/collections', { account: true, emptyCollection: true });
    api.save(api.feedCard('linen-days').id);
    const c = [...api.collections.values()][0]!;
    await page.goto(`/collections/${c.id}`);
    await expect(page.getByRole('heading', { name: 'Nothing here yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Make something' })).toBeDisabled();
    await expect(page.getByRole('main').getByRole('link', { name: 'Discover' })).toBeVisible();
    await page.getByRole('main').getByRole('button', { name: 'Add saved items' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add saved items' });
    await dialog.getByRole('checkbox', { name: 'Linen days' }).check();
    await dialog.getByRole('button', { name: 'Add 1 item' }).click();
    await expect(page.getByRole('link', { name: 'Linen days' })).toBeVisible();
  });

  test('no collections: unfiled saves, Create a collection, examples and Capture', async ({
    page,
  }) => {
    const api = await open(page, '/', { account: true });
    api.save(api.feedCard('linen-days').id);
    await page.goto('/collections');
    await expect(page.getByRole('heading', { name: 'No collections yet' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Saved for later' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create a collection' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Capture' })).toBeVisible();
    await page.getByRole('button', { name: 'Create a collection' }).click();
    await page.getByRole('dialog', { name: 'New collection' }).getByLabel('Name').fill('Weekend');
    await page.getByRole('button', { name: 'Create collection' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Weekend' })).toBeVisible();
  });

  test('stale collection revision on plan creation invites review', async ({ page }) => {
    const api = await open(page, '/collections', { account: true, seedCollections: true });
    const slow = [...api.collections.values()].find((c) => c.name === 'Slow Sunday')!;
    const ids = slow.members.slice(0, 2).map((m) => m.item_id);
    await page.goto(`/collections/${slow.id}/make?items=${ids.join(',')}`);
    await expect(page.getByRole('button', { name: 'Create movie night' })).toBeEnabled();
    slow.revision += 1; // someone else changed it
    await page.getByRole('button', { name: 'Create movie night' }).click();
    await expect(
      page.getByText('This collection changed. Review the latest version and try again.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review collection' })).toBeVisible();
  });

  test('anonymous visitors are invited to create an account on Collections and Plans', async ({
    page,
  }) => {
    await open(page, '/collections');
    await expect(page.getByText('Create an account to keep collections.')).toBeVisible();
    await page.goto('/plans');
    await expect(
      page.getByText('Create an account to make and keep plans from your collections.'),
    ).toBeVisible();
  });
});
