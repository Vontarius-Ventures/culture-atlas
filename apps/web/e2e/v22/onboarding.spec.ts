/**
 * Spec amendment 2.2, screens 14 and 15: the required sign-up questionnaire
 * and the building-feed interstitial, against the contract-validated mock of
 * /v1/onboarding/* (the backend is built in parallel; fetches are real).
 * Runs at 1440 (desktop), 390 (mobile), 360 (minimum) and 320 (narrow).
 */
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';
import { isDesktop, noSeriousAxe, openV22 } from './helpers';

// Clicks cards in the feed; Reduce Motion keeps the floating feed still
// (the conveyor itself is covered in feed-float.spec.ts).
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const counter = (page: Page) => page.locator('.pick-counter');
const build = (page: Page) => page.getByRole('button', { name: 'Build my feed' });

/** Mobile shows one step at a time; desktop shows every section. */
async function goToStep(page: Page, step: 2 | 3, desktop: boolean) {
  if (desktop) return;
  const label = (await page.locator('.onb-steps').innerText()).trim();
  const current = Number(/Step (\d)/.exec(label)?.[1] ?? 1);
  for (let s = current; s < step; s++)
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(`Step ${step} of 3`)).toBeVisible();
}

test.describe('Taste onboarding (screen 14)', () => {
  test('anonymous visitors never see the questionnaire (ONB-01)', async ({ page }) => {
    const api = await openV22(page, '/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/welcome/taste');
    await expect(page).toHaveURL(/\/$/);
    expect(api.log.some((r) => r.path.startsWith('/v1/onboarding'))).toBe(false);
  });

  test('sign-up leads into the questionnaire; three picks from images, chips and search build the feed', async ({
    page,
  }, testInfo) => {
    const desktop = isDesktop(testInfo);
    const api = await openV22(page, '/settings', { onboarding: { seed: 'progressive' } });
    await page.getByRole('button', { name: 'Create account' }).click();
    // The new account is sent to the questionnaire before its personal feed.
    await expect(page).toHaveURL(/\/welcome\/taste/);
    await expect(page.getByRole('heading', { name: 'Pick what catches your eye.' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    await expect(counter(page)).toHaveText('3 picks to go');
    await expect(counter(page)).toHaveAttribute('aria-live', 'polite');

    // An image counts once even though it stands for several tags.
    const tea = page.getByRole('button', { name: 'Tea rituals' });
    await expect(tea).toHaveAttribute('aria-pressed', 'false');
    await tea.click();
    await expect(tea).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText('2 picks to go');
    expect(api.onboarding.picks[0]!.saved_item_ids).toHaveLength(2);

    // Undo and redo: removing a pick unsaves it.
    await tea.click();
    await expect(counter(page)).toHaveText('3 picks to go');
    await expect.poll(() => api.onboarding.picks.length).toBe(0);
    await tea.click();
    await expect(counter(page)).toHaveText('2 picks to go');

    await goToStep(page, 2, desktop);
    const japandi = page
      .getByRole('group', { name: 'Wear' })
      .getByRole('button', { name: 'Japandi' });
    // Keyboard: chips are real toggle buttons.
    await japandi.focus();
    await page.keyboard.press('Space');
    await expect(japandi).toHaveAttribute('aria-pressed', 'true');
    await expect(counter(page)).toHaveText('1 pick to go');

    if (desktop) {
      // Below the minimum the button stays focusable, says why, and does nothing.
      await expect(build(page)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText('Pick at least 3 so your feed starts with you.')).toBeVisible();
      await build(page).focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      await expect(page).toHaveURL(/\/welcome\/taste/);
      expect(api.onboarding.completeCalls).toBe(0);
    }

    // Live search: name and type only; adding sends the signed result id.
    await page.getByLabel('Add an artist, film, brand or place').fill('nina');
    const results = page.getByRole('list', { name: 'Search results' });
    await expect(results.getByRole('button')).toHaveCount(3);
    const nina = results.getByRole('button', { name: /Nina Simone/ });
    await expect(nina).toContainText('Artist');
    await nina.click();
    await expect(nina).toHaveAttribute('aria-pressed', 'true');
    await expect(nina).toContainText('Added');
    await expect(counter(page)).toHaveText('Ready');
    const posted = api.onboarding.picks.find((p) => p.label === 'Nina Simone');
    expect(posted?.source).toBe('search');

    // Exclusions are optional and never count.
    await goToStep(page, 3, desktop);
    await expect(page.getByRole('heading', { name: /Anything to leave out\?/ })).toBeVisible();
    const shellfish = page
      .getByRole('group', { name: 'Foods to leave out' })
      .getByRole('button', { name: 'Shellfish' });
    await shellfish.click();
    await expect(shellfish).toHaveAttribute('aria-pressed', 'true');
    await page.getByLabel('Something else to leave out').fill('Cilantro');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cilantro' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(counter(page)).toHaveText('Ready');

    await expect(build(page)).toHaveAttribute('aria-disabled', 'false');
    await expectNoHorizontalScroll(page);
    await noSeriousAxe(page);
    await build(page).click();
    expect(api.onboarding.exclusions).toEqual(['shellfish', 'cilantro']);

    // Screen 15, then Discover as soon as the first category is ready.
    await expect(page).toHaveURL(/\/welcome\/building/);
    await expect(page.getByRole('heading', { name: 'Building your feed…' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Your picks' }).getByRole('listitem')).toHaveCount(
      3,
    );
    await expect(page).toHaveURL(/\/$/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    expect(api.onboarding.completeCalls).toBe(1);
  });

  test('an account created to complete a save finishes that save, then the save counts as one pick', async ({
    page,
  }) => {
    const api = await openV22(page, '/');
    await page.getByRole('button', { name: 'Save Vintage racing' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await dialog.getByRole('button', { name: 'Create account' }).click();
    // The dialog is not interrupted by the questionnaire.
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill('Slow Sunday');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // Then the questionnaire, with the intended save already counted.
    await expect(page).toHaveURL(/\/welcome\/taste/);
    await expect(counter(page)).toHaveText('2 picks to go');
    expect(api.onboarding.picks.map((p) => p.source)).toEqual(['pending_save']);
  });

  test('an existing account that owes the questionnaire is redirected until it is complete (ONB-06)', async ({
    page,
  }) => {
    const api = await openV22(page, '/collections', {
      account: true,
      onboarding: { required: true, picks: ['img-tea', 'chip-wear-japandi'] },
    });
    await expect(page).toHaveURL(/\/welcome\/taste/);
    // Picks made before leaving are kept (resume).
    await expect(counter(page)).toHaveText('1 pick to go');
    await expect(page.getByRole('button', { name: 'Tea rituals' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.goto('/plans');
    await expect(page).toHaveURL(/\/welcome\/taste/);
    expect(api.log.some((r) => r.path === '/v1/plans')).toBe(false);
  });

  test('accounts that finished onboarding are never sent back', async ({ page }) => {
    await openV22(page, '/collections', { account: true, onboarding: { required: false } });
    await expect(page.getByRole('heading', { name: 'Your collections' })).toBeVisible();
    await expect(page).toHaveURL(/\/collections$/);
  });

  test('with Qloo search unavailable, onboarding still completes from the catalog (ONB-03)', async ({
    page,
  }, testInfo) => {
    const desktop = isDesktop(testInfo);
    const api = await openV22(page, '/welcome/taste', {
      account: true,
      onboarding: { required: true, search: 'unavailable', seed: 'unavailable' },
    });
    await page.getByRole('button', { name: 'Linen days' }).click();
    await page.getByRole('button', { name: 'Sunday listening' }).click();
    await goToStep(page, 2, desktop);
    await page.getByLabel('Add an artist, film, brand or place').fill('nina');
    await expect(
      page.getByText('Search is taking a break. Pick from the ideas above.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Film noir' }).click();
    await expect(counter(page)).toHaveText('Ready');
    await goToStep(page, 3, desktop);
    await build(page).click();
    await expect(page).toHaveURL(/\/welcome\/building/);
    // Honest state: nothing fabricated, keep building in the background.
    await expect(page.getByText("We'll keep building in the background.")).toBeVisible();
    await expect(page.getByText('Until then, your feed shows example results.')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole('link', { name: 'See my feed' }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(api.onboarding.picks).toHaveLength(3);
  });

  test('mobile steps: Step N of 3, Back and Next, no bottom navigation', async ({
    page,
  }, testInfo) => {
    test.skip(isDesktop(testInfo), 'Mobile steps only');
    await openV22(page, '/welcome/taste', { account: true, onboarding: { required: true } });
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await expect(page.locator('.bottom-nav')).toHaveCount(0);
    await expect(build(page)).toBeHidden();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Step 2 of 3')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Choose a few favorites.' })).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Pick what catches your eye.' })).toBeHidden();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
});
