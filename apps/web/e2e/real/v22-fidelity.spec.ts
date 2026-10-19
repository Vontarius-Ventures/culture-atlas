import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Design fidelity for screens 14-18 (spec amendment 2.2) against the REAL
 * stack: the web app, the job worker and the media worker on PostgreSQL, with
 * no /v1 or /v2 mocks. Each width signs up its own account and walks the same
 * states as the HTML mockups (specs/capture-platform-v2/design/html, captured
 * by design/html/capture-screens.mjs), so every screenshot here sits next to
 * design/screens/<name>-<width>.png. Notes: docs/design-fidelity-v22.md.
 *
 * Providers:
 *  - Qloo is LIVE (catalog chips and images are the committed live catalog;
 *    search, seed and resolution are live requests) behind
 *    scripts/e2e/qloo-gate.ts, an outage switch used only to capture the honest
 *    "Qloo unavailable" states (14 search, 15 building).
 *  - The vision model is the worker's e2e stand-in (apps/worker/src/e2e-fake-models.ts):
 *    a fixed reading for the noodles photo, so no model spend and no
 *    pretend-live reading. Run it with E2E_FAKE_QUICK_MS=15000 so the
 *    processing state (screen 16) lasts long enough for a full-page capture.
 *
 * Opt-in: V22_FIDELITY=1. Widths are set per shot, so only the desktop project runs.
 *
 *   cd apps/web && V22_FIDELITY=1 E2E_BASE_URL=http://localhost:3294 \
 *     pnpm exec playwright test -c playwright.real-v22.config.ts e2e/real/v22-fidelity.spec.ts --project desktop
 */

const OUT = path.join(import.meta.dirname, '../screenshots/fidelity/v22');
const GATE = process.env.QLOO_GATE_URL ?? 'http://127.0.0.1:4490';
const NOODLES = path.resolve(import.meta.dirname, '../../public/samples/onboarding/noodles.jpg');
const TABLE = path.resolve(import.meta.dirname, '../../public/samples/onboarding/table.jpg');
const HEIGHTS: Record<number, number> = { 1440: 900, 390: 844, 320: 700 };
const WIDTHS = [1440, 390, 320] as const;

test.describe.configure({ mode: 'serial' });
test.beforeEach(() => {
  test.skip(
    !process.env.V22_FIDELITY,
    'Opt-in: V22_FIDELITY=1 with the live-Qloo gate (docs/design-fidelity-v22.md)',
  );
  test.skip(test.info().project.name !== 'desktop', 'Widths are set per shot');
});
test.setTimeout(600_000);

async function gate(mode: 'up' | 'down') {
  const res = await fetch(`${GATE}/__gate/mode`, {
    method: 'POST',
    body: JSON.stringify({ mode }),
  });
  expect(res.ok, 'qloo-gate must be running').toBe(true);
}

async function newPage(browser: Browser, width: number) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width, height: HEIGHTS[width]! },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    hasTouch: width < 768,
  });
  // Under `next dev` the dev indicator would cover the phone navigation; it is not part of the app.
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = 'nextjs-portal{display:none!important}';
      document.head.appendChild(style);
    });
  });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

async function settle(page: Page) {
  // The Next.js dev indicator is not part of the app.
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.evaluate(() =>
    document
      .querySelectorAll('img[loading="lazy"]')
      .forEach((img) => img.setAttribute('loading', 'eager')),
  );
  await page
    .waitForFunction(
      () => Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
      null,
      {
        timeout: 15_000,
      },
    )
    .catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
}

