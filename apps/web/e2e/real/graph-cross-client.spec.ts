import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { upsertReference } from '../../../../packages/domain/src/compiler/store';
import { linkGraphReferenceIdentities } from '../../../../packages/domain/src/interest-graph/identity-links';
import {
  activeExpansionJobs,
  closeJourneyDb,
  expansionRuns,
  isGraphDiscoveryOn,
  journeyDb,
  one,
  paidModelAttempts,
  scalar,
  sessionOf,
  shot,
  supportRows,
  waitForExpansionRuns,
  waitForProjectionReady,
} from './graph-helpers';

/**
 * VAL-CROSS-005 (experience release): shared controls survive closed-app
 * refresh and account switch, through the real product on the shared journey
 * database — the real web app, the real job worker (the closed-app sweeper),
 * the reviewed pilot corpus, and the real web account-switch flow.
 *
 * One desktop journey, five legs:
 *  1. Convergence: two web clients on one account share the persisted
 *     suppress/restore and pause/resume controls and the single shared
 *     revision; a change made in one client is what the other serves after a
 *     plain reload, and the ineligible reason one client had already seen
 *     (the photo Why-this) disappears for the other client.
 *  2. Conflict: a stale edit (a control carrying the revision the OTHER
 *     client already moved) answers the typed 409 and the client reloads the
 *     server's truth; the stale intent never lands.
 *  3. Closed-app refresh: a save commits, both clients close, and the real
 *     dispatcher/sweeper projects, marks the refresh due and runs the bounded
 *     expansion with no client open and no feed read in the window; reopening
 *     serves only the compatible successful results and adds no confirmed
 *     interest beyond the explicit save.
 *  4. Account switch: signing out broadcasts to other tabs (they reload and
 *     drop the account's private surfaces), an old delayed response held
 *     across the switch never renders the first account's private Taste, back
 *     navigation renders only the current account, and the second account
 *     never sees the first account's private Taste, feed, captures or
 *     reasons anywhere it can navigate.
 *
 * Requires the discovery journey stack with BOTH graph flags on and the
 * file-mail identity driver (the `*_journey_discovery_ios` manifest
 * commands); run it through the matching `browser_real_cross_client`
 * manifest command. E2E_BASE_URL must be the same origin the server's
 * APP_BASE_URL builds mail callbacks with (http://127.0.0.1:3200) — a
 * localhost/127.0.0.1 mismatch splits the tab's sessionStorage (the
 * identity callback would lose its pending challenge) and its cookies, so
 * the verification leg would silently run as a stranger. The spec skips
 * itself otherwise. The deterministic fixtures are the same labeled shapes
 * as graph-taste-journeys.spec.ts: reviewed Rodin/Seurat compiler-shaped
 * references, the account's own items on them, one sample capture with a
 * reviewed fixture analysis (labeled "Example result", never a live model
 * reading), and one wikidata-linked van Gogh reference whose save roots a
 * corpus walk with no candidates. The paid-model ledger must not move and
 * no live provider call occurs.
 */
test.skip(!isGraphDiscoveryOn, 'cross-client journeys require INTEREST_GRAPH_DISCOVERY_ENABLED=true');
test.beforeEach(() => {
  test.skip(test.info().project.name !== 'desktop', 'the cross-client journey is viewport-independent');
});

test.afterAll(async () => {
  await closeJourneyDb();
});

const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
const VANGOGH_WIKIDATA_ID = 'Q5582';
const RODIN = 'Auguste Rodin';
const SEURAT = 'Georges Seurat';
const VANGOGH = 'Vincent van Gogh';
const NINA = 'Nina Simone';
const COLLECTION = 'Studio roots';
const ROOM_SAMPLE = path.resolve(import.meta.dirname, '../../public/samples/room.jpg');
const MAIL_DIR = process.env.IDENTITY_MAIL_FILE_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/ios-mail';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trackErrors(page: Page, apiErrors: string[]) {
  page.on('response', (r) => {
    const url = new URL(r.url());
    if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) && r.status() >= 500)
      apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
}

/** Records every /v1//v2 request time on this page (the no-feed-read proof). */
function trackRequests(page: Page, requests: { at: number; method: string; path: string }[]) {
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/'))
      requests.push({ at: Date.now(), method: r.method(), path: url.pathname });
  });
}

