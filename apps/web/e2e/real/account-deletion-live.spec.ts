import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
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
 * VAL-CROSS-006 (with the real-stack legs of VAL-DELETE-002/004): Settings
 * deletion ends a live private journey — from an authenticated account that
 * actually HAS feed/photo reasons, a real prepared upload, an agent credential
 * and a share link, while real media/graph work is queued against stopped
 * workers.
 *
 * The journey, all on the real stack (real web, real worker, real media
 * worker, isolated journey DB + storage):
 *
 *  - the account reaches an admitted personal feed card ("Because you saved
 *    Auguste Rodin.") and an admitted photo card ("Because your photo shows
 *    Auguste Rodin.") through the real projection/expansion worker;
 *  - a real v2 upload is verified+prepared by the real media worker;
 *  - old credentials are created through the real UI (an agent connection with
 *    its once-shown credential, a link share on the account's collection) and
 *    each is proven WORKING before the deletion;
 *  - the worker and media worker are then stopped through the manifest's own
 *    service-control commands (CA_MISSION_CONTROL), and fresh media/graph work
 *    is queued behind them (a pending photo analysis job, a pending upload
 *    verification, a pending projection/expansion outbox event);
 *  - Settings deletion is opened and CANCELLED once: every private surface
 *    and every owed job survives unchanged;
 *  - the deletion is confirmed: the browser session, the agent credential and
 *    the share link all lose access at once (checked with the exact old
 *    credentials), a duplicate acceptance cannot recreate authority, and the
 *    broadcast reloads the account's other tab so a late private response
 *    never renders the deleted account's Taste;
 *  - the held workers are RELEASED: the cancelled jobs are never executed (no
 *    analysis, no provider call, no new graph run), and the real worker runs
 *    the durable purge to completion while the page reports exactly what the
 *    server says — pending, then complete only when the cleanup finished;
 *  - the isolated DB/storage inventory shows the account's private rows and
 *    BOTH storage namespaces gone, the durable deletion record kept, the
 *    shared reviewed corpus and a second account untouched, and the old
 *    signed media URL dead.
 *
 * Deterministic fixture readings (the sample capture) are labeled on the page
 * and never claimed as live model qualification; the paid-model ledger must
 * not move and no 5xx may occur.
 *
 * Requires the file-mail DISCOVERY journey stack (web_journey_discovery_ios)
 * plus worker_journey_discovery and the media_worker service, started through
 * services.yaml; the spec holds/releases the worker + media worker itself via
 * the manifest's CA_MISSION_CONTROL script and only ever stops processes the
 * manifest owns (its PID files). Skips itself without the discovery flag or
 * the control script, so no other stack is touched accidentally.
 */
test.skip(!isGraphDiscoveryOn, 'the live deletion journey requires INTEREST_GRAPH_DISCOVERY_ENABLED=true');
test.skip(!process.env.CA_MISSION_CONTROL, 'the live deletion journey holds/releases the manifest services (CA_MISSION_CONTROL)');

test.afterAll(async () => {
  await closeJourneyDb();
});

// If a step fails while the workers are held, release them again so the
// journey stack is left in its running state for the next run.
test.afterEach(async () => {
  for (const service of ['worker', 'media_worker'] as const) {
    if (spawnSync('sh', [CONTROL, 'health', service]).status !== 0) {
      await startService(service, service === 'worker' ? '[worker] starting' : '[media-worker]').catch(() => undefined);
    }
  }
});

const RODIN_QLOO_ID = '0A4E018D-ED71-43C0-B16E-0431CDC5C403';
const SEURAT_QLOO_ID = '9E815B4D-1392-4952-AA23-996274BACD45';
const RODIN = 'Auguste Rodin';
const SEURAT = 'Georges Seurat';
const NINA = 'Nina Simone';
const COLLECTION = 'Studio roots';
const ROOM_SAMPLE = path.resolve(import.meta.dirname, '../../public/samples/room.jpg');
const CAFE_SAMPLE = path.resolve(import.meta.dirname, '../../public/samples/cafe.jpg');
const STORAGE_DIR = process.env.STORAGE_LOCAL_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/storage';
const MAIL_DIR = process.env.IDENTITY_MAIL_FILE_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/ios-mail';
const LOG_DIR = '/tmp/ca-graph-pr8-3bb8f6d4/journey-logs';
const CONTROL = process.env.CA_MISSION_CONTROL!;
const REPO = path.resolve(import.meta.dirname, '../../../..');
const SESSION_COOKIE = 'ca_session';
const CSRF_HEADER = 'x-csrf-token';
const BASE = 'http://127.0.0.1:3200';

/** The manifest's own service-control stop, exactly as services.yaml uses it. */
function stopService(service: 'worker' | 'media_worker') {
  const res = spawnSync('sh', [CONTROL, 'stop', service], { encoding: 'utf8' });
  expect(res.status, `stopping ${service}: ${res.stdout ?? ''} ${res.stderr ?? ''}`).toBe(0);
}

/**
 * Restart a held service in the background with the manifest start command's
 * exact environment (the spec process inherits the same values), capturing
 * its release log for the held-worker release evidence.
 */
function startService(service: 'worker' | 'media_worker', readyLine: string): Promise<string> {
  const flags =
    `INTEREST_GRAPH_PROJECTION_ENABLED=${process.env.INTEREST_GRAPH_PROJECTION_ENABLED ?? 'true'} ` +
    `INTEREST_GRAPH_DISCOVERY_ENABLED=${process.env.INTEREST_GRAPH_DISCOVERY_ENABLED ?? 'true'}`;
  const common =
    `DATABASE_URL=${process.env.DATABASE_URL} APP_BASE_URL=${process.env.APP_BASE_URL ?? BASE} ` +
    `STORAGE_DRIVER=local STORAGE_LOCAL_DIR=${STORAGE_DIR} TASTE_SEED_ENABLED=false ${flags} `;
  const dir = service === 'worker' ? 'apps/worker' : 'apps/media-worker';
  const extra =
    service === 'media_worker'
      ? `MEDIA_WORKER_SCRATCH_DIR=${process.env.MEDIA_WORKER_SCRATCH_DIR ?? '/tmp/ca-graph-pr8-3bb8f6d4/scratch'} `
      : '';
  const command = `cd "${REPO}/${dir}" && ${common}${extra}sh "${CONTROL}" start ${service} tsx -- ../../node_modules/.bin/tsx src/main.ts`;
  mkdirSync(LOG_DIR, { recursive: true });
  const log = path.join(LOG_DIR, `${service}-release.log`);
  writeFileSync(log, '');
  const child = spawn('sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  const flush = () => writeFileSync(log, Buffer.concat(chunks).toString('utf8'));
  // Flush on every chunk so the log stays honest for the whole journey: later
  // work lines (the real purge) must land in the file, not only the startup
  // lines captured while waiting for the ready line.
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (c: Buffer) => { chunks.push(c); flush(); });
  child.unref();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const poll = setInterval(() => {
      flush();
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.includes(readyLine)) {
        clearInterval(poll);
        resolve(log);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`${service} did not reach "${readyLine}" in 60s; log so far:\n${text.slice(-2000)}`));
      }
    }, 500);
  });
}

