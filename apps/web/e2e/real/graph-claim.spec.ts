import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  closeJourneyDb,
  isGraphOn,
  journeyDb,
  one,
  paidModelAttempts,
  scalar,
  sessionOf,
  shot,
  supportRows,
  tasteRevision,
  waitForProjectionReady,
} from './graph-helpers';

/**
 * VAL-CROSS-001, graph-on phase: the anonymous-to-account claim through the
 * real product's preview-claim option (password sign-in, claim_session) over
 * prepared anonymous material — a session capture, a session hide, and the
 * legacy session-owned save rows (one overlapping an account save, one not) —
 * against the real web app and job worker on the isolated journey database
 * with the projection flag enabled for fresh accounts.
 *
 * What it proves on the real stack:
 *  - the merged canonical state projects once, only after the claim, through
 *    the worker's outbox dispatch (no inline work, no new user mutation);
 *  - the overlapping save stays exactly one endorsement (claim dedupe);
 *  - a retried claim adds nothing (the rebuilt projection is row-for-row the
 *    same semantic set);
 *  - the revoked anonymous session and its snapshots cannot reach the
 *    transferred private material;
 *  - no paid provider is charged (example captures replay; the paid ledger
 *    must not move).
 *
 * Requires the journey stack started with INTEREST_GRAPH_PROJECTION_ENABLED=true
 * (web and worker); the spec skips itself when that flag is not set so the
 * shared real-suite command stays green on a projection-off stack.
 */
test.skip(!isGraphOn, 'graph-on claim journey requires INTEREST_GRAPH_PROJECTION_ENABLED=true');

test.afterAll(async () => {
  await closeJourneyDb();
});

const NINA = 'Nina Simone';
const FELA = 'Fela Kuti';

function trackErrors(page: Page, apiErrors: string[]) {
  page.on('response', (r) => {
    const url = new URL(r.url());
    if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) && r.status() >= 500)
      apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
}

