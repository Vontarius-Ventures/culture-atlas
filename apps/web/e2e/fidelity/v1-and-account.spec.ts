import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll, settleImages } from '../helpers';

/**
 * Design fidelity: the v1 references (design/cultural-atlas-v1/mockups 01–07)
 * and the v2 agent and sharing references (specs/capture-platform-v2/design
 * sections 10–13), rendered by the REAL app with the fixture account from
 * scripts/seed-fidelity.ts. Screenshots are compared with the references by
 * image inspection; the notes live in docs/design-fidelity-v1-and-account.md.
 *
 * Every screen is also checked for horizontal overflow and for 44 px targets
 * on its primary controls.
 */

const OUT = path.join(import.meta.dirname, '../screenshots/fidelity/v1-and-account');
const SEED_FILE = process.env.FIDELITY_SEED ?? path.join(import.meta.dirname, '../../../../.data/fidelity-seed.json');

interface Seed {
  email: string;
  settings_email: string;
  password: string;
  collections: { slow_sunday: string; after_dark: string; everyday_favorites: string; quiet_weekends: string };
  items: { vintage_racing: string };
  plan_id: string;
}

const seed = (): Seed => JSON.parse(readFileSync(SEED_FILE, 'utf8')) as Seed;

async function shot(page: Page, info: TestInfo, name: string, viewportOnly = false) {
  mkdirSync(OUT, { recursive: true });
  // No hover state in reference captures.
  await page.mouse.move(0, 0);
  // Under `next dev` the dev indicator is drawn over the page; it is not part of the app.
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await settleImages(page);
  await page.screenshot({
    path: path.join(OUT, `${name}-${info.project.name}.png`),
    // 320 px captures show the whole page, to prove that everything wraps.
    fullPage: info.project.name === 'narrow' && !viewportOnly,
    animations: 'disabled',
  });
}

async function csrf(request: APIRequestContext): Promise<string> {
  const res = await request.get('/v1/session');
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { csrf_token: string }).csrf_token;
}

/** Headers for a signed-in v2 mutation (CSRF plus the expected account, as the app sends them). */
async function mutationHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.get('/v1/session');
  expect(res.ok()).toBeTruthy();
  const s = (await res.json()) as { csrf_token: string; principal: { account_id: string | null } };
  return { 'x-csrf-token': s.csrf_token, 'x-atlas-expected-account': s.principal.account_id ?? '' };
}

async function signIn(page: Page, account: 'library' | 'settings') {
  const s = seed();
  const token = await csrf(page.request);
  const res = await page.request.post('/v1/session/sign-in', {
    data: { email: account === 'library' ? s.email : s.settings_email, password: s.password },
    headers: { 'x-csrf-token': token },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

/** Revoke every live share of a collection so it starts as "Currently private". */
async function makePrivate(page: Page, collectionId: string) {
  const headers = await mutationHeaders(page.request);
  const list = await page.request.get(`/v2/collections/${collectionId}/shares`);
  expect(list.ok(), await list.text()).toBeTruthy();
  const { shares } = (await list.json()) as { shares: { id: string; state?: string; revoked_at?: string | null }[] };
  for (const s of shares) {
    if (s.revoked_at || s.state === 'revoked') continue;
    const del = await page.request.delete(`/v2/shares/${s.id}`, { headers });
    expect(del.ok(), await del.text()).toBeTruthy();
  }
}

async function expectTargets(page: Page, selector: string) {
  const sizes = await page.locator(selector).evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => {
      const r = e.getBoundingClientRect();
      return { h: Math.round(r.height), w: Math.round(r.width), text: (e.textContent ?? '').trim().slice(0, 30) };
    }),
  );
  for (const s of sizes) expect(Math.min(s.h, s.w), `target "${s.text}" must be at least 44 px`).toBeGreaterThanOrEqual(44);
}

// Screens 10–13 belong to the account-settings fixture; the rest to the library fixture.
test.beforeEach(async ({ page }, info) => {
  await signIn(page, /^1[0-3] /.test(info.title) ? 'settings' : 'library');
});

test('01/04 Discover', async ({ page }, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Find more of what you love.' })).toBeVisible();
  const grid = page.getByRole('list', { name: /discoveries/i }).first();
  await expect(grid.getByRole('listitem').nth(7)).toBeVisible();
  const titles = await grid.locator('.card__title').allTextContents();
  expect(titles.slice(0, 8)).toEqual([
    'Vintage racing', 'Quiet corners', 'Sunday listening', 'Around the table',
    'Night wanderings', 'Sculptural forms', 'Linen days', 'Tea rituals',
  ]);
  await expectNoHorizontalScroll(page);
  await shot(page, info, '01-discover');
  await expectTargets(page, '.filter-row button, .save-chip, .header__capture, .mobile-dock__capture, .bottom-nav__link');
});

test('05 Save sheet', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Save Vintage racing' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Save to a collection' })).toBeVisible();
  await expect(dialog.getByText('Slow Sunday')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, '05-save', true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('06 Item detail', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Vintage racing' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Vintage racing' })).toBeVisible();
  await expect(page.getByText('A few motorsport references stood out.').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You might also like' })).toBeVisible();
  await expect(page.locator('.related .card__title')).toHaveText(['Sunday listening', 'Night on film', 'A softer silhouette']);
  await expectNoHorizontalScroll(page);
  await shot(page, info, '06-item');
});

