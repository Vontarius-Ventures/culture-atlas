/**
 * Spec amendment 2.2, screens 16-18: "While we look" (FAST-04), the ready
 * notice with its title badge, and Settings → Taste. Contract-validated /v1
 * mocks; real fetches from the UI.
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';
import type { MockApi, MockOptions } from '../mock/api';
import { noSeriousAxe, openV22, setVisibility } from './helpers';

/** A capture of the person's own (non-example) photo, opened while it is being read. */
async function openProcessing(
  page: Page,
  opts: MockOptions,
  capabilities?: { while_we_look_enabled: boolean },
) {
  const api = await openV22(page, '/', { holdJobs: true, ...opts }, capabilities);
  await page.waitForLoadState('networkidle');
  const c = api.createCapture(null, 'upload');
  // Only count what the result page itself requests.
  api.log.length = 0;
  await page.goto(`/captures/${c.id}?job=${c.jobId}`);
  await expect(page.getByRole('heading', { name: 'Finding your next favorites…' })).toBeVisible();
  return { api, capture: c };
}

const generationCalls = (api: MockApi) =>
  api.log.filter(
    (r) =>
      r.method !== 'GET' &&
      (r.path === '/v1/captures' ||
        /\/discoveries$/.test(r.path) ||
        r.path.startsWith('/v1/plans')),
  );

