import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { closeJourneyDb, one, sessionOf, shot } from './graph-helpers';

/**
 * First-party Settings account deletion on the real stack (VAL-DELETE-001):
 * a fresh account goes Settings → Delete account, sees the server's own
 * disclosure, cancels (nothing changes), sees a request error reported as an
 * error and never as an accepted deletion, and then confirms: the browser's
 * own session is revoked at once, the one-time status token keeps answering
 * the public status route, and the cleanup is reported exactly as the worker
 * performs it — pending, then complete only when the server says so.
 *
 * The only fault injection is the single failed POST in the error step (a
 * dropped server answer); the acceptance itself is the real API + the real
 * worker against the isolated journey database.
 */

test.afterAll(async () => {
  await closeJourneyDb();
});

/** Server-truth questionnaire state for the signed-in account. */
async function onboardingState(page: Page): Promise<{ state: { required: boolean; picks_count: number } }> {
  const res = await page.request.get('/v1/onboarding/state');
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as { state: { required: boolean; picks_count: number } };
}

async function createAccount(page: Page, email: string, project: string) {
  await page.goto('/settings');
  const prompt = page.getByRole('button', { name: 'Create account' }).first();
  await expect(prompt).toBeVisible();
  await page.getByLabel('Your name').fill('Del Ada');
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Password').fill('a fine password');
  await prompt.click();
  // New accounts owe the taste questionnaire (min 3 picks; no save counts here).
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Pick what catches your eye.' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.pick-counter')).toHaveText('3 picks to go', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Tea rituals' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('2 picks to go');
  await page.getByRole('button', { name: 'Late-night cinema' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('1 pick to go');
  await page.getByRole('button', { name: 'Sesame noodles' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  // Picks save as they are made; wait until all three are durable server-side.
  await expect.poll(async () => (await onboardingState(page)).state.picks_count, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  // Below 768px the Build button only shows on step 3 (onboarding.css).
  if (project !== 'desktop') {
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Build my feed' }).click();
  // "Build my feed" only navigates after the server accepts completion, so a URL
  // change is the real signal — then completion must be durable before /settings.
  await expect(page).not.toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  await expect.poll(async () => (await onboardingState(page)).state.required, { timeout: 30_000 }).toBe(false);
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 30_000 });
}

test('settings deletion entry: cancel changes nothing, errors stay errors, acceptance revokes at once and reports cleanup truthfully', async ({ page }, info: TestInfo) => {
  test.setTimeout(240_000);
  const email = `delete-account-${info.project.name}-${Date.now()}@example.com`;
  await createAccount(page, email, info.project.name);
  const session = await sessionOf(page);
  expect(session.principal.kind).toBe('account');
  const accountId = session.principal.account_id!;

  await test.step('entry: the Settings account section links to the deletion page', async () => {
    const entry = page.getByRole('link', { name: /Delete account/ });
    await expect(entry).toBeVisible();
    await shot(page, info, `deletion-entry`);
    await entry.click();
    await expect(page).toHaveURL(/\/settings\/deletion/);
  });

  await test.step('the confirmation explains removal, revocation and the real retention limits', async () => {
    await expect(page.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
    // The disclosure is the server's own copy (getMyAccountDeletion).
    for (const line of [
      'Every browser session, agent token, native phone installation, share link and sensor connection is revoked.',
      /deleted from private storage/,
      /documented retention terms/,
      /Encrypted backups roll off/,
    ]) {
      await expect(page.getByText(line).first()).toBeVisible();
    }
    await shot(page, info, `deletion-explain`);
  });

  await test.step('cancel changes nothing', async () => {
    await page.getByRole('link', { name: 'Back to settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    const after = await sessionOf(page);
    expect(after.principal.kind).toBe('account');
    expect(await one(`SELECT deleted_at FROM accounts WHERE id = $1`, [accountId])).toMatchObject({
      deleted_at: null,
    });
    expect(await one(`SELECT account_id FROM account_deletions WHERE account_id = $1`, [accountId])).toBeUndefined();
  });

  let storedToken = '';
  await test.step('a failed request is an error, never an accepted deletion', async () => {
    await page.goto('/settings/deletion');
    await expect(page.getByRole('button', { name: 'Delete my account' })).toBeVisible();
    // One dropped server answer: the UI must report it as an error.
    await page.route('**/v2/me/account-deletion', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'service_unavailable', message: 'The request did not go through.', retryable: true, request_id: 'journey' },
        }),
      });
    });
    await page.getByRole('button', { name: 'Delete my account' }).click();
    // Next's route announcer also has role="alert"; the view's own is the paragraph.
    const alert = page.locator('p[role="alert"]');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/unchanged/i);
    await shot(page, info, `deletion-error`);
    await page.unroute('**/v2/me/account-deletion');
    // Nothing changed on the account.
    const after = await sessionOf(page);
    expect(after.principal.kind).toBe('account');
    expect(await one(`SELECT deleted_at FROM accounts WHERE id = $1`, [accountId])).toMatchObject({
      deleted_at: null,
    });
    // The stored capability appears only with an accepted deletion.
    storedToken = await page.evaluate(() =>
      (JSON.parse(window.localStorage.getItem('atlas.account-deletion.v1') ?? 'null') as { status_token: string } | null)?.status_token ?? '',
    );
    expect(storedToken).toBe('');
  });

  await test.step('confirming revokes this browser at once and shows the honest pending state', async () => {
    await page.getByRole('button', { name: 'Delete my account' }).click();
    await expect(page.getByRole('heading', { name: /Your account is/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/Your account is being deleted|Your account is deleted/).first()).toBeVisible();
    // The acceptance is durable: tombstone + deletion record.
    await expect
      .poll(async () => (await one<{ deleted_at: Date | null }>(`SELECT deleted_at FROM accounts WHERE id = $1`, [accountId]))?.deleted_at ?? null)
      .not.toBeNull();
    await expect(
      await one<{ cleanup_state: string }>(`SELECT cleanup_state FROM account_deletions WHERE account_id = $1`, [accountId]),
    ).toBeTruthy();
    // The old cookie lost its authority: the session is anonymous now.
    const after = await sessionOf(page);
    expect(after.principal.kind).toBe('anonymous');
    // The one-time capability is kept locally so the status keeps answering.
    storedToken = await page.evaluate(() =>
      (JSON.parse(window.localStorage.getItem('atlas.account-deletion.v1') ?? 'null') as { status_token: string } | null)?.status_token ?? '',
    );
    expect(storedToken).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    await shot(page, info, `deletion-accepted`);
  });

  await test.step('the status follows the real worker: pending, then complete only when the server says so', async () => {
    // The real worker owns the purge; the page reports exactly what the
    // status route answers, polling with the kept token.
    await expect
      .poll(async () => page.getByRole('heading', { name: 'Your account is deleted' }).isVisible(), { timeout: 120_000 })
      .toBe(true);
    await expect(page.getByText(/All of your private data has been removed/)).toBeVisible();
    await expect
      .poll(
        async () =>
          (await one<{ cleanup_state: string }>(`SELECT cleanup_state FROM account_deletions WHERE account_id = $1`, [accountId]))
            ?.cleanup_state,
      )
      .toBe('complete');
    // The token itself keeps answering the public route with no session.
    const status = await page.request.get('/v2/account-deletion/status', {
      headers: { 'x-atlas-deletion-token': storedToken },
    });
    expect(status.ok()).toBeTruthy();
    const body = (await status.json()) as { status: { state: string; completed_steps: string[] } };
    expect(body.status.state).toBe('complete');
    expect(body.status.completed_steps).toEqual(['media_objects', 'private_rows']);
    // A wrong token discloses nothing.
    const wrong = await page.request.get('/v2/account-deletion/status', {
      headers: { 'x-atlas-deletion-token': 'x'.repeat(43) },
    });
    expect(wrong.status()).toBe(404);
    await shot(page, info, `deletion-complete`);
  });
});
