import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';

/**
 * Design fidelity for capture platform v2 references 01–09 against the REAL
 * stack (production build, job worker, media worker, PostgreSQL, S3-compatible
 * storage and an SESv2-compatible mail endpoint). Nothing in the app is mocked:
 * the library is seeded through the real identity, device and upload APIs with
 * the project's own illustrations (fixtures/capture-v2, public/samples), and
 * the media worker prepares every photo and video with ffmpeg.
 *
 * Two phases, run in order (see docs/design-fidelity-v2-capture.md):
 *  - V2_FIDELITY_PHASE=main: server started WITH the experimental glasses
 *    rollout variables, so the web hand-off (04), the glasses device view (05)
 *    and glasses-sourced media exist. Seeds once (state in test-results), then
 *    captures 01–08 at 1440, 390 and 320 px.
 *  - V2_FIDELITY_PHASE=unavailable: server restarted WITHOUT them; captures 09.
 *
 * Network conditions the references depict ("Uploading 62%", "Upload paused")
 * are produced with Playwright routing on the storage PUT requests: a held
 * part stays in flight and an aborted part is a lost connection. Those are
 * real client states, not injected data.
 */

const MAIL_DIR = process.env.V2_FIDELITY_MAIL_DIR ?? '';
const PHASE = process.env.V2_FIDELITY_PHASE ?? 'main';
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3200';
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const OUT = path.join(import.meta.dirname, '..', 'screenshots', 'fidelity', 'v2-capture');
// Outside test-results (Playwright empties that on every run); .data/ is git-ignored.
const WORK = path.join(ROOT, '.data', 'v2-fidelity');
const STATE = path.join(WORK, 'state.json');
const SIGNATURE_PREFIX = JSON.parse(
  readFileSync(path.join(ROOT, 'fixtures/native-contract/enrollment-signature.json'), 'utf8'),
).payload_prefix as string;

test.skip(!MAIL_DIR, 'V2_FIDELITY_MAIL_DIR (where the mail endpoint writes) is required');
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 30_000, navigationTimeout: 45_000 });

type Viewport = { name: 'desktop' | 'mobile' | 'narrow'; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow', width: 320, height: 700 },
];
const contextOptions = (v: Viewport) => ({
  viewport: { width: v.width, height: v.height },
  deviceScaleFactor: v.name === 'desktop' ? 1 : 2,
  isMobile: v.name !== 'desktop',
  hasTouch: v.name !== 'desktop',
  reducedMotion: 'reduce' as const,
  baseURL: BASE,
});

interface SavedState {
  email: string;
  cookies: Awaited<ReturnType<BrowserContext['cookies']>>;
  phone: { accountId: string; installationId: string; refresh: string; sequence: number };
  /** Media that belong in the library composition; everything else is cleaned up. */
  keep: string[];
  video: string;
}

// ---------------------------------------------------------------------------
// Fixture media: the project's illustrations, encoded with ffmpeg.

const ff = (...args: string[]) =>
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const IMG = (p: string) => path.join(ROOT, p);
const media = (name: string) => path.join(WORK, 'media', name);

/** A slow push-in over one still: a quiet phone clip without audio. */
function clip(
  src: string,
  seconds: number,
  out: string,
  opts: { webm?: boolean; kbps?: number; size?: string } = {},
) {
  const [w, h] = (opts.size ?? '1280x960').split('x').map(Number);
  const frames = seconds * 24;
  const vf = `scale=${w! * 2}:${h! * 2},zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=24,noise=alls=6:allf=t,format=yuv420p`;
  const codec = opts.webm
    ? [
        '-c:v',
        'libvpx-vp9',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-b:v',
        `${opts.kbps ?? 1200}k`,
      ]
    : [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-b:v',
        `${opts.kbps ?? 1200}k`,
        '-movflags',
        '+faststart',
      ];
  ff('-loop', '1', '-i', src, '-t', String(seconds), '-vf', vf, ...codec, '-an', out);
}