/**
 * Object bytes are the storage contract, and so is the namespace itself: the
 * purge must leave neither files nor empty directory shells under an account
 * prefix (both drivers prune the emptied tree; the shared roots stay).
 */
function countFiles(dir: string): number {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0; // ENOENT: the namespace is gone entirely.
  }
  let n = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n++;
  }
  return n;
}

function trackErrors(page: Page, apiErrors: string[]) {
  page.on('response', (r) => {
    const url = new URL(r.url());
    if (/^\/(v1|v2|mcp)/.test(url.pathname) && r.status() >= 500)
      apiErrors.push(`${r.request().method()} ${url.pathname} ${r.status()}`);
  });
}

/** The session's own CSRF token, as the browser client sends it. */
async function csrfOf(page: Page): Promise<string> {
  const session = (await sessionOf(page)) as unknown as { csrf_token: string };
  return session.csrf_token;
}

/** A compiler-shaped Qloo person reference, as photo resolution writes it. */
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
 * The deterministic photo fixture (same shape as the photo journeys): the
 * public sample photo's bytes, a capture row in the real storage layout, and
 * a reviewed fixture analysis authorizing one depicted Rodin reference. It is
 * labeled "Example result" on the page and is never live model qualification.
 */
async function seedSupportedCapture(accountId: string, rodinReferenceId: string): Promise<string> {
  const captureId = await journeyDb().transaction(async (tx) => {
    const cap = await tx.query<{ id: string }>(
      `INSERT INTO captures (owner_account_id, source, sample_id, image_sha256, width, height, status)
       VALUES ($1, 'sample', 'room', $2, 1000, 1250, 'ready') RETURNING id`,
      [accountId, `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.padEnd(64, '0')],
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
      [id, 'A reviewed example reading prepared for this journey.'],
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
  const file = path.join(STORAGE_DIR, `owners/a-${accountId}/captures/${captureId}/derivative.jpg`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(ROOM_SAMPLE));
  writeFileSync(`${file}.meta`, JSON.stringify({ contentType: 'image/jpeg' }));
  return captureId;
}

function mailTime(file: string): number {
  const iso = file.slice(0, 19).replace(/T(\d\d)-(\d\d)-(\d\d)$/, 'T$1:$2:$3');
  return new Date(`${iso}Z`).getTime();
}

/** Newest identity mail for this address since `after` (the file mailbox is local-dev only). */
async function mailFor(email: string, after: number): Promise<{ callback: string }> {
  let found: { callback: string } | undefined;
  await expect
    .poll(() => {
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
    }, { timeout: 20_000 })
    .toBe(true);
  return found!;
}

/** The fresh email-link account questionnaire: three image-tile picks, then Build. */
async function answerQuestionnaire(page: Page) {
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  for (const image of ['Tea rituals', 'Linen days', 'Sunday listening'])
    await page.getByRole('button', { name: image }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  for (let step = 0; step < 3; step++) {
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (!(await next.isVisible())) break;
    await next.click();
  }
  await page.getByRole('button', { name: 'Build my feed' }).click();
  await expect(page).not.toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  await expect
    .poll(() =>
      page
        .evaluate(async () => (await fetch('/v1/onboarding/state', { cache: 'no-store' })).json())
        .then((s: { required: boolean }) => s.required !== true),
    )
    .toBe(true);
}

/** The password Settings-prompt account (no email verification needed). */
async function createPasswordAccount(page: Page, email: string, name: string) {
  await page.goto('/settings');
  const prompt = page.getByRole('button', { name: 'Create account' }).first();
  await expect(prompt).toBeVisible();
  await page.getByLabel('Your name').fill(name);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel('Password').fill('a fine password');
  await prompt.click();
  await expect(page).toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  await expect(page.locator('.pick-counter')).toHaveText('3 picks to go', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Tea rituals' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('2 picks to go');
  await page.getByRole('button', { name: 'Late-night cinema' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('1 pick to go');
  await page.getByRole('button', { name: 'Sesame noodles' }).click();
  await expect(page.locator('.pick-counter')).toHaveText('Ready');
  // Picks save as they are made; wait until all three are durable server-side.
  await expect
    .poll(
      async () =>
        ((await (await page.request.get('/v1/onboarding/state')).json()) as {
          state: { picks_count: number };
        }).state.picks_count,
      { timeout: 15_000 },
    )
    .toBeGreaterThanOrEqual(3);
  // Below 768px the Build button only shows on step 3 (onboarding.css).
  for (let step = 0; step < 3; step++) {
    const next = page.getByRole('button', { name: 'Next', exact: true });
    if (!(await next.isVisible())) break;
    await next.click();
  }
  await page.getByRole('button', { name: 'Build my feed' }).click();
  await expect(page).not.toHaveURL(/\/welcome\/taste/, { timeout: 30_000 });
  // "Build my feed" only navigates after the server accepts completion, then
  // completion must be durable before navigating anywhere else.
  await expect
    .poll(
      async () =>
        ((await (await page.request.get('/v1/onboarding/state')).json()) as {
          state: { required: boolean };
        }).state.required,
      { timeout: 30_000 },
    )
    .toBe(false);
  await page.goto('/settings');
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 30_000 });
}

test('settings deletion ends a live private journey: revoke at once, fence late workers, purge truthfully, preserve the rest', async (
  { browser },
  info: TestInfo,
) => {
  test.setTimeout(900_000);
  const stamp = Date.now();
  const emailA = `deletion-live-a-${stamp}@journey.test`;
  const emailB = `deletion-live-b-${stamp}@journey.test`;
  const apiErrors: string[] = [];
  const paidBefore = await paidModelAttempts();

  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  trackErrors(pageA, apiErrors);
  const dialog = pageA.getByRole('dialog', { name: 'Save to a collection' });
  let contextB: BrowserContext | null = null;
  let pageB: Page | null = null;

  await test.step('onboarding: a verified email-link account with a real first save', async () => {
    await pageA.goto('/library');
    await expect(pageA.getByText('Your library is private.')).toBeVisible();
    await pageA.getByRole('banner').getByRole('link', { name: 'Sign in' }).click();
    await expect(pageA).toHaveURL(/\/identity$/);
    await pageA.getByLabel('Email').fill(emailA);
    const mailStartedAt = Date.now();
    await pageA.getByRole('button', { name: 'Email verification link' }).click();
    await expect(pageA.locator('main p[role="status"]')).toContainText('If eligible, your email has a verification link');
    const mail = await mailFor(emailA, mailStartedAt);
    await pageA.goto(mail.callback);
    await answerQuestionnaire(pageA);
    await pageA.goto('/');
    await expect(pageA.getByRole('heading', { name: 'Find more of what you love.' })).toBeVisible();
    const ninaCard = pageA.getByRole('listitem').filter({ hasText: NINA }).first();
    await ninaCard.getByRole('button', { name: `Save ${NINA}` }).click();
    await expect(dialog.getByRole('radio', { name: 'New collection' })).toBeVisible();
    await dialog.getByRole('radio', { name: 'New collection' }).check({ force: true });
    await dialog.getByLabel('Collection name').fill(COLLECTION);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
  });

  const sessionA = await sessionOf(pageA);
  expect(sessionA.principal.kind).toBe('account');
  const accountId = sessionA.principal.account_id!;
  const sessionCookie = (await contextA.cookies(BASE)).find((c) => c.name === SESSION_COOKIE)!.value;
  const csrfToken = await csrfOf(pageA);

  let rodinItem = '';
  let seuratItem = '';
  await test.step('fixtures: the reviewed references and the account’s own items on them', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    const seuratRef = await qlooPersonReference(SEURAT_QLOO_ID, SEURAT);
    await linkGraphReferenceIdentities(journeyDb());
    rodinItem = await accountItem(accountId, rodinRef, RODIN_QLOO_ID, RODIN, 'French sculptor, 1840–1917');
    seuratItem = await accountItem(accountId, seuratRef, SEURAT_QLOO_ID, SEURAT, 'French painter, 1859–1891');
  });

  await test.step('save Rodin: a confirmed personal root with real projection', async () => {
    await pageA.goto(`/items/${rodinItem}`);
    await expect(pageA.getByRole('heading', { name: RODIN, level: 1 })).toBeVisible();
    await pageA.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: COLLECTION }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
    await waitForProjectionReady(accountId);
    expect(
      (await supportRows(accountId)).some((r) => r.origin_kind === 'saved_item' && r.discovery_item_id === rodinItem && r.active),
    ).toBe(true);
  });

  let personalRecId = '';
  await test.step('the personal-root card reaches the feed with its pinned Why this', async () => {
    await waitForExpansionRuns(accountId, 1);
    await expect
      .poll(
        async () => {
          const seen = pageA
            .waitForResponse((r) => new URL(r.url()).pathname === '/v1/discoveries', { timeout: 15_000 })
            .catch(() => null);
          await pageA.goto('/');
          await seen;
          await pageA.waitForTimeout(800);
          return pageA.getByRole('listitem').filter({ hasText: SEURAT }).count();
        },
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(1);
    const feedCard = pageA.getByRole('listitem').filter({ hasText: SEURAT }).first();
    await feedCard.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(pageA.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    personalRecId = pageA.url().match(/rec=([0-9a-f-]{36})/)![1]!;
    await pageA.getByRole('button', { name: 'Why this?' }).click();
    await expect(pageA.locator('.connection__roots')).toContainText(`Because you saved ${RODIN}.`);
    await expect(pageA.locator('.connection__path')).toContainText(`${RODIN} — work on display at — Art Institute of Chicago`);
    await shot(pageA, info, 'deletionlive-01-feed-personal-reason');
  });

  let captureId = '';
  let captureImageUrl = '';
  await test.step('the supported photo path: a labeled deterministic prepared capture with a photo reason', async () => {
    const rodinRef = await qlooPersonReference(RODIN_QLOO_ID, RODIN);
    captureId = await seedSupportedCapture(accountId, rodinRef);
    const runsBefore = await scalar(
      'SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = $2 AND state = $3',
      [accountId, 'expansion', 'complete'],
    );
    await pageA.goto(`/captures/${captureId}`);
    await expect(pageA.getByRole('heading', { name: 'Discoveries' })).toBeVisible();
    // Deterministic, labeled: a sample capture with a reviewed reading — never a live model claim.
    await expect(pageA.getByText('Example result').first()).toBeVisible();
    await pageA.getByRole('button', { name: 'Save this inspiration' }).click();
    await dialog.getByRole('radio', { name: 'Save for later' }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText('Saved for later').first()).toBeVisible();
    await waitForProjectionReady(accountId);
    await waitForExpansionRuns(accountId, runsBefore + 1);
    await expect
      .poll(
        async () => {
          const seen = pageA
            .waitForResponse((r) => new URL(r.url()).pathname === `/v1/captures/${captureId}`, { timeout: 15_000 })
            .catch(() => null);
          await pageA.goto(`/captures/${captureId}`);
          await seen;
          await pageA.waitForTimeout(800);
          return (
            pageA
              .getByRole('list', { name: 'Discoveries from your photo' })
              .getByRole('listitem')
              .filter({ hasText: SEURAT })
              .count()
          );
        },
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(1);
    const photoCard = pageA
      .getByRole('list', { name: 'Discoveries from your photo' })
      .getByRole('listitem')
      .filter({ hasText: SEURAT })
      .first();
    await photoCard.getByRole('link', { name: new RegExp(SEURAT) }).click();
    await expect(pageA.getByRole('heading', { name: SEURAT, level: 1 })).toBeVisible();
    await pageA.getByRole('button', { name: 'Why this?' }).click();
    await expect(pageA.locator('.connection__roots')).toContainText(`Because your photo shows ${RODIN}.`);
    await shot(pageA, info, 'deletionlive-02-photo-reason');
  });

  let runsBaseline = 0;
  await test.step('a real media-worker upload is verified and prepared', async () => {
    await pageA.goto('/uploads');
    await expect(pageA.getByText('No uploads in progress.')).toBeVisible();
    await pageA.getByTestId('uploads-input').setInputFiles([ROOM_SAMPLE]);
    const rows = pageA.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await expect(rows.filter({ hasText: 'room.jpg' })).toContainText('Ready', { timeout: 120_000 });
    const asset = await one<{ id: string; kind: string; status: string }>(
      'SELECT id, kind, status FROM media_assets WHERE account_id = $1',
      [accountId],
    );
    expect(asset).toMatchObject({ kind: 'photo', status: 'ready' });
    // The real journey produced completed expansion runs before deletion; the
    // purge later removes them with the account and no late worker recreates
    // any (checked in the release step).
    runsBaseline = await scalar(
      'SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = $2 AND state = $3',
      [accountId, 'expansion', 'complete'],
    );
    expect(runsBaseline).toBeGreaterThanOrEqual(1);
    // The two storage namespaces the purge must clear (the v2 multipart store
    // places its object keys under capture-v2/objects/).
    expect(existsSync(path.join(STORAGE_DIR, 'owners', `a-${accountId}`))).toBe(true);
    expect(existsSync(path.join(STORAGE_DIR, 'capture-v2', 'objects', 'accounts', accountId))).toBe(true);
    await shot(pageA, info, 'deletionlive-03-upload-ready');
  });

  let agentCredential = '';
  await test.step('an agent connection is created through the real UI and works', async () => {
    await pageA.goto('/settings/agents');
    await pageA.getByRole('link', { name: 'Connect agent' }).click();
    await expect(pageA).toHaveURL(/\/settings\/agents\/new/);
    await pageA.getByLabel('Agent name').fill('Journey helper');
    await pageA.getByLabel('View selected collections').check();
    await pageA.getByLabel('Library access').selectOption('all');
    await pageA.getByRole('button', { name: 'Connect agent' }).click();
    const secret = pageA.getByLabel('Agent credential');
    await expect(secret).toBeVisible({ timeout: 30_000 });
    agentCredential = await secret.inputValue();
    expect(agentCredential).toMatch(/^cat_/);
    await shot(pageA, info, 'deletionlive-04-agent-credential');
    // Positive control: the exact credential can read the account's collections.
    const res = await fetch(`${BASE}/v1/collections`, {
      headers: { authorization: `Bearer ${agentCredential}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { collections: { name: string }[] };
    expect(body.collections.some((c) => c.name === COLLECTION)).toBe(true);
  });

  let shareLink = '';
  await test.step('a link share on the account’s collection works for a stranger', async () => {
    const collection = await one<{ id: string }>('SELECT id FROM collections WHERE owner_account_id = $1 AND name = $2', [
      accountId,
      COLLECTION,
    ]);
    expect(collection).toBeTruthy();
    await pageA.goto(`/collections/${collection!.id}/share`);
    await pageA.getByLabel('Who can view').selectOption('link');
    await pageA.getByLabel(/I understand that anyone who has the link/).check();
    await pageA.getByRole('button', { name: 'Save sharing settings' }).click();
    const field = pageA.getByLabel('Link (shown once)');
    await expect(field).toBeVisible({ timeout: 30_000 });
    shareLink = await field.inputValue();
    expect(shareLink).toMatch(/\/shared#share=/);
    // Positive control: a stranger with the link sees the shared collection.
    const contextStranger = await browser.newContext();
    const pageStranger = await contextStranger.newPage();
    trackErrors(pageStranger, apiErrors);
    await pageStranger.goto(shareLink);
    await expect(pageStranger.getByRole('heading', { name: COLLECTION })).toBeVisible({ timeout: 30_000 });
    // The collection's saved items are visible to the stranger with the link.
    await expect(pageStranger.getByRole('heading', { name: NINA })).toBeVisible();
    await expect(pageStranger.getByRole('heading', { name: RODIN })).toBeVisible();
    await shot(pageStranger, info, 'deletionlive-05-share-live');
    await contextStranger.close();
  });

  let accountBId = '';
  let supportBaselineB = 0;
  await test.step('a second account exists with its own private state', async () => {
    contextB = await browser.newContext();
    pageB = await contextB.newPage();
    trackErrors(pageB, apiErrors);
    await createPasswordAccount(pageB!, emailB, 'Del Two');
    const sessionB = await sessionOf(pageB!);
    expect(sessionB.principal.kind).toBe('account');
    accountBId = sessionB.principal.account_id!;
    await waitForProjectionReady(accountBId);
    supportBaselineB = (await supportRows(accountBId)).length;
    expect(supportBaselineB).toBeGreaterThanOrEqual(1);
  });

  let pageTab2: Page | null = null;
  let releaseHeld = (): void => undefined;
  await test.step('a second tab of the account parks on its private Taste holding a live response', async () => {
    pageTab2 = await contextA.newPage();
    trackErrors(pageTab2, apiErrors);
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
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
    await pageTab2.evaluate(() => {
      document.documentElement.setAttribute('data-deletion-journey-probe', 'a-live');
    });
  });

  let heldCaptureId = '';
  let heldJobId = '';
  await test.step('hold the real workers and queue fresh media/graph work behind them', async () => {
    stopService('worker');
    stopService('media_worker');
    // The held services are really down.
    expect(spawnSync('sh', [CONTROL, 'health', 'worker']).status).not.toBe(0);
    expect(spawnSync('sh', [CONTROL, 'health', 'media_worker']).status).not.toBe(0);

    // Owed graph work: an explicit save arms projection + expansion intent.
    const revisionBefore = await tasteRevision(accountId);
    await pageA.goto(`/items/${seuratItem}`);
    await pageA.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.getByRole('radio', { name: COLLECTION }).check({ force: true });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(pageA.getByText(`Saved to ${COLLECTION}`).first()).toBeVisible();
    await expect.poll(async () => (await tasteRevision(accountId)) > revisionBefore, { timeout: 15_000 }).toBe(true);
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1 AND dispatch_state = 'pending'`, [
        accountId,
      ]))?.n ?? 0,
    ).toBeGreaterThanOrEqual(1);

    // Owed media work: a v1 photo whose analysis job is queued, not started.
    await pageA.goto('/capture/photo');
    await pageA.getByTestId('upload-input').setInputFiles([ROOM_SAMPLE]);
    await expect(pageA.getByRole('img', { name: 'Your selected photo' })).toBeVisible();
    await pageA.getByRole('button', { name: 'Discover', exact: true }).click();
    await expect(pageA).toHaveURL(/\/captures\//);
    heldCaptureId = new URL(pageA.url()).pathname.split('/').pop()!;
    await expect(pageA.getByRole('heading', { level: 1 })).toHaveText('Finding your next favorites…', { timeout: 30_000 });
    await shot(pageA, info, 'deletionlive-06-analysis-pending');
    const heldJob = await one<{ id: string; state: string }>(
      `SELECT id, state FROM jobs WHERE result_type = 'capture' AND result_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [heldCaptureId],
    );
    expect(heldJob?.state).toBe('queued');
    heldJobId = heldJob!.id;
    expect((await one<{ status: string }>('SELECT status FROM captures WHERE id = $1', [heldCaptureId]))?.status).toBe('pending');

    // Owed media work: a v2 upload waiting for its media-worker verify, which
    // never starts (the honest "Checking file" in-progress state).
    await pageA.goto('/uploads');
    await pageA.getByTestId('uploads-input').setInputFiles([CAFE_SAMPLE]);
    const rows = pageA.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(rows.filter({ hasText: 'cafe.jpg' })).toContainText('Checking file', { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          (
            await one<{ n: number }>(`SELECT count(*) AS n FROM capture_work WHERE account_id = $1 AND state IN ('queued','running')`, [
              accountId,
            ])
          )?.n ?? 0,
        { timeout: 30_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await shot(pageA, info, 'deletionlive-07-upload-pending');
  });

  let statusToken = '';
  await test.step('cancel once: every private surface and every owed job survives unchanged', async () => {
    await pageA.goto('/settings');
    const entry = pageA.getByRole('link', { name: /Delete account/ });
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(pageA).toHaveURL(/\/settings\/deletion/);
    await expect(pageA.getByRole('heading', { name: 'Delete your account' })).toBeVisible();
    // The disclosure is the server's own, including the job-cancellation promise.
    await expect(
      pageA
        .getByText(
          'Every queued or running analysis, discovery, research and graph job for the account is cancelled and can never publish.',
        )
        .first(),
    ).toBeVisible();
    await shot(pageA, info, 'deletionlive-08-disclosure');
    await pageA.getByRole('link', { name: 'Back to settings' }).click();
    await expect(pageA).toHaveURL(/\/settings$/);
    expect((await sessionOf(pageA)).principal.kind).toBe('account');
    // The private surfaces still work for the owner.
    await pageA.goto('/settings/taste');
    await expect(pageA.getByRole('link', { name: RODIN, exact: true })).toBeVisible();
    // Nothing changed durably: no tombstone, no deletion record, no cancellation.
    expect((await one<{ deleted_at: Date | null }>('SELECT deleted_at FROM accounts WHERE id = $1', [accountId]))?.deleted_at ?? null).toBeNull();
    expect(await one('SELECT account_id FROM account_deletions WHERE account_id = $1', [accountId])).toBeUndefined();
    expect((await one<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [heldJobId]))?.state).toBe('queued');
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM capture_work WHERE account_id = $1 AND state IN ('queued','running')`, [
        accountId,
      ]))?.n ?? 0,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1 AND dispatch_state = 'pending'`, [
        accountId,
      ]))?.n ?? 0,
    ).toBeGreaterThanOrEqual(1);
    await shot(pageA, info, 'deletionlive-09-cancel-unchanged');
  });

  await test.step('confirm: acceptance revokes every old authority at once', async () => {
    // The old signed media URL for the prepared capture, captured while the
    // account is still alive and re-checked before the signing TTL can pass:
    // after the purge its 404 must be the purged object, not expired time.
    const captureDetail = (await (await pageA.request.get(`/v1/captures/${captureId}`)).json()) as {
      image: { url: string } | null;
    };
    captureImageUrl = captureDetail.image?.url ?? '';
    expect(captureImageUrl).toMatch(/\/v1\/media\?/);
    await pageA.goto('/settings/deletion');
    await pageA.getByRole('button', { name: 'Delete my account' }).click();
    await expect(pageA.getByRole('heading', { name: /Your account is being deleted/ })).toBeVisible({ timeout: 30_000 });
    await expect(pageA.getByText(/still removing your private data|Cleanup is in progress/).first()).toBeVisible();

    // The acceptance is durable and fences everything.
    await expect
      .poll(async () => (await one<{ deleted_at: Date | null }>(`SELECT deleted_at FROM accounts WHERE id = $1`, [accountId]))?.deleted_at ?? null)
      .not.toBeNull();
    const deletion = await one<{ cleanup_state: string; completed_steps: string[] }>(
      'SELECT cleanup_state, completed_steps FROM account_deletions WHERE account_id = $1',
      [accountId],
    );
    expect(deletion?.cleanup_state).toBe('pending');
    expect(deletion?.completed_steps).toEqual([]);
    // The queued jobs are cancelled now and can never run.
    expect((await one<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [heldJobId]))?.state).toBe('cancelled');
    expect(await one(`SELECT id FROM capture_work WHERE account_id = $1 AND state IN ('queued','running')`, [accountId])).toBeUndefined();
    // Every credential surface is revoked in the same transaction.
    expect((await one<{ n: number }>(`SELECT count(*) AS n FROM sessions WHERE account_id = $1 AND revoked_at IS NULL`, [accountId]))?.n ?? 0).toBe(0);
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM agent_connections WHERE owner_account_id = $1 AND revoked_at IS NULL`, [
        accountId,
      ]))?.n ?? 0,
    ).toBe(0);
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM collection_shares WHERE owner_account_id = $1 AND revoked_at IS NULL`, [
        accountId,
      ]))?.n ?? 0,
    ).toBe(0);
    // The graph replay kills are in place.
    expect(
      (await one<{ n: number }>(`SELECT count(*) AS n FROM feature_flag_kills WHERE account_id = $1 AND reason = 'account_deletion'`, [
        accountId,
      ]))?.n ?? 0,
    ).toBe(4);

    // The deleting browser is anonymous now, and the one-time token is kept.
    expect((await sessionOf(pageA)).principal.kind).toBe('anonymous');
    statusToken = await pageA.evaluate(() =>
      (JSON.parse(window.localStorage.getItem('atlas.account-deletion.v1') ?? 'null') as { status_token: string } | null)?.status_token ?? '',
    );
    expect(statusToken).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    await shot(pageA, info, 'deletionlive-10-accepted');
  });

  await test.step('the account’s other tab reloads and never renders the deleted account’s private state', async () => {
    // The acceptance broadcast reloaded tab 2 (the probe document is gone)…
    await expect
      .poll(async () => pageTab2!.evaluate(() => document.documentElement.getAttribute('data-deletion-journey-probe')), {
        timeout: 30_000,
      })
      .toBeNull();
    // …so the held private response released AFTER the acceptance belongs to a
    // dead document, and the reloaded tab is the anonymous truth.
    releaseHeld();
    await pageTab2!.waitForTimeout(1_500);
    await expect(pageTab2!.getByRole('heading', { name: 'Background discovery' })).toHaveCount(0);
    await expect(pageTab2!.getByText(RODIN)).toHaveCount(0);
    expect((await sessionOf(pageTab2!)).principal.kind).toBe('anonymous');
    await shot(pageTab2!, info, 'deletionlive-11-other-tab-cleared');
  });

  await test.step('the exact old credentials lose private access', async () => {
    // The browser session cookie: the owner route answers a denial, not the account.
    const ownerRead = await fetch(`${BASE}/v2/me/account-deletion`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}` },
    });
    expect(ownerRead.status).toBeGreaterThanOrEqual(400);
    // The private Taste the old cookie used to read: revoked means signed out,
    // so this owner-agnostic route answers with the empty anonymous view —
    // and never with the deleted account's private taste.
    const tasteRead = await fetch(`${BASE}/v1/taste`, { headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}` } });
    const tasteText = await tasteRead.text();
    expect(tasteText).not.toMatch(/Tea rituals|Linen days|Sunday listening|Simone|Rodin/);
    expect(JSON.parse(tasteText)).toMatchObject({ saved_count: 0, interests: [], hidden_count: 0 });
    // A duplicate acceptance cannot recreate authority or re-run anything.
    const deletionCountBefore = await scalar('SELECT count(*) AS n FROM account_deletions WHERE account_id = $1', [accountId]);
    const duplicate = await fetch(`${BASE}/v2/me/account-deletion`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${sessionCookie}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: csrfToken,
        'x-atlas-expected-account': accountId,
      },
      body: JSON.stringify({ confirm: true, status_token: 'x'.repeat(43) }),
    });
    expect(duplicate.status).toBeGreaterThanOrEqual(400);
    expect(await scalar('SELECT count(*) AS n FROM account_deletions WHERE account_id = $1', [accountId])).toBe(deletionCountBefore);
    expect(await scalar(`SELECT count(*) AS n FROM jobs WHERE dedupe_key = 'purge_account:' || $1::text`, [accountId])).toBe(1);
    // The pinned recommendation connection is gone for the old authority.
    const connection = await fetch(`${BASE}/v2/me/recommendations/${personalRecId}/connection`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie}` },
    });
    expect(connection.status).toBeGreaterThanOrEqual(400);
    // The agent credential: the same bearer that read the collections is denied.
    const agentRead = await fetch(`${BASE}/v1/collections`, { headers: { authorization: `Bearer ${agentCredential}` } });
    expect(agentRead.status).toBeGreaterThanOrEqual(400);
    const agentBody = (await agentRead.json().catch(() => ({}))) as { collections?: unknown };
    expect(agentBody.collections).toBeUndefined();
    // The share link: a stranger with the exact link now sees the revoked state.
    const contextStranger = await browser.newContext();
    const pageStranger = await contextStranger.newPage();
    trackErrors(pageStranger, apiErrors);
    await pageStranger.goto(shareLink);
    await expect(pageStranger.getByRole('heading', { name: 'This collection is no longer shared.' })).toBeVisible({ timeout: 30_000 });
    await shot(pageStranger, info, 'deletionlive-12-share-revoked');
    await contextStranger.close();
  });

  await test.step('release the held workers: late producers never recreate, the real purge runs', async () => {
    const workerLog = await startService('worker', '[worker] starting');
    await startService('media_worker', '[media-worker]');
    // Both services are healthy again through the manifest's own control.
    expect(spawnSync('sh', [CONTROL, 'health', 'worker']).status).toBe(0);
    expect(spawnSync('sh', [CONTROL, 'health', 'media_worker']).status).toBe(0);

    // The durable purge runs to completion on the real worker, and the
    // held-worker release log records the real cleanup.
    await expect
      .poll(
        async () =>
          (await one<{ cleanup_state: string }>('SELECT cleanup_state FROM account_deletions WHERE account_id = $1', [accountId]))
            ?.cleanup_state,
        { timeout: 180_000 },
      )
      .toBe('complete');
    await expect
      .poll(async () => readFileSync(workerLog, 'utf8').includes('account purge complete'), { timeout: 30_000 })
      .toBe(true);

    // The released worker never executed the cancelled analysis: no provider
    // call, no analysis row, no capture recreation.
    expect(
      await scalar(
        `SELECT count(*) AS n FROM provider_queries pq JOIN analyses a ON a.id = pq.analysis_id WHERE a.capture_id = $1`,
        [heldCaptureId],
      ),
    ).toBe(0);
    expect(await scalar('SELECT count(*) AS n FROM analyses WHERE capture_id = $1', [heldCaptureId])).toBe(0);
    // The released sweeper/dispatcher never created new graph work for the
    // account: the expansion runs recorded before deletion were purged with
    // the account, and no late worker recreated any (graph_outbox holds no
    // pending intents either).
    expect(
      await scalar('SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1', [accountId]),
    ).toBe(0);
    expect(
      await scalar('SELECT count(*) AS n FROM graph_outbox WHERE owner_account_id = $1 AND dispatch_state <> $2', [accountId, 'done']),
    ).toBe(0);

    // The former media URL is dead: the signed URL was still unexpired (its
    // exp is in the future), so this 404 is the purged object, not time.
    const exp = Number(new URL(captureImageUrl).searchParams.get('exp'));
    expect(exp * 1000).toBeGreaterThan(Date.now());
    const formerMedia = await fetch(captureImageUrl);
    expect(formerMedia.status).toBe(404);
  });

  await test.step('the page reports completion only when the server says so', async () => {
    await expect
      .poll(async () => pageA.getByRole('heading', { name: 'Your account is deleted' }).isVisible(), { timeout: 120_000 })
      .toBe(true);
    await expect(pageA.getByText(/All of your private data has been removed/)).toBeVisible();
    await shot(pageA, info, 'deletionlive-13-complete');
    // The one-time token keeps answering the public route with no session;
    // a wrong token discloses nothing.
    const status = await pageA.request.get('/v2/account-deletion/status', {
      headers: { 'x-atlas-deletion-token': statusToken },
    });
    expect(status.ok()).toBeTruthy();
    const body = (await status.json()) as { status: { state: string; completed_steps: string[] } };
    expect(body.status.state).toBe('complete');
    expect(body.status.completed_steps).toEqual(['media_objects', 'private_rows']);
    const wrong = await pageA.request.get('/v2/account-deletion/status', {
      headers: { 'x-atlas-deletion-token': 'x'.repeat(43) },
    });
    expect(wrong.status()).toBe(404);
  });

  await test.step('the isolated DB/storage inventory: the account is gone, the corpus and account B remain', async () => {
    // The account row itself is gone — the airtight fence.
    expect(await one('SELECT id FROM accounts WHERE id = $1', [accountId])).toBeUndefined();
    // Every private store is empty for the account.
    for (const [table, column] of [
      ['sessions', 'account_id'],
      ['captures', 'owner_account_id'],
      ['discovery_items', 'owner_account_id'],
      ['saved_items', 'owner_account_id'],
      ['collections', 'owner_account_id'],
      ['preference_events', 'owner_account_id'],
      ['taste_profiles', 'owner_account_id'],
      ['personal_graph_state', 'owner_account_id'],
      ['personal_interest_edges', 'owner_account_id'],
      ['personal_interest_support', 'owner_account_id'],
      ['graph_outbox', 'owner_account_id'],
      ['graph_runs', 'owner_account_id'],
      ['jobs', 'owner_account_id'],
      ['capture_work', 'account_id'],
      ['upload_sessions', 'account_id'],
      ['media_assets', 'account_id'],
      ['agent_connections', 'owner_account_id'],
      ['native_sessions', 'account_id'],
      ['collection_shares', 'owner_account_id'],
      ['share_sessions', 'owner_account_id'],
      ['mobile_installations', 'account_id'],
    ] as const) {
      expect(await scalar(`SELECT count(*) AS n FROM ${table} WHERE ${column} = $1`, [accountId]), `${table} for the deleted account`).toBe(0);
    }
    // The durable deletion record intentionally outlives the account row.
    expect(
      await one<{ cleanup_state: string; completed_steps: string[] }>(
        'SELECT cleanup_state, completed_steps FROM account_deletions WHERE account_id = $1',
        [accountId],
      ),
    ).toMatchObject({ cleanup_state: 'complete' });
    // The system-owned purge job completed.
    expect(
      (await one<{ state: string }>(`SELECT state FROM jobs WHERE dedupe_key = 'purge_account:' || $1::text`, [accountId]))?.state,
    ).toBe('complete');
    // Both private storage namespaces are purged: no account media object
    // bytes remain in either the v1 store or the v2 multipart store, and no
    // empty account directory shell survives the purge either.
    expect(countFiles(path.join(STORAGE_DIR, 'owners', `a-${accountId}`))).toBe(0);
    expect(countFiles(path.join(STORAGE_DIR, 'capture-v2', 'objects', 'accounts', accountId))).toBe(0);
    expect(existsSync(path.join(STORAGE_DIR, 'owners', `a-${accountId}`))).toBe(false);
    expect(existsSync(path.join(STORAGE_DIR, 'capture-v2', 'objects', 'accounts', accountId))).toBe(false);
    // The shared namespace roots survive for sibling accounts and sessions.
    expect(existsSync(path.join(STORAGE_DIR, 'owners'))).toBe(true);
    expect(existsSync(path.join(STORAGE_DIR, 'capture-v2', 'objects', 'accounts'))).toBe(true);

    // The reviewed shared corpus survives untouched.
    expect(
      await scalar(`SELECT count(*) AS n FROM graph_nodes WHERE canonical_key IN ('atlas:creator:auguste-rodin', 'atlas:creator:georges-seurat')`),
    ).toBe(2);
    expect(await scalar('SELECT count(*) AS n FROM sources')).toBeGreaterThanOrEqual(13);

    // The second account survives with its private state intact and its
    // session still working.
    expect(await one('SELECT id FROM accounts WHERE id = $1', [accountBId])).toBeTruthy();
    expect((await supportRows(accountBId)).length).toBe(supportBaselineB);
    await pageB!.goto('/settings');
    await expect(pageB!.getByRole('button', { name: 'Sign out' })).toBeVisible();
    const sessionB = await sessionOf(pageB!);
    expect(sessionB.principal.kind).toBe('account');
    expect(sessionB.principal.account_id).toBe(accountBId);
    await shot(pageB!, info, 'deletionlive-14-second-account-preserved');
  });

  await test.step('honesty gates: the paid ledger never moved and no 5xx occurred', async () => {
    expect(await paidModelAttempts()).toBe(paidBefore);
    expect(apiErrors).toEqual([]);
    // The release log is the held-worker evidence: surface its relevant lines.
    const relevant = readFileSync(path.join(LOG_DIR, 'worker-release.log'), 'utf8')
      .split('\n')
      .filter((l) => /starting|purge|cancel|account/i.test(l))
      .slice(0, 12);
    console.log(`[deletion-live] held-worker release log lines:\n${relevant.join('\n')}`);
  });

  await test.step('cleanup: close the journey contexts', async () => {
    await contextB!.close();
    await contextA.close();
  });
});
