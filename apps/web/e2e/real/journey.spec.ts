import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll, SCREENSHOT_DIR, settleImages } from '../helpers';

/**
 * The spec's consumer acceptance journey against the REAL app + worker (no
 * mocks): browse, try an example, upload, create an account, save into a
 * collection, select mixed items, create a movie night, connect an agent.
 * It passes with or without provider keys and asserts the honest states:
 * replayed examples are labeled "Example result", missing providers show
 * their unavailable/partial states, and nothing is invented.
 */

const PUBLIC = path.resolve(import.meta.dirname, '../../public/samples');

async function shot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() =>
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager')),
  );
  await settleImages(page, true);
  // Never put a credential in a committed screenshot.
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `real-${name}-${info.project.name}.png`),
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('.credential__value')],
  });
}

async function toastSays(page: Page, text: string | RegExp) {
  await expect(page.locator('.toast').filter({ hasText: text }).first()).toBeVisible();
}

test('main journey on the real stack', async ({ page }, info) => {
  const project = info.project.name;
  const email = `journey-${project}-${Date.now()}@example.com`;
  const apiErrors: string[] = [];
  let capturePath = '';
  let artistTitle = '';
  page.on('response', (r) => {
    const url = new URL(r.url());
    // 4xx answers the UI handles on purpose are fine; 5xx never is.
    if (url.pathname.startsWith('/v1/') && r.status() >= 500) apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });

  await test.step('first visit: browse the example feed and load more', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
    const grid = page.getByRole('list', { name: /discoveries/i }).first();
    await expect(grid.getByRole('listitem').first()).toBeVisible();
    const before = await grid.getByRole('listitem').count();
    await expect(page.getByText('Example result').first()).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(() => grid.getByRole('listitem').count()).toBeGreaterThan(before);
    await expectNoHorizontalScroll(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, info, '01-discover');
  });

  await test.step('item detail and back', async () => {
    await page.getByRole('link', { name: /Nina Simone/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Nina Simone', level: 1 })).toBeVisible();
    // Samples are reviewed examples, not provider results: they carry no
    // recommendation and therefore no "Why this?" disclosure (feed/samples.ts
    // content rules forbid claims between samples). Assert the honest state.
    await expect(page.getByRole('button', { name: 'Why this?' })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '02-item');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
  });

  await test.step('try an example: a labeled result', async () => {
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    capturePath = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Finding your next favorites…', { timeout: 60_000 });
    await expect(page.getByText('Example result').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, '03-example-result');
  });

  await test.step('saving prompts an account; the save lands in a new collection', async () => {
    const card = page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first();
    const title = (await card.getByRole('link').first().textContent())?.trim() ?? '';
    await card.getByRole('button', { name: /^Save / }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('button', { name: 'Create account' })).toBeVisible();
    await shot(page, info, '04-account-prompt');
    await dialog.getByLabel(/Your name/).fill('Ada');
    await dialog.getByLabel(/^Email/).fill(email);
    await dialog.getByLabel(/^Password/).fill('a fine password');
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill('Slow Sunday');
    await shot(page, info, '05-save-picker');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await toastSays(page, 'Saved to Slow Sunday');
    expect(title.length).toBeGreaterThan(0);
  });

  await test.step('a new account answers the taste questionnaire (amendment 2.2), the save counting as one pick', async () => {
    await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
    await expect(page.locator('.pick-counter')).toHaveText('2 picks to go');
    await page.getByRole('button', { name: 'Tea rituals' }).click();
    if (project !== 'desktop') await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('group', { name: 'Play' }).getByRole('button', { name: 'Jazz' }).click();
    await expect(page.locator('.pick-counter')).toHaveText('Ready');
    if (project !== 'desktop') await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Build my feed' }).click();
    await expect(page).toHaveURL(/\/welcome\/building|\/$/);
    // Without a Qloo key the seed cannot run: the honest state, then back to the result.
    await page.goto(capturePath);
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Finding your next favorites…', { timeout: 60_000 });
  });

  await test.step('save the inspiration itself', async () => {
    await page.getByRole('button', { name: 'Save this inspiration' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('radio', { name: 'Slow Sunday' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await toastSays(page, 'Saved to Slow Sunday');
    await expect(page.getByRole('button', { name: 'Inspiration saved' })).toBeVisible();
  });

  await test.step('upload a photo', async () => {
    await page.goto('/capture/photo');
    await page.getByTestId('upload-input').setInputFiles(path.join(PUBLIC, 'room.jpg'));
    await expect(page.getByRole('img', { name: 'Your selected photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).not.toHaveText('Finding your next favorites…', { timeout: 90_000 });
    // With a VLM key this is a real reading; without one, the honest service state.
    const text = (await heading.textContent()) ?? '';
    if (/can’t look at this photo yet/.test(text)) {
      // Two honest unavailable states: a transient provider outage says "right
      // now … in a little while", a server without a qualified analysis profile
      // says reading "isn't available on this server yet". Both keep the photo
      // and offer the same retry.
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    }
    await expect(page.getByText(/vlm|qloo|anthropic/i)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await shot(page, info, '06-upload-result');
  });

  await test.step('save an artist from the feed into the remembered collection', async () => {
    await page.goto('/');
    // After the questionnaire the feed is personal (seeded picks when Qloo is reachable,
    // labeled examples otherwise): save the first artist card it shows.
    const artist = page.getByRole('list', { name: /discoveries/i }).first().getByRole('listitem').filter({ hasText: 'Artist' }).first();
    const save = artist.getByRole('button', { name: /^Save / }).first();
    const label = (await save.getAttribute('aria-label')) ?? (await save.innerText());
    artistTitle = label.replace(/^Save /, '').trim();
    expect(artistTitle.length).toBeGreaterThan(0);
    await save.click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('radio', { name: 'Slow Sunday' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await toastSays(page, 'Saved to Slow Sunday');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, info, '07-discover-returning');
  });

  await test.step('collections index and the mixed collection', async () => {
    await page.goto('/collections');
    await expect(page.getByRole('link', { name: /Slow Sunday/ }).first()).toBeVisible();
    await shot(page, info, '08-collections');
    await page.getByRole('link', { name: /Slow Sunday/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Slow Sunday', level: 1 })).toBeVisible();
    await expect(page.getByText(artistTitle).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, '09-collection');
  });

  await test.step('select mixed items and make a movie night', async () => {
    await page.getByRole('button', { name: 'Make something' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Movie night/ }).click();
    await expect(page.locator('.selection-bar__count')).toHaveText(/selected/);
    await shot(page, info, '10-selection');
    await page.getByRole('button', { name: 'Make a movie night' }).click();
    await expect(page.getByRole('heading', { name: 'Make a movie night' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, '11-plan-form');
    await page.getByRole('button', { name: 'Create movie night' }).click();
    await expect(page).toHaveURL(/\/plans\//);
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Putting your movie night together…', { timeout: 90_000 });
    // Every section settles into real picks or an honest state; nothing invented.
    await expect(page.locator('.plan .skeleton')).toHaveCount(0, { timeout: 90_000 });
    await expect(page.getByRole('heading', { name: 'Inspired by' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, info, '12-plan');
  });

  await test.step('plans list', async () => {
    // The plan was created in the previous step. This list is read client-side, and under
    // the parallel-viewport load of a keyed stack that single read can time out and land on
    // the error state, which never retries on its own. Wait for the API to reflect the plan,
    // then retry the page until it renders the link (the journey's slow steps use 60-90s).
    const listedPlans = async () =>
      ((await (await page.request.get('/v1/plans')).json()) as { plans: unknown[] }).plans.length;
    await expect.poll(listedPlans, { timeout: 90_000, intervals: [1_000] }).toBeGreaterThan(0);
    await expect(async () => {
      await page.goto('/plans');
      await expect(
        page.getByRole('link', { name: /Movie night|movie night/i }).first(),
      ).toBeVisible({ timeout: 30_000 });
    }).toPass({ timeout: 90_000, intervals: [1_000] });
    await shot(page, info, '13-plans');
  });

  await test.step('connect an agent to one collection (credential shown once)', async () => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await page.getByRole('button', { name: 'Connect an agent' }).click();
    await page.getByLabel('Agent name').fill('Demo agent');
    await page.getByRole('checkbox', { name: 'Slow Sunday' }).check();
    // The demo agent creates a plan and replaces its film: plans:write.
    await page.getByRole('checkbox', { name: 'Create and change plans' }).check();
    await page.getByRole('button', { name: 'Connect agent' }).click();
    const credential = page.locator('.credential__value').first();
    await expect(credential).toContainText('cat_');
    if (project === 'desktop') {
      const dir = path.resolve(import.meta.dirname, '../../test-results');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'agent-token.txt'), (await credential.textContent())!.trim());
    }
    await shot(page, info, '14-agent-credential');
  });

  expect(apiErrors, 'no server errors during the journey').toEqual([]);
});