function prepareMedia() {
  mkdirSync(path.join(WORK, 'media'), { recursive: true });
  const stills: Record<string, string> = {
    'quiet-corners.jpg': 'fixtures/capture-v2/quiet-corners.jpg',
    'slow-morning.jpg': 'apps/web/public/samples/cafe.jpg',
    'olive-layers.jpg': 'fixtures/capture-v2/olive-layers.jpg',
    'record-shop.jpg': 'apps/web/public/samples/feed/sunday-listening.jpg',
    'made-by-hand.jpg': 'apps/web/public/capture/source-hero.jpg',
    'green-spaces.jpg': 'fixtures/capture-v2/green-spaces.jpg',
    'village-alley.jpg': 'fixtures/capture-v2/village-alley.jpg',
    'cafe.jpg': 'apps/web/public/samples/cafe.jpg',
    'pottery.jpg': 'apps/web/public/capture/source-hero.jpg',
  };
  for (const [name, src] of Object.entries(stills))
    if (!existsSync(media(name))) ff('-i', IMG(src), '-q:v', '3', media(name));
  if (!existsSync(media('along-the-coast.mp4')))
    clip(IMG('fixtures/capture-v2/along-the-coast.jpg'), 42, media('along-the-coast.mp4'));
  if (!existsSync(media('afternoon-walk.mp4')))
    clip(IMG('fixtures/capture-v2/afternoon-walk.jpg'), 18, media('afternoon-walk.mp4'));
  if (!existsSync(media('a-slower-afternoon.mp4'))) {
    // Eight 5.25 s scenes cycling the cup, the room, the lamps and the window
    // table, so the media worker's evenly spaced moments show each in turn.
    const scenes = [
      'apps/web/public/samples/cafe.jpg',
      'fixtures/capture-v2/cafe-interior.jpg',
      'fixtures/capture-v2/cafe-lamps.jpg',
      'fixtures/capture-v2/cafe-window.jpg',
    ].map((src, i) => {
      const out = media(`slower-${i}.mp4`);
      ff(
        '-loop',
        '1',
        '-i',
        IMG(src),
        '-t',
        '5.25',
        '-r',
        '24',
        '-vf',
        'scale=1280:960:force_original_aspect_ratio=increase,crop=1280:720,format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-an',
        out,
      );
      return out;
    });
    const list = media('slower.txt');
    writeFileSync(list, [...scenes, ...scenes].map((p) => `file '${p}'`).join('\n'));
    ff(
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      media('a-slower-afternoon.mp4'),
    );
  }
  // Browser uploads use WebM: Playwright's Chromium has no MP4 demuxer, so the
  // client could not read an MP4's duration for the "Video · 42 sec" line.
  // Over 8 MiB so the transfer has a second part to hold.
  for (const name of ['coast.webm', 'walk.webm', 'harbour.webm'])
    if (!existsSync(media(name)))
      clip(IMG('fixtures/capture-v2/along-the-coast.jpg'), 42, media(name), {
        webm: true,
        kbps: 2400,
        size: '960x720',
      });
  if (!existsSync(media('room.webm')))
    clip(IMG('fixtures/capture-v2/quiet-corners.jpg'), 28, media('room.webm'), {
      webm: true,
      kbps: 700,
      size: '1600x1200',
    });
  // The camera preview: Chromium's fake camera plays this file.
  if (!existsSync(media('terrace.y4m')))
    ff(
      '-loop',
      '1',
      '-i',
      IMG('apps/web/public/samples/cafe.jpg'),
      '-t',
      '1',
      '-r',
      '10',
      '-vf',
      'scale=960:1200,crop=900:1200,format=yuv420p',
      media('terrace.y4m'),
    );
}

// ---------------------------------------------------------------------------
// Mail, browser session and a native client (the same HTTP rules the apps follow).

async function mailFor(email: string, after: number): Promise<string> {
  let link = '';
  await expect
    .poll(
      () => {
        for (const f of readdirSync(MAIL_DIR).filter((n) => n.endsWith('.json'))) {
          const file = path.join(MAIL_DIR, f);
          if (statSync(file).mtimeMs < after - 2000) continue;
          const mail = JSON.parse(readFileSync(file, 'utf8')) as { to: string; callback: string };
          if (mail.to === email) link = mail.callback;
        }
        return link;
      },
      { timeout: 20_000 },
    )
    .not.toBe('');
  return link;
}

