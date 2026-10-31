/**
 * Style reading + "More like this" + cross-domain rails + experimental label
 * (prp/2026-10-23-style-analysis/design.md F.1/F.2/H.3), against the mock API
 * built from the E.2 contract. The server is built in parallel; these pin the
 * web behavior to the contract fixtures in e2e/mock/style.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, open } from './helpers';
import type { MockOptions } from './mock/api';
import { LIBRARY_SEED, openV2 } from './v2/mock-v2';

async function openOutfit(page: Page, opts: MockOptions) {
  const api = await open(page, '/', opts);
  await page.getByRole('button', { name: 'Try an example' }).click();
  await page.getByRole('button', { name: 'An outfit' }).click();
  await expect(page).toHaveURL(/\/captures\//);
  return api;
}

const styleCard = (page: Page) => page.getByRole('region', { name: 'Style reading' });

test.describe('Style reading', () => {
  test('skeleton, then chips, palette and details; region highlight; experimental note', async ({
    page,
  }) => {
    const api = await openOutfit(page, { style: 'ready', stylePollsToReady: 5 });
    const card = styleCard(page);
    // Running: a static placeholder with the D.4 caption, no claims yet.
    await expect(card.getByText('Reading the style…')).toBeVisible({ timeout: 15_000 });
    // Ready: server strings rendered verbatim.
    await expect(
      card.getByText('A cream nylon jacket with racing stripes and a sporty, vintage look.'),
    ).toBeVisible({ timeout: 15_000 });
    const captureReads = () =>
      api.log.filter((r) => r.method === 'GET' && /^\/v1\/captures\/[^/]+$/.test(r.path));
    const readsAtFirstTerminalStyle = captureReads().length;
    const chips = card.getByRole('list', { name: 'Style' });
    await expect(chips.getByRole('button', { name: 'Sportswear, clear' })).toBeVisible();
    await expect(
      chips.getByRole('button', { name: 'Resembles vintage motorsport, likely' }),
    ).toBeVisible();
    // Asserted is a solid border, a resemblance is dashed (no strength dots).
    await expect(chips.locator('[data-wording="asserted"]')).toHaveCSS('border-top-style', 'solid');
    await expect(chips.locator('[data-wording="resembles"]')).toHaveCSS(
      'border-top-style',
      'dashed',
    );
    // Measured palette: names only, never hex text.
    const palette = card.getByRole('list', { name: 'Palette' });
    await expect(palette.getByRole('button', { name: 'Cream. Copy color name' })).toBeVisible();
    await expect(card.getByText('#E9E1CF')).toHaveCount(0);
    // Details: first three rows, then "Show all details".
    await expect(card.getByText('Suggests the 1970s')).toBeVisible();
    await expect(card.getByText('Snap-button collar')).toHaveCount(0);
    await card.getByRole('button', { name: 'Show all details' }).click();
    await expect(card.getByText('Snap-button collar')).toBeVisible();
    await expect(card.getByText('Feels sporty, nostalgic')).toBeVisible();
    await expect(card.getByText('Related: Fila, Ellesse')).toBeVisible();

    // A claim with a region outlines it on the photo; selecting again clears it.
    await chips.getByRole('button', { name: 'Sportswear, clear' }).click();
    const box = page.getByTestId('region-highlight');
    await expect(box).toBeVisible();
    await expect(page.getByText(/Highlighted area: .* of the photo/)).toBeAttached();
    await chips.getByRole('button', { name: 'Sportswear, clear' }).click();
    await expect(box).toHaveCount(0);
    // Locate icons on detail rows highlight too.
    await card.getByRole('button', { name: 'Show where: Nylon shell' }).click();
    await expect(box).toBeVisible();
    await page.getByRole('button', { name: 'Clear highlight' }).click();
    await expect(box).toHaveCount(0);

    // The Experimental badge opens the plain note.
    const badge = card.getByRole('button', { name: 'Experimental' });
    await expect(badge).toHaveAttribute('aria-expanded', 'false');
    await badge.click();
    await expect(
      card.getByText(
        'Readings can miss details.',
      ),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(badge).toHaveAttribute('aria-expanded', 'false');

    // Style-only work kept re-reading the capture after the job finished, then stopped.
    // One final read checks for a late guard veto after the first terminal style.
    await expect.poll(() => captureReads().length).toBe(readsAtFirstTerminalStyle + 1);
    const reads = api.log.filter(
      (r) => r.method === 'GET' && /^\/v1\/captures\/[^/]+$/.test(r.path),
    );
    expect(reads.length).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(2000);
    const after = api.log.filter(
      (r) => r.method === 'GET' && /^\/v1\/captures\/[^/]+$/.test(r.path),
    );
    expect(after.length).toBe(reads.length);
    await expectNoHorizontalScroll(page);
  });

  test('More like this rail: reasons name the style, caption once, Why this shows the experimental line', async ({
    page,
  }) => {
    await openOutfit(page, { style: 'ready' });
    const rail = page.getByRole('region', { name: 'Brands to explore' }).first();
    await expect(rail.getByText('Sportswear · nylon shell')).toBeVisible({ timeout: 15_000 });
    const cards = rail.getByRole('listitem');
    await expect(cards).toHaveCount(6);
    // Each reason names an attribute the reading shows.
    await expect(rail.getByText('Because of the sportswear and nylon shell').first()).toBeVisible();
    await expect(
      rail.getByText('For the vintage motorsport look your photo resembles'),
    ).toBeVisible();
    await expect(
      styleCard(page).getByRole('button', { name: 'Resembles vintage motorsport, likely' }),
    ).toBeVisible();
    // "From your photo": on the first rail and once above the cross-domain group.
    await expect(page.getByText('From your photo')).toHaveCount(2);
    await expect(rail.getByText('From your photo')).toBeVisible();
    // Cross-domain rails reuse the Discoveries grid and filter.
    const grid = page.getByRole('list', { name: 'Discoveries from your photo' });
    await expect(grid.getByRole('listitem')).toHaveCount(6);
    await expect(
      grid.getByText('Bold stripes in the spirit of 1970s endurance racing.'),
    ).toBeVisible();

    // The second subject has an honest empty rail asking for a city.
    const second = page.getByRole('region', { name: 'Qloo connections' }).first();
    await expect(second.getByText('Add a city to explore places.')).toBeVisible();

    // Card detail: Why this? shows the style attributes and the why line.
    await cards.first().getByRole('link').click();
    await expect(page).toHaveURL(/\/items\//, { timeout: 20_000 });
    await page.getByRole('button', { name: 'Why this?' }).click();
    const attrs = page.getByRole('list', { name: 'Style that connected it' });
    await expect(attrs.getByText('Sportswear')).toBeVisible();
    await expect(attrs.getByText('nylon shell')).toBeVisible();
    await expect(
      page.getByText('From your photo.'),
    ).toBeVisible();
  });

  test('subject tabs flash the subject; "More like this" jumps to the rail; Add city', async ({
    page,
  }) => {
    const api = await openOutfit(page, { style: 'ready' });
    const card = styleCard(page);
    const tabs = card.getByRole('group', { name: 'Things in your photo' });
    await expect(tabs.getByRole('button', { name: 'Cream racing jacket' })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 15_000 },
    );
    await tabs.getByRole('button', { name: 'Wooden chair' }).click();
    await expect(page.getByTestId('region-highlight')).toBeVisible();
    await expect(card.getByText('Resembles mid-century modern')).toBeVisible();
    await expect(card.getByText('Looks like walnut')).toBeVisible();
    // The flash clears itself after 1.2 s.
    await expect(page.getByTestId('region-highlight')).toHaveCount(0, { timeout: 3000 });

    await tabs.getByRole('button', { name: 'Cream racing jacket' }).click();
    await card.getByRole('button', { name: 'More for Sportswear' }).click();
    await page.getByRole('button', { name: 'More like this' }).click();
    const rail = page.getByRole('region', { name: 'Brands to explore' }).first();
    await expect(rail).toBeFocused();
    await expect(rail).toBeInViewport();

    // Add city: one field, PUT /v1/me/city with the typed value in the body only.
    await page.getByRole('button', { name: 'Add city' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'Add city' });
    await sheet.getByLabel('City').fill('Los Angeles, CA');
    // Submit from the field (the dev-only Next.js indicator can cover the sheet's button on phones).
    await sheet.getByLabel('City').press('Enter');
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.toast__message', { hasText: 'City saved' })).toBeVisible();
    const put = api.log.find((r) => r.method === 'PUT' && r.path === '/v1/me/city');
    expect(put).toBeTruthy();
    expect(put!.search).toBe('');
    await expect(page.getByLabel('City')).toHaveCount(0);
  });

  test('a failed reading offers one Try again, then shows the reading', async ({ page }) => {
    const api = await openOutfit(page, { style: 'failed' });
    const card = styleCard(page);
    await expect(card.getByText("Couldn't read this one.")).toBeVisible({
      timeout: 15_000,
    });
    // Everything else still renders.
    await expect(
      page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem'),
    ).toHaveCount(6);
    await card.getByRole('button', { name: 'Try again' }).click();
    await expect(card.getByRole('button', { name: 'Sportswear, clear' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    expect(
      api.log.filter((r) => r.method === 'POST' && /\/style\/retry$/.test(r.path)),
    ).toHaveLength(1);
  });

  test('a retry already used hides Try again and says why', async ({ page }) => {
    await openOutfit(page, { style: 'failed', styleRetryUsed: true });
    const card = styleCard(page);
    await card.getByRole('button', { name: 'Try again' }).click({ timeout: 15_000 });
    await expect(
      page.locator('.toast__message', { hasText: 'This photo’s style was already read again.' }),
    ).toBeVisible();
    await expect(card.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('a stage-2 veto fades the claim out, announces the update and drops its card', async ({
    page,
  }) => {
    await openOutfit(page, { style: 'retract', pollsToRetract: 2, stylePollsToReady: 1 });
    const card = styleCard(page);
    await expect(card.getByRole('button', { name: 'Sportswear, clear' })).toBeVisible({
      timeout: 15_000,
    });
    // The retraction arrives on a later read (the mock reads it on the third GET).
    await expect(card.getByText('Resembles vintage motorsport')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByText('Style updated')).toBeAttached();
    const rail = page.getByRole('region', { name: 'Brands to explore' }).first();
    await expect(
      rail.getByText('For the vintage motorsport look your photo resembles'),
    ).toHaveCount(0);
    await expect(rail.getByRole('listitem')).toHaveCount(5);
  });

  test('empty, daily limit and paused readings use the D.4 copy', async ({ page }) => {
    await openOutfit(page, { style: 'empty' });
    await expect(styleCard(page).getByText('No clear style here.')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('daily limit', async ({ page }) => {
    await openOutfit(page, { style: 'limit' });
    await expect(
      styleCard(page).getByText(
        "That's all the readings for today. Your photo is saved for tomorrow.",
      ),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('paused', async ({ page }) => {
    await openOutfit(page, { style: 'paused' });
    await expect(
      styleCard(page).getByText(
        "Paused for now. Your photo is saved.",
      ),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('older analyses without style fields render exactly as before', async ({ page }) => {
    await openOutfit(page, {});
    await expect(
      page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem'),
    ).toHaveCount(6, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Style reading' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Brands to explore' })).toHaveCount(0);
    await expect(page.getByText('From your photo')).toHaveCount(0);
  });

  test('a qualified (non-experimental) reading shows no badge or caption', async ({ page }) => {
    await openOutfit(page, { style: 'ready', experimental: false });
    await expect(styleCard(page).getByRole('button', { name: 'Sportswear, clear' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(styleCard(page).getByRole('button', { name: 'Experimental' })).toHaveCount(0);
    await expect(page.getByText('From your photo')).toHaveCount(0);
  });

  test('reduced motion renders instantly; no serious axe violations; no horizontal scroll', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openOutfit(page, { style: 'ready' });
    const chip = styleCard(page).getByRole('button', { name: 'Sportswear, clear' });
    await expect(chip).toBeVisible({ timeout: 15_000 });
    const animations = await page.evaluate(
      () =>
        document
          .getAnimations()
          .filter((a) => (a as CSSAnimation).animationName?.startsWith('style-')).length,
    );
    expect(animations).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath('style-reduced-motion.png'),
      fullPage: true,
    });
    const results = await new AxeBuilder({ page })
      .include('.style-card')
      .include('.style-rail')
      .analyze();
    const serious = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
    await expectNoHorizontalScroll(page);
  });
});

test.describe('Experimental label on media detail', () => {
  test('photo exploring shows the Experimental badge and its note', async ({ page }) => {
    const v2 = await openV2(page, '', {
      media: LIBRARY_SEED.slice(0, 1),
      analysis: true,
      experimentalAnalysis: true,
    });
    await page.goto(`/library/media/${[...v2.media.keys()][0]}`);
    const badge = page.getByRole('button', { name: 'Experimental' });
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(
      page.getByText(
        'Readings can miss details.',
      ),
    ).toBeVisible();
  });

  test('a qualified analysis shows no badge', async ({ page }) => {
    const v2 = await openV2(page, '', { media: LIBRARY_SEED.slice(0, 1), analysis: true });
    await page.goto(`/library/media/${[...v2.media.keys()][0]}`);
    await expect(page.getByRole('button', { name: /Explore this photo/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Experimental' })).toHaveCount(0);
  });
});