test.describe('While we look (screen 16)', () => {
  test('shows six feed cards while the photo is read, then collapses into More to explore', async ({
    page,
  }) => {
    const { api } = await openProcessing(page, { account: true, personalFeed: true });
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Looking at your photo. This takes a few seconds.' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible();
    await expect(page.getByText('From your feed', { exact: true })).toBeVisible();
    const strip = page.getByRole('list', { name: 'From your feed' });
    await expect(strip.getByRole('listitem')).toHaveCount(6);
    // Cards keep Save and detail behaviour.
    await expect(strip.getByRole('button', { name: /^Save / }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await noSeriousAxe(page);

    // FAST-04: reading the strip only reads the feed snapshot; it never starts generation.
    const feedReads = api.log.filter((r) => r.path === '/v1/discoveries');
    expect(feedReads.length).toBeGreaterThan(0);
    expect(generationCalls(api)).toEqual([]);

    (api.opts as MockOptions).holdJobs = false;
    await expect(page.getByRole('heading', { name: 'Vintage racing' })).toBeVisible({
      timeout: 15_000,
    });
    const more = page.getByRole('button', { name: /More to explore/ });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(more).toContainText('6 from your feed');
    await expect(strip).toBeHidden();
    // Keyboard operable disclosure.
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(strip.getByRole('listitem')).toHaveCount(6);
    await page.keyboard.press('Space');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(generationCalls(api)).toEqual([]);
  });

  test('anonymous visitors see labeled example cards', async ({ page }) => {
    await openProcessing(page, {});
    const strip = page.getByRole('list', { name: 'While we look' });
    await expect(strip.getByRole('listitem')).toHaveCount(6);
    await expect(strip.getByText('Example result')).toHaveCount(6);
    // Not their feed: no "From your feed" claim.
    await expect(page.getByText('From your feed', { exact: true })).toHaveCount(0);
  });

  test('the while_we_look_enabled kill switch hides the strip', async ({ page }) => {
    const { api } = await openProcessing(
      page,
      { account: true, personalFeed: true },
      { while_we_look_enabled: false },
    );
    await page.waitForTimeout(1000);
    await expect(page.getByRole('heading', { name: 'While we look' })).toHaveCount(0);
    expect(api.log.filter((r) => r.path === '/v1/discoveries')).toEqual([]);
  });

  test('a capture opened after it finished shows no strip', async ({ page }) => {
    const api = await openV22(page, '/', { account: true, personalFeed: true });
    const c = api.createCapture(null, 'upload');
    const job = api.jobs.get(c.jobId!)!;
    job.onComplete?.();
    job.state = 'complete';
    await page.goto(`/captures/${c.id}`);
    await expect(page.getByRole('heading', { name: 'Vintage racing' })).toBeVisible();
    await expect(page.getByRole('button', { name: /More to explore/ })).toHaveCount(0);
  });
});

test.describe('Ready notice (screen 17)', () => {
  test('after leaving the result: polite toast with Open, and a title badge while hidden', async ({
    page,
  }) => {
    const { api, capture } = await openProcessing(page, { account: true, personalFeed: true });
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible();
    await page.locator('nav a[href="/"]:visible').first().dispatchEvent('click');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    const title = await page.title();
    await setVisibility(page, 'hidden');
    (api.opts as MockOptions).holdJobs = false;
    await expect
      .poll(() => page.title(), { timeout: 20_000 })
      .toBe('(1) Your photo is ready · culture atlas');
    const toast = page.locator('.ready-toast');
    await expect(toast).toContainText('Your photo is ready');
    // Announced politely; never takes focus.
    await expect(page.locator('.ready-region')).toHaveAttribute('aria-live', 'polite');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.ready-toast') ?? null),
    ).toBeNull();
    await setVisibility(page, 'visible');
    await expect.poll(() => page.title()).toBe(title);
    await expectNoHorizontalScroll(page);
    await toast.getByRole('button', { name: 'Open' }).click();
    await expect(page).toHaveURL(new RegExp(`/captures/${capture.id}`));
    await expect(page.getByRole('heading', { name: 'Vintage racing' })).toBeVisible();
    await expect(toast).toHaveCount(0);
  });

  test('no toast while the person is still on the result', async ({ page }) => {
    const { api } = await openProcessing(page, { account: true, personalFeed: true });
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible();
    (api.opts as MockOptions).holdJobs = false;
    await expect(page.getByRole('heading', { name: 'Vintage racing' })).toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(3000);
    await expect(page.locator('.ready-toast')).toHaveCount(0);
  });

  test('Dismiss closes the toast', async ({ page }) => {
    const { api } = await openProcessing(page, { account: true, personalFeed: true });
    await expect(page.getByRole('heading', { name: 'While we look' })).toBeVisible();
    await page.locator('nav a[href="/"]:visible').first().dispatchEvent('click');
    (api.opts as MockOptions).holdJobs = false;
    const toast = page.locator('.ready-toast');
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await toast.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
  });
});

test.describe('Settings → Taste (screen 18)', () => {
  const opts: MockOptions = {
    account: true,
    onboarding: {
      picks: ['chip-wear-japandi', 'img-linen', 'img-listening', 'chip-watch-film-noir'],
      searchPicks: ['Nina Simone'],
      exclusions: ['peanuts'],
    },
  };

  test('reachable from Settings; picks grouped by category, removable below 3', async ({
    page,
  }) => {
    const api = await openV22(page, '/settings', opts);
    await page.getByRole('link', { name: /Edit your taste/ }).click();
    await expect(page).toHaveURL(/\/settings\/taste$/);
    await expect(page.getByRole('heading', { name: 'Taste', exact: true })).toBeVisible();
    const wear = page.getByRole('region', { name: /^Wear/ });
    await expect(wear.getByRole('listitem')).toHaveCount(2);
    const play = page.getByRole('region', { name: /^Play/ });
    await expect(play.getByText('Artist')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await noSeriousAxe(page);
    for (const label of ['Japandi', 'Linen days', 'Sunday listening']) {
      await page.getByRole('button', { name: `Remove ${label}` }).click();
      await expect(page.getByRole('button', { name: `Remove ${label}` })).toHaveCount(0);
    }
    expect(api.onboarding.picks.map((p) => p.label).sort()).toEqual(['Film noir', 'Nina Simone']);
  });

  test('Add more opens the same pickers inline; Done closes them', async ({ page }) => {
    const api = await openV22(page, '/settings/taste', opts);
    await page.getByRole('button', { name: /Add more to Watch/ }).click();
    const ideas = page.getByRole('group', { name: 'Watch ideas' });
    await expect(ideas.getByRole('button', { name: 'Film noir' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await ideas.getByRole('button', { name: 'Heist' }).click();
    await expect(page.getByRole('button', { name: 'Remove Heist' })).toBeVisible();
    await page.getByLabel('Add an artist, film, brand or place').fill('nina');
    const wu = page
      .getByRole('list', { name: 'Search results' })
      .getByRole('button', { name: /Nina Wu/ });
    await wu.click();
    await expect(page.getByRole('button', { name: 'Remove Nina Wu' })).toBeVisible();
    const searched = api.log.find((r) => r.path === '/v1/onboarding/search');
    expect(searched?.search).toContain('category=watch');
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(ideas).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Add more to Watch/ })).toBeFocused();
  });

  test('exclusions save explicitly and are not picks', async ({ page }) => {
    const api = await openV22(page, '/settings/taste', opts);
    const group = page.getByRole('group', { name: 'Foods to leave out' });
    await expect(group.getByRole('button', { name: 'Peanuts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await group.getByRole('button', { name: 'Dairy' }).click();
    expect(api.onboarding.exclusions).toEqual(['peanuts']);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved', { exact: true })).toBeVisible();
    expect(api.onboarding.exclusions).toEqual(['peanuts', 'dairy']);
    expect(api.onboarding.picks).toHaveLength(5);
  });
});
