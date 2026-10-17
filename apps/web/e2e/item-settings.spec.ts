import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, open } from './helpers';

test.describe('Item detail and references', () => {
  test('disclosures are closed by default; related items continue exploration; Discover more is explicit', async ({
    page,
  }) => {
    const api = await open(page, '/');
    await page.goto(`/items/${api.feedCard('vintage-racing').id}?from=discover`);
    const why = page.getByRole('button', { name: 'Why this?' });
    await expect(why).toHaveAttribute('aria-expanded', 'false');
    await why.click();
    await expect(page.getByText(/connects to things you looked at/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Endurance racing (motorsport)' })).toBeVisible();
    // Opening never starts generation.
    expect(api.log.filter((r) => r.method !== 'GET')).toEqual([]);
    const related = page.getByRole('list', { name: 'Related discoveries' });
    await expect(related.getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: 'Discover more' }).click();
    await expect(related.getByRole('listitem')).toHaveCount(6, { timeout: 15_000 });
    expect(api.log.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual([
      `/v1/items/${api.feedCard('vintage-racing').id}/discoveries`,
    ]);
    await related.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Quiet corners' })).toBeVisible();
  });

  test('Hide removes an item from the feed with Undo', async ({ page }) => {
    const api = await open(page, '/');
    await page.getByRole('link', { name: 'Linen days' }).click();
    await page.getByRole('button', { name: 'More options for Linen days' }).click();
    await page.getByRole('button', { name: 'Hide this' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('link', { name: 'Linen days' })).toHaveCount(0);
    expect(api.hidden.has(api.feedCard('linen-days').id)).toBe(true);
    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('link', { name: 'Linen days' })).toBeVisible();
  });

  test('reference page: overview, sections, sources closed by default, related', async ({
    page,
  }) => {
    const api = await open(page, '/');
    await page.goto(`/references/${api.referenceId}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Endurance racing jackets' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Team colors' })).toBeVisible();
    const sources = page.getByRole('button', { name: 'Sources' });
    await expect(sources).toHaveAttribute('aria-expanded', 'false');
    await sources.click();
    await expect(page.getByRole('link', { name: 'Endurance racing (motorsport)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Related discoveries' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Settings', () => {
  test('connect an agent to selected collections: credential shown once, then revoke', async ({
    page,
  }) => {
    const api = await open(page, '/settings', { account: true, seedCollections: true });
    await expect(page.getByText('No agents are connected.')).toBeVisible();
    await page.getByRole('button', { name: 'Connect an agent' }).click();
    await page.getByLabel('Agent name').fill('Demo agent');
    await expect(page.getByRole('button', { name: 'Connect agent' })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Slow Sunday' }).check();
    await page.getByRole('checkbox', { name: 'Add to and organize those collections' }).check();
    await page.getByRole('button', { name: 'Connect agent' }).click();
    const dialog = page.getByRole('dialog', { name: 'Agent connected' });
    await expect(dialog.getByText('cat_ab12_s3cr3t-shown-once')).toBeVisible();
    await expect(dialog.getByText('This is the only time it’s shown.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    expect(api.agents[0]).toMatchObject({
      client_name: 'Demo agent',
      library_access: 'selected_collections',
    });
    expect(api.agents[0]!.scopes).toContain('collections:write');
    expect(api.agents[0]!.scopes).not.toContain('plans:write');
    await expect(page.getByText('Access: Slow Sunday')).toBeVisible();
    await expect(page.getByText('cat_ab12_s3cr3t-shown-once')).toHaveCount(0);
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke access' }).click();
    await expect(page.getByText('No agents are connected.')).toBeVisible();
  });

  test('World Sensor offline shows last import status and that upload still works', async ({
    page,
  }) => {
    await open(page, '/settings', { account: true, sensorOffline: true });
    await expect(page.getByText(/Offline · last import 3 hours ago/)).toBeVisible();
    await expect(page.getByText('Upload and camera are still available.')).toBeVisible();
  });
});

test.describe('Accessibility', () => {
  const pages: Array<
    [string, Parameters<typeof open>[2], (api: Awaited<ReturnType<typeof open>>) => string]
  > = [
    ['discover', {}, () => '/'],
    ['collections', { account: true, seedCollections: true }, () => '/collections'],
    [
      'collection',
      { account: true, seedCollections: true },
      (api) => `/collections/${[...api.collections.values()][0]!.id}`,
    ],
    ['item', {}, (api) => `/items/${api.feedCard('vintage-racing').id}`],
    [
      'plan',
      { account: true, seedCollections: true, seedPlan: true },
      (api) => `/plans/${[...api.plans.values()][0]!.id}`,
    ],
    ['settings', { account: true, seedCollections: true, sensorOffline: true }, () => '/settings'],
    ['capture', {}, () => '/capture/photo'],
    ['capture-source', {}, () => '/capture'],
  ];
  for (const [name, opts, path] of pages) {
    test(`no serious axe violations: ${name}`, async ({ page }) => {
      const api = await open(page, '/capture', opts);
      await page.goto(path(api));
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('main')).toBeVisible();
      const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      ).toEqual([]);
      await expectNoHorizontalScroll(page);
    });
  }

  test('save picker dialog has no serious axe violations', async ({ page }) => {
    await open(page, '/', { account: true, seedCollections: true });
    await page.getByRole('button', { name: 'Save Around the table' }).click();
    await expect(page.getByRole('radio', { name: 'Slow Sunday' })).toBeChecked();
    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(
      results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id),
    ).toEqual([]);
  });

  test('reduced motion disables transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '/');
    const value = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--transition-standard').trim(),
    );
    expect(value).toMatch(/^0m?s$/);
  });
});
