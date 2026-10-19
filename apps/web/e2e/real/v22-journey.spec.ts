import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import pg from 'pg';
import { expectNoHorizontalScroll, SCREENSHOT_DIR, settleImages } from '../helpers';

/**
 * Spec amendment 2.2 on the REAL stack: next start + worker + media worker,
 * no /v1 mocks (docs/v22-real-stack.md). Providers are stand-ins that need no
 * live key: Qloo is scripts/e2e/fake-qloo.ts behind the real Qloo adapter
 * (every name it invents says "Fixture"), and the worker's Concentrate
 * gateway uses the in-process fake transport of src/e2e-fake-models.ts.
 *
 *  1. Main journey: anonymous browse and a labeled example with no
 *     questionnaire; sign up; the questionnaire (image grid, chips, search,
 *     one exclusion; Build my feed disabled below 3); building your feed;
 *     personal Discover from the seeded picks; upload a photo; While we look;
 *     results; the ready toast after leaving; Settings -> Taste remove/add.
 *  2. Qloo unavailable: onboarding completes from the catalog, search says it
 *     is taking a break, the seed job retries and recovers when Qloo returns.
 *  3. An existing account with fewer than 3 saves is asked once at sign-in.
 */

const ONBOARDING_PHOTO = path.resolve(import.meta.dirname, '../../public/samples/onboarding/noodles.jpg');
/** A different photo: the same bytes again would reuse the first capture's finished reading. */
const SECOND_PHOTO = path.resolve(import.meta.dirname, '../../public/samples/onboarding/table.jpg');
const FAKE_QLOO = process.env.FAKE_QLOO_URL ?? 'http://127.0.0.1:4410';
const DATABASE_URL = process.env.E2E_DATABASE_URL;

const counter = (page: Page) => page.locator('.pick-counter');
const build = (page: Page) => page.getByRole('button', { name: 'Build my feed' });
const desktopLayout = (info: TestInfo) => info.project.name === 'desktop';

async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() =>
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager')),
  );
  await settleImages(page, true);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `real-v22-${name}-${info.project.name}.png`),
    fullPage: true,
    animations: 'disabled',
  });
}

async function qlooMode(mode: 'up' | 'down') {
  const res = await fetch(`${FAKE_QLOO}/__fake/mode`, { method: 'POST', body: JSON.stringify({ mode }) });
  expect(res.ok).toBe(true);
}

/** Mobile shows one step at a time; desktop shows every section. */
async function goToStep(page: Page, step: 1 | 2 | 3, info: TestInfo) {
  if (desktopLayout(info)) return;
  const label = (await page.locator('.onb-steps').innerText()).trim();
  const current = Number(/Step (\d)/.exec(label)?.[1] ?? 1);
  for (let s = current; s < step; s++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (let s = current; s > step; s--) await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByText(`Step ${step} of 3`)).toBeVisible();
}

async function signUp(page: Page, email: string) {
  await page.goto('/settings');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill('a fine password');
  await page.getByRole('button', { name: 'Create account' }).click();
}

async function signOut(page: Page) {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function signIn(page: Page, email: string) {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill('a fine password');
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
}

function trackServerErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('response', (r) => {
    const url = new URL(r.url());
    if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) && r.status() >= 500)
      errors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
  return errors;
}

test.beforeEach(async () => {
  await qlooMode('up');
});