async function browserHeaders(page: Page): Promise<Record<string, string>> {
  const session = await (await page.request.get('/v1/session')).json();
  return {
    'x-csrf-token': session.csrf_token,
    'x-atlas-expected-account': session.principal.account_id,
    'idempotency-key': randomUUID(),
    'content-type': 'application/json',
  };
}

class Phone {
  accountId = '';
  installationId = '';
  access = '';
  refresh = '';
  sequence = 0;
  async call(method: string, route: string, body?: unknown, auth = true, expected?: string) {
    const headers: Record<string, string> = {};
    if (auth) headers.authorization = `Bearer ${this.access}`;
    if (method !== 'GET') {
      headers['idempotency-key'] = randomUUID();
      headers['x-atlas-expected-account'] = expected ?? this.accountId;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(route, BASE), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wire JSON, asserted at use
    return { status: res.status, body: (text ? JSON.parse(text) : null) as any };
  }
  async enroll(email: string) {
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const started = Date.now();
    const start = await this.call(
      'POST',
      '/v2/identity/email/start',
      {
        email,
        purpose: 'sign_in',
        destination: 'android',
        state,
        nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      },
      false,
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const fragment = new URLSearchParams(new URL(await mailFor(email, started)).hash.slice(1));
    const complete = await this.call(
      'POST',
      '/v2/identity/email/complete',
      {
        challenge_id: fragment.get('challenge_id'),
        token: fragment.get('token'),
        state,
        nonce,
        code_verifier: verifier,
      },
      false,
    );
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    const grant = complete.body as { account_id: string; enrollment_grant: string };
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { x, y } = key.publicKey.export({ format: 'jwk' });
    const jwk = { kty: 'EC', crv: 'P-256', x, y };
    const publicId = randomUUID();
    const challenge = await this.call(
      'POST',
      '/v2/devices/enrollment/challenge',
      {
        enrollment_grant: grant.enrollment_grant,
        installation_public_id: publicId,
        platform: 'android',
        public_key: jwk,
      },
      false,
      grant.account_id,
    );
    expect(challenge.status, JSON.stringify(challenge.body)).toBe(201);
    const payload = [
      SIGNATURE_PREFIX,
      challenge.body.nonce,
      publicId,
      'android',
      createHash('sha256').update(grant.enrollment_grant).digest('hex'),
    ].join('\n');
    const signature = sign('sha256', Buffer.from(payload), {
      key: key.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const enrolled = await this.call(
      'POST',
      '/v2/devices/enroll',
      {
        platform: 'android',
        app_version: '1.0.0',
        installation_public_id: publicId,
        enrollment_grant: grant.enrollment_grant,
        proof: { nonce: challenge.body.nonce, signature, public_key: jwk },
        capabilities: { photo: true, video: true, meta_glasses_sdk: true },
      },
      false,
      grant.account_id,
    );
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBe(201);
    this.accountId = grant.account_id;
    this.installationId = enrolled.body.installation.id;
    this.access = enrolled.body.native_session.access_token;
    this.refresh = enrolled.body.native_session.refresh_token;
  }
  async rotate() {
    const res = await this.call(
      'POST',
      '/v2/identity/native/refresh',
      {
        refresh_token: this.refresh,
        installation_id: this.installationId,
        refresh_request_id: randomBytes(32).toString('base64url'),
      },
      false,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    this.access = res.body.access_token;
    this.refresh = res.body.refresh_token;
  }
  /** Foreground, ready, with its Meta glasses registered through the SDK. */
  async heartbeat() {
    const res = await this.call('PUT', '/v2/device/status', {
      sequence: ++this.sequence,
      capabilities: {
        photo: true,
        video: true,
        meta_glasses: true,
        meta_wearables_sdk: true,
        meta_wearables_supported_os: true,
      },
      readiness: 'ready',
      app_state: 'foreground',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  async upload(file: string, o: { kind: 'photo' | 'video'; source: string; type: string }) {
    const bytes = readFileSync(file);
    await this.heartbeat();
    const created = await this.call('POST', '/v2/uploads', {
      client_capture_id: randomUUID(),
      kind: o.kind,
      source: o.source,
      filename: path.basename(file),
      content_type: o.type,
      byte_size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const {
      upload_id: uploadId,
      asset_id: assetId,
      part_size: partSize,
      part_count: count,
    } = created.body;
    const numbers = Array.from({ length: count }, (_, i) => i + 1);
    const parts = await this.call('POST', `/v2/uploads/${uploadId}/parts`, {
      part_numbers: numbers,
    });
    expect(parts.status, JSON.stringify(parts.body)).toBe(200);
    const receipts = [];
    for (const p of parts.body.parts) {
      const put = await fetch(p.url, {
        method: 'PUT',
        headers: p.headers,
        body: bytes.subarray((p.part_number - 1) * partSize, p.part_number * partSize),
      });
      expect(put.status).toBe(200);
      receipts.push({ part_number: p.part_number, etag: put.headers.get('etag')! });
    }
    const done = await this.call('POST', `/v2/uploads/${uploadId}/complete`, { parts: receipts });
    expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
    return assetId as string;
  }
}

async function waitReady(page: Page, ids: string[]) {
  for (const id of ids)
    await expect
      .poll(async () => (await (await page.request.get(`/v2/media/${id}`)).json()).media?.status, {
        timeout: 180_000,
        intervals: [1000],
      })
      .toBe('ready');
}

async function setTitle(page: Page, id: string, title: string) {
  const detail = await (await page.request.get(`/v2/media/${id}`)).json();
  const res = await page.request.patch(`/v2/media/${id}`, {
    headers: await browserHeaders(page),
    data: { title, expected_revision: detail.revision },
  });
  expect(res.status(), await res.text()).toBe(200);
}

// ---------------------------------------------------------------------------
// Network conditions on the storage PUT requests (S3 presigned part URLs).

const isPart = (route: Route) =>
  route.request().method() === 'PUT' && /[?&]partNumber=\d+/.test(route.request().url());
/** Part 2 never answers: the transfer stays in flight after part 1 (about 60 %). */
async function holdSecondParts(context: BrowserContext) {
  await context.route(
    (url) => /[?&]partNumber=2(&|$)/.test(url.search),
    (route) => {
      if (!isPart(route)) return route.continue();
      // Never fulfilled: the browser keeps the request open.
    },
  );
}
/** Every part fails like a dropped connection while `on` is true. */
function dropParts(context: BrowserContext) {
  const state = { on: false };
  void context.route(
    (url) => /[?&]partNumber=\d+/.test(url.search),
    (route) => (state.on && isPart(route) ? route.abort('internetdisconnected') : route.fallback()),
  );
  return state;
}

async function addFiles(page: Page, testId: string, files: string[]) {
  await page.getByTestId(testId).setInputFiles(files);
}

// ---------------------------------------------------------------------------

async function shot(page: Page, name: string, v: Viewport, fullPage = false) {
  await page.addStyleTag({
    content: 'nextjs-portal{display:none!important} *{caret-color:transparent!important}',
  });
  if (fullPage)
    await page.evaluate(() =>
      document
        .querySelectorAll('img[loading="lazy"]')
        .forEach((i) => i.setAttribute('loading', 'eager')),
    );
  // Not settleImages: held transfers keep the network busy, so wait for
  // decoded images directly, with a bound.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  await page
    .waitForFunction(
      (all) =>
        Array.from(document.images)
          .filter((img) => {
            if (all) return true;
            const r = img.getBoundingClientRect();
            return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
          })
          .every((img) => img.complete && img.naturalWidth > 0),
      fullPage,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(400);
  await expectNoHorizontalScroll(page);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({
    path: path.join(OUT, `${name}-${v.name}.png`),
    fullPage,
    animations: 'disabled',
  });
}

/** Server errors fail loudly with their body (the stack must stay healthy). */
function watchErrors(context: BrowserContext) {
  context.on('response', (r) => {
    if (r.status() >= 500)
      void r.text().then(
        (body) => console.error(`${r.request().method()} ${r.url()} ${r.status()} ${body}`),
        () => undefined,
      );
  });
  return context;
}
const profileDir = (name: string) => path.join(WORK, 'profiles', name);
async function profile(name: string, v: Viewport, args: string[] = []) {
  return watchErrors(
    await chromium.launchPersistentContext(profileDir(name), { ...contextOptions(v), args }),
  );
}

function loadState(): SavedState {
  return JSON.parse(readFileSync(STATE, 'utf8')) as SavedState;
}
function saveState(s: SavedState) {
  writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

test('seed the library through the real stack', async ({ browser }) => {
  test.skip(PHASE !== 'main' || existsSync(STATE), 'already seeded');
  test.setTimeout(900_000);
  prepareMedia();
  const email = `fidelity-${Date.now()}@example.com`;

  // 1. Sign up in the browser with the email link.
  const context = await browser.newContext(contextOptions(VIEWPORTS[0]!));
  const page = await context.newPage();
  // Open the app first so the anonymous browser session exists before sign-in
  // starts (the challenge is bound to the session that asked for it).
  await page.goto('/library');
  await expect(page.getByText('Your library is private.')).toBeVisible();
  await page.goto('/identity');
  await page.getByLabel('Email').fill(email);
  const started = Date.now();
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await page.goto(await mailFor(email, started));
  await expect(page).toHaveURL(/\/library$/, { timeout: 30_000 });
  const cookies = await context.cookies();

  // 2. Library profiles start their own transfers first, so the seeded media
  //    (newer) lead the grid as in the references: two in flight on desktop,
  //    one paused by a lost connection on each phone width.
  for (const v of VIEWPORTS) {
    const ctx = await profile(`library-${v.name}`, v);
    await ctx.addCookies(cookies);
    const drop = dropParts(ctx);
    await holdSecondParts(ctx);
    const p = ctx.pages()[0] ?? (await ctx.newPage());
    await p.goto('/uploads');
    await expect(p.getByText('No uploads in progress.')).toBeVisible();
    if (v.name === 'desktop') {
      await addFiles(p, 'uploads-input', [media('walk.webm'), media('harbour.webm')]);
      await expect(p.getByText(/Uploading \d+%/)).toHaveCount(2, { timeout: 60_000 });
    } else {
      drop.on = true;
      await addFiles(p, 'uploads-input', [media('pottery.jpg')]);
      await expect(p.getByText('Upload paused')).toBeVisible({ timeout: 60_000 });
    }
    await ctx.close();
  }

  // 3. The owner's phone, with its glasses, adds the rest (oldest first).
  const phone = new Phone();
  await phone.enroll(email);
  const glassesConnection = await phone.call('POST', '/v2/device/wearables', {
    sdk_reference: 'fidelity-glasses',
    display_name: 'Ray-Ban Meta',
    capabilities: { photo: true, video: true },
    permission_state: 'granted',
  });
  expect(glassesConnection.status, JSON.stringify(glassesConnection.body)).toBe(201);
  const jpeg = { kind: 'photo' as const, type: 'image/jpeg' };
  const mp4 = { kind: 'video' as const, type: 'video/mp4' };
  const plan: Array<[string, string, { kind: 'photo' | 'video'; type: string; source: string }]> = [
    ['a-slower-afternoon.mp4', 'A slower afternoon', { ...mp4, source: 'meta_glasses' }],
    ['village-alley.jpg', 'Whitewashed steps', { ...jpeg, source: 'phone_camera' }],
    ['green-spaces.jpg', 'Green spaces', { ...jpeg, source: 'phone_camera' }],
    ['made-by-hand.jpg', 'Made by hand', { ...jpeg, source: 'upload' }],
    ['afternoon-walk.mp4', 'Afternoon walk', { ...mp4, source: 'phone_camera' }],
    ['record-shop.jpg', 'Record shop', { ...jpeg, source: 'phone_camera' }],
    ['along-the-coast.mp4', 'Along the coast', { ...mp4, source: 'meta_glasses' }],
    ['olive-layers.jpg', 'Olive layers', { ...jpeg, source: 'upload' }],
    ['slow-morning.jpg', 'A slow morning', { ...jpeg, source: 'phone_camera' }],
    ['quiet-corners.jpg', 'Quiet corners', { ...jpeg, source: 'meta_glasses' }],
  ];
  const ids: string[] = [];
  for (const [file, title, o] of plan) {
    const id = await phone.upload(media(file), o);
    await waitReady(page, [id]);
    await setTitle(page, id, title);
    ids.push(id);
  }
  const library = await (await page.request.get('/v2/library?limit=100')).json();
  saveState({
    email,
    cookies,
    phone: {
      accountId: phone.accountId,
      installationId: phone.installationId,
      refresh: phone.refresh,
      sequence: phone.sequence,
    },
    // Seeded media plus the library profiles' own transfers.
    keep: library.items.map((i: { media: { id: string } }) => i.media.id),
    video: ids[0]!,
  });
  await context.close();
});

/** Removes media a previous screenshot run added (uploads screen), keeping the composition. */
async function cleanUp(page: Page, keep: string[]) {
  const library = await (await page.request.get('/v2/library?limit=100')).json();
  const extra = library.items.filter((i: { media: { id: string } }) => !keep.includes(i.media.id));
  if (!extra.length) return;
  const res = await page.request.post('/v2/media/batch-delete', {
    headers: await browserHeaders(page),
    data: {
      items: extra.map((i: { media: { id: string }; generation: number }) => ({
        id: i.media.id,
        expected_generation: i.generation,
      })),
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

test('capture platform v2 screens 01–08 on the real stack', async ({ browser }) => {
  test.skip(PHASE !== 'main', 'main phase only');
  test.setTimeout(900_000);
  prepareMedia();
  const s = loadState();
  const phone = new Phone();
  Object.assign(phone, s.phone);
  await phone.rotate();
  // Heartbeat sequences only move forward; skip past any a failed run used.
  phone.sequence += 1000;
  saveState({ ...s, phone: { ...s.phone, refresh: phone.refresh, sequence: phone.sequence } });

  const admin = await browser.newContext(contextOptions(VIEWPORTS[0]!));
  await admin.addCookies(s.cookies);
  const adminPage = await admin.newPage();
  await cleanUp(adminPage, s.keep);

  for (const v of VIEWPORTS) {
    await test.step(`01/08 library ${v.name}`, async () => {
      const ctx = await profile(`library-${v.name}`, v);
      await holdSecondParts(ctx);
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.goto('/library');
      await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeVisible();
      await expect(
        page
          .getByRole('status')
          .filter({ hasText: v.name === 'desktop' ? '2 files uploading' : '1 upload paused' })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await shot(page, v.name === 'desktop' ? '01-library' : '08-library', v);
      await ctx.close();
    });
  }

  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext(contextOptions(v));
    await ctx.addCookies(s.cookies);
    const page = await ctx.newPage();

    await test.step(`02 source ${v.name}`, async () => {
      await page.goto('/capture');
      await expect(
        page.getByRole('heading', { name: 'Keep what catches your eye.' }),
      ).toBeVisible();
      await shot(page, '02-source', v, true);
    });

    await test.step(`04 glasses connect ${v.name}`, async () => {
      await page.goto('/settings/devices/glasses');
      await expect(page.getByRole('heading', { name: 'Connect your glasses' })).toBeVisible();
      await shot(page, '04-glasses-connect', v, true);
    });

    await test.step(`05 glasses ready ${v.name}`, async () => {
      await phone.heartbeat();
      // The server ignores a sequence it has already seen; keep it for the next run.
      saveState({ ...loadState(), phone: { ...loadState().phone, sequence: phone.sequence } });
      await page.goto(`/settings/devices/${s.phone.installationId}`);
      await expect(page.getByText('Ready to capture')).toBeVisible();
      await shot(page, '05-glasses-ready', v, true);
    });

    await test.step(`07 video detail ${v.name}`, async () => {
      await page.goto(`/library/media/${s.video}`);
      await expect(
        page.getByRole('heading', { level: 1, name: 'A slower afternoon' }),
      ).toBeVisible();
      const moments = page.getByRole('button', { name: /^Moment at / });
      await expect(moments.first()).toBeVisible();
      // The second moment (the room), as in the reference.
      await moments.nth(1).click();
      await shot(page, '07-video-detail', v, v.name !== 'desktop');
    });
    await ctx.close();
  }

  // 03: the browser camera, Chromium's fake device playing an illustration.
  const camera = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${media('terrace.y4m')}`,
    ],
  });
  for (const v of VIEWPORTS) {
    await test.step(`03 camera ${v.name}`, async () => {
      const ctx = await camera.newContext(contextOptions(v));
      await ctx.addCookies(s.cookies);
      await ctx.grantPermissions(['camera', 'microphone'], { origin: BASE });
      const page = await ctx.newPage();
      await page.goto('/capture/camera?start=1');
      await page.getByRole('button', { name: 'Video', exact: true }).click();
      // The reference shows the microphone on: an explicit choice, never the default.
      await page.getByRole('button', { name: 'Microphone off' }).click();
      await page.getByRole('button', { name: 'Start recording' }).click();
      await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
      await expectNoHorizontalScroll(page);
      await expect(page.getByRole('timer')).toContainText('Recording 0:12', { timeout: 20_000 });
      // Straight away, while the timer still reads 0:12.
      await page.screenshot({
        path: path.join(OUT, `03-camera-${v.name}.png`),
        animations: 'disabled',
      });
      await page.getByRole('button', { name: 'Stop recording' }).click();
      await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
      await page.getByRole('button', { name: 'Delete' }).click();
      await ctx.close();
    });
  }
  await camera.close();

  // 06: a fresh transfer queue per width, in the reference's order.
  for (const v of VIEWPORTS) {
    await test.step(`06 uploads ${v.name}`, async () => {
      const ctx = await browser.newContext(contextOptions(v));
      await ctx.addCookies(s.cookies);
      const drop = dropParts(ctx);
      await holdSecondParts(ctx);
      const page = await ctx.newPage();
      await page.goto('/uploads');
      await expect(page.getByText('No uploads in progress.')).toBeVisible();
      const rows = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
      await addFiles(page, 'uploads-input', [media('cafe.jpg')]);
      await expect(rows.filter({ hasText: 'cafe.jpg' })).toContainText('Ready', {
        timeout: 60_000,
      });
      await addFiles(page, 'uploads-input', [media('coast.webm')]);
      await expect(rows.filter({ hasText: 'coast.webm' })).toContainText(/Uploading \d+%/, {
        timeout: 60_000,
      });
      await addFiles(page, 'uploads-input', [media('room.webm')]);
      await expect(rows.filter({ hasText: 'room.webm' })).toContainText(
        /Checking file|Preparing video/,
        { timeout: 60_000 },
      );
      drop.on = true;
      await addFiles(page, 'uploads-input', [media('pottery.jpg')]);
      await expect(rows.filter({ hasText: 'pottery.jpg' })).toContainText('Upload paused', {
        timeout: 30_000,
      });
      await expect(rows.filter({ hasText: 'room.webm' })).toContainText('Preparing video', {
        timeout: 60_000,
      });
      await shot(page, '06-uploads', v, v.name === 'desktop');
      await ctx.close();
    });
  }
  await cleanUp(adminPage, s.keep);
  await admin.close();
});

test('capture platform v2 screen 09 (glasses not enabled) on the real stack', async ({
  browser,
}) => {
  test.skip(PHASE !== 'unavailable', 'unavailable phase only');
  const s = loadState();
  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext(contextOptions(v));
    await ctx.addCookies(s.cookies);
    const page = await ctx.newPage();
    await page.goto('/capture/glasses');
    await expect(page.getByRole('heading', { name: 'Not available yet' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your library is unchanged.' })).toBeVisible();
    await shot(page, '09-glasses-unavailable', v, true);
    await ctx.close();
  }
});
