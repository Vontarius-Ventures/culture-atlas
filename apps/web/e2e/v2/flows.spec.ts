/**
 * Behaviour of the v2 capture web UI against the contract-validated /v2 mock:
 * navigation, library states and selection, resumable uploads (no duplicates),
 * media detail, glasses eligibility/hand-off and devices.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';
import { FIXTURES, LIBRARY_SEED, openV2, seedUploadQueue, VIDEO_SEED } from './mock-v2';

const isDesktop = (name: string) => name === 'desktop';
const fixture = (name: string) => path.join(FIXTURES, name);
const fileOf = (name: string, mimeType: string) => ({
  name,
  mimeType,
  buffer: readFileSync(fixture(name)),
});

async function noSeriousAxe(page: Page) {
  // Let finite entry animations (the toast's `rise` fade) finish: axe measures
  // contrast on the computed colors, so a half-faded toast fails at random.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  const results = await new AxeBuilder({ page }).exclude('nextjs-portal').analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(serious.map((v) => `${v.id}: ${v.nodes[0]?.target}`)).toEqual([]);
}

test.describe('navigation', () => {
  test('four destinations, Capture as a separate action, Settings secondary', async ({
    page,
  }, testInfo) => {
    await openV2(page, '/library', { media: LIBRARY_SEED.slice(0, 2) });
    const nav = isDesktop(testInfo.project.name)
      ? page.getByRole('banner').getByRole('navigation', { name: 'Primary' })
      : page.locator('nav.bottom-nav');
    await expect(nav.getByRole('link')).toHaveText(['Discover', 'Library', 'Collections', 'Plans']);
    await expect(nav.getByRole('link', { name: 'Library' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('link', { name: 'Settings' }).first()).toBeVisible();
    if (isDesktop(testInfo.project.name))
      await expect(page.getByRole('banner').getByRole('link', { name: 'Capture' })).toBeVisible();
    else {
      // Capture is a distinct action in the (same-on-every-route) header, apart from the
      // four destinations in the bottom bar; Settings stays reachable there too.
      const capture = page.getByRole('banner').getByRole('link', { name: 'Capture' });
      await expect(capture).toBeVisible();
      await expect(page.getByRole('banner').getByRole('link', { name: 'Settings' })).toBeVisible();
      const navBox = (await nav.boundingBox())!;
      const capBox = (await capture.boundingBox())!;
      expect(capBox.y + capBox.height).toBeLessThanOrEqual(navBox.y + 1);
    }
    await expectNoHorizontalScroll(page);
  });

  test('camera and media detail have no bottom bar', async ({ page }) => {
    const v2 = await openV2(page, '/capture/camera', { media: [VIDEO_SEED] });
    await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
    await expect(page.locator('nav.bottom-nav')).toHaveCount(0);
    await page.goto(`/library/media/${[...v2.media.keys()][0]}`);
    await expect(page.getByRole('heading', { level: 1, name: 'A slower afternoon' })).toBeVisible();
    await expect(page.locator('nav.bottom-nav')).toHaveCount(0);
  });

  test('/library/:id redirects to /library/media/:id', async ({ page }) => {
    const v2 = await openV2(page, '', { media: [VIDEO_SEED] });
    const id = [...v2.media.keys()][0]!;
    await page.goto(`/library/${id}`);
    await expect(page).toHaveURL(new RegExp(`/library/media/${id}$`));
  });

  test('legacy photo discovery stays reachable at /capture/photo', async ({ page }) => {
    await openV2(page, '/capture/photo', { account: false });
    await expect(page.getByRole('heading', { name: 'Capture something you like.' })).toBeVisible();
  });
});

test.describe('library', () => {
  test('signed-out visitors see the private-library sign-in state', async ({ page }) => {
    const v2 = await openV2(page, '/library', { account: false });
    await expect(page.getByRole('heading', { name: 'Your library is private.' })).toBeVisible();
    // One sign-in path: the panel and the header both start the email sign-in.
    await expect(page.getByRole('main').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/identity',
    );
    await expect(page.getByRole('banner').getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/identity',
    );
    expect(v2.log.filter((r) => r.path === '/v2/library')).toHaveLength(0);
  });

  test('a failed load explains and retries', async ({ page }) => {
    await openV2(page, '/library', { media: LIBRARY_SEED, libraryFailures: 1 });
    await expect(
      page.getByRole('alert').filter({ hasText: 'temporarily unavailable' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeVisible();
  });

  test('empty library invites camera or upload', async ({ page }) => {
    await openV2(page, '/library');
    await expect(page.getByRole('heading', { name: 'Nothing kept yet.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open camera' })).toHaveAttribute(
      'href',
      '/capture/camera?start=1',
    );
    await expect(page.getByRole('button', { name: 'Upload files' }).last()).toBeVisible();
    await noSeriousAxe(page);
  });

  test('filters ask the server for photos or videos; Uploading shows in-flight media', async ({
    page,
  }) => {
    const v2 = await openV2(page, '/library', {
      media: [
        ...LIBRARY_SEED,
        {
          title: 'Still preparing',
          kind: 'video',
          source: 'upload',
          status: 'processing',
          image: 'living-room.jpg',
        },
      ],
    });
    await expect(page.getByRole('link', { name: 'Still preparing' })).toBeVisible();
    // Unfinished preparation does not hide media and is described in words.
    await expect(page.getByText('Upload · Preparing video').first()).toBeAttached();
    await page.getByRole('button', { name: 'Videos', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Along the coast' })).toBeVisible();
    expect(v2.log.some((r) => r.path === '/v2/library')).toBe(true);
    await page.getByRole('button', { name: 'Uploading', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Still preparing' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Along the coast' })).toHaveCount(0);
  });

  test('select, then delete with confirmation (batch, per-item generations)', async ({ page }) => {
    const v2 = await openV2(page, '/library', { media: LIBRARY_SEED });
    await page
      .getByRole('button', { name: 'Select', exact: true })
      .or(page.getByRole('checkbox', { name: 'Select', exact: true }))
      .first()
      .click();
    // dispatchEvent: on phones a card can sit under the fixed Capture dock until scrolled.
    await page.getByRole('checkbox', { name: 'Select Quiet corners' }).dispatchEvent('click');
    await page.getByRole('checkbox', { name: 'Select Record shop' }).dispatchEvent('click');
    const region = page.getByRole('region', { name: 'Selection' });
    await expect(region).toContainText('2 selected');
    await region.getByRole('button', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete 2 items?' });
    await expect(dialog).toContainText('not touched');
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Record shop' })).toHaveCount(0);
    const del = v2.log.find((r) => r.path === '/v2/media/batch-delete');
    expect((del!.body as { items: unknown[] }).items).toHaveLength(2);
  });

  test('save selected media to a collection', async ({ page }) => {
    const v2 = await openV2(page, '/library', { media: LIBRARY_SEED, seedCollections: true });
    await page
      .getByRole('button', { name: 'Select', exact: true })
      .or(page.getByRole('checkbox', { name: 'Select', exact: true }))
      .first()
      .click();
    await page.getByRole('checkbox', { name: 'Select Olive layers' }).dispatchEvent('click');
    await page
      .getByRole('region', { name: 'Selection' })
      .getByRole('button', { name: 'Save to collection' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Save to a collection' });
    await dialog.getByRole('button', { name: /Slow Sunday/ }).click();
    await expect(page.getByText('Saved 1 item to Slow Sunday').first()).toBeVisible();
    expect(
      v2.log.some((r) => r.method === 'PUT' && /^\/v2\/collections\/[^/]+\/media\//.test(r.path)),
    ).toBe(true);
  });
});

test.describe('uploads', () => {
  test('adds files with per-file results: accepted files finish, rejected ones say why', async ({
    page,
  }) => {
    const v2 = await openV2(page, '/uploads');
    await expect(page.getByText('No uploads in progress.')).toBeVisible();
    await page
      .getByTestId('uploads-input')
      .setInputFiles([
        fileOf('quiet-corners.jpg', 'image/jpeg'),
        { name: 'holiday.heic', mimeType: 'image/heic', buffer: Buffer.from('not really') },
        { name: 'renamed.png', mimeType: 'image/jpeg', buffer: Buffer.from('jpeg bytes') },
      ]);
    const rows = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: 'holiday.heic' })).toContainText(
      'HEIC photos are not supported yet',
    );
    await expect(rows.filter({ hasText: 'renamed.png' })).toContainText(
      'does not match its contents',
    );
    await expect(rows.filter({ hasText: 'quiet-corners.jpg' })).toContainText('Ready', {
      timeout: 15_000,
    });
    await expect(page.getByText('Uploading does not start analysis.')).toBeVisible();
    const creates = v2.log.filter((r) => r.method === 'POST' && r.path === '/v2/uploads');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({
      kind: 'photo',
      source: 'upload',
      content_type: 'image/jpeg',
      filename: 'quiet-corners.jpg',
    });
    expect((creates[0]!.body as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
    // Nothing asked for analysis.
    expect(v2.log.some((r) => r.path.includes('/analysis'))).toBe(false);
    await rows.filter({ hasText: 'quiet-corners.jpg' }).getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/library\/media\//);
    await noSeriousAxe(page);
  });

  test('a dropped connection pauses; Retry resumes the same upload without duplicates', async ({
    page,
  }) => {
    const v2 = await openV2(page, '/uploads', { failParts: true });
    await page.getByTestId('uploads-input').setInputFiles(fixture('olive-layers.jpg'));
    const row = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(row).toContainText('Upload paused');
    v2.opts.failParts = false;
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect(row).toContainText('Ready', { timeout: 15_000 });
    expect(v2.log.filter((r) => r.method === 'POST' && r.path === '/v2/uploads')).toHaveLength(1);
    // Resume asked the server first.
    const uploadId = [...v2.uploads.keys()][0]!;
    expect(v2.log.some((r) => r.method === 'GET' && r.path === `/v2/uploads/${uploadId}`)).toBe(
      true,
    );
    expect(v2.log.filter((r) => r.path.endsWith('/complete'))).toHaveLength(1);
  });

  test('after a reload the queue resumes from the server receipts (only missing parts move)', async ({
    page,
  }) => {
    const v2 = await openV2(page, '/uploads');
    // The first page's queue has loaded (empty) before rows are written behind its back.
    await expect(page.getByText('No uploads in progress.')).toBeVisible();
    const id = '10000000-0000-4000-8000-000000000077';
    const size = 9_000_000; // two 8 MiB parts
    const up = v2.seedUpload(
      id,
      {
        client_capture_id: id,
        kind: 'video',
        source: 'upload',
        filename: 'walk.mp4',
        content_type: 'video/mp4',
        byte_size: size,
        sha256: 'a'.repeat(64),
      },
      [1],
    );
    await seedUploadQueue(page, v2.accountId!, [
      {
        client_capture_id: id,
        filename: 'walk.mp4',
        kind: 'video',
        content_type: 'video/mp4',
        byte_size: size,
        phase: 'uploading',
        withBlob: true,
        upload_id: up.id,
        asset_id: up.assetId,
        receipts: [],
      },
    ]);
    v2.log.length = 0;
    await page.reload();
    const row = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(row).toContainText('Ready', { timeout: 15_000 });
    expect(v2.log.some((r) => r.method === 'POST' && r.path === '/v2/uploads')).toBe(false);
    const parts = v2.log.find((r) => r.path.endsWith('/parts'));
    expect(parts?.body).toEqual({ part_numbers: [2] });
    expect(v2.partLog).toEqual([`${up.id}/2`]);
    const complete = v2.log.find((r) => r.path.endsWith('/complete'));
    expect((complete!.body as { parts: unknown[] }).parts).toHaveLength(2);
  });

  test('Pause stops the transfer, Cancel aborts it on the server', async ({ page }) => {
    const v2 = await openV2(page, '/uploads', { holdParts: true });
    await expect(page.getByText('No uploads in progress.')).toBeVisible();
    const id = '10000000-0000-4000-8000-000000000088';
    const up = v2.seedUpload(
      id,
      {
        client_capture_id: id,
        kind: 'video',
        source: 'upload',
        filename: 'long.mp4',
        content_type: 'video/mp4',
        byte_size: 9_000_000,
        sha256: 'a'.repeat(64),
      },
      [1],
    );
    await seedUploadQueue(page, v2.accountId!, [
      {
        client_capture_id: id,
        filename: 'long.mp4',
        kind: 'video',
        content_type: 'video/mp4',
        byte_size: 9_000_000,
        phase: 'uploading',
        withBlob: true,
        upload_id: up.id,
        asset_id: up.assetId,
      },
    ]);
    await page.reload();
    const row = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '93');
    await row.getByRole('button', { name: 'Pause' }).click();
    await expect(row).toContainText('Paused. Your file is still selected.');
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toHaveCount(0);
    expect(v2.log.some((r) => r.method === 'DELETE' && r.path === `/v2/uploads/${up.id}`)).toBe(
      true,
    );
  });

  test("another account's local drafts stay locked and can be deleted unseen", async ({ page }) => {
    const v2 = await openV2(page, '/uploads');
    await seedUploadQueue(page, v2.accountId!, [
      {
        filename: 'secret.jpg',
        kind: 'photo',
        content_type: 'image/jpeg',
        byte_size: 1000,
        phase: 'queued',
        withBlob: true,
        account_id: '99999999-0000-4000-8000-000000000001',
      },
    ]);
    await page.reload();
    await expect(
      page.getByText('1 file from another account is kept on this device.', { exact: false }),
    ).toBeVisible();
    await expect(page.getByText('secret.jpg')).toHaveCount(0);
    expect(v2.log.some((r) => r.method === 'POST' && r.path === '/v2/uploads')).toBe(false);
    await page.getByRole('button', { name: 'Delete local drafts' }).click();
    await expect(page.getByText('from another account')).toHaveCount(0);
  });

  test('video uploads unavailable on the server are explained per file; photos continue', async ({
    page,
  }) => {
    await openV2(page, '/uploads', { videoUploads: false });
    await page
      .getByTestId('uploads-input')
      .setInputFiles([fixture('coast.mp4'), fixture('made-by-hand.jpg')]);
    const rows = page.getByRole('list', { name: 'Uploads' }).getByRole('listitem');
    await expect(rows.filter({ hasText: 'made-by-hand.jpg' })).toContainText('Ready', {
      timeout: 15_000,
    });
    await expect(rows.filter({ hasText: 'coast.mp4' })).toContainText(
      'Video uploads are not qualified on this server.',
    );
  });
});

test.describe('media detail', () => {
  test('player is muted by default with labelled controls; delete confirms and returns to the library', async ({
    page,
  }) => {
    const v2 = await openV2(page, '', { media: [VIDEO_SEED] });
    const id = [...v2.media.keys()][0]!;
    await page.goto(`/library/media/${id}`);
    await expect(page.locator('video.player__video')).toHaveJSProperty('muted', true);
    await expect(page.getByRole('slider', { name: 'Seek' })).toBeVisible();
    await page.getByRole('button', { name: 'Unmute' }).click();
    await expect(page.getByRole('button', { name: 'Mute' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Exploring is unavailable (no qualified model): the button explains why.
    await expect(page.getByRole('button', { name: 'Explore this video' })).toBeDisabled();
    await expect(
      page.getByText('Exploration is temporarily unavailable. Your video stays in your library.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'More' }).click();
    await expect(page.getByRole('link', { name: 'Download original' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete from library' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/library$/);
    const del = v2.log.find((r) => r.method === 'DELETE' && r.path === `/v2/media/${id}`);
    expect(del?.body).toEqual({ expected_generation: 1 });
    await noSeriousAxe(page);
  });

  test('exploring a selected moment sends that frame', async ({ page }) => {
    const v2 = await openV2(page, '', { media: [VIDEO_SEED], analysis: true });
    const id = [...v2.media.keys()][0]!;
    await page.goto(`/library/media/${id}`);
    await page.getByRole('button', { name: 'Moment at 0:24' }).click();
    await page.getByRole('button', { name: 'Explore this moment' }).click();
    await expect(page.getByText(/Exploring this moment/)).toBeVisible();
    const req = v2.log.find((r) => r.method === 'POST' && r.path === `/v2/media/${id}/analysis`);
    expect(req?.body).toMatchObject({
      mode: 'selected_frame',
      timestamp_ms: 24_000,
      expected_generation: 1,
    });
    // Cancel really cancels the request on the server (not only the polling).
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Explore this moment' })).toBeEnabled();
    expect(
      v2.log.some((r) => r.method === 'DELETE' && r.path.startsWith(`/v2/media/${id}/analysis/`)),
    ).toBe(true);
  });

  test('a partial video result opens like a complete one instead of polling forever', async ({
    page,
  }) => {
    const capture = '00000000-0000-4000-8000-00000000c0de';
    const v2 = await openV2(page, '', {
      media: [VIDEO_SEED],
      analysis: true,
      analysisStates: [
        { state: 'running' },
        { state: 'partial', capture_id: capture, result_url: `/captures/${capture}` },
      ],
    });
    const id = [...v2.media.keys()][0]!;
    await page.goto(`/library/media/${id}`);
    await page.getByRole('button', { name: 'Explore this video' }).click();
    // The result remembers it was opened from the library (?from=library&media=…).
    await expect(page).toHaveURL(new RegExp(`/captures/${capture}(\\?from=library|$)`), {
      timeout: 15_000,
    });
  });

  test('a paused request reads “Waiting to explore” with Cancel; an input failure explains what to do', async ({
    page,
  }) => {
    const states: NonNullable<Parameters<typeof openV2>[2]>['analysisStates'] = [
      { state: 'queued', waiting_reason: 'rate_limited' },
    ];
    const v2 = await openV2(page, '', { media: [VIDEO_SEED], analysis: true, analysisStates: states });
    const id = [...v2.media.keys()][0]!;
    await page.goto(`/library/media/${id}`);
    await page.getByRole('button', { name: 'Explore this video' }).click();
    await expect(page.getByText('Waiting to explore…')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'Explore this video' })).toBeEnabled();

    states.splice(0, states.length, { state: 'failed', error_code: 'model_input_rejected' });
    await page.getByRole('button', { name: 'Explore this video' }).click();
    await expect(page.getByText(/We couldn’t explore this media\. Choose a different moment/)).toBeVisible({
      timeout: 10_000,
    });
  });

  test('a video still preparing shows status and no play action', async ({ page }) => {
    const v2 = await openV2(page, '', {
      media: [{ ...VIDEO_SEED, status: 'processing', frames: [] }],
    });
    await page.goto(`/library/media/${[...v2.media.keys()][0]}`);
    await expect(page.getByRole('status').filter({ hasText: 'Preparing video' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0);
  });

  test('media that is not yours or gone reads as not found', async ({ page }) => {
    await openV2(page, '/library/media/00000000-0000-4000-8000-0000000fffff');
    await expect(page.getByRole('heading', { name: 'Not in your library' })).toBeVisible();
  });
});

test.describe('glasses and devices', () => {
  test('desktop hands off with a signed phone link and QR code; never browser Bluetooth', async ({
    page,
  }, testInfo) => {
    test.skip(!isDesktop(testInfo.project.name), 'desktop hand-off');
    await page.addInitScript(() => {
      const w = window as unknown as { __bluetoothRequests: number };
      w.__bluetoothRequests = 0;
      const bt = (navigator as unknown as { bluetooth?: { requestDevice: () => Promise<never> } })
        .bluetooth;
      if (bt)
        bt.requestDevice = () => {
          w.__bluetoothRequests += 1;
          return Promise.reject(new Error('blocked in test'));
        };
    });
    await openV2(page, '/capture/glasses', { glasses: 'device' });
    await page.getByRole('button', { name: 'Continue on your phone' }).click();
    await expect(page.getByRole('img', { name: 'QR code for the phone link' })).toBeVisible();
    await expect(page.getByLabel('Phone link', { exact: true })).toHaveValue(
      /\/capture\/glasses\?handoff=/,
    );
    await expect(page.getByText(/Expires in 10 min/)).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __bluetoothRequests: number }).__bluetoothRequests,
      ),
    ).toBe(0);
    await noSeriousAxe(page);
  });

  test('the phone link opens only for the same account and reports expiry', async ({ page }) => {
    await openV2(page, '/capture/glasses?handoff=h1.valid.sig', { glasses: 'device' });
    await expect(page.getByText('Opened from your computer.')).toBeVisible();
    await page.goto('/capture/glasses?handoff=expired');
    await expect(
      page.getByText('This link has expired. Create a new one on your computer.'),
    ).toBeVisible();
  });

  test('release blockers show Not available yet with camera/upload and the experimental explanation', async ({
    page,
  }) => {
    await openV2(page, '/capture/glasses');
    await expect(page.getByRole('heading', { name: 'Not available yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reconnect|Try again/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'About experimental access' }).click();
    const why = page.getByRole('list', { name: 'Why it is not available' });
    await expect(why).toContainText('App release');
    await expect(why).toContainText('Country or account');
    await expect(why).toContainText('Device');
    await expect(why).toContainText('Permission');
    await expect(page.getByRole('link', { name: 'Use this camera' })).toHaveAttribute(
      'href',
      '/capture/camera?start=1',
    );
  });

  test('devices: fresh phones read Ready, stale ones never do; Remove confirms and revokes', async ({
    page,
  }) => {
    const v2 = await openV2(page, '', {
      devices: [
        { platform: 'ios' },
        { platform: 'android', last_seen_at: new Date(Date.now() - 10 * 60_000).toISOString() },
      ],
    });
    await page.goto('/settings/devices');
    const rows = page.locator('.devices__row');
    await expect(rows.filter({ hasText: 'iPhone' })).toContainText('Ready to capture');
    await expect(rows.filter({ hasText: 'Android phone' })).toContainText('Last seen');
    await expect(rows.filter({ hasText: 'Android phone' })).not.toContainText('Ready');
    await rows.filter({ hasText: 'Android phone' }).getByRole('button', { name: 'Remove' }).click();
    await page.getByRole('button', { name: 'Remove Android phone' }).click();
    await expect(rows.filter({ hasText: 'Android phone' })).toHaveCount(0);
    const del = v2.log.find((r) => r.method === 'DELETE' && r.path.startsWith('/v2/devices/'));
    expect(del?.body).toEqual({ expected_revision: 1 });
    await noSeriousAxe(page);
  });
});
