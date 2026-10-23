/**
 * Screens 14-18 rendered at 1440, 390 and 320 px in the states of their HTML
 * mockups (specs/capture-platform-v2/design/html, captured by
 * design/html/capture-screens.mjs), saved to e2e/screenshots/v22/<name>-<width>.png
 * for side-by-side comparison with design/screens/<name>-<width>.png.
 * Like the mockup script: reduced motion, device scale 1, and full-page shots
 * grow the viewport so sticky bars sit at the end of the page.
 */
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { installMockApi, type MockApi, type MockOptions } from '../mock/api';

const OUT = path.join(import.meta.dirname, '..', 'screenshots', 'v22');
const HEIGHTS: Record<number, number> = { 1440: 900, 390: 844, 320: 700 };

test.describe.configure({ mode: 'serial' });
// Widths are set per shot, so one project is enough.
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'Widths are set per shot');
});
test.setTimeout(240_000);

async function pageAt(browser: Browser, width: number, opts: MockOptions) {
  const context = await browser.newContext({
    viewport: { width, height: HEIGHTS[width]! },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    hasTouch: width < 768,
    isMobile: false,
  });
  const page = await context.newPage();
  await page.route(/\/v2\/capabilities/, (route) =>
    route.fulfill({
      status: 401,
      json: {
        error: {
          code: 'unauthenticated',
          message: 'Sign in.',
          retryable: false,
          request_id: 'mock',
        },
      },
    }),
  );
  const api = await installMockApi(page, opts);
  return { page, api, close: () => context.close() };
}

async function settle(page: Page) {
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

async function shot(page: Page, name: string, width: number, fullPage: boolean) {
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
    // Images that were below the fold decode once the viewport covers them.
    await page.evaluate(() =>
      Promise.all(Array.from(document.images).map((img) => img.decode().catch(() => undefined))),
    );
  }
  await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), animations: 'disabled' });
}

const ONB = (o: NonNullable<MockOptions['onboarding']>): MockOptions => ({
  account: true,
  onboarding: { required: true, ...o },
});

async function taste(
  browser: Browser,
  name: string,
  widths: number[],
  o: NonNullable<MockOptions['onboarding']>,
  step: 1 | 2 | 3,
  search: string | null,
) {
  for (const width of widths) {
    const { page, close } = await pageAt(browser, width, ONB(o));
    await page.goto(`/welcome/taste?step=${step}`);
    await expect(page.locator('#onb-s1')).toBeAttached();
    if (search !== null) {
      await page.getByLabel('Add an artist, film, brand or place').fill(search);
      if (o.search === 'unavailable')
        await expect(
          page.getByText('Search is taking a break. Pick from the ideas above.'),
        ).toBeAttached();
      else await expect(page.getByRole('list', { name: 'Search results' })).toBeAttached();
      await page.getByLabel('Add an artist, film, brand or place').blur();
    }
    await shot(page, name, width, true);
    await close();
  }
}

test('14 taste picks', async ({ browser }) => {
  const base = { exclusions: ['shellfish'] };
  await taste(
    browser,
    '14-taste-picks',
    [1440],
    { ...base, picks: ['img-tea', 'chip-wear-japandi'] },
    1,
    'nina',
  );
  await taste(
    browser,
    '14-taste-picks-ready',
    [1440],
    {
      ...base,
      picks: ['img-tea', 'img-listening', 'chip-wear-japandi'],
      searchPicks: ['Nina Simone'],
    },
    1,
    'nina',
  );
  await taste(
    browser,
    '14-taste-picks-search-unavailable',
    [1440, 390, 320],
    { ...base, picks: ['img-tea', 'chip-wear-japandi'], search: 'unavailable' },
    2,
    'nina',
  );
  await taste(
    browser,
    '14-taste-picks-step1',
    [390, 320],
    { ...base, picks: ['img-tea'] },
    1,
    null,
  );
  await taste(
    browser,
    '14-taste-picks-step2',
    [390, 320],
    { ...base, picks: ['img-tea', 'chip-wear-japandi'] },
    2,
    'nina',
  );
  await taste(
    browser,
    '14-taste-picks-step3',
    [390, 320],
    { ...base, picks: ['img-tea', 'chip-wear-japandi'], searchPicks: ['Nina Simone'] },
    3,
    null,
  );
  await taste(
    browser,
    '14-taste-picks-step3-disabled',
    [390, 320],
    { ...base, picks: ['img-tea', 'chip-wear-japandi'] },
    3,
    null,
  );
});