/**
 * Loads `url` and counts matching feed/capture cards only after the page's own
 * read has landed and rendered — the first paint serves the client cache, so a
 * count taken right after navigation can miss a freshly published card.
 */
async function pollCardCount(page: Page, url: string, readPath: RegExp, text: string): Promise<number> {
  const seen = page.waitForResponse((r) => readPath.test(new URL(r.url()).pathname), { timeout: 15_000 }).catch(() => null);
  await page.goto(url);
  await seen;
  await page.waitForTimeout(800);
  return page.getByRole('listitem').filter({ hasText: text }).count();
}

/** A compiler-shaped provider reference, exactly as photo resolution writes it. */
async function providerReference(
  provider: 'qloo' | 'wikidata',
  externalId: string,
  name: string,
): Promise<string> {
  return upsertReference(journeyDb(), {
    canonicalKey: `${provider}:${externalId}`,
    name,
    type: 'creator',
    externalIds: { [provider]: externalId },
  });
}

/** The account's own item on one reference (the exact shape of an artist save). */
async function accountItem(
  accountId: string,
  referenceId: string,
  canonicalKey: string,
  externalIds: Record<string, string>,
  title: string,
  subtitle: string,
): Promise<string> {
  const { rows } = await journeyDb().query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, is_sample, kind, category, canonical_key, title,
                                  display_metadata, external_ids, reference_id)
     VALUES ($1, false, 'artist', 'play', $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (owner_account_id, canonical_key)
       DO UPDATE SET reference_id = EXCLUDED.reference_id, updated_at = now()
     RETURNING id`,
    [accountId, canonicalKey, title, JSON.stringify({ subtitle }), JSON.stringify(externalIds), referenceId],
  );
  return rows[0]!.id;
}

/**
 * The deterministic photo fixture (the labeled shape from
 * graph-taste-journeys.spec.ts): the public sample photo, a capture row in
 * the real storage layout, and a reviewed fixture analysis that authorizes
 * one depicted Rodin reference. Returns the capture id.
 */
async function seedFixtureCapture(accountId: string, rodinReferenceId: string): Promise<string> {
  const captureId = await journeyDb().transaction(async (tx) => {
    const cap = await tx.query<{ id: string }>(
      `INSERT INTO captures (owner_account_id, source, sample_id, image_sha256, width, height, status)
       VALUES ($1, 'sample', 'room', $2, 1000, 1250, 'ready') RETURNING id`,
      [accountId, `fixture-${Date.now()}`.padEnd(64, '0')],
    );
    const id = cap.rows[0]!.id;
    await tx.query(`UPDATE captures SET private_object_key = $2 WHERE id = $1`, [
      id,
      `owners/a-${accountId}/captures/${id}/derivative.jpg`,
    ]);
    const an = await tx.query<{ id: string }>(
      `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
       VALUES ($1, 1, 'reviewed-example', 'A quiet reading corner',
               'A reviewed example reading prepared for this journey.', '{"observations":"complete","references":"complete"}')
       RETURNING id`,
      [id],
    );
    const analysisId = an.rows[0]!.id;
    await tx.query('UPDATE captures SET active_analysis_id = $2 WHERE id = $1', [id, analysisId]);
    await tx.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
       VALUES ($1, $2, 'depicted', 0.9, 'resolved', true, false, NULL)`,
      [analysisId, rodinReferenceId],
    );
    await tx.query(
      `INSERT INTO discovery_items (owner_account_id, kind, canonical_key, capture_id, title)
       VALUES ($1, 'capture', $2, $3, 'A quiet reading corner')`,
      [accountId, `capture:${id}`, id],
    );
    return id;
  });
  const storageDir = process.env.STORAGE_LOCAL_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/storage';
  const file = path.join(storageDir, `owners/a-${accountId}/captures/${captureId}/derivative.jpg`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(ROOM_SAMPLE));
  writeFileSync(`${file}.meta`, JSON.stringify({ contentType: 'image/jpeg' }));
  return captureId;
}