test('07 Collections index', async ({ page }, info) => {
  await page.goto('/collections');
  await expect(page.getByRole('heading', { level: 1, name: 'Your collections' })).toBeVisible();
  await expect(page.getByText('Saved for later')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, '07-collections');
});

test('02 Collection detail with two selected', async ({ page }, info) => {
  const s = seed();
  await page.goto(`/collections/${s.collections.slow_sunday}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Slow Sunday' })).toBeVisible();
  await page.getByLabel('Select Sunday listening').check();
  await page.getByLabel('Select Late-night cinema').check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, info, '02-collection');
});

test('03 Movie night', async ({ page }, info) => {
  const s = seed();
  await page.goto(`/plans/${s.plan_id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Your slow Sunday, planned.' })).toBeVisible();
  await expect(page.getByText('In the Mood for Love').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, '03-plan');
});

test('10 Connected agents', async ({ page }, info) => {
  await page.goto('/settings/agents');
  await expect(page.getByRole('heading', { level: 1, name: 'Connected agents' })).toBeVisible();
  await expect(page.getByText('My research assistant').first()).toBeVisible();
  await expect(page.getByText(/Viewed Quiet weekends/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, '10-agents');
});

test('11 Connect an agent', async ({ page }, info) => {
  await page.goto('/settings/agents/new');
  await expect(page.getByRole('heading', { level: 1, name: 'Connect an agent' })).toBeVisible();
  await page.getByLabel('Agent name').fill('My research assistant');
  await expectNoHorizontalScroll(page);
  await shot(page, info, '11-agent-permission');
});

test('12 Share a collection', async ({ page }, info) => {
  const s = seed();
  await makePrivate(page, s.collections.quiet_weekends);
  await page.goto(`/collections/${s.collections.quiet_weekends}/share`);
  await expect(page.getByRole('heading', { level: 1, name: 'Share Quiet weekends' })).toBeVisible();
  await expect(page.getByText('Currently private')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, info, '12-collection-share');
});

test('13 Shared collection (viewer)', async ({ page, browser }, info) => {
  const s = seed();
  await makePrivate(page, s.collections.quiet_weekends);
  const headers = await mutationHeaders(page.request);
  const res = await page.request.post(`/v2/collections/${s.collections.quiet_weekends}/shares`, {
    data: { audience: 'link', confirm_policy: true, include_media: false, allow_originals: false, expires_in_days: 7 },
    headers,
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const { link } = (await res.json()) as { link: string };
  const viewerUrl = new URL(link);
  // A separate browser context: the viewer is not the owner.
  const viewer = await browser.newContext({
    viewport: page.viewportSize() ?? undefined,
    reducedMotion: 'reduce',
    isMobile: info.project.name !== 'desktop',
    hasTouch: info.project.name !== 'desktop',
  });
  const vp = await viewer.newPage();
  await vp.goto(`${viewerUrl.pathname}${viewerUrl.hash}`);
  await expect(vp.getByRole('heading', { level: 1, name: 'Quiet weekends' })).toBeVisible();
  await expect(vp.getByText('Shared by Alex', { exact: false })).toBeVisible();
  await expectNoHorizontalScroll(vp);
  await shot(vp, info, '13-shared-collection');
  await viewer.close();
  await makePrivate(page, s.collections.quiet_weekends);
});