test('taste onboarding, personal feed and fast analysis on the real stack', async ({ page }, info) => {
  const errors = trackServerErrors(page);
  const email = `v22-${info.project.name}-${Date.now()}@example.com`;

  await test.step('anonymous: browse, try an example, never the questionnaire (ONB-01)', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await expect(page.getByText('Example result').first()).toBeVisible();
    await page.goto('/welcome/taste');
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Finding your next favorites…', { timeout: 60_000 });
    await expect(page.getByText('Example result').first()).toBeVisible();
    await expect(page).not.toHaveURL(/welcome/);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '01-anonymous-example');
  });

  await test.step('sign up leads into the questionnaire', async () => {
    await signUp(page, email);
    await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Pick what catches your eye.' })).toBeVisible();
    await expect(counter(page)).toHaveText('3 picks to go');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '02-questionnaire');
  });

  await test.step('picks from the image grid, the chips and live search; one exclusion', async () => {
    const tea = page.getByRole('button', { name: 'Tea rituals' });
    await tea.click();
    await expect(tea).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText('2 picks to go');
    if (desktopLayout(info)) {
      await expect(build(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText('Pick at least 3 so your feed starts with you.')).toBeVisible();
    }
    await goToStep(page, 2, info);
    const japandi = page.getByRole('group', { name: 'Wear' }).getByRole('button', { name: 'Japandi' });
    await japandi.click();
    await expect(japandi).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText('1 pick to go');
    await page.getByLabel('Add an artist, film, brand or place').fill('nina');
    const results = page.getByRole('list', { name: 'Search results' });
    const nina = results.getByRole('button', { name: /Nina/ }).first();
    await expect(nina).toBeVisible({ timeout: 15_000 });
    await nina.click();
    await expect(nina).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText('Ready');
    await goToStep(page, 3, info);
    const shellfish = page.getByRole('group', { name: 'Foods to leave out' }).getByRole('button', { name: 'Shellfish' });
    await shellfish.click();
    await expect(shellfish).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText('Ready');
    await expect(build(page)).toHaveAttribute('aria-disabled', 'false');
    await expectNoHorizontalScroll(page);
    await shot(page, info, '03-questionnaire-ready');
  });

  await test.step('building your feed, then the personal Discover from the seeded picks', async () => {
    await build(page).click();
    await expect(page).toHaveURL(/\/welcome\/building/);
    await expect(page.getByRole('heading', { name: 'Building your feed…' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Your picks' }).getByRole('listitem')).toHaveCount(3);
    await shot(page, info, '04-building');
    await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    // Seeded, Qloo-backed cards (fixture names from the fake Qloo), not only the labeled examples.
    await expect(page.getByText(/^Fixture /).first()).toBeVisible({ timeout: 30_000 });
    // The picks are explicit saves (ONB-02) and the exclusion is a preference.
    const state = await page.request.get('/v1/onboarding/state');
    const body = (await state.json()) as { state: { required: boolean; picks_count: number }; food_exclusions: string[]; seed: { state: string } };
    expect(body.state).toMatchObject({ required: false, picks_count: 3 });
    expect(body.food_exclusions).toEqual(['shellfish']);
    await expectNoHorizontalScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, info, '05-personal-discover');
  });

  await test.step('upload a photo: While we look from the feed, then the two-stage reading', async () => {
    await page.goto('/capture/photo');
    await page.getByTestId('upload-input').setInputFiles(ONBOARDING_PHOTO);
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible({ timeout: 15_000 });
    const strip = page.getByRole('list', { name: 'From your feed' });
    await expect(strip.getByRole('listitem').first()).toBeVisible();
    expect(await strip.getByRole('listitem').count()).toBeGreaterThanOrEqual(4);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '06-while-we-look');
    await expect(page.getByRole('heading', { name: 'Sesame noodle supper' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /More to explore/ })).toBeVisible();
    await expect(strip).toBeHidden();
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/vlm|qloo|concentrate|anthropic/i)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '07-result');
  });

  await test.step('leave while a second photo is read: the ready toast offers Open', async () => {
    await page.goto('/capture/photo');
    await page.getByTestId('upload-input').setInputFiles(SECOND_PHOTO);
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    const capturePath = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible({ timeout: 15_000 });
    // Client-side navigation away (the watcher lives in this tab).
    await page.locator('nav a[href="/collections"]:visible').first().click();
    await expect(page).toHaveURL(/\/collections/);
    const toast = page.locator('.ready-toast');
    await expect(toast).toContainText('Your photo is ready', { timeout: 60_000 });
    await expect(page.locator('.ready-region')).toHaveAttribute('aria-live', 'polite');
    await expectNoHorizontalScroll(page);
    await shot(page, info, '08-ready-toast');
    await toast.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(capturePath));
    await expect(page.getByRole('heading', { name: 'Sesame noodle supper' })).toBeVisible();
  });

  await test.step('Settings -> Taste: remove a pick and add one', async () => {
    await page.goto('/settings');
    await page.getByRole('link', { name: /Edit your taste/ }).click();
    await expect(page).toHaveURL(/\/settings\/taste$/);
    await expect(page.getByRole('heading', { name: 'Taste', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Japandi' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove Japandi' }).click();
    await expect(page.getByRole('button', { name: 'Remove Japandi' })).toHaveCount(0);
    await page.getByRole('button', { name: /Add more to Watch/ }).click();
    const ideas = page.getByRole('group', { name: 'Watch ideas' });
    await ideas.getByRole('button', { name: 'Film noir' }).click();
    await expect(ideas.getByRole('button', { name: 'Film noir' })).toHaveAttribute('aria-pressed', 'true');
    const picks = (await (await page.request.get('/v1/taste/picks')).json()) as { picks_count: number };
    expect(picks.picks_count).toBe(3);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '09-taste-settings');
  });

  expect(errors, 'no server errors during the journey').toEqual([]);
});

