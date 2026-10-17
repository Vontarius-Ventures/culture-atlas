import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll, open, screenshot } from '../helpers';
import { installAgentsSharingMock, type AgentsSharingOptions } from './agents-sharing-mock';

/**
 * Screens 10–13 against their HTML mockups (specs/capture-platform-v2/design/
 * index.html sections 10–13). Screenshots land in e2e/screenshots/v2/ as
 * <screen>-<project>.png for desktop (1440), mobile (390), minimum (360) and
 * narrow (320). Run: cd apps/web && E2E_PORT=3107 pnpm exec playwright test e2e/v2/agents-sharing.spec.ts
 */

async function setup(page: Page, opts: AgentsSharingOptions & { collectionName?: string } = {}) {
  const v1 = await open(page, 'about:blank', { account: true });
  const collection = v1.createCollection(opts.collectionName ?? 'Quiet weekends', 'A few things for slower days.');
  const mock = await installAgentsSharingMock(page, { ...opts, collection: { id: collection.id, name: collection.name } });
  return { v1, mock, collection };
}

async function shot(page: Page, info: TestInfo, name: string) {
  await expectNoHorizontalScroll(page);
  await screenshot(page, info, `v2/${name}`, true);
}

async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).include('.as-page').withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

test.describe('10 Agents', () => {
  test('lists the connection, resources, expiry, last use and activity like the mockup', async ({ page }, info) => {
    await setup(page, { seedAgent: true });
    await page.goto('/settings/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'Connected agents' })).toBeVisible();
    await expect(page.getByText('Choose what each agent can see and do.')).toBeVisible();
    const card = page.getByRole('article', { name: 'My research assistant' });
    await expect(card.getByText('Connected', { exact: true })).toBeVisible();
    await expect(card.getByText('View device setup · Read preferences')).toBeVisible();
    await expect(card.getByText('Collections: Quiet weekends')).toBeVisible();
    await expect(card.getByText('Expires in 24 days · Last used today')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Edit permissions' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Revoke access' })).toBeVisible();
    await expect(page.getByText('Read your preferences')).toBeVisible();
    await expect(page.getByText('Viewed Quiet weekends')).toBeVisible();
    await expect(page.getByText('No capture requests')).toBeVisible();
    // No secret or credential prefix is rendered in the list.
    await expect(page.locator('body')).not.toContainText('cat_');
    await axe(page);
    await shot(page, info, '10-agents');
  });

  test('revoke confirms the named connection, then removes it and reports success', async ({ page }, info) => {
    const { mock } = await setup(page, { seedAgent: true });
    await page.goto('/settings/agents');
    const card = page.getByRole('article', { name: 'My research assistant' });
    await card.getByRole('button', { name: 'Revoke access' }).click();
    await expect(card.getByText('Revoke access for My research assistant?')).toBeVisible();
    await shot(page, info, '10-agents-revoke-confirm');
    await card.getByRole('group').getByRole('button', { name: 'Revoke access' }).click();
    await expect(page.getByText('Access revoked for My research assistant.')).toBeVisible();
    await expect(page.getByRole('article', { name: 'My research assistant' })).toHaveCount(0);
    expect(mock.requests).toContain(`DELETE /v2/agent-connections/${mock.connections[0]!.id}`);
  });

  test('rotation shows the new credential once in a separate success state', async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await setup(page, { seedAgent: true });
    await page.goto('/settings/agents');
    const card = page.getByRole('article', { name: 'My research assistant' });
    await card.getByRole('button', { name: 'Edit permissions' }).click();
    await expect(card.getByLabel('View my device setup')).toBeChecked();
    await card.getByRole('button', { name: 'Rotate credential' }).click();
    await card.getByRole('group').getByRole('button', { name: 'Rotate credential' }).click();
    await expect(page.getByRole('heading', { name: 'Copy your agent credential' })).toBeVisible();
    await expect(page.getByLabel('Agent credential')).toHaveValue(/^cat_9c8d7e6f_/);
    await shot(page, info, '10-agents-rotated-secret');
    await page.getByRole('button', { name: 'Copy credential' }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByLabel('Agent credential')).toHaveCount(0);
  });
});

test.describe('11 Agent permission', () => {
  test('defaults to setup and preferences, explains phone permission, and shows the secret once', async ({ page }, info) => {
    await setup(page);
    await page.goto('/settings/agents/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Connect an agent' })).toBeVisible();
    await page.getByLabel('Agent name').fill('My research assistant');
    await expect(page.getByLabel('View my device setup')).toBeChecked();
    await expect(page.getByLabel('Read my preferences')).toBeChecked();
    for (const label of ['Change ordinary preferences', 'View selected collections', 'Request capture while I allow it']) {
      await expect(page.getByLabel(label)).not.toBeChecked();
    }
    await expect(page.getByText('Capture also requires permission on your phone.')).toBeVisible();
    await page.getByLabel('Agent name').blur();
    await expect(page.getByText('Setup and preferences only')).toBeVisible();
    await expect(page.getByText('No media, microphone or camera access')).toBeVisible();
    await expect(page.getByLabel('Expires after')).toHaveValue('30');
    await axe(page);
    await shot(page, info, '11-agent-permission');

    // Copy failure never announces "Copied".
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });
    });
    await page.getByRole('button', { name: 'Connect agent' }).click();
    await expect(page.getByRole('heading', { name: 'Copy your agent credential' })).toBeVisible();
    await expect(page.getByText('MCP endpoint:')).toBeVisible();
    await shot(page, info, '11-agent-secret-once');
  });

  test('collections and capture need explicit selections before Connect', async ({ page }, info) => {
    await setup(page);
    await page.goto('/settings/agents/new');
    await page.getByLabel('Agent name').fill('Library helper');
    await page.getByLabel('View selected collections').check();
    await expect(page.getByLabel('Library access')).toHaveValue('selected_collections');
    await expect(page.getByRole('button', { name: 'Connect agent' })).toBeDisabled();
    await expect(page.getByText('Choose at least one collection.')).toBeVisible();
    await page.getByLabel('Quiet weekends').check();
    await expect(page.getByLabel('Download permitted originals')).not.toBeChecked();
    await page.getByLabel('Request capture while I allow it').check();
    await expect(page.getByText('No phones are registered.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect agent' })).toBeDisabled();
    await shot(page, info, '11-agent-permission-expanded');
  });
});