test('15 building your feed', async ({ browser }) => {
  for (const state of ['building', 'unavailable'] as const) {
    for (const width of [1440, 390, 320]) {
      const { page, api, close } = await pageAt(
        browser,
        width,
        ONB({
          required: false,
          picks: ['img-tea', 'chip-wear-japandi'],
          searchPicks: ['Nina Simone'],
          seed: state === 'unavailable' ? 'unavailable' : 'progressive',
        }),
      );
      api.onboarding.addCatalogPick('img-listening');
      api.onboarding.completedAt = new Date().toISOString();
      api.onboarding.seedJobId = '00000000-0000-4000-8000-0000000005ee';
      // Hold the clock so the Wear-ready state stays on screen (it advances to Discover after a beat).
      await page.clock.install();
      await page.goto('/welcome/building');
      await expect(page.getByRole('heading', { name: 'Building your feed…' })).toBeVisible();
      if (state === 'building') {
        await page.clock.runFor(1200);
        await expect(page.locator('.seed .is-ready')).toHaveCount(1);
      } else {
        await page.clock.runFor(1200);
        await expect(page.getByText("We'll keep building in the background.")).toBeVisible();
      }
      await shot(
        page,
        state === 'building' ? '15-building-feed' : '15-building-feed-unavailable',
        width,
        false,
      );
      await close();
    }
  }
});

/** A capture of the room illustration, with the feed in the mockup's order. */
function seedCapture(api: MockApi) {
  const c = api.createCapture(null, 'upload');
  c.image = {
    url: '/samples/room.jpg',
    width: 1000,
    height: 1250,
    alt: 'Your photo: a paned window, a low table and a branch in a vase',
  };
  c.title = 'Quiet corners';
  c.interpretation =
    'Soft window light, a low table and a single branch: a calm room built from a few natural things.';
  const order = [
    'sunday-listening',
    'linen-days',
    'late-night-cinema',
    'sesame-noodles',
    'sculptural-forms',
    'night-wanderings',
  ];
  const first = order.map((k) => api.feedCard(k).id);
  api.feedIds = [...first, ...api.feedIds.filter((id) => !first.includes(id))];
  return c;
}

test('16 while we look', async ({ browser }) => {
  for (const state of ['processing', 'results'] as const) {
    for (const width of [1440, 390, 320]) {
      const { page, api, close } = await pageAt(browser, width, {
        account: true,
        personalFeed: true,
        holdJobs: true,
      });
      const c = seedCapture(api);
      await page.goto(`/captures/${c.id}?job=${c.jobId}`);
      await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible();
      await expect(
        page.getByRole('list', { name: 'From your feed' }).getByRole('listitem'),
      ).toHaveCount(6);
      if (state === 'results') {
        (api.opts as MockOptions).holdJobs = false;
        await expect(page.getByRole('heading', { name: 'Quiet corners' })).toBeVisible({
          timeout: 15_000,
        });
        await expect(page.getByRole('button', { name: /More to explore/ })).toHaveAttribute(
          'aria-expanded',
          'false',
        );
      }
      await shot(
        page,
        state === 'processing' ? '16-while-we-look' : '16-more-to-explore',
        width,
        true,
      );
      await close();
    }
  }
});

test('17 ready notice', async ({ browser }) => {
  for (const width of [1440, 390, 320]) {
    const { page, api, close } = await pageAt(browser, width, {
      account: true,
      personalFeed: true,
      holdJobs: true,
    });
    const c = seedCapture(api);
    await page.goto(`/captures/${c.id}?job=${c.jobId}`);
    await expect(page.getByRole('heading', { name: 'Finding your next favorites…' })).toBeVisible();
    // The capture has loaded (its strip shows), so the reading is being watched.
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible();
    // Leave the result through the primary navigation (client-side, so the tab keeps its state).
    await page.locator('nav a[href="/"]:visible').first().dispatchEvent('click');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    // The reading finishes after the person left its result.
    (api.opts as MockOptions).holdJobs = false;
    await expect(page.getByText('Your photo is ready'), `toast at ${width}`).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, '17-ready-notice', width, false);
    await close();
  }
});

test('18 taste settings', async ({ browser }) => {
  for (const width of [1440, 390, 320]) {
    const { page, close } = await pageAt(browser, width, {
      account: true,
      onboarding: {
        required: false,
        picks: [
          'chip-wear-japandi',
          'img-tailoring',
          'img-linen',
          'img-listening',
          'chip-play-bossa-nova',
          'chip-watch-film-noir',
          'img-tea',
          'chip-eat-sichuan-cuisine',
        ],
        searchPicks: ['Nina Simone'],
        exclusions: ['peanuts', 'shellfish'],
      },
    });
    await page.goto('/settings/taste');
    await expect(page.getByRole('heading', { name: 'Interests', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Japandi' })).toBeVisible();
    // As in the mockup: the Watch group is adding more.
    await page.getByRole('button', { name: /Add more to Watch/ }).click();
    await expect(page.getByRole('group', { name: 'Watch ideas' })).toBeVisible();
    await shot(page, '18-taste-settings', width, true);
    await close();
  }
});