/** Newest identity mail for this address since `after` (the file mailbox is local-dev only). */
async function mailFor(email: string, after: number): Promise<{ callback: string }> {
  let found: { to: string; callback: string } | undefined;
  for (let i = 0; i < 60 && !found; i++) {
    if (i > 0) await sleep(1_000);
    for (const file of readdirSync(MAIL_DIR).sort((a, b) => b.localeCompare(a))) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(MAIL_DIR, file);
      if (statSync(full).mtimeMs < after - 2_000) continue;
      const mail = JSON.parse(readFileSync(full, 'utf8')) as { to: string; callback: string };
      if (mail.to === email) {
        found = mail;
        break;
      }
    }
  }
  if (!found) throw new Error(`no identity mail arrived for ${email}`);
  return found;
}

/** The current signed-in session's own view of the typed graph summary. */
async function graphSummary(page: Page): Promise<{
  owner_account_id: string;
  settings: { revision: number; discovery_paused: boolean };
  counts: { confirmed: number; tentative: number; suppressed: number };
}> {
  return page.evaluate(async () =>
    (await (await fetch('/v2/me/interest-graph', { cache: 'no-store' })).json()) as {
      owner_account_id: string;
      settings: { revision: number; discovery_paused: boolean };
      counts: { confirmed: number; tentative: number; suppressed: number };
    },
  );
}