test.describe('12 Collection share', () => {
  test('starts Restricted and private, with the live-change disclosure', async ({ page }, info) => {
    const { collection } = await setup(page);
    await page.goto(`/collections/${collection.id}/share`);
    await expect(page.getByRole('heading', { level: 1, name: 'Share Quiet weekends' })).toBeVisible();
    await expect(page.getByLabel('Who can view')).toHaveValue('restricted');
    await expect(page.getByLabel('Recipient email')).toHaveAttribute('placeholder', 'name@example.com');
    await expect(page.getByLabel('Include captured photos and videos')).not.toBeChecked();
    await expect(page.getByLabel('Allow original downloads')).not.toBeChecked();
    await expect(page.getByText('New items added to this collection follow these sharing settings.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Currently private' })).toBeVisible();
    await expect(page.getByText('Link access, if enabled, expires after 7 days by default.')).toBeVisible();
    // No link exists before a successful create.
    await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
    await axe(page);
    await shot(page, info, '12-collection-share');
  });

  test('invites by email, previews media before including it, and creates a link only after confirming', async ({ page, context }, info) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const { collection, mock } = await setup(page);
    await page.goto(`/collections/${collection.id}/share`);
    await page.getByLabel('Recipient email').fill('sam@example.com');
    await page.getByRole('button', { name: 'Create invitation link' }).click();
    await expect(page.getByLabel('Invitation link (expires in 7 days)')).toHaveValue(/\/shared\/invite#invite=csi_/);
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();

    await page.getByLabel('Include captured photos and videos').check();
    await page.getByRole('button', { name: 'Save sharing settings' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm what becomes visible' })).toBeVisible();
    await expect(page.getByText('Morning walk · video')).toBeVisible();
    await shot(page, info, '12-collection-share-confirm-media');
    await page.getByRole('button', { name: 'Include them' }).click();
    await expect(page.getByText('Sharing settings saved.')).toBeVisible();

    await page.getByLabel('Who can view').selectOption('link');
    await expect(page.getByText('Anyone with this link can view the items you include.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save sharing settings' })).toBeDisabled();
    await page.getByLabel(/I understand that anyone who has the link can view/).check();
    await page.getByLabel('Include captured photos and videos').uncheck();
    await page.getByRole('button', { name: 'Save sharing settings' }).click();
    await expect(page.getByLabel('Link (shown once)')).toHaveValue(/\/shared#share=cas_/);
    await expect(page.getByRole('heading', { name: 'Link sharing is on' })).toBeVisible();
    await shot(page, info, '12-collection-share-link');
    expect(mock.shares.filter((s) => s.audience === 'link')).toHaveLength(1);

    await page.getByRole('button', { name: /Turn off link/ }).click();
    await page.getByRole('group', { name: 'Confirm stop sharing' }).getByRole('button', { name: 'Turn off link' }).click();
    await expect(page.getByText('Link turned off.')).toBeVisible();
  });
});

test.describe('13 Shared collection', () => {
  test('redeems the fragment, strips it from history and shows a view-only public-safe collection', async ({ page }, info) => {
    const { mock } = await setup(page, { shared: 'link' });
    const response = await page.goto('/shared#share=cas_EXAMPLEONLY_EXAMPLEONLY_EXAMPLEONLY_EXAMPLE');
    expect(response?.headers()['referrer-policy']).toBe('no-referrer');
    // Production dynamic pages send `private, no-cache, no-store, …`; `next dev` rewrites
    // this to `no-cache, must-revalidate`. Either way the page is never publicly cacheable.
    expect(response?.headers()['cache-control']).toMatch(/no-store|no-cache/);
    expect(response?.headers()['cache-control']).not.toContain('public');
    expect(response?.headers()['x-robots-tag']).toContain('noindex');
    await expect(page.getByRole('heading', { level: 1, name: 'Quiet weekends' })).toBeVisible();
    expect(mock.redeemed).toBe(true);
    expect(page.url()).not.toContain('#');
    expect(page.url()).not.toContain('cas_');
    await expect(page.getByText('Shared collection · View only')).toBeVisible();
    await expect(page.getByText('Shared by Alex · A few things for slower days.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A neighborhood gallery' })).toBeVisible();
    await expect(page.getByText('2 shared discoveries · Captured photos and videos are not included.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save a discovery to my collection' })).toBeVisible();
    // No private navigation or owner menus.
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Capture' })).toHaveCount(0);
    await axe(page);
    await shot(page, info, '13-shared-collection');
  });

  test('expired or revoked links show the empty state without titles or thumbnails', async ({ page }, info) => {
    await setup(page, { shared: 'revoked' });
    await page.goto('/shared#share=cas_EXAMPLEONLY_EXAMPLEONLY_EXAMPLEONLY_REVOKE');
    await expect(page.getByRole('heading', { level: 1, name: 'This collection is no longer shared.' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Quiet weekends');
    await expect(page.locator('img')).toHaveCount(0);
    expect(page.url()).not.toContain('#');
    await shot(page, info, '13-shared-revoked');
  });
});
