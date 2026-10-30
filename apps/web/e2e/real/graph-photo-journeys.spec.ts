import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { upsertReference } from '../../../../packages/domain/src/compiler/store';
import { linkGraphReferenceIdentities } from '../../../../packages/domain/src/interest-graph/identity-links';
import {
  closeJourneyDb,
  isGraphDiscoveryOn,
  journeyDb,
  one,
  paidModelAttempts,
  scalar,
  sessionOf,
  shot,
  supportRows,
  tasteRevision,
  waitForExpansionRuns,
  waitForProjectionReady,
} from './graph-helpers';

/**
 * VAL-CROSS-004: photo upload reaches only honestly supported outcomes, on the
 * real stack — the real web app, the real media worker (ffmpeg verify/prepare),
 * the real analysis worker, the reviewed pilot corpus and the shared journey
 * database. Nothing is mocked and no live provider is called:
 *
 *  - a real v2 media upload (the /uploads flow) is verified and prepared by the
 *    actual media worker; its exploration is honestly unavailable (no qualified
 *    photo role on this server) and intake/view/analysis add no confirmed
 *    interest;
 *  - a real v1 photo upload (/capture/photo) is analyzed by the real worker and
 *    fails closed with the honest server state — never a fabricated reading;
 *  - the supported-reference path is a DETERMINISTIC PREPARED analysis (a
 *    reviewed fixture), labeled on the page ("Example result" for the sample
 *    capture; an explicit disclosure line for the upload-source fixture). It is
 *    never a live photo qualification, and the paid-model ledger must not move;
 *  - the photo card's Why this carries the photo's own evidence
 *    ("Because your photo shows …"), and no disclosure ever blends the two
 *    origins: each pinned proof shows exactly its own roots. Before any
 *    photo exists the feed card's Why this shows the personal save
 *    ("Because you saved …"); after the photo leg the feed pin is the newest
 *    serving context by design, so it is asserted to carry exactly one
 *    origin's roots, never a mixed reason;
 *  - correcting the prepared capture (rejecting its depicted reference)
 *    withdraws its old photo card from its capture page at once; its pinned
 *    reason withdraws when its last active photo support goes (the sample
 *    capture's deletion completes it), showing the honest withdrawn-proof
 *    state, while independent saves and the original personal reason link
 *    survive.
 *
 * Requires the journey stack with BOTH graph flags on plus the file-mail web
 * variant (web_journey_discovery_ios: the v2 media platform requires a
 * verified email, so the account is created through the real email-link
 * identity flow) AND the media_worker service; the spec skips itself without
 * the discovery flag. The correction fixture is upload-source on purpose: its
 * re-analysis fails closed at the (unqualified) vision role before any Qloo
 * call, so the journey makes zero live provider requests.
 */
test.skip(!isGraphDiscoveryOn, 'photo journeys require INTEREST_GRAPH_DISCOVERY_ENABLED=true');

test.afterAll(async () => {
  await closeJourneyDb();
});

const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
const RODIN = 'Auguste Rodin';
const SEURAT = 'Georges Seurat';
const NINA = 'Nina Simone';
const COLLECTION = 'Studio roots';
const ROOM_SAMPLE = path.resolve(import.meta.dirname, '../../public/samples/room.jpg');
const DISCLOSED_FIXTURE_READING = 'A reviewed example reading prepared for this journey.';

/**
 * Loads `url` and counts matching feed/capture cards only after the page's own
 * read has landed and rendered — the first paint serves the client cache, so a
 * count taken right after navigation can miss a freshly published card.
 */
async function pollCardCount(
  page: Page,
  url: string,
  readPath: RegExp,
  text: string,
): Promise<number> {
  const seen = page
    .waitForResponse((r) => readPath.test(new URL(r.url()).pathname), { timeout: 15_000 })
    .catch(() => null);
  await page.goto(url);
  await seen;
  await page.waitForTimeout(800);
  return page.getByRole('listitem').filter({ hasText: text }).count();
}

function trackErrors(page: Page, apiErrors: string[]) {
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (/^\/(v1|v2|mcp)/.test(url.pathname) && r.status() >= 500)
      apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
}