test('Qloo unavailable: catalog-only completion, search degraded, the seed retries (ONB-03)', async ({ page }, info) => {
  const errors = trackServerErrors(page);
  await signUp(page, `v22-down-${info.project.name}-${Date.now()}@example.com`);
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  await qlooMode('down');
  try {
    await page.getByRole('button', { name: 'Linen days' }).click();
    await page.getByRole('button', { name: 'Sunday listening' }).click();
    await goToStep(page, 2, info);
    await page.getByLabel('Add an artist, film, brand or place').fill('nina');
    await expect(page.getByText('Search is taking a break. Pick from the ideas above.')).toBeVisible({ timeout: 20_000 });
    await page.getByRole('group', { name: 'Watch' }).getByRole('button', { name: 'Film noir' }).click();
    await expect(counter(page)).toHaveText('Ready');
    await shot(page, info, '10-qloo-down-search');
    await goToStep(page, 3, info);
    await build(page).click();
    await expect(page).toHaveURL(/\/welcome\/building/);
    await expect(page.getByText("We'll keep building in the background.")).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalScroll(page);
    await shot(page, info, '11-qloo-down-building');
    // The seed job is re-queued with backoff, never filled with invented cards.
    await expect
      .poll(async () => ((await (await page.request.get('/v1/onboarding/seed')).json()) as { state: string }).state, { timeout: 30_000 })
      .toBe('retrying');
    const before = (await (await page.request.get('/v1/discoveries')).json()) as { items: Array<{ title: string }> };
    expect(before.items.some((i) => i.title.startsWith('Fixture '))).toBe(false);
  } finally {
    await qlooMode('up');
  }
  // Qloo is back: a retry publishes the seeded categories.
  await expect
    .poll(
      async () => {
        const seed = (await (await page.request.get('/v1/onboarding/seed')).json()) as { categories: Array<{ state: string }> };
        return seed.categories.some((c) => c.state === 'ready');
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  await page.goto('/');
  await expect(page.getByText(/^Fixture /).first()).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test('an existing account with fewer than 3 saves is asked once at sign-in (ONB-06)', async ({ page }, info) => {
  test.skip(!DATABASE_URL, 'Needs E2E_DATABASE_URL to make a pre-2.2 account');
  const email = `v22-existing-${info.project.name}-${Date.now()}@example.com`;
  await signUp(page, email);
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  const accountId = ((await (await page.request.get('/v1/session')).json()) as { principal: { account_id: string } }).principal.account_id;
  // Make it an account from before amendment 2.2: no onboarding state at all.
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    await db.query('DELETE FROM onboarding_states WHERE account_id = $1', [accountId]);
  } finally {
    await db.end();
  }
  await page.goto('/collections');
  await expect(page).toHaveURL(/\/collections/);
  await signOut(page);

  await signIn(page, email);
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Tea rituals' }).click();
  await page.getByRole('button', { name: 'Sesame noodles' }).click();
  await goToStep(page, 2, info);
  await page.getByRole('group', { name: 'Play' }).getByRole('button', { name: 'Jazz' }).click();
  await goToStep(page, 3, info);
  await build(page).click();
  await expect(page).toHaveURL(/\/(welcome\/building)?$/);
  await shot(page, info, '12-existing-account');

  // Asked once: the next sign-in goes straight to the app.
  await signOut(page);
  await signIn(page, email);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.goto('/collections');
  await expect(page).toHaveURL(/\/collections$/);
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/collections$/);
});
