import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { closeJourneyDb, isGraphOn, paidModelAttempts, scalar, sessionOf, shot, tasteRevision } from './graph-helpers';

/**
 * VAL-CROSS-001, graph-off phase: with the interest-graph flags off, a fresh
 * anonymous visitor gets the unchanged product, and the legacy account-claim
 * path still moves their material to a fresh account without creating any
 * personal graph state. Runs against the real web app + job worker on the
 * isolated journey database; example captures replay their reviewed reading, so
 * nothing here touches a paid provider.
 *
 * Run with the standard (projection-off) journey stack; the spec skips itself
 * on a projection-enabled stack, where its zero-graph assertions are invalid.
 */
test.skip(isGraphOn, 'graph-off journey requires the projection flag to be off');

test.afterAll(async () => {
  await closeJourneyDb();
});

const NINA = 'Nina Simone';
const FELA = 'Fela Kuti';

async function hideItem(page: Page, title: string) {
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: `More options for ${title}` }).click();
  await page.getByRole('button', { name: 'Hide this' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: title })).toHaveCount(0);
}

async function answerQuestionnaire(page: Page, info: TestInfo) {
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  await expect(page.locator('.pick-counter')).toHaveText('2 picks to go');
  await page.getByRole('button', { name: 'Tea rituals' }).click();
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('group', { name: 'Play' }).getByRole('button', { name: 'Jazz' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Build my feed' }).click();
  await expect(page).toHaveURL(/\/welcome\/building|\/$/, { timeout: 30_000 });
}

test('graph-off first visit and account claim keep the legacy product', async ({ page }, info: TestInfo) => {
  const email = `graph-off-${info.project.name}-${Date.now()}@example.com`;
  const apiErrors: string[] = [];
  page.on('response', (r) => {
    const url = new URL(r.url());
    if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) && r.status() >= 500)
      apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
  const paidBefore = await paidModelAttempts();

  await test.step('first visit: the example feed with Load more', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try an example' })).toBeVisible();
    const grid = page.getByRole('list', { name: /discoveries/i }).first();
    await expect(grid.getByRole('listitem').first()).toBeVisible();
    const before = await grid.getByRole('listitem').count();
    await expect(page.getByText('Example result').first()).toBeVisible();
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect.poll(() => grid.getByRole('listitem').count()).toBeGreaterThan(before);
    await shot(page, info, 'off-01-discover');
  });

  await test.step('category filter keeps working', async () => {
    await page.getByRole('group', { name: /filter/i }).getByRole('button', { name: 'Play' }).click();
    const grid = page.getByRole('list', { name: /discoveries/i }).first();
    await expect(grid.getByRole('listitem').first()).toBeVisible();
    await expect(page.getByRole('link', { name: NINA }).first()).toBeVisible();
    await page.getByRole('group', { name: /filter/i }).getByRole('button', { name: 'All' }).click();
    await expect(grid.getByRole('listitem').first()).toBeVisible();
  });

  await test.step('item detail and back navigation', async () => {
    await page.getByRole('link', { name: NINA }).first().click();
    await expect(page.getByRole('heading', { name: NINA, level: 1 })).toBeVisible();
    // Sample items carry no claimed connection: the Why-this disclosure stays
    // absent rather than inventing a reason.
    await expect(page.getByRole('button', { name: 'Why this?' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: `More options for ${NINA}` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    await shot(page, info, 'off-02-item');
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
  });

  const anonSession = await sessionOf(page);

  await test.step('hide an item anonymously (prepared for the claim)', async () => {
    await hideItem(page, FELA);
    await expect(page.getByText(`Hidden “${FELA}”`).first()).toBeVisible();
  });

  let capturePath = '';
  await test.step('photo entry: try an example, a labeled replay result', async () => {
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    capturePath = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Finding your next favorites…', { timeout: 60_000 });
    await expect(page.getByText('Example result').first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first()).toBeVisible();
    await shot(page, info, 'off-03-example-capture');
  });

  await test.step('Music Mode entry stays available', async () => {
    await page.goto('/capture/music');
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();
    await shot(page, info, 'off-04-music-mode');
  });

  await test.step('library and settings keep their anonymous states', async () => {
    await page.goto('/library');
    await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();
    await shot(page, info, 'off-05-library');
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
    await shot(page, info, 'off-06-settings');
  });

  await test.step('saving prompts the legacy account creation and claims the visit', async () => {
    await page.goto(capturePath);
    const card = page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first();
    await card.getByRole('button', { name: /^Save / }).click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('button', { name: 'Create account' })).toBeVisible();
    await dialog.getByLabel(/Your name/).fill('Graph Off');
    await dialog.getByLabel(/^Email/).fill(email);
    await dialog.getByLabel(/^Password/).fill('a fine password');
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill('Preview keep');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved to Preview keep').first()).toBeVisible();
  });

  const session = await sessionOf(page);
  expect(session.principal.kind).toBe('account');
  const accountId = session.principal.account_id!;
  expect(accountId.length).toBeGreaterThan(0);
  const anonId = anonSession.principal.session_id;

  await test.step('the claim moved the anonymous material to the account', async () => {
    const captureId = capturePath.split('/').pop() ?? '';
    const moved = await scalar(
      `SELECT count(*) AS n FROM captures
        WHERE id::text = $1 AND owner_account_id = $2 AND owner_session_id IS NULL AND expires_at IS NULL`,
      [captureId, accountId],
    );
    expect(moved).toBe(1);
    const exclusion = await scalar(
      `SELECT count(*) AS n FROM item_exclusions e
        JOIN discovery_items i ON i.id = e.discovery_item_id
       WHERE e.owner_account_id = $1 AND i.title = $2`,
      [accountId, FELA],
    );
    expect(exclusion).toBe(1);
    const sessionRow = await scalar(
      'SELECT count(*) AS n FROM sessions WHERE id::text = $1 AND claimed_at IS NOT NULL AND revoked_at IS NOT NULL',
      [anonId],
    );
    expect(sessionRow).toBe(1);
    // The intended save came along as exactly one save and one pick.
    expect(await scalar('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [accountId])).toBe(1);
    expect(
      await scalar(
        `SELECT count(*) AS n FROM onboarding_pick_items pi
         WHERE pi.account_id = $1 AND pi.created_save AND EXISTS (
           SELECT 1 FROM saved_items si WHERE si.owner_account_id = $1 AND si.discovery_item_id = pi.discovery_item_id)`,
        [accountId],
      ),
    ).toBe(1);
    expect(await tasteRevision(accountId)).toBeGreaterThanOrEqual(2);
  });

  await test.step('the taste questionnaire completes the legacy onboarding', async () => {
    await answerQuestionnaire(page, info);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await shot(page, info, 'off-07-feed-returning');
    // Two tile picks (one bundled) on top of the claimed pick: 3 picks, 4 members, 4 saves.
    expect(await scalar('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [accountId])).toBe(4);
    expect(
      await scalar('SELECT count(DISTINCT pi.pick_id) AS n FROM onboarding_pick_items pi WHERE pi.account_id = $1', [accountId]),
    ).toBe(3);
  });

  await test.step('flags off: the visit created no personal graph state at all', async () => {
    const outbox = await scalar('SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1', [accountId]);
    expect(outbox).toBe(0);
    const state = await scalar('SELECT count(*) AS n FROM personal_graph_state WHERE owner_account_id = $1', [accountId]);
    expect(state).toBe(0);
    const edges = await scalar('SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1', [accountId]);
    expect(edges).toBe(0);
    const runs = await scalar('SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1', [accountId]);
    expect(runs).toBe(0);
  });

  await test.step('signed-in settings and the paid-provider ledger stay unchanged', async () => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await shot(page, info, 'off-08-account-settings');
    expect(apiErrors, 'no server errors during the journey').toEqual([]);
    expect(await paidModelAttempts()).toBe(paidBefore);
  });
});