/** Browser-session mutation headers, exactly as the web client sends them. */
async function mutationHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const session = await (await request.get('/v1/session')).json();
  return {
    'x-csrf-token': session.csrf_token,
    'x-atlas-expected-account': session.principal.account_id,
    'idempotency-key': crypto.randomUUID(),
    'content-type': 'application/json',
  };
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
    [
      accountId,
      `qloo:${qlooId}`,
      title,
      JSON.stringify({ subtitle }),
      JSON.stringify({ qloo: qlooId }),
      referenceId,
    ],
  );
  return rows[0]!.id;
}

/**
 * The deterministic photo fixture: the public sample photo's bytes, a capture
 * row in the real storage layout, and a reviewed fixture analysis authorizing
 * one depicted Rodin reference (resolved, non-text-only — the same support
 * shape a real analysis writes). The sample variant (`source='sample'`) rides
 * the honest "Example result" label; the upload variant is the correction
 * fixture — its re-analysis fails closed at the unqualified vision role before
 * any Qloo call, and its reading carries the explicit disclosure line. Returns
 * the capture id.
 */
async function seedSupportedCapture(
  accountId: string,
  rodinReferenceId: string,
  variant: { source: 'sample' | 'upload'; sampleId: string | null },
): Promise<string> {
  const captureId = await journeyDb().transaction(async (tx) => {
    const cap = await tx.query<{ id: string }>(
      `INSERT INTO captures (owner_account_id, source, sample_id, image_sha256, width, height, status)
       VALUES ($1, $2, $3, $4, 1000, 1250, 'ready') RETURNING id`,
      [
        accountId,
        variant.source,
        variant.sampleId,
        `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.padEnd(64, '0'),
      ],
    );
    const id = cap.rows[0]!.id;
    await tx.query(`UPDATE captures SET private_object_key = $2 WHERE id = $1`, [
      id,
      `owners/a-${accountId}/captures/${id}/derivative.jpg`,
    ]);
    const an = await tx.query<{ id: string }>(
      `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
       VALUES ($1, 1, 'reviewed-example', 'A quiet reading corner', $2, '{"observations":"complete","references":"complete"}')
       RETURNING id`,
      [
        id,
        variant.source === 'sample'
          ? 'A reviewed example reading prepared for this journey.'
          : DISCLOSED_FIXTURE_READING,
      ],
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

/**
 * The journey stack serves identity mail as local JSON files (the
 * `web_journey_discovery_ios` manifest command sets IDENTITY_MAIL_FILE_DIR).
 * Files are named `<ISO time with ':' replaced by '-'>-<uuid>.json`.
 */
const MAIL_DIR = process.env.IDENTITY_MAIL_FILE_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/ios-mail';

function mailTime(file: string): number {
  const iso = file.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3');
  return new Date(`${iso}Z`).getTime();
}

/** Newest identity mail for this address since `after` (the file mailbox is local-dev only). */
async function mailFor(email: string, after: number): Promise<{ callback: string }> {
  let found: { callback: string } | undefined;
  await expect
    .poll(
      () => {
        const files = readdirSync(MAIL_DIR)
          .filter((f) => f.endsWith('.json') && mailTime(f) >= after - 2000)
          .sort()
          .reverse();
        for (const file of files) {
          const mail = JSON.parse(readFileSync(path.join(MAIL_DIR, file), 'utf8')) as {
            to: string;
            callback: string;
          };
          if (mail.to === email) {
            found = mail;
            return true;
          }
        }
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found!;
}

async function answerQuestionnaire(page: Page) {
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  // A fresh email-link account has no prior save: three image-tile picks.
  for (const image of ['Tea rituals', 'Linen days', 'Sunday listening'])
    await page.getByRole('button', { name: image }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  for (let step = 0; step < 3; step++) {
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (!(await next.isVisible())) break;
    await next.click();
  }
  await page.getByRole('button', { name: 'Build my feed' }).click();
  await expect(page).toHaveURL(/\/welcome\/building|\/$/, { timeout: 30_000 });
  // Wait for the server's own truth before navigating anywhere else.
  await expect
    .poll(() =>
      page
        .evaluate(async () => (await fetch('/v1/onboarding/state', { cache: 'no-store' })).json())
        .then((s: { required: boolean }) => s.required !== true),
    )
    .toBe(true);
}

test('photo upload reaches only honestly supported outcomes', async ({
  browser,
}, info: TestInfo) => {
  test.setTimeout(540_000);
  const email = `graph-photo-${info.project.name}-${Date.now()}@example.com`;
  const apiErrors: string[] = [];
  const paidBefore = await paidModelAttempts();

  const context = await browser.newContext();
  const page = await context.newPage();
  trackErrors(page, apiErrors);

  const dialog = page.getByRole('dialog', { name: 'Save to a collection' });

  await test.step('onboarding: verified email-link account, questionnaire, first save', async () => {
    // The v2 media platform (the real media-worker upload leg below) requires a
    // verified email, so the account is created through the real email-link
    // identity flow the stack delivers as local JSON mail.
    await page.goto('/library');
    await expect(page.getByText('Your library is private.')).toBeVisible();
    await page.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/identity$/);
    await page.getByLabel('Email').fill(email);
    const mailStartedAt = Date.now();
    await page.getByRole('button', { name: 'Email verification link' }).click();
    await expect(page.locator('main p[role="status"]')).toContainText(
      'If eligible, your email has a verification link',
    );
    const mail = await mailFor(email, mailStartedAt);
    await page.goto(mail.callback);
    await answerQuestionnaire(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    // An ordinary first save creates the journey's collection.
    const ninaCard = page.getByRole('listitem').filter({ hasText: NINA }).first();
    await ninaCard.getByRole('button', { name: `Save ${NINA}` }).click();
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill(COLLECTION);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
  });

  const session = await sessionOf(page);
  expect(session.principal.kind).toBe('account');
  const accountId = session.principal.account_id!;

  let rodinItem = '';

  await test.step('fixtures: the reviewed references and the account’s own items on them', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    const seuratRef = await qlooPersonReference(SEURAT_QLOO_ID, SEURAT);
    // Bind both compiler-shaped references to their reviewed corpus identities.
    await linkGraphReferenceIdentities(journeyDb());
    expect(
      await scalar(
        `SELECT count(*) AS n FROM graph_nodes
          WHERE canonical_key IN ('atlas:creator:auguste-rodin', 'atlas:creator:georges-seurat')
            AND cultural_reference_id IN ($1, $2)`,
        [rodinRef, seuratRef],
      ),
    ).toBe(2);
    rodinItem = await accountItem(
      accountId,
      rodinRef,
      RODIN_QLOO_ID,
      RODIN,
      'French sculptor, 1840–1917',
    );
    await accountItem(accountId, seuratRef, SEURAT_QLOO_ID, SEURAT, 'French painter, 1859–1891');
  });

  await test.step('save the Rodin item: a personal confirmed root', async () => {
    await page.goto(`/items/${rodinItem}`);
    await expect(page.getByRole('heading', { name: RODIN, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: COLLECTION }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
    await waitForProjectionReady(accountId);
    const support = await supportRows(accountId);
    expect(
      support.some(
        (r) => r.origin_kind === 'saved_item' && r.discovery_item_id === rodinItem && r.active,
      ),
    ).toBe(true);
  });

  let personalHref = '';
  await test.step('the personal-root card reaches the feed', async () => {
    await waitForExpansionRuns(accountId, 1);
    await expect
      .poll(() => pollCardCount(page, '/', /^\/v1\/discover$/, SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    // Before any photo exists, the feed card's evidence is the personal save.
    const feedCard0 = page.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await feedCard0.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(page.locator('.connection__roots')).toContainText(`Because you saved ${RODIN}.`);
    await expect(page.locator('.connection__roots')).not.toContainText('Because your photo shows');
    // The original personal reason link, kept for the correction/deletion
    // regressions: reopening it later must keep the same personal evidence.
    personalHref = page.url();
    await shot(page, info, 'photo-00-feed-personal-card');
  });

  // The account's support and taste revision before any photo intake: uploads
  // must add nothing to them.
  const supportBeforeUploads = await supportRows(accountId);
  const revisionBeforeUploads = await tasteRevision(accountId);

  let photoMediaId = '';
  await test.step('real media-worker upload: the queue verifies and prepares the photo', async () => {
    await page.goto('/uploads');
    await expect(page.getByText('No uploads in progress.')).toBeVisible();
    // The rights-cleared public sample photo (project-original illustration).
    await page.getByTestId('uploads-input').setInputFiles([ROOM_SAMPLE]);
    const rows = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await expect(rows.filter({ hasText: 'room.jpg' })).toContainText('Ready', { timeout: 120_000 });
    await expect(page.getByText('Uploading does not start analysis.')).toBeVisible();
    await shot(page, info, 'photo-01-uploads-ready');
    // The actual media worker processed the intake: verify + prepare both done.
    const work = await journeyDb().query<{ kind: string; state: string }>(
      `SELECT kind, state FROM capture_work WHERE account_id = $1 AND kind IN ('verify_upload','prepare_media') ORDER BY kind`,
      [accountId],
    );
    expect(
      work.rows
        .filter((r) => r.kind === 'verify_upload' || r.kind === 'prepare_media')
        .map((r) => `${r.kind}:${r.state}`)
        .sort(),
    ).toEqual(['prepare_media:complete', 'verify_upload:complete']);
    const asset = await one<{ id: string; kind: string; status: string }>(
      'SELECT id, kind, status FROM media_assets WHERE account_id = $1',
      [accountId],
    );
    expect(asset).toMatchObject({ kind: 'photo', status: 'ready' });
    photoMediaId = asset!.id;
    await page.goto('/library');
    await expect(page.getByRole('link', { name: /^Photo from / })).toHaveCount(1);
    // The library lists the prepared upload; the meta line collapses on small
    // viewports (the mobile variant drops the redundant Ready status).
    const libraryMeta =
      info.project.name === 'desktop'
        ? page.getByText('Upload · Ready')
        : page.locator('.media-card__meta--mobile');
    await expect(libraryMeta).toBeVisible();
    await expect(libraryMeta).toContainText('Upload');
    await shot(page, info, 'photo-02-library');
  });

  await test.step('exploration is honestly unavailable, and intake/view added no confirmed interest', async () => {
    await page.goto(`/library/media/${photoMediaId}`);
    await expect(page.getByRole('heading', { level: 1, name: /Photo from/ })).toBeVisible();
    // The server reports analysis unavailable (no qualified photo role).
    const caps = await (await page.request.get('/v2/capabilities')).json();
    expect(caps.availability.analysis.available).toBe(false);
    expect(caps.flags.concentrate_analysis_enabled).toBe(false);
    await expect(page.getByRole('button', { name: 'Explore this photo' })).toBeDisabled();
    await expect(
      page.getByText('Exploration is temporarily unavailable. Your photo stays in your library.'),
    ).toBeVisible();
    // A direct request is refused the same honest way: 503, nothing invented.
    const detail = await (await page.request.get(`/v2/media/${photoMediaId}`)).json();
    const refused = await page.request.post(`/v2/media/${photoMediaId}/analysis`, {
      headers: await mutationHeaders(page.request),
      data: { mode: 'photo', expected_generation: detail.generation },
    });
    expect(refused.status()).toBe(503);
    expect((await refused.json()).error.message).toBe(
      'Exploration is not available on this server yet.',
    );
    const after = await (await page.request.get(`/v2/media/${photoMediaId}`)).json();
    expect(after.links.analysis ?? null).toBeNull();
    await shot(page, info, 'photo-03-media-unavailable');
    // Intake, view and the refused analysis added no confirmed interest and no taste change.
    expect(await supportRows(accountId)).toEqual(supportBeforeUploads);
    expect(await tasteRevision(accountId)).toBe(revisionBeforeUploads);
    expect(
      await scalar(
        'SELECT count(*) AS n FROM saved_items si JOIN discovery_items di ON di.id = si.discovery_item_id WHERE si.owner_account_id = $1 AND di.kind = $2',
        [accountId, 'capture'],
      ),
    ).toBe(0);
  });

  let v1CapturePath = '';
  await test.step('real analysis-worker upload: the v1 photo flow fails closed with the honest state', async () => {
    await page.goto('/capture/photo');
    await page.getByTestId('upload-input').setInputFiles(ROOM_SAMPLE);
    await expect(page.getByRole('img', { name: 'Your selected photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Discover', exact: true }).click();
    await expect(page).toHaveURL(/\/captures\//);
    v1CapturePath = new URL(page.url()).pathname;
    const v1CaptureId = v1CapturePath.split('/').pop()!;
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).not.toHaveText('Finding your next favorites…', { timeout: 120_000 });
    // The honest unavailable state: this server has no qualified photo role.
    await expect(heading).toHaveText('We can’t look at this photo yet');
    await expect(
      page.getByText('Photo reading isn’t available on this server yet. Your photo is saved.'),
    ).toBeVisible();
    // Never presented as an example or a success: no reading, no references, no
    // cards. (The collapsed "More to explore" strip below may still show the
    // labeled example feed; the capture's own result surface must not.)
    await expect(page.locator('.example-label')).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'References' })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Discoveries from your photo' })).toHaveCount(0);
    await expect(page.getByText(/vlm|qloo|anthropic|concentrate/i)).toHaveCount(0);
    await shot(page, info, 'photo-04-upload-unavailable');
    // The real worker's honest record: the analysis job failed closed before any provider.
    const job = await one<{ state: string; error_code: string }>(
      `SELECT state, error_code FROM jobs WHERE result_type = 'capture' AND result_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [v1CaptureId],
    );
    expect(job).toMatchObject({ state: 'failed', error_code: 'provider_unavailable' });
    const cap = await one<{ status: string }>('SELECT status FROM captures WHERE id = $1', [
      v1CaptureId,
    ]);
    expect(cap?.status).toBe('failed');
    // The attempted-and-failed reading is recorded, never a fabricated result.
    expect(
      await scalar(
        `SELECT count(*) AS n FROM provider_queries pq
          JOIN analyses a ON a.id = pq.analysis_id JOIN captures c ON c.id = a.capture_id
         WHERE c.owner_account_id = $1 AND pq.provider = 'vlm' AND pq.status = 'error'`,
        [accountId],
      ),
    ).toBeGreaterThanOrEqual(1);
    // Still no confirmed interest, no taste change, no live Qloo.
    expect(await supportRows(accountId)).toEqual(supportBeforeUploads);
    expect(await tasteRevision(accountId)).toBe(revisionBeforeUploads);
  });

  let captureS = '';
  await test.step('the supported-reference path: a labeled deterministic prepared capture', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    captureS = await seedSupportedCapture(accountId, rodinRef, {
      source: 'sample',
      sampleId: 'room',
    });
    const runsBefore = await scalar(
      'SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = $2 AND state = $3',
      [accountId, 'expansion', 'complete'],
    );
    await page.goto(`/captures/${captureS}`);
    await expect(page.getByRole('heading', { name: 'Discoveries' })).toBeVisible();
    // Deterministic, labeled: a sample capture with a reviewed reading — never a live model claim.
    await expect(page.getByText('Example result').first()).toBeVisible();
    await page.getByRole('button', { name: 'Save this inspiration' }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved for later').first()).toBeVisible();
    // The capture's reference support projects; the photo expansion publishes.
    await waitForProjectionReady(accountId);
    const support = await supportRows(accountId);
    expect(support.some((r) => r.origin_kind === 'capture_reference' && r.active)).toBe(true);
    await waitForExpansionRuns(accountId, runsBefore + 1);
    await expect
      .poll(
        () =>
          pollCardCount(
            page,
            `/captures/${captureS}`,
            new RegExp(`^/v1/captures/${captureS}$`),
            SEURAT,
          ),
        {
          timeout: 120_000,
        },
      )
      .toBeGreaterThanOrEqual(1);
    await shot(page, info, 'photo-05-photo-card');
  });

  await test.step('the photo Why this separates photo evidence from personal evidence', async () => {
    const card = page.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await card.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    expect(page.url()).toMatch(/from=capture&capture=[0-9a-f-]{36}&rec=[0-9a-f-]{36}/);
    await page.getByRole('button', { name: 'Why this?' }).click();
    // The photo card rests on the photo's own reference support…
    await expect(page.locator('.connection__roots')).toContainText(
      `Because your photo shows ${RODIN}.`,
    );
    // …never on the account's personal save of the same artist.
    await expect(page.locator('.connection__roots')).not.toContainText('Because you saved');
    // The sourced cultural connection is its own section, with its permitted source link.
    await expect(page.locator('.connection__path')).toContainText(
      `${RODIN} — work on display at — Art Institute of Chicago`,
    );
    const source = page.getByRole('link', { name: 'Adam — The Art Institute of Chicago' });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', 'https://www.artic.edu/artworks/11320');
    await shot(page, info, 'photo-06-why-this-photo');
  });

  await test.step('the feed card discloses one honest origin, never a blended one', async () => {
    await page.goto('/');
    const feedCard = page.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await feedCard.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    expect(page.url()).toMatch(/from=discover&rec=[0-9a-f-]{36}/);
    await page.getByRole('button', { name: 'Why this?' }).click();
    // The feed pin is the newest currently-serving owner-context
    // recommendation for the item (by design: capture analyses are eligible
    // pins too), so after the photo leg it may be either the personal proof
    // or the photo proof. The separation invariant under test: a disclosure
    // carries exactly ONE origin's roots — the personal save and the photo
    // never blend into one reason — and the cultural path is the shared one.
    const roots = page.locator('.connection__roots');
    await expect(roots.getByRole('listitem')).toHaveCount(1);
    const rootText = (await roots.innerText()).trim();
    expect([`Because you saved ${RODIN}.`, `Because your photo shows ${RODIN}.`]).toContain(
      rootText,
    );
    await expect(page.locator('.connection__path')).toContainText(
      `${RODIN} — work on display at — Art Institute of Chicago`,
    );
    await shot(page, info, 'photo-07-why-this-feed');
  });

  await test.step('Taste separates the confirmed personal save from the photo-picked affinity', async () => {
    await page.goto('/settings/taste');
    await expect(page.getByRole('heading', { name: 'Background discovery' })).toBeVisible();
    // The personal save is a confirmed interest with its ordinary controls…
    await expect(page.getByRole('link', { name: RODIN, exact: true })).toBeVisible();
    // …while the photo's reference sits in its own, distinct photo section.
    await expect(page.getByText('Also picked up from your photos (1)')).toBeVisible();
    await expect(page.getByRole('button', { name: `Stop showing ${RODIN}` })).toBeVisible();
    await shot(page, info, 'photo-08-taste-separated');
  });

  let captureU = '';
  let oldRecU = '';
  await test.step('correction: the corrected capture’s old reason is withdrawn, independent saves remain', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    // The upload-source fixture: its re-analysis fails closed at the unqualified
    // vision role (before any Qloo call), and its reading is explicitly disclosed.
    captureU = await seedSupportedCapture(accountId, rodinRef, {
      source: 'upload',
      sampleId: null,
    });
    const runsBefore = await scalar(
      'SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = $2 AND state = $3',
      [accountId, 'expansion', 'complete'],
    );
    await page.goto(`/captures/${captureU}`);
    await expect(page.getByText(DISCLOSED_FIXTURE_READING)).toBeVisible();
    await page.getByRole('button', { name: 'Save this inspiration' }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Saved for later').first()).toBeVisible();
    await waitForProjectionReady(accountId);
    await waitForExpansionRuns(accountId, runsBefore + 1);
    await expect
      .poll(
        () =>
          pollCardCount(
            page,
            `/captures/${captureU}`,
            new RegExp(`^/v1/captures/${captureU}$`),
            SEURAT,
          ),
        {
          timeout: 120_000,
        },
      )
      .toBeGreaterThanOrEqual(1);
    // The old proof link, captured from the photo rail before the correction.
    const railU = page
      .getByRole('list', { name: 'Discoveries from your photo' })
      .getByRole('listitem')
      .filter({ hasText: SEURAT });
    await expect(railU).toHaveCount(1);
    const cardUHref = (await railU
      .first()
      .getByRole('link', { name: new RegExp(SEURAT) })
      .getAttribute('href'))!;
    expect(cardUHref).toMatch(/rec=[0-9a-f-]{36}/);
    await shot(page, info, 'photo-09-supported-upload-capture');
    // Correct the capture through the real UI: reject the depicted reference.
    await page.getByRole('button', { name: 'Explore the references' }).click();
    await page.getByRole('button', { name: 'Something else?' }).click();
    await page.getByRole('checkbox', { name: RODIN }).check();
    await page.getByRole('button', { name: 'Update discoveries' }).click();
    await expect(page.getByText('Thanks. Updating your discoveries.').first()).toBeVisible();
    // The projection catches up on the correction (the re-analysis itself fails
    // closed, honestly; the withdrawal does not depend on it).
    await waitForProjectionReady(accountId);
    // The old photo card is withdrawn from the capture page.
    await expect
      .poll(
        () =>
          pollCardCount(
            page,
            `/captures/${captureU}`,
            new RegExp(`^/v1/captures/${captureU}$`),
            SEURAT,
          ),
        {
          timeout: 120_000,
        },
      )
      .toBe(0);
    await shot(page, info, 'photo-10-corrected-withdrawn');
    // The corrected capture's reference support is gone…
    expect(
      await scalar(
        'SELECT count(*) AS n FROM personal_interest_support WHERE owner_account_id = $1 AND capture_id = $2 AND origin_kind = $3 AND active',
        [accountId, captureU, 'capture_reference'],
      ),
    ).toBe(0);
    // …and its re-analysis failed honestly (the unqualified role), never a new reading.
    const reanalysis = await one<{ state: string; error_code: string }>(
      `SELECT state, error_code FROM jobs WHERE result_type = 'capture' AND result_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [captureU],
    );
    expect(reanalysis).toMatchObject({ state: 'failed', error_code: 'provider_unavailable' });
    // Reopen the old photo proof link. The corrected capture's own card is
    // gone from its capture page and its own reference support is withdrawn,
    // but the reason itself stays honest while ANOTHER still-active
    // authorized photo (the sample capture) keeps the same photo affinity
    // edge alive: the disclosure keeps the true photo root, never a
    // fabricated or substituted one.
    oldRecU = cardUHref.match(/rec=([0-9a-f-]{36})/)![1]!;
    const oldConnectionU = await (
      await page.request.get(`/v2/me/recommendations/${oldRecU}/connection`)
    ).json();
    expect(oldConnectionU.state).toBe('connected');
    await page.goto(cardUHref);
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(page.locator('.connection__roots')).toContainText(
      `Because your photo shows ${RODIN}.`,
    );
    await shot(page, info, 'photo-11-old-proof-honest-while-supported');
    // The independent personal save and the personal-root feed card survive.
    expect(
      await scalar(
        'SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
        [accountId, rodinItem],
      ),
    ).toBe(1);
    const support = await supportRows(accountId);
    expect(
      support.some(
        (r) => r.origin_kind === 'saved_item' && r.discovery_item_id === rodinItem && r.active,
      ),
    ).toBe(true);
    await expect
      .poll(() => pollCardCount(page, '/', /^\/v1\/discover$/, SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    // The original personal reason link still carries the personal evidence.
    await page.goto(personalHref);
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(page.locator('.connection__roots')).toContainText(`Because you saved ${RODIN}.`);
    await expect(page.locator('.connection__path')).toContainText(
      `${RODIN} — work on display at — Art Institute of Chicago`,
    );
  });

  await test.step('deletion: the deleted capture’s paths and media vanish, independent saves remain', async () => {
    // The current photo card and its media URL, captured from the photo rail
    // while the capture is live.
    await page.goto(`/captures/${captureS}`);
    await expect(page.getByText('Example result').first()).toBeVisible();
    const railS = page
      .getByRole('list', { name: 'Discoveries from your photo' })
      .getByRole('listitem')
      .filter({ hasText: SEURAT });
    await expect(railS).toHaveCount(1);
    const cardSHref = (await railS
      .first()
      .getByRole('link', { name: new RegExp(SEURAT) })
      .getAttribute('href'))!;
    expect(cardSHref).toMatch(/rec=[0-9a-f-]{36}/);
    const imageUrl = await page.locator('.result-photo__img').first().getAttribute('src');
    expect(imageUrl).toBeTruthy();
    await shot(page, info, 'photo-12-before-delete');
    // Delete through the real UI (window.confirm is accepted once).
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'More options for this photo' }).click();
    await page.getByRole('button', { name: 'Delete photo' }).click();
    await expect(page.getByText('Photo deleted').first()).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    // The capture page is honestly gone.
    await page.goto(`/captures/${captureS}`);
    await expect(
      page.getByText('This photo isn’t available. It may have expired or been deleted.'),
    ).toBeVisible();
    await shot(page, info, 'photo-13-capture-gone');
    // Private media access is revoked with the capture.
    const media = await page.request.get(imageUrl!);
    expect(media.status()).toBeGreaterThanOrEqual(400);
    // The deleted capture's support rows are gone.
    expect(
      await scalar(
        'SELECT count(*) AS n FROM personal_interest_support WHERE owner_account_id = $1 AND capture_id = $2',
        [accountId, captureS],
      ),
    ).toBe(0);
    const deleted = await one<{ status: string }>('SELECT status FROM captures WHERE id = $1', [
      captureS,
    ]);
    expect(deleted?.status).toBe('deleted');
    // Reopen BOTH old photo proof links: with the sample capture deleted and
    // the corrected capture's support already withdrawn, no active
    // capture-reference support remains on the shared photo affinity edge —
    // the deleted capture's reason AND the corrected capture's reason are
    // now honestly unavailable, never substituted by another reason.
    const oldRecS = cardSHref.match(/rec=([0-9a-f-]{36})/)![1]!;
    for (const recId of [oldRecS, oldRecU]) {
      const connection = await (
        await page.request.get(`/v2/me/recommendations/${recId}/connection`)
      ).json();
      expect(connection.state).toBe('unavailable');
      expect(connection.unavailable_reason).toBe('support_withdrawn');
    }
    await page.goto(cardSHref);
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(
      page.getByText('The background for this suggestion is no longer available.'),
    ).toBeVisible();
    await expect(page.getByText('What it was based on has changed.')).toBeVisible();
    await shot(page, info, 'photo-14-old-proof-deleted');
    // The independent saves and the personal-root feed card still survive.
    await waitForProjectionReady(accountId);
    expect(
      await scalar(
        'SELECT count(*) AS n FROM saved_items WHERE owner_account_id = $1 AND discovery_item_id = $2',
        [accountId, rodinItem],
      ),
    ).toBe(1);
    await expect
      .poll(() => pollCardCount(page, '/', /^\/v1\/discover$/, SEURAT), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    // The original personal reason link still carries the personal evidence.
    await page.goto(personalHref);
    await expect(page.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Why this?' }).click();
    await expect(page.locator('.connection__roots')).toContainText(`Because you saved ${RODIN}.`);
  });

  await test.step('no paid provider was charged, no live Qloo ran, no server error occurred', async () => {
    // The paid-model ledger never moved: every real analysis failed closed, and
    // the fixture readings are deterministic and labeled — never live qualification.
    expect(await paidModelAttempts()).toBe(paidBefore);
    // Zero live Qloo calls for this account's captures: the failed uploads
    // never reached the resolve stage, and the graph walks ride reviewed corpus.
    expect(
      await scalar(
        `SELECT count(*) AS n FROM provider_queries pq
          JOIN analyses a ON a.id = pq.analysis_id JOIN captures c ON c.id = a.capture_id
         WHERE c.owner_account_id = $1 AND pq.provider = 'qloo'`,
        [accountId],
      ),
    ).toBe(0);
    expect(apiErrors, 'no server errors during the journey').toEqual([]);
  });

  await context.close();
});