/** The legacy claimed-history shape: a session-owned save with its save event (accounts.ts claimSession still merges these). */
async function seedLegacySessionSave(sessionId: string, itemId: string) {
  await journeyDb().query('INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2)', [sessionId, itemId]);
  await journeyDb().query(
    `INSERT INTO preference_events (owner_session_id, action, target_type, target_id, payload)
     SELECT $1, 'save', 'discovery_item', $2, jsonb_build_object('canonical_key', canonical_key)
       FROM discovery_items WHERE id = $2`,
    [sessionId, itemId],
  );
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

test('claim projects the merged state once and denies the old anonymous authority', async ({ browser }, info: TestInfo) => {
  const email = `graph-claim-${info.project.name}-${Date.now()}@example.com`;
  const password = 'a fine password';
  const apiErrors: string[] = [];
  const paidBefore = await paidModelAttempts();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  trackErrors(pageA, apiErrors);

  const ninaId = (
    await journeyDb().query<{ id: string }>(`SELECT id FROM discovery_items WHERE canonical_key = 'sample:artist-nina-simone' AND is_sample`)
  ).rows[0]!.id;
  const amelieId = (
    await journeyDb().query<{ id: string }>(`SELECT id FROM discovery_items WHERE canonical_key = 'sample:film-amelie' AND is_sample`)
  ).rows[0]!.id;
  expect(ninaId.length && amelieId.length).toBeTruthy();

  await test.step('account A: create through the save dialog, onboard, save the overlapping item', async () => {
    await pageA.goto('/');
    await expect(pageA.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    const ninaCard = pageA
      .getByRole('list', { name: /discoveries/i })
      .first()
      .getByRole('listitem')
      .filter({ hasText: NINA })
      .first();
    await ninaCard.getByRole('button', { name: `Save ${NINA}` }).click();
    const dialog = pageA.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('button', { name: 'Create account' })).toBeVisible();
    await dialog.getByLabel(/Your name/).fill('Ada Claim');
    await dialog.getByLabel(/^Email/).fill(email);
    await dialog.getByLabel(/^Password/).fill(password);
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill('Sunday roots');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText('Saved to Sunday roots').first()).toBeVisible();
    await answerQuestionnaire(pageA, info);
    await pageA.goto('/');
    await expect(pageA.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    await shot(pageA, info, 'claim-01-account-feed');
  });

  const sessionA = await sessionOf(pageA);
  expect(sessionA.principal.kind).toBe('account');
  const accountId = sessionA.principal.account_id!;
  let projectionRevisionBeforeClaim = 0;

  await test.step('the account’s own material projects before any claim', async () => {
    const state = await waitForProjectionReady(accountId);
    projectionRevisionBeforeClaim = state.projection_revision;
    expect(state.last_graph_run_id).not.toBeNull();
    const runs = await scalar(
      `SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'projection' AND state = 'complete'`,
      [accountId],
    );
    expect(runs).toBeGreaterThanOrEqual(1);
    const before = await supportRows(accountId);
    // Every pick member is itself a save (Amendment 2.2: the pending save counts
    // as one pick; the bundled tile pick adds its members). The three onboarding
    // tile members are account-owned item roots; the Nina save targets a shared
    // catalog sample row and projects as private support on the account's own
    // saved_items row — a real confirmed root, not an omission.
    expect(before.filter((r) => r.origin_kind === 'saved_item').length).toBe(4);
    expect(new Set(before.filter((r) => r.pick_id).map((r) => r.pick_id)).size).toBe(3);
    expect(before.filter((r) => r.capture_id)).toHaveLength(0);
    // Projection is shadow-only: nothing graph-parented reaches the feed tables.
    expect(
      await scalar('SELECT count(*) AS n FROM recommendations WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL', [
        accountId,
      ]),
    ).toBe(0);
  });

  await test.step('sign out: a fresh anonymous session prepares the visit', async () => {
    await pageA.goto('/settings');
    await expect(pageA.getByRole('heading', { name: 'Your account' })).toBeVisible();
    await pageA.getByRole('button', { name: 'Sign out' }).click();
    await pageA.waitForURL(/\/\?signed_out=1|\/$/);
    const anon = await sessionOf(pageA);
    expect(anon.principal.kind).toBe('anonymous');
  });

  const anonId = (await sessionOf(pageA)).principal.session_id;
  let capturePath = '';
  let captureId = '';

  await test.step('prepare: a session capture with its labeled replay result', async () => {
    await pageA.goto('/');
    await pageA.getByRole('button', { name: 'Try an example' }).click();
    await pageA.getByRole('button', { name: 'An outfit' }).click();
    await expect(pageA).toHaveURL(/\/captures\//);
    capturePath = new URL(pageA.url()).pathname;
    captureId = capturePath.split('/').pop() ?? '';
    await expect(pageA.getByRole('heading', { level: 1 })).not.toHaveText('Finding your next favorites…', { timeout: 60_000 });
    await expect(pageA.getByText('Example result').first()).toBeVisible();
    await shot(pageA, info, 'claim-02-anon-capture');
  });

  await test.step('prepare: a session hide from the item page', async () => {
    await pageA.goto('/');
    await pageA.getByRole('link', { name: FELA }).first().click();
    await expect(pageA.getByRole('heading', { name: FELA, level: 1 })).toBeVisible();
    await pageA.getByRole('button', { name: `More options for ${FELA}` }).click();
    await pageA.getByRole('button', { name: 'Hide this' }).click();
    await expect(pageA).toHaveURL(/\/$/);
    await expect(pageA.getByText(`Hidden “${FELA}”`).first()).toBeVisible();
  });

  await test.step('prepare: the legacy session-owned saves (one overlapping the account save)', async () => {
    await seedLegacySessionSave(anonId, ninaId);
    await seedLegacySessionSave(anonId, amelieId);
    expect(
      await scalar('SELECT count(*) AS n FROM saved_items WHERE owner_session_id = $1', [anonId]),
    ).toBe(2);
    // The anonymous visit owns a feed snapshot, which the claim must revoke.
    expect(await scalar('SELECT count(*) AS n FROM feed_snapshots WHERE owner_session_id = $1', [anonId])).toBeGreaterThanOrEqual(
      1,
    );
  });

  const cookiesBeforeClaim = await contextA.cookies();
  const claimResponsePromise = pageA.waitForResponse(
    (r) => r.url().includes('/v1/session/sign-in') && r.request().method() === 'POST',
  );

  await test.step('claim: the preview-claim sign-in over the prepared visit', async () => {
    await pageA.goto(capturePath);
    const card = pageA.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first();
    await card.getByRole('button', { name: /^Save / }).click();
    const dialog = pageA.getByRole('dialog', { name: 'Save to a collection' });
    await expect(dialog.getByRole('button', { name: 'Create account' })).toBeVisible();
    await dialog.locator('.account-prompt__switch').getByRole('button', { name: 'Sign in' }).click();
    await dialog.getByLabel(/^Email/).fill(email);
    await dialog.getByLabel(/^Password/).fill(password);
    await shot(pageA, info, 'claim-03-preview-claim');
    await dialog.locator('.account-prompt__actions').getByRole('button', { name: 'Sign in' }).click();
    const claimResponse = await claimResponsePromise;
    expect(claimResponse.status()).toBe(200);
    const body = (await claimResponse.json()) as {
      claimed: { captures: number; saved_items: number };
      pending_save: { saved_item_id: string } | null;
    };
    // The capture transfers; the overlapping save dedupes (deleted, not counted);
    // the fresh session save is re-owned (counted).
    expect(body.claimed.captures).toBe(1);
    expect(body.claimed.saved_items).toBe(1);
    expect(body.pending_save?.saved_item_id).toBeTruthy();
    await expect(dialog.getByRole('radio', { name: 'Sunday roots' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText('Saved to Sunday roots').first()).toBeVisible();
    const session = await sessionOf(pageA);
    expect(session.principal.kind).toBe('account');
    expect(session.principal.account_id).toBe(accountId);
    await shot(pageA, info, 'claim-04-claimed');
  });

  // Read after the claim transaction: the claim intent targets the revision
  // the merged state committed at (the claim itself bumps nothing); the claim
  // dialog's pending save is the next revision.
  const revisionAtClaim = await tasteRevision(accountId) - 1;
  const pendingSaveRevision = revisionAtClaim + 1;

  await test.step('the claim moved and revoked exactly the prepared material', async () => {
    const capture = await journeyDb().query<{ owner_account_id: string | null; owner_session_id: string | null }>(
      'SELECT owner_account_id, owner_session_id FROM captures WHERE id::text = $1',
      [captureId],
    );
    expect(capture.rows[0]!.owner_account_id).toBe(accountId);
    expect(capture.rows[0]!.owner_session_id).toBeNull();
    expect(
      await scalar(`SELECT count(*) AS n FROM item_exclusions e JOIN discovery_items i ON i.id = e.discovery_item_id
        WHERE e.owner_account_id = $1 AND i.title = $2`, [accountId, FELA]),
    ).toBe(1);
    expect(
      await scalar(
        'SELECT count(*) AS n FROM sessions WHERE id::text = $1 AND claimed_at IS NOT NULL AND revoked_at IS NOT NULL',
        [anonId],
      ),
    ).toBe(1);
    expect(await scalar('SELECT count(*) AS n FROM feed_snapshots WHERE owner_session_id = $1', [anonId])).toBe(0);
    // One canonical endorsement each: the overlap did not double Nina, the
    // transferred save added Amélie, the pending save added the capture card.
    expect(
      await scalar('SELECT count(*) AS n FROM saved_items si JOIN discovery_items i ON i.id = si.discovery_item_id WHERE si.owner_account_id = $1 AND i.canonical_key = $2', [
        accountId,
        'sample:artist-nina-simone',
      ]),
    ).toBe(1);
    expect(
      await scalar('SELECT count(*) AS n FROM saved_items si JOIN discovery_items i ON i.id = si.discovery_item_id WHERE si.owner_account_id = $1 AND i.canonical_key = $2', [
        accountId,
        'sample:film-amelie',
      ]),
    ).toBe(1);
    expect(await scalar('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [accountId])).toBe(6);
  });

  await test.step('the merged state projects once, after the claim', async () => {
    expect(
      await scalar(
        `SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1 AND event_type = 'claim' AND target_taste_revision = $2`,
        [accountId, revisionAtClaim],
      ),
    ).toBe(1);
    const state = await waitForProjectionReady(accountId);
    // The merged projection covers both the claim intent and the pending save.
    expect(state.applied).toBeGreaterThanOrEqual(pendingSaveRevision);
    expect(state.projection_revision).toBeGreaterThan(projectionRevisionBeforeClaim);
    const support = await supportRows(accountId);
    // Exactly one endorsement per canonical save: the three onboarding tiles,
    // the capture card (account-owned, a plain save), and the two shared-row
    // saves (Nina kept through the merge, Amélie transferred by it) as private
    // saved-item support. The hide and the unsaved capture confirm nothing.
    expect(support.filter((r) => r.origin_kind === 'saved_item').length).toBe(6);
    expect(new Set(support.filter((r) => r.pick_id).map((r) => r.pick_id)).size).toBe(3);
    expect(support.filter((r) => r.capture_id)).toHaveLength(0);
    // The claimed shared-row save survives the claim as private account-owned
    // confirmed support: its edge targets the account's own saved_items row,
    // never a forged item owner.
    const ninaSave = await one<{ id: string }>(
      `SELECT si.id FROM saved_items si JOIN discovery_items i ON i.id = si.discovery_item_id
        WHERE si.owner_account_id = $1 AND i.canonical_key = 'sample:artist-nina-simone'`,
      [accountId],
    );
    expect(ninaSave?.id).toBeTruthy();
    const ninaSupport = support.filter((r) => r.saved_item_id === ninaSave!.id && r.origin_kind === 'saved_item');
    expect(ninaSupport).toHaveLength(1);
    expect(ninaSupport[0]!.saved_item_source_id).toBe(ninaSave!.id);
    await shot(pageA, info, 'claim-05-merged-feed');
  });

  const supportAfterClaim = await supportRows(accountId);

  await test.step('a retried claim adds nothing', async () => {
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    trackErrors(pageB, apiErrors);
    const retryResponsePromise = pageB.waitForResponse(
      (r) => r.url().includes('/v1/session/sign-in') && r.request().method() === 'POST',
    );
    await pageB.goto('/settings');
    await expect(pageB.getByRole('heading', { name: 'Sign in or create an account' })).toBeVisible();
    await pageB.locator('.account-prompt__switch').getByRole('button', { name: 'Sign in' }).click();
    await pageB.getByLabel(/^Email/).fill(email);
    await pageB.getByLabel(/^Password/).fill(password);
    await shot(pageB, info, 'claim-06-retry-signin');
    await pageB.locator('.account-prompt__actions').getByRole('button', { name: 'Sign in' }).click();
    const retryResponse = await retryResponsePromise;
    expect(retryResponse.status()).toBe(200);
    const body = (await retryResponse.json()) as { claimed: { captures: number; saved_items: number } };
    expect(body.claimed).toEqual({ captures: 0, saved_items: 0 });
    const session = await sessionOf(pageB);
    expect(session.principal.kind).toBe('account');
    expect(session.principal.account_id).toBe(accountId);
    await expect(pageB.getByRole('heading', { name: 'Your account' })).toBeVisible();

    await waitForProjectionReady(accountId);
    const supportAfterRetry = await supportRows(accountId);
    expect(JSON.stringify(supportAfterRetry)).toBe(JSON.stringify(supportAfterClaim));
    expect(
      await scalar('SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1', [accountId]),
    ).toBe(6);
    await contextB.close();
  });

  await test.step('the old anonymous authority cannot reach the transferred material', async () => {
    const contextC = await browser.newContext();
    await contextC.addCookies(cookiesBeforeClaim);
    const pageC = await contextC.newPage();
    trackErrors(pageC, apiErrors);
    const sessionResponse = await contextC.request.get('/v1/session');
    const session = (await sessionResponse.json()) as { principal: { kind: string; session_id: string } };
    expect(session.principal.kind).toBe('anonymous');
    expect(session.principal.session_id).not.toBe(anonId);
    const captureResponse = await contextC.request.get(`/v1/captures/${captureId}`);
    expect(captureResponse.status()).toBe(404);
    await pageC.goto(capturePath);
    await expect(pageC.getByText('This photo isn’t available. It may have expired or been deleted.')).toBeVisible();
    await shot(pageC, info, 'claim-07-denied-capture');
    await contextC.close();
  });

  await test.step('the owner still sees the transferred capture; nothing was charged', async () => {
    await pageA.goto(capturePath);
    await expect(pageA.getByText('This photo isn’t available. It may have expired or been deleted.')).toHaveCount(0);
    await expect(pageA.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem').first()).toBeVisible();
    await shot(pageA, info, 'claim-08-owner-capture');
    expect(apiErrors, 'no server errors during the journey').toEqual([]);
    expect(await paidModelAttempts()).toBe(paidBefore);
  });
});