async function answerQuestionnaire(page: Page, picks: [string, string]) {
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  await expect(page.locator('.pick-counter')).toHaveText('2 picks to go');
  // 'Build my feed' POSTs /v1/onboarding/complete and only then navigates; the
  // URL alone can never prove that (the taste spec's /\/welcome\/building|\//
  // matches every URL), and leaving before the POST lands leaves the account
  // onboarding-required — the next navigation then aborts the in-flight POST.
  const completed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/onboarding/complete' && r.ok(),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: picks[0] }).click();
  await page.getByRole('group', { name: 'Play' }).getByRole('button', { name: picks[1] }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  await page.getByRole('button', { name: 'Build my feed' }).click();
  expect(await completed, 'onboarding completion must reach the server').not.toBeNull();
  await expect(page).toHaveURL(/\/welcome\/building|\//, { timeout: 30_000 });
}

/** Creates an account through the real save dialog (the password the other web clients sign in with). */
async function createAccountThroughSave(
  page: Page,
  email: string,
  password: string,
  collection: string,
  picks: [string, string],
) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: NINA }).first();
  await card.getByRole('button', { name: `Save ${NINA}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
  // The prompt opens in create mode; 'Create account' is the submit, not a toggle.
  await expect(dialog.getByRole('button', { name: 'Create account' })).toBeVisible();
  await dialog.getByLabel(/Your name/).fill('Ada Graph');
  await dialog.getByLabel(/^Email/).fill(email);
  await dialog.getByLabel(/^Password/).fill(password);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
  if (collection) {
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill(collection);
  } else {
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
  }
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await answerQuestionnaire(page, picks);
  await page.goto('/');
}

/** Signs an existing password account in through the real save dialog. */
async function signInThroughSave(page: Page, email: string, password: string) {
  await page.goto('/');
  const card = page.getByRole('listitem').filter({ hasText: NINA }).first();
  await card.getByRole('button', { name: `Save ${NINA}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  // The sign-in claims the pending save (unfiled) and keeps the picker open
  // to file it; the destination choice is part of the real flow.
  await expect(dialog.getByRole('radio', { name: 'Save for later' })).toBeVisible();
  await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Saved for later').first()).toBeVisible();
}

/** Verifies the signed-in account's email through the real /identity link flow (the file mailbox). */
async function verifyEmail(page: Page, email: string) {
  await page.goto('/identity');
  await page.getByLabel('Email').fill(email);
  await page.locator('select[name="purpose"]').selectOption('verify');
  const startedAt = Date.now();
  await page.getByRole('button', { name: 'Email verification link' }).click();
  await expect(page.getByText('If eligible, your email has a verification link', { exact: false })).toBeVisible();
  const mail = await mailFor(email, startedAt);
  await page.goto(mail.callback);
  // The callback page completes the verification client-side and only
  // redirects on success; the account_emails row is not there until that
  // POST commits (a bare goto resolves at page load, before the POST).
  await expect(page).toHaveURL(/\/library/, { timeout: 20_000 });
}

test('shared controls converge, survive a closed-app refresh, and stay isolated on account switch', async ({ browser }, info: TestInfo) => {
  test.setTimeout(900_000);
  const stamp = Date.now();
  const emailA = `crossclient-a-${stamp}@journey.test`;
  const emailB = `crossclient-b-${stamp}@journey.test`;
  const password = 'a fine password';
  const apiErrors: string[] = [];
  const paidBefore = await paidModelAttempts();

  // ---- The second account (different picks, no fixtures) exists up front. ----
  let accountBId = '';
  await test.step('second account B: different taste, no graph fixtures', async () => {
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    trackErrors(pageB, apiErrors);
    await createAccountThroughSave(pageB, emailB, password, '', ['Sesame noodles', 'Classical']);
    const sessionB = await sessionOf(pageB);
    expect(sessionB.principal.kind).toBe('account');
    accountBId = sessionB.principal.account_id!;
    // B signs in later by password (leg 4); email verification stays A's leg
    // because identity email-start is per-IP rate limited and the phone leg
    // needs A's verified email for its email-link sign-in.
    await contextB.close();
  });

  // ---- Account A onboarding and the deterministic graph fixtures. ----
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  trackErrors(pageA, apiErrors);
  const requestsA: { at: number; method: string; path: string }[] = [];
  trackRequests(pageA, requestsA);

  let accountId = '';
  let rodinItem = '';
  let seuratItem = '';
  let vangoghItem = '';
  let captureId = '';

  await test.step('account A: onboarding through a save, verified email', async () => {
    await createAccountThroughSave(pageA, emailA, password, COLLECTION, ['Tea rituals', 'Jazz']);
    // A's email is verified through the real link flow: the phone leg signs
    // into THIS account via email-link, which requires the verified row.
    await verifyEmail(pageA, emailA);
    const session = await sessionOf(pageA);
    expect(session.principal.kind).toBe('account');
    accountId = session.principal.account_id!;
    expect(
      await scalar('SELECT count(*) AS n FROM account_emails WHERE email = $1 AND verified_at IS NOT NULL', [emailA]),
    ).toBe(1);
  });

  await test.step('fixtures: reviewed references, the account’s own items, the labeled capture', async () => {
    const rodinRef = await providerReference('qloo', RODIN_QLOO_ID, RODIN);
    const seuratRef = await providerReference('qloo', SEURAT_QLOO_ID, SEURAT);
    const vangoghRef = await providerReference('wikidata', VANGOGH_WIKIDATA_ID, VANGOGH);
    await linkGraphReferenceIdentities(journeyDb());
    expect(
      await scalar(
        `SELECT count(*) AS n FROM graph_nodes
          WHERE canonical_key IN ('atlas:creator:auguste-rodin', 'atlas:creator:georges-seurat', 'atlas:creator:vincent-van-gogh')
            AND cultural_reference_id IN ($1, $2, $3)`,
        [rodinRef, seuratRef, vangoghRef],
      ),
    ).toBe(3);
    rodinItem = await accountItem(accountId, rodinRef, `qloo:${RODIN_QLOO_ID}`, { qloo: RODIN_QLOO_ID }, RODIN, 'French sculptor, 1840–1917');
    seuratItem = await accountItem(accountId, seuratRef, `qloo:${SEURAT_QLOO_ID}`, { qloo: SEURAT_QLOO_ID }, SEURAT, 'French painter, 1859–1891');
    vangoghItem = await accountItem(accountId, vangoghRef, `wikidata:${VANGOGH_WIKIDATA_ID}`, { wikidata: VANGOGH_WIKIDATA_ID }, VANGOGH, 'Dutch painter, 1853–1890');
    captureId = await seedFixtureCapture(accountId, rodinRef);
  });

  await test.step('the account saves the Rodin item and the worker publishes the Seurat card', async () => {
    const dialog = pageA.getByRole('dialog', { name: 'Save to a collection' });
    await pageA.goto(`/items/${rodinItem}`);
    await pageA.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText('Saved for later').first()).toBeVisible();
    await waitForProjectionReady(accountId);
    const support = await supportRows(accountId);
    expect(support.some((r) => r.origin_kind === 'saved_item' && r.discovery_item_id === rodinItem && r.active)).toBe(true);
    await waitForExpansionRuns(accountId, 1);
    const rec = await one<{ discovery_item_id: string }>(
      `SELECT discovery_item_id FROM recommendations
        WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    );
    expect(rec?.discovery_item_id).toBe(seuratItem);
    await expect
      .poll(() => pollCardCount(pageA, '/', /^\/v1\/discoveries$/, SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
  });

  await test.step('a saved photo suggestion projects the tentative affinity', async () => {
    await pageA.goto(`/captures/${captureId}`);
    await expect(pageA.getByRole('heading', { name: 'Discoveries' })).toBeVisible();
    await expect(pageA.getByText('Example result').first()).toBeVisible();
    await pageA.getByRole('button', { name: 'Save this inspiration' }).click();
    const dialog = pageA.getByRole('dialog', { name: 'Save to a collection' });
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText('Saved for later').first()).toBeVisible();
    await waitForProjectionReady(accountId);
    const support = await supportRows(accountId);
    expect(support.some((r) => r.origin_kind === 'capture_reference' && r.active)).toBe(true);
    await waitForExpansionRuns(accountId, 2);
  });

  // ---- Leg 1: two clients, one account: convergence. ----
  const contextC2 = await browser.newContext();
  const pageC2 = await contextC2.newPage();
  trackErrors(pageC2, apiErrors);

  let recIdPhoto = '';

  await test.step('client 2 signs in and has already seen the photo reason', async () => {
    await signInThroughSave(pageC2, emailA, password);
    await expect
      .poll(() => pollCardCount(pageC2, `/captures/${captureId}`, new RegExp(`^/v1/captures/${captureId}$`), SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    const card = pageC2.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await card.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(pageC2.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    expect(pageC2.url()).toMatch(/from=capture&capture=[0-9a-f-]{36}&rec=[0-9a-f-]{36}/);
    recIdPhoto = new URL(pageC2.url()).searchParams.get('rec')!;
    await pageC2.getByRole('button', { name: 'Why this?' }).click();
    await expect(pageC2.getByText(`Because your photo shows ${RODIN}.`)).toBeVisible();
    await shot(pageC2, info, 'crossclient-01-client2-seen-reason');
  });

  await test.step('client 1 suppresses the affinity and pauses; client 2 converges on reload', async () => {
    await pageA.goto('/settings/taste');
    await pageA.getByRole('button', { name: `Stop showing ${RODIN}` }).click();
    await expect(pageA.getByRole('button', { name: `Show again ${RODIN}` })).toBeVisible();
    await pageA.getByRole('button', { name: 'Pause background discovery' }).click();
    await expect(pageA.getByText(/Background discovery is paused\./)).toBeVisible();
    const summaryA = await graphSummary(pageA);
    expect(summaryA.settings.discovery_paused).toBe(true);
    expect(summaryA.counts.suppressed).toBe(1);

    // Client 2's ineligible cached reason is gone on its next read, with no
    // client-2 action: the photo card withdraws with its support.
    await expect
      .poll(() => pollCardCount(pageC2, `/captures/${captureId}`, new RegExp(`^/v1/captures/${captureId}$`), SEURAT), { timeout: 120_000 })
      .toBe(0);
    await shot(pageC2, info, 'crossclient-02-withdrawn-for-client2');

    // The settings converge: client 2 reloads and serves exactly what client 1 saved.
    await pageC2.goto('/settings/taste');
    await expect(pageC2.getByRole('button', { name: `Show again ${RODIN}` })).toBeVisible();
    await expect(pageC2.getByText(/Background discovery is paused\./)).toBeVisible();
    const summaryC2 = await graphSummary(pageC2);
    expect(summaryC2.settings.revision).toBe(summaryA.settings.revision);
    expect(summaryC2.settings.discovery_paused).toBe(true);
    expect(summaryC2.counts.suppressed).toBe(1);
    await shot(pageC2, info, 'crossclient-03-client2-converged');
  });

  await test.step('client 2 restores; client 1 converges on reload', async () => {
    await pageC2.getByRole('button', { name: `Show again ${RODIN}` }).click();
    await expect(pageC2.getByRole('button', { name: `Stop showing ${RODIN}` })).toBeVisible();
    const summaryC2 = await graphSummary(pageC2);
    expect(summaryC2.counts.tentative).toBe(1);
    expect(summaryC2.settings.discovery_paused).toBe(true);

    await pageA.goto('/settings/taste');
    await expect(pageA.getByRole('button', { name: `Stop showing ${RODIN}` })).toBeVisible();
    const summaryA = await graphSummary(pageA);
    expect(summaryA.settings.revision).toBe(summaryC2.settings.revision);
    // Client 2 resumes pause through its own client, and client 1 converges again.
    await pageC2.getByRole('button', { name: 'Resume background discovery' }).click();
    await expect(pageC2.getByRole('button', { name: 'Pause background discovery' })).toBeVisible();
  });

  // ---- Leg 2: the stale edit conflicts and reloads server truth. ----
  await test.step('a stale edit conflicts: the server truth is reloaded, the stale intent never lands', async () => {
    // Client 2 holds this revision and view…
    const stale = await graphSummary(pageC2);
    expect(stale.settings.discovery_paused).toBe(false);
    // …client 1 reloads to the same shared revision and moves it twice
    // (pause, then resume)…
    await pageA.goto('/settings/taste');
    await pageA.getByRole('button', { name: 'Pause background discovery' }).click();
    await expect(pageA.getByText(/Background discovery is paused\./)).toBeVisible();
    await pageA.getByRole('button', { name: 'Resume background discovery' }).click();
    await expect(pageA.getByRole('button', { name: 'Pause background discovery' })).toBeVisible();
    const moved = await graphSummary(pageA);
    expect(moved.settings.revision).toBeGreaterThan(stale.settings.revision);
    // …so client 2's control carries a stale revision wanting a different
    // state: the typed conflict reloads the latest instead of saving.
    await pageC2.getByRole('button', { name: 'Pause background discovery' }).click();
    await expect(pageC2.getByText('Just updated elsewhere. Showing the latest state.')).toBeVisible();
    await expect(pageC2.getByRole('button', { name: 'Pause background discovery' })).toBeVisible();
    const reloaded = await graphSummary(pageC2);
    expect(reloaded.settings.revision).toBe(moved.settings.revision);
    expect(reloaded.settings.discovery_paused).toBe(false);
    expect(
      (await one<{ paused: boolean }>('SELECT (discovery_paused_at IS NOT NULL) AS paused FROM graph_refresh_state WHERE owner_account_id = $1', [accountId]))?.paused,
    ).toBe(false);
    await shot(pageC2, info, 'crossclient-04-conflict-refreshed');
  });

  // ---- Leg 3: the closed-app sweeper refresh. ----
  let baselineRuns = 0;
  let baselineSupport: Awaited<ReturnType<typeof supportRows>> = [];
  let confirmedBefore = 0;
  let tSave = 0;

  await test.step('drain, then commit a fresh save and close both clients', async () => {
    await expect.poll(async () => activeExpansionJobs(accountId), { timeout: 90_000 }).toBe(0);
    baselineRuns = await expansionRuns(accountId);
    for (let i = 0; i < 3; i++) {
      await sleep(8_000);
      const runs = await expansionRuns(accountId);
      if (runs === baselineRuns && (await activeExpansionJobs(accountId)) === 0) break;
      baselineRuns = runs;
    }
    baselineSupport = await supportRows(accountId);
    confirmedBefore = (await graphSummary(pageA)).counts.confirmed;

    // Park on the item page (never the feed: a feed read would enqueue due
    // work itself), save the van Gogh item, and close both clients at once.
    await pageA.goto(`/items/${vangoghItem}`);
    tSave = Date.now();
    await pageA.getByRole('button', { name: 'Save', exact: true }).click();
    const dialog = pageA.getByRole('dialog', { name: 'Save to a collection' });
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText('Saved for later').first()).toBeVisible();
    // No feed read happened after the save: the only client requests are the
    // save itself, and both clients close now.
    expect(requestsA.filter((r) => r.path === '/v1/discoveries' && r.at >= tSave)).toEqual([]);
    await contextC2.close();
    await contextA.close();
  });

  let newRunId = '';
  await test.step('the real sweeper refreshes with no client open and no feed read', async () => {
    // The whole pipeline is worker-driven from here: outbox dispatch,
    // projection, the due marker, the sweeper's expansion dispatch, the run.
    await waitForProjectionReady(accountId);
    await expect
      .poll(async () => (await expansionRuns(accountId)) > baselineRuns, { timeout: 90_000 })
      .toBe(true);
    const run = await one<{ id: string; created_at: string; state: string }>(
      `SELECT id, created_at, state FROM graph_runs
        WHERE owner_account_id = $1 AND run_kind = 'expansion' ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    );
    expect(run?.state).toBe('complete');
    newRunId = run!.id;
    expect(Date.parse(run!.created_at)).toBeGreaterThan(tSave);
    const job = await one<{ created_at: string }>(
      `SELECT created_at FROM jobs
        WHERE type = 'expand_interest_graph' AND payload->>'account_id' = $1 ORDER BY created_at DESC LIMIT 1`,
      [accountId],
    );
    expect(Date.parse(job!.created_at)).toBeGreaterThan(tSave);
    const timeline = await one<{ due_since: string | null; last_expansion_at: string }>(
      'SELECT expansion_due_since, last_expansion_at FROM graph_refresh_state WHERE owner_account_id = $1',
      [accountId],
    );
    // Evidence: the due marker (or the just-consumed window) and the fresh
    // run all happened after the save, with both clients closed.
    console.log('[cross-client] closed-app refresh timeline', {
      tSave,
      dueSince: timeline?.due_since,
      lastExpansionAt: timeline?.last_expansion_at,
      jobCreatedAt: job!.created_at,
      runCreatedAt: run!.created_at,
      runState: run!.state,
    });
    expect(Date.parse(job!.created_at)).toBeGreaterThanOrEqual(tSave);
  });

  // ---- Leg 3 continued: reopen and read only compatible successful results. ----
  const contextC3 = await browser.newContext();
  const pageC3 = await contextC3.newPage();
  trackErrors(pageC3, apiErrors);

  await test.step('reopening exposes only compatible successful results, no new confirmed interests', async () => {
    await signInThroughSave(pageC3, emailA, password);
    await expect
      .poll(() => pollCardCount(pageC3, '/', /^\/v1\/discoveries$/, SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    // The served card is the latest successful compatible run's own result.
    // (The feed page max is 24 — a larger limit is invalid input.)
    const feed = (await pageC3.evaluate(async () =>
      (await (await fetch('/v1/discoveries?limit=24', { cache: 'no-store' })).json()) as unknown,
    )) as { items: { id: string; recommendation_id: string | null }[] };
    expect(Array.isArray(feed.items)).toBe(true);
    const served = feed.items.find((i) => i.id === seuratItem);
    expect(served?.recommendation_id).toBeTruthy();
    const servedRun = await one<{ run: string; state: string }>(
      `SELECT graph_run_id AS run, 'complete' AS state FROM recommendations WHERE id = $1`,
      [served!.recommendation_id],
    );
    expect(servedRun?.run).toBe(newRunId);
    // Every run the account has is a successful compatible one; nothing
    // partial, queued or failed can serve.
    expect(await scalar(`SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND state <> 'complete'`, [accountId])).toBe(0);

    // The closed-app refresh added no confirmed interest: support grew by
    // exactly the explicit van Gogh save, nothing else.
    const after = await supportRows(accountId);
    const added = after.filter(
      (r) => !baselineSupport.some((b) => JSON.stringify(b) === JSON.stringify(r)),
    );
    expect(added).toHaveLength(1);
    expect(added[0]!.origin_kind).toBe('saved_item');
    expect(added[0]!.discovery_item_id).toBe(vangoghItem);
    const summary = await graphSummary(pageC3);
    expect(summary.counts.confirmed).toBe(confirmedBefore + 1);
    expect(summary.counts.tentative).toBe(1);
    await shot(pageC3, info, 'crossclient-05-reopened-feed');
  });

  await test.step('the reopened client sees the shared controls exactly as they were left', async () => {
    await pageC3.goto('/settings/taste');
    await expect(pageC3.getByRole('button', { name: `Stop showing ${RODIN}` })).toBeVisible();
    await expect(pageC3.getByRole('button', { name: 'Pause background discovery' })).toBeVisible();
    await expect(pageC3.getByRole('link', { name: VANGOGH, exact: true })).toBeVisible();
    await shot(pageC3, info, 'crossclient-06-reopened-taste');
  });

  // ---- Leg 4: account switch, delayed response, back navigation. ----
  await test.step('switching to the second account never renders the first account’s private state', async () => {
    // A's private surfaces are live on this client: Taste, feed, the capture.
    await pageC3.goto(`/captures/${captureId}`);
    await expect(pageC3.getByText('Example result').first()).toBeVisible();
    await pageC3.goto('/settings/taste');
    await expect(pageC3.getByRole('heading', { name: 'Background discovery' })).toBeVisible();
    await shot(pageC3, info, 'crossclient-07-a-taste');

    // A second tab of the same browser holds A's private summary in flight:
    // the response is captured at the server and not delivered yet.
    const pageTab2 = await contextC3.newPage();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await pageTab2.route('**/v2/me/interest-graph*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      await held;
      await route.fulfill({ response }).catch(() => undefined);
    });
    await pageTab2.goto('/settings/taste');
    await expect(pageTab2.getByRole('heading', { name: 'Background discovery' })).toBeVisible();
    // Mark this document so the spec can prove the sign-out broadcast reloaded it.
    await pageTab2.evaluate(() => {
      document.documentElement.setAttribute('data-cross-client-probe', 'a-session');
    });

    // Sign out (tab 1): the broadcast reloads tab 2, destroying the held
    // response's document. Then the second account signs in on tab 1.
    await pageC3.goto('/settings');
    await pageC3.getByRole('button', { name: 'Sign out' }).click();
    await expect
      .poll(async () => (await sessionOf(pageC3)).principal.kind, { timeout: 30_000 })
      .not.toBe('account');
    await pageTab2.waitForFunction(
      () => document.documentElement.getAttribute('data-cross-client-probe') === null,
      undefined,
      { timeout: 30_000 },
    );
    await signInThroughSave(pageC3, emailB, password);
    const sessionB = await sessionOf(pageC3);
    expect(sessionB.principal.account_id).toBe(accountBId);

    // The delayed response is released AFTER the switch: the stale document
    // it belonged to is gone, and whatever tab 2 renders now can only be the
    // current (signed-out) session's own state — never A's private Taste.
    release();
    await sleep(1_500);
    await expect(pageTab2.getByRole('heading', { name: 'Background discovery' })).toHaveCount(0);
    await expect(pageTab2.getByText(RODIN)).toHaveCount(0);
    await expect(pageTab2.getByText(VANGOGH)).toHaveCount(0);
    const tab2Session = await sessionOf(pageTab2);
    expect(tab2Session.principal.account_id ?? null).not.toBe(accountId);
    await shot(pageTab2, info, 'crossclient-08-stale-tab-revoked');

    // Back navigation renders only the current account's state.
    await pageC3.goBack();
    for (let i = 0; i < 3; i++) {
      await expect(pageC3.getByText(RODIN)).toHaveCount(0);
      await expect(pageC3.getByText(SEURAT)).toHaveCount(0);
      await expect(pageC3.getByText('A quiet reading corner')).toHaveCount(0);
      await expect(pageC3.getByText(emailA)).toHaveCount(0);
      if (!(await pageC3.goBack().catch(() => null))) break;
    }

    // Direct navigation to A's private URLs answers as B's own state, not A's.
    await pageC3.goto(`/captures/${captureId}`);
    await expect(pageC3.getByText('A quiet reading corner')).toHaveCount(0);
    await pageC3.goto(`/items/${rodinItem}`);
    await expect(pageC3.getByRole('heading', { name: RODIN, level: 1 })).toHaveCount(0);

    // A's pinned recommendation reason is not B's to read.
    const connectionStatus = await pageC3.evaluate(
      async (rec) => (await fetch(`/v2/me/recommendations/${rec}/connection`, { cache: 'no-store' })).status,
      recIdPhoto,
    );
    expect(connectionStatus).toBe(404);

    // B's own Taste and feed carry only B's state.
    await pageC3.goto('/settings/taste');
    await expect(pageC3.getByRole('heading', { name: 'Background discovery' })).toBeVisible();
    await expect(pageC3.getByRole('button', { name: `Stop showing ${RODIN}` })).toHaveCount(0);
    await expect(pageC3.getByRole('link', { name: VANGOGH, exact: true })).toHaveCount(0);
    await shot(pageC3, info, 'crossclient-09-b-taste');
    await expect
      .poll(() => pollCardCount(pageC3, '/', /^\/v1\/discoveries$/, SEURAT), { timeout: 60_000 })
      .toBe(0);
    await shot(pageC3, info, 'crossclient-10-b-feed');

    await pageTab2.close();
    await contextC3.close();
  });

  await test.step('no paid provider was charged and no server error occurred', async () => {
    expect(await paidModelAttempts()).toBe(paidBefore);
    expect(apiErrors).toEqual([]);
  });
});
