import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
 * VAL-CROSS-002/003 + VAL-FEED-001/003, discovery phase: the whole
 * onboarding-to-source-backed-discovery journey through the real product on
 * the shared journey database — the real web app, the real job worker, the
 * reviewed pilot corpus — with both Why-this disclosures (feed and photo),
 * the ordinary save/remove/Undo/hide cycle, and the Settings → Taste
 * background-discovery controls (suppress/restore and pause/resume).
 *
 * The deterministic fixtures, clearly labeled:
 *  - the reviewed Rodin/Seurat compiler-shaped references and the account's
 *    own items on them (the exact shapes of the domain's default corpus path);
 *  - one sample capture whose reviewed fixture analysis authorizes one
 *    depicted Rodin reference. It is NOT a live model reading: the capture
 *    page shows the honest "Example result" label, and the paid-model ledger
 *    must not move. The journey proves a deterministic card and its proof,
 *    never a live model qualification.
 *
 * The reviewed path the card rides: Rodin → DOCUMENTED_ASSOCIATION
 * (work_on_display_at) → Art Institute of Chicago ← Seurat, with the AIC
 * "Adam" collection record as the permitted evidence link.
 *
 * Requires the journey stack started with INTEREST_GRAPH_PROJECTION_ENABLED=true
 * AND INTEREST_GRAPH_DISCOVERY_ENABLED=true (web and worker — the
 * `*_journey_discovery` manifest commands); the spec skips itself otherwise.
 */
test.skip(!isGraphDiscoveryOn, 'taste journeys require INTEREST_GRAPH_DISCOVERY_ENABLED=true');

test.afterAll(async () => {
  await closeJourneyDb();
});

const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
const RODIN = 'Auguste Rodin';
const SEURAT = 'Georges Seurat';
const NINA = 'Nina Simone';
const FELA = 'Fela Kuti';
const COLLECTION = 'Studio roots';
const ROOM_SAMPLE = path.resolve(import.meta.dirname, '../../public/samples/room.jpg');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function trackErrors(page: Page, apiErrors: string[]) {
  page.on('response', (r) => {
    const url = new URL(r.url());
    if ((url.pathname.startsWith('/v1/') || url.pathname.startsWith('/v2/')) && r.status() >= 500)
      apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
}

/** A compiler-shaped Qloo person reference, exactly as photo resolution writes it. */
async function qlooPersonReference(qlooId: string, name: string): Promise<string> {
  return upsertReference(journeyDb(), {
    canonicalKey: `qloo:${qlooId}`,
    name,
    type: 'creator',
    externalIds: { qloo: qlooId, qloo_types: ['urn:entity:person'] },
  });
}

/** The account's own item on one reference (the exact shape of an artist save). */
async function accountItem(
  accountId: string,
  referenceId: string,
  qlooId: string,
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
    [accountId, `qloo:${qlooId}`, title, JSON.stringify({ subtitle }), JSON.stringify({ qloo: qlooId }), referenceId],
  );
  return rows[0]!.id;
}

/**
 * The deterministic photo fixture: the public sample photo, a capture row in
 * the real storage layout, and a reviewed fixture analysis that authorizes
 * one depicted Rodin reference (resolved, non-text-only — the same support
 * shape a real analysis writes). Returns the capture id.
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
  // The sample photo's real bytes, in the exact key the media read serves.
  const storageDir = process.env.STORAGE_LOCAL_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/storage';
  const file = path.join(storageDir, `owners/a-${accountId}/captures/${captureId}/derivative.jpg`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(ROOM_SAMPLE));
  writeFileSync(`${file}.meta`, JSON.stringify({ contentType: 'image/jpeg' }));
  return captureId;
}

async function answerQuestionnaire(page: Page, info: TestInfo) {
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 20_000 });
  await expect(page.locator('.pick-counter')).toHaveText('2 picks to go');
  await page.getByRole('button', { name: 'Tea rituals' }).click();
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('group', { name: 'Play' }).getByRole('button', { name: 'Jazz' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  if (info.project.name !== 'desktop') await page.getByRole('button', { name: 'Next', exact: true }).click();
  // 'Build my feed' POSTs /v1/onboarding/complete and only then navigates, so
  // the real post-build proof is the server's own truth, not a URL pattern:
  // a loose alternation like /\/welcome\/building|\// accepts every URL and
  // the earlier green run therefore did not actually verify the build landed.
  const completed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/onboarding/complete' && r.ok(),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Build my feed' }).click();
  expect((await completed).status(), 'onboarding completion must reach the server').toBe(200);
  // Server truth before anything else navigates: the account is no longer
  // onboarding-required.
  const state = (await (await page.request.get('/v1/onboarding/state')).json()) as {
    state: { required: boolean };
  };
  expect(state.state.required).toBe(false);
  // The concrete post-build navigation: the building screen, which then
  // auto-advances to the Discover root. Anchored end-to-end so no unrelated
  // route can satisfy it.
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/(welcome\/building)?$/, { timeout: 30_000 });
}

test('onboarding to source-backed discovery with reversible saves and honest taste controls', async ({ browser }, info: TestInfo) => {
  test.setTimeout(420_000);
  const email = `graph-taste-${info.project.name}-${Date.now()}@example.com`;
  const password = 'a fine password';
  const apiErrors: string[] = [];
  const paidBefore = await paidModelAttempts();

  const context = await browser.newContext();
  const page = await context.newPage();
  trackErrors(page, apiErrors);

  const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
  const toast = page.locator('.toast');
  const undo = () => toast.getByRole('button', { name: 'Undo' });

  await test.step('onboarding: create the account through a save, pick, build the feed', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    const ninaCard = page
      .getByRole('listitem')
      .filter({ hasText: NINA })
      .first();
    await ninaCard.getByRole('button', { name: `Save ${NINA}` }).click();
    await expect(dialog.getByRole('button', { name: 'Create account' })).toBeVisible();
    await dialog.getByLabel(/Your name/).fill('Ada Graph');
    await dialog.getByLabel(/^Email/).fill(email);
    await dialog.getByLabel(/^Password/).fill(password);
    await dialog.getByRole('button', { name: 'Create account' }).click();
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill(COLLECTION);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
    await answerQuestionnaire(page, info);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
  });

  const session = await sessionOf(page);
  expect(session.principal.kind).toBe('account');
  const accountId = session.principal.account_id!;

  let rodinItem = '';
  let seuratItem = '';

  await test.step('fixtures: the reviewed references and the account’s own items on them', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    const seuratRef = await qlooPersonReference(SEURAT_QLOO_ID, SEURAT);
    // The corpus landed before these references existed; the idempotent
    // verified-linkage pass (the same pass corpus admission runs) binds both
    // compiler-shaped references to their reviewed corpus identities durably.
    await linkGraphReferenceIdentities(journeyDb());
    expect(
      await scalar(
        `SELECT count(*) AS n FROM graph_nodes
          WHERE canonical_key IN ('atlas:creator:auguste-rodin', 'atlas:creator:georges-seurat')
            AND cultural_reference_id IN ($1, $2)`,
        [rodinRef, seuratRef],
      ),
    ).toBe(2);
    rodinItem = await accountItem(accountId, rodinRef, RODIN_QLOO_ID, RODIN, 'French sculptor, 1840–1917');
    seuratItem = await accountItem(accountId, seuratRef, SEURAT_QLOO_ID, SEURAT, 'French painter, 1859–1891');
  });

  await test.step('save the Rodin item through the item page', async () => {
    await page.goto(`/items/${rodinItem}`);
    await expect(page.getByRole('heading', { name: RODIN, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: COLLECTION }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
  });

  await test.step('the worker projects the save onto a confirmed root', async () => {
    await waitForProjectionReady(accountId);
    const support = await supportRows(accountId);
    // The Rodin save projects as one confirmed explicit root (an account-owned
    // item edge; the expansion walks its reviewed reference to the node).
    expect(support.some((r) => r.origin_kind === 'saved_item' && r.discovery_item_id === rodinItem && r.active)).toBe(true);
  });

  await test.step('expansion publishes the source-backed Seurat card into the feed', async () => {
    await waitForExpansionRuns(accountId, 1);
    // The published card is the account's own item on the candidate reference,
    // carrying the reviewed association as its reason. The first COMPLETED
    // expansion run may already be the pre-save pick-roots pass (the sweep
    // dispatches as soon as onboarding picks project as support), so the run
    // count alone cannot prove the save's pass published; poll for the
    // published recommendation row itself, bounded like the card wait below.
    await expect
      .poll(
        () =>
          one<{ discovery_item_id: string; display_reason: string; origin: string }>(
            `SELECT discovery_item_id, display_reason, origin FROM recommendations
              WHERE owner_account_id = $1 AND graph_run_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
            [accountId],
          ),
        { timeout: 120_000 },
      )
      .toEqual({
        discovery_item_id: seuratItem,
        display_reason: 'Also work on display at Art Institute of Chicago',
        origin: 'catalog',
      });
    await expect
      .poll(() => pollCardCount(page, '/', /^\/v1\/discover$/, SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    await shot(page, info, 'taste-01-feed-card');
  });

  await test.step('the feed disclosure shows the pinned personal proof', async () => {
    const card = page.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await card.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    // The feed card's recommendation context rides the link (the disclosure reads it).
    expect(page.url()).toMatch(/from=discover&rec=[0-9a-f-]{36}/);
    // The graph card has no legacy why-this; exactly one disclosure serves it.
    await expect(page.getByRole('button', { name: 'Why this?' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(page.getByText('Also work on display at Art Institute of Chicago')).toBeVisible();
    await expect(page.getByText(`Because you saved ${RODIN}.`)).toBeVisible();
    await expect(page.getByText(`${RODIN} — work on display at — Art Institute of Chicago`)).toBeVisible();
    const source = page.getByRole('link', { name: 'Adam — The Art Institute of Chicago' });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', 'https://www.artic.edu/artworks/11320');
    await expect(page.getByText(/The Art Institute of Chicago · collection record/).first()).toBeVisible();
    await shot(page, info, 'taste-02-why-this-personal');
  });

  await test.step('ordinary save/undo/remove/undo/hide keep support reversible', async () => {
    // Save to a new collection, then undo it.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill('Sunday painters');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved to Sunday painters').first()).toBeVisible();
    await undo().click();
    await expect(page.getByText('Removed from Sunday painters').first()).toBeVisible();
    // Save for later, then remove through the saved control, undo, remove again.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved for later').first()).toBeVisible();
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    await dialog.getByRole('button', { name: 'Unsave everywhere' }).click();
    await expect(page.getByText('Removed from your saves').first()).toBeVisible();
    await undo().click();
    await expect(page.getByText('Saved again').first()).toBeVisible();
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    await dialog.getByRole('button', { name: 'Unsave everywhere' }).click();
    await expect(page.getByText('Removed from your saves').first()).toBeVisible();
    // Hide through the item menu, then undo.
    await page.getByRole('button', { name: `More options for ${SEURAT}` }).click();
    await page.getByRole('button', { name: 'Hide this' }).click();
    await expect(page.getByText(`Hidden “${SEURAT}”`).first()).toBeVisible();
    await undo().click();
    await expect(page.getByText('Shown again').first()).toBeVisible();
    // Every withdrawal was undone: no lingering save, no lingering exclusion.
    expect(
      await scalar(
        `SELECT count(*) AS n FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
          WHERE si.owner_account_id = $1 AND di.canonical_key = $2`,
        [accountId, `qloo:${SEURAT_QLOO_ID}`],
      ),
    ).toBe(0);
    expect(
      await scalar('SELECT count(*) AS n FROM item_exclusions WHERE owner_account_id = $1 AND canonical_key = $2', [
        accountId,
        `qloo:${SEURAT_QLOO_ID}`,
      ]),
    ).toBe(0);
  });

  let captureId = '';

  await test.step('a saved photo suggests the same artist through its own proof', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    captureId = await seedFixtureCapture(accountId, rodinRef);
    const runsBefore = await expansionRuns(accountId);
    await page.goto(`/captures/${captureId}`);
    await expect(page.getByRole('heading', { name: 'Discoveries' })).toBeVisible();
    // The fixture is labeled: a sample capture with a reviewed reading, never a live model claim.
    await expect(page.getByText('Example result').first()).toBeVisible();
    await page.getByRole('button', { name: 'Save this inspiration' }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved for later').first()).toBeVisible();
    // Pause never blocks projection: the capture support projects.
    await waitForProjectionReady(accountId);
    const support = await supportRows(accountId);
    expect(support.some((r) => r.origin_kind === 'capture_reference' && r.active)).toBe(true);
    await waitForExpansionRuns(accountId, runsBefore + 1);
    await expect
      .poll(() => pollCardCount(page, `/captures/${captureId}`, new RegExp(`^/v1/captures/${captureId}$`), SEURAT), {
        timeout: 120_000,
      })
      .toBeGreaterThanOrEqual(1);
    const card = page.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await card.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    expect(page.url()).toMatch(/from=capture&capture=[0-9a-f-]{36}&rec=[0-9a-f-]{36}/);
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(page.getByText(`Because your photo shows ${RODIN}.`)).toBeVisible();
    await expect(page.getByText(`${RODIN} — work on display at — Art Institute of Chicago`)).toBeVisible();
    await shot(page, info, 'taste-03-why-this-photo');
  });

  await test.step('Settings → Taste shows confirmed interests and tentative photo affinities', async () => {
    await page.goto('/settings/taste');
    await expect(page.getByRole('heading', { name: 'Background discovery' })).toBeVisible();
    await expect(page.getByRole('link', { name: RODIN, exact: true })).toBeVisible();
    await expect(page.getByText('Also picked up from your photos (1)')).toBeVisible();
    await expect(page.getByRole('button', { name: `Stop showing ${RODIN}` })).toBeVisible();
    await shot(page, info, 'taste-04-taste-graph');
  });

  await test.step('suppressing the affinity withdraws the photo card without touching saves', async () => {
    await page.getByRole('button', { name: `Stop showing ${RODIN}` }).click();
    await expect(page.getByRole('button', { name: `Show again ${RODIN}` })).toBeVisible();
    // Suppression is server truth: it survives a reload.
    await page.goto('/settings/taste');
    await expect(page.getByRole('button', { name: `Show again ${RODIN}` })).toBeVisible();
    expect(
      await scalar(
        `SELECT count(*) AS n FROM personal_edge_suppressions s
           JOIN graph_nodes n ON n.id = s.node_id
          WHERE s.owner_account_id = $1 AND n.canonical_key = 'atlas:creator:auguste-rodin' AND s.restored_at IS NULL`,
        [accountId],
      ),
    ).toBe(1);
    // It never deletes the save and never creates an exclusion.
    expect(
      await scalar(
        `SELECT count(*) AS n FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
          WHERE si.owner_account_id = $1 AND di.canonical_key = $2`,
        [accountId, `qloo:${RODIN_QLOO_ID}`],
      ),
    ).toBe(1);
    expect(
      await scalar('SELECT count(*) AS n FROM item_exclusions WHERE owner_account_id = $1 AND canonical_key = $2', [
        accountId,
        `qloo:${RODIN_QLOO_ID}`,
      ]),
    ).toBe(0);
    // The photo card's reason is withdrawn with its support: no substitution.
    await expect
      .poll(() => pollCardCount(page, `/captures/${captureId}`, new RegExp(`^/v1/captures/${captureId}$`), SEURAT), {
        timeout: 120_000,
      })
      .toBe(0);
    await shot(page, info, 'taste-05-suppressed-withdrawn');
    // Restoring shows it again.
    await page.goto('/settings/taste');
    await page.getByRole('button', { name: `Show again ${RODIN}` }).click();
    await expect(page.getByRole('button', { name: `Stop showing ${RODIN}` })).toBeVisible();
    expect(
      await scalar(
        `SELECT count(*) AS n FROM personal_edge_suppressions s
           JOIN graph_nodes n ON n.id = s.node_id
          WHERE s.owner_account_id = $1 AND n.canonical_key = 'atlas:creator:auguste-rodin' AND s.restored_at IS NOT NULL`,
        [accountId],
      ),
    ).toBe(1);
    await expect
      .poll(() => pollCardCount(page, `/captures/${captureId}`, new RegExp(`^/v1/captures/${captureId}$`), SEURAT), {
        timeout: 120_000,
      })
      .toBeGreaterThanOrEqual(1);
  });

  await test.step('pausing background discovery stops expansion, not projection', async () => {
    // Let the worker drain everything the earlier steps made due.
    await expect.poll(async () => activeExpansionJobs(accountId), { timeout: 90_000 }).toBe(0);
    let baseline = await expansionRuns(accountId);
    for (let i = 0; i < 3; i++) {
      await sleep(8_000);
      const runs = await expansionRuns(accountId);
      if (runs === baseline && (await activeExpansionJobs(accountId)) === 0) break;
      baseline = runs;
    }
    await page.goto('/settings/taste');
    await page.getByRole('button', { name: 'Pause background discovery' }).click();
    await expect(page.getByText(/Background discovery is paused\./)).toBeVisible();
    expect(
      (await one<{ paused: boolean }>('SELECT (discovery_paused_at IS NOT NULL) AS paused FROM graph_refresh_state WHERE owner_account_id = $1', [accountId]))?.paused,
    ).toBe(true);
    // A fresh save while paused: projection still runs and marks expansion due.
    await page.goto('/');
    const felaCard = page.getByRole('listitem').filter({ hasText: FELA }).first();
    await felaCard.getByRole('button', { name: `Save ${FELA}` }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved for later').first()).toBeVisible();
    await waitForProjectionReady(accountId);
    expect(
      await scalar(
        `SELECT count(*) AS n FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id
          WHERE si.owner_account_id = $1 AND di.canonical_key = 'sample:artist-fela-kuti'`,
        [accountId],
      ),
    ).toBe(1);
    expect(
      (await one<{ due: boolean }>('SELECT (expansion_due_since IS NOT NULL) AS due FROM graph_refresh_state WHERE owner_account_id = $1', [accountId]))?.due,
    ).toBe(true);
    // The paused account is skipped: no dispatch, no run, while the marker stays.
    const during = await expansionRuns(accountId);
    await sleep(13_000);
    expect(await expansionRuns(accountId)).toBe(during);
    expect(await activeExpansionJobs(accountId)).toBe(0);
    // Resuming re-enables the retained marker and the worker runs it.
    await page.goto('/settings/taste');
    await page.getByRole('button', { name: 'Resume background discovery' }).click();
    await expect(page.getByRole('button', { name: 'Pause background discovery' })).toBeVisible();
    expect(
      (await one<{ paused: boolean }>('SELECT (discovery_paused_at IS NOT NULL) AS paused FROM graph_refresh_state WHERE owner_account_id = $1', [accountId]))?.paused,
    ).toBe(false);
    await waitForExpansionRuns(accountId, during + 1, 90_000);
  });

  await test.step('no paid provider was charged and no server error occurred', async () => {
    expect(await paidModelAttempts()).toBe(paidBefore);
    expect(apiErrors).toEqual([]);
    await shot(page, info, 'taste-06-resumed');
  });

  await context.close();
});