/** Same capture rules as the mockup script: full-page shots grow the viewport so sticky bars sit at the end. */
async function shot(page: Page, name: string, width: number, fullPage: boolean) {
  mkdirSync(OUT, { recursive: true });
  await page.mouse.move(0, 0);
  await settle(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${name}@${width} must not scroll sideways`).toBeLessThanOrEqual(0);
  if (fullPage) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(height, HEIGHTS[width]!) });
    const settled = await page.evaluate(() => document.documentElement.scrollHeight);
    if (settled !== height)
      await page.setViewportSize({ width, height: Math.max(settled, HEIGHTS[width]!) });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() =>
      Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined))),
    );
  }
  await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), animations: 'disabled' });
  if (fullPage) await page.setViewportSize({ width, height: HEIGHTS[width]! });
}

async function signUp(page: Page, email: string) {
  // Open the app first so one anonymous session exists before the form posts.
  await page.goto('/');
  await page.goto('/settings');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill('a fine password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  await expect(page.locator('.pick-counter')).toHaveText('3 picks to go');
}

async function goToStep(page: Page, width: number, step: 1 | 2 | 3) {
  if (width >= 768) return;
  const label = (await page.locator('.onb-steps').innerText()).trim();
  const current = Number(/Step (\d)/.exec(label)?.[1] ?? 1);
  for (let s = current; s < step; s++)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  for (let s = current; s > step; s--)
    await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByText(`Step ${step} of 3`)).toBeVisible();
}

const tile = (page: Page, label: string) =>
  page.locator('.pick-grid').getByRole('button', { name: label });
const chip = (page: Page, group: string, label: string) =>
  page.getByRole('group', { name: group }).getByRole('button', { name: label, exact: true });
const searchBox = (page: Page) => page.getByLabel('Add an artist, film, brand or place');
const results = (page: Page) => page.getByRole('list', { name: 'Search results' });

async function search(page: Page, q: string) {
  await searchBox(page).fill(q);
  await expect(results(page).getByRole('button').first()).toBeVisible({ timeout: 20_000 });
  await searchBox(page).blur();
}

async function addNinaSimone(page: Page) {
  const nina = results(page)
    .getByRole('button', { name: /Nina Simone/ })
    .first();
  await expect(nina).toBeVisible();
  await nina.click();
  await expect(nina).toHaveAttribute('aria-pressed', 'true');
}

async function press(page: Page, button: ReturnType<typeof tile>) {
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Screen 15: capture as soon as it renders, then again if a category turns ready before it moves on. */
async function captureBuilding(page: Page, width: number) {
  await expect(page).toHaveURL(/\/welcome\/building/);
  await expect(page.getByRole('heading', { name: 'Building your feed…' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Your picks' }).getByRole('listitem')).toHaveCount(4);
  await page.screenshot({
    path: path.join(OUT, `15-building-feed-${width}.png`),
    animations: 'disabled',
  });
  const ready = page.locator('.seed li.is-ready').first();
  const sawReady = await ready
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (sawReady) {
    await page
      .screenshot({ path: path.join(OUT, `15-building-feed-${width}.png`), animations: 'disabled' })
      .catch(() => undefined);
  }
  await expect(page).toHaveURL(/\/$/, { timeout: 60_000 });
}

for (const width of WIDTHS) {
  test(`screens 14-18 at ${width}`, async ({ browser }) => {
    await gate('up');
    const { page, close } = await newPage(browser, width);
    const desktop = width >= 768;
    try {
      await signUp(page, `fidelity-v22-${width}-${Date.now()}@example.com`);

      // ---- 14: taste picks -------------------------------------------------
      await press(page, tile(page, 'Tea rituals'));
      if (desktop) {
        await press(page, chip(page, 'Wear', 'Japandi'));
        await press(page, chip(page, 'Foods to leave out', 'Shellfish'));
        await search(page, 'nina');
        await shot(page, '14-taste-picks', width, true);
        // Pick order drives the screen 15 collage (Tea rituals, Japandi, Nina Simone, Sunday
        // listening, as in mockup 15). Mockup 18 lists Sunday listening before Nina Simone, which
        // no single pick order satisfies together with 15; 15 wins (docs/design-fidelity-v22.md).
        await addNinaSimone(page);
        await press(page, tile(page, 'Sunday listening'));
        await expect(page.locator('.pick-counter')).toHaveText('Ready');
        await shot(page, '14-taste-picks-ready', width, true);
      } else {
        await shot(page, '14-taste-picks-step1', width, true);
        await goToStep(page, width, 2);
        await press(page, chip(page, 'Wear', 'Japandi'));
        await search(page, 'nina');
        await shot(page, '14-taste-picks-step2', width, true);
        await goToStep(page, width, 3);
        await press(page, chip(page, 'Foods to leave out', 'Shellfish'));
        await shot(page, '14-taste-picks-step3-disabled', width, true);
        await goToStep(page, width, 2);
        await addNinaSimone(page);
        await goToStep(page, width, 3);
        await expect(page.locator('.pick-counter')).toHaveText('Ready');
        await shot(page, '14-taste-picks-step3', width, true);
        await goToStep(page, width, 1);
        await press(page, tile(page, 'Sunday listening'));
        await goToStep(page, width, 3);
      }

      // ---- 15: building your feed ---------------------------------------------
      await page.getByRole('button', { name: 'Build my feed' }).click();
      await captureBuilding(page, width);
      await expect(
        page.getByRole('heading', { name: 'Find more of what you love.' }),
      ).toBeVisible();

      // ---- 16: while we look, then more to explore ------------------------------
      await page.goto('/capture/photo');
      await page.getByTestId('upload-input').setInputFiles(NOODLES);
      await page.getByRole('button', { name: 'Discover' }).click();
      await expect(page).toHaveURL(/\/captures\//);
      await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByRole('list', { name: 'From your feed' }).getByRole('listitem').first(),
      ).toBeVisible();
      await shot(page, '16-while-we-look', width, true);
      await expect(page.getByRole('heading', { name: 'Sesame noodle supper' })).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        page
          .getByRole('list', { name: 'Discoveries from your photo' })
          .getByRole('listitem')
          .first(),
      ).toBeVisible({
        timeout: 60_000,
      });
      // Let enrichment and the category sections land so the page is in its final state.
      await expect(page.getByText('Updating your discoveries…')).toHaveCount(0, {
        timeout: 90_000,
      });
      await expect(
        page.locator('.capture-result .skeleton-card, .capture-result [aria-busy="true"]'),
      ).toHaveCount(0, {
        timeout: 30_000,
      });
      await shot(page, '16-more-to-explore', width, true);
      // Record what the live run reported per category, for the honest verdict in the notes.
      const captureId = /\/captures\/([^/?#]+)/.exec(page.url())?.[1];
      const detail = (await (await page.request.get(`/v1/captures/${captureId}`)).json()) as {
        analysis?: { sections?: Record<string, string> };
      };
      console.log(`[16@${width}] sections ${JSON.stringify(detail.analysis?.sections ?? {})}`);

      // ---- 17: ready notice -----------------------------------------------------
      await page.goto('/capture/photo');
      await page.getByTestId('upload-input').setInputFiles(TABLE);
      await page.getByRole('button', { name: 'Discover' }).click();
      await expect(page).toHaveURL(/\/captures\//);
      await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible({
        timeout: 15_000,
      });
      await page.locator('nav a[href="/"]:visible').first().click();
      await expect(page).toHaveURL(/\/$/);
      const toast = page.locator('.ready-toast');
      await expect(toast).toContainText('Your photo is ready', { timeout: 60_000 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, '17-ready-notice', width, false);

      // ---- 18: settings -> taste ------------------------------------------------
      // The mockup's picks: add the rest through the same endpoints the pickers use.
      const session = (await (await page.request.get('/v1/session')).json()) as {
        csrf_token: string;
      };
      for (const id of [
        'img-tailoring',
        'img-linen',
        'chip-play-bossa-nova',
        'chip-watch-film-noir',
        'chip-eat-sichuan-cuisine',
      ]) {
        const res = await page.request.post('/v1/taste/picks', {
          data: { source: 'catalog', catalog_item_id: id },
          headers: {
            'x-csrf-token': session.csrf_token,
            'idempotency-key': `fid-${width}-${id}-${Date.now()}`,
          },
        });
        expect(res.ok(), await res.text()).toBeTruthy();
      }
      const excl = await page.request.put('/v1/onboarding/exclusions', {
        data: { food_exclusions: ['peanuts', 'shellfish'] },
        headers: {
          'x-csrf-token': session.csrf_token,
          'idempotency-key': `fid-${width}-excl-${Date.now()}`,
        },
      });
      expect(excl.ok(), await excl.text()).toBeTruthy();
      await page.goto('/settings/taste');
      await expect(page.getByRole('heading', { name: 'Taste', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Remove Film noir' })).toBeVisible();
      await page.getByRole('button', { name: /Add more to Watch/ }).click();
      await expect(
        page.getByRole('group', { name: 'Watch ideas' }).getByRole('button').first(),
      ).toBeVisible();
      await shot(page, '18-taste-settings', width, true);
    } finally {
      await gate('up');
      await close();
    }
  });

  test(`Qloo unavailable: screens 14 and 15 at ${width}`, async ({ browser }) => {
    await gate('up');
    const { page, close } = await newPage(browser, width);
    try {
      await signUp(page, `fidelity-v22-down-${width}-${Date.now()}@example.com`);
      await press(page, tile(page, 'Tea rituals'));
      if (width >= 768) await press(page, chip(page, 'Foods to leave out', 'Shellfish'));
      await goToStep(page, width, 2);
      await press(page, chip(page, 'Wear', 'Japandi'));
      await gate('down');
      await searchBox(page).fill('nina');
      await expect(
        page.getByText('Search is taking a break. Pick from the ideas above.'),
      ).toBeVisible({ timeout: 30_000 });
      await searchBox(page).blur();
      await shot(page, '14-taste-picks-search-unavailable', width, true);

      // Qloo is back for one search (the collage then matches the mockup's four picks).
      await gate('up');
      await expect(async () => {
        await searchBox(page).fill('');
        await searchBox(page).fill('nina simone');
        await expect(
          results(page)
            .getByRole('button', { name: /Nina Simone/ })
            .first(),
        ).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 90_000, intervals: [5_000] });
      await addNinaSimone(page);
      await goToStep(page, width, 1);
      await press(page, tile(page, 'Sunday listening'));
      await goToStep(page, width, 3);

      await gate('down');
      await page.getByRole('button', { name: 'Build my feed' }).click();
      await expect(page).toHaveURL(/\/welcome\/building/);
      await expect(page.getByText("We'll keep building in the background.")).toBeVisible({
        timeout: 45_000,
      });
      await shot(page, '15-building-feed-unavailable', width, false);
    } finally {
      await gate('up');
      await close();
    }
  });
}
