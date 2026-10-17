/**
 * Capture platform v2 reference surfaces (specs/capture-platform-v2/design/
 * mockups 01–09) rendered at 1440 / 390 / 360 / 320 px against the
 * contract-validated /v2 mock, saved to e2e/screenshots/v2/ for side-by-side
 * comparison. Deviations are recorded in docs/design-deviations.md.
 */
import path from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';
import { LIBRARY_SEED, openV2, seedUploadQueue, VIDEO_SEED } from './mock-v2';

const DIR = path.join(import.meta.dirname, '..', 'screenshots', 'v2');

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
  await page.addStyleTag({
    content: 'nextjs-portal{display:none!important} *{caret-color:transparent!important}',
  });
  // Not networkidle: some states deliberately hold a request open.
  await page
    .waitForFunction(
      () =>
        Array.from(document.images)
          .filter((img) => img.getBoundingClientRect().width > 0)
          .every((img) => img.complete && img.naturalWidth > 0),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(DIR, `${name}-${testInfo.project.name}.png`),
    fullPage,
    animations: 'disabled',
  });
}

const desktop = (t: TestInfo) => t.project.name === 'desktop';

test.describe('v2 reference surfaces', () => {
  test('01/08 library', async ({ page }, testInfo) => {
    if (desktop(testInfo)) await page.setViewportSize({ width: 1440, height: 1000 });
    const v2 = await openV2(page, '/library', { media: LIBRARY_SEED, holdParts: true });
    await expect(page.getByRole('heading', { name: 'Your library' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeVisible();
    // Two transfers in flight (created two days ago, so below the fold of "Today").
    const inFlight = (n: number, name: string, bytes: number) =>
      v2.seedUpload(
        `10000000-0000-4000-8000-00000000000${n}`,
        {
          client_capture_id: `10000000-0000-4000-8000-00000000000${n}`,
          kind: 'video',
          source: 'upload',
          filename: name,
          content_type: 'video/mp4',
          byte_size: bytes,
          sha256: 'a'.repeat(64),
        },
        [1],
        2 * 24 * 60,
      );
    await seedUploadQueue(
      page,
      v2.accountId!,
      desktop(testInfo)
        ? [
            {
              client_capture_id: '10000000-0000-4000-8000-000000000001',
              filename: 'coast.mp4',
              kind: 'video',
              content_type: 'video/mp4',
              byte_size: 12_000_000,
              phase: 'uploading',
              withBlob: true,
              upload_id: inFlight(1, 'coast.mp4', 12_000_000).id,
              receipts: [1],
            },
            {
              client_capture_id: '10000000-0000-4000-8000-000000000002',
              filename: 'walk.mp4',
              kind: 'video',
              content_type: 'video/mp4',
              byte_size: 14_000_000,
              phase: 'uploading',
              withBlob: true,
              upload_id: inFlight(2, 'walk.mp4', 14_000_000).id,
              receipts: [1],
            },
          ]
        : [
            {
              filename: 'pottery.jpg',
              kind: 'photo',
              content_type: 'image/jpeg',
              byte_size: 5_000_000,
              phase: 'paused',
              pause_reason: 'offline',
              error: 'Connection lost. Your file is still selected.',
              withBlob: true,
            },
          ],
    );
    await page.reload();
    await expect(page.getByRole('link', { name: 'Quiet corners' })).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'All', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: desktop(testInfo) ? '2 files uploading' : '1 upload paused' })
        .first(),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, '01-library');
  });

  test('02 source', async ({ page }, testInfo) => {
    await openV2(page, '/capture');
    await expect(page.getByRole('heading', { name: 'Keep what catches your eye.' })).toBeVisible();
    await expect(page.getByRole('link', { name: /This camera/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Meta glasses/ })).toContainText('Experimental');
    await expect(page.getByRole('button', { name: /Upload files/ })).toBeVisible();
    await expect(page.getByText('Your library is private. Choose what to explore.')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, '02-source');
  });

  test('04 glasses connect (web)', async ({ page }, testInfo) => {
    await openV2(page, '/settings/devices/glasses', { glasses: 'device' });
    await expect(page.getByRole('heading', { name: 'Connect your glasses' })).toBeVisible();
    await expect(page.getByText('Experimental').first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, '04-glasses-connect', true);
  });

  test('05 glasses ready (web view of a phone)', async ({ page }, testInfo) => {
    const v2 = await openV2(page, '', { devices: [{ platform: 'ios' }] });
    await page.goto(`/settings/devices/${v2.devices[0]!.id}`);
    await expect(page.getByRole('heading', { name: 'Your glasses' })).toBeVisible();
    await expect(page.getByText('Ready to capture')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Allow remote capture' })).toBeDisabled();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, '05-glasses-ready', true);
  });

  test('06 uploads', async ({ page }, testInfo) => {
    const v2 = await openV2(page, '/uploads', { holdParts: true });
    await expect(page.getByText('No uploads in progress.')).toBeVisible();
    const coast = v2.seedUpload(
      '10000000-0000-4000-8000-000000000002',
      {
        client_capture_id: '10000000-0000-4000-8000-000000000002',
        kind: 'video',
        source: 'upload',
        filename: 'coast.mp4',
        content_type: 'video/mp4',
        byte_size: 13_529_000,
        sha256: 'a'.repeat(64),
      },
      [1],
    );
    const room = v2.addMedia({
      title: null,
      kind: 'video',
      source: 'upload',
      status: 'processing',
      image: 'living-room.jpg',
    });
    const cafe = v2.addMedia({
      title: null,
      kind: 'photo',
      source: 'upload',
      image: 'slow-morning.jpg',
    });
    await seedUploadQueue(page, v2.accountId!, [
      {
        filename: 'cafe.jpg',
        kind: 'photo',
        content_type: 'image/jpeg',
        byte_size: 3_145_728,
        phase: 'ready',
        thumb: 'slow-morning.jpg',
        upload_id: 'u-cafe',
        asset_id: cafe.media.id,
      },
      {
        client_capture_id: '10000000-0000-4000-8000-000000000002',
        filename: 'coast.mp4',
        kind: 'video',
        content_type: 'video/mp4',
        byte_size: 13_529_000,
        duration_ms: 42_000,
        phase: 'uploading',
        thumb: 'along-the-coast.jpg',
        withBlob: true,
        upload_id: coast.id,
        asset_id: coast.assetId,
        receipts: [1],
      },
      {
        filename: 'room.mov',
        kind: 'video',
        content_type: 'video/quicktime',
        byte_size: 20_000_000,
        duration_ms: 28_000,
        phase: 'processing',
        thumb: 'living-room.jpg',
        upload_id: 'u-room',
        asset_id: room.media.id,
      },
      {
        filename: 'pottery.jpg',
        kind: 'photo',
        content_type: 'image/jpeg',
        byte_size: 5_242_880,
        phase: 'paused',
        pause_reason: 'offline',
        error: 'Connection lost. Your file is still selected.',
        thumb: 'made-by-hand.jpg',
        withBlob: true,
      },
    ]);
    await page.reload();
    await expect(page.getByText('Uploading 62%')).toBeVisible();
    await expect(page.getByText('Preparing video')).toBeVisible();
    await expect(page.getByText('Upload paused')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    if (desktop(testInfo)) await page.setViewportSize({ width: 1440, height: 900 });
    await shot(page, testInfo, '06-uploads');
  });

  test('07 video detail', async ({ page }, testInfo) => {
    if (desktop(testInfo)) await page.setViewportSize({ width: 1440, height: 1000 });
    const v2 = await openV2(page, '', { media: [VIDEO_SEED], analysis: true });
    const id = [...v2.media.keys()][0]!;
    await page.goto(`/library/media/${id}`);
    await expect(page.getByRole('heading', { level: 1, name: 'A slower afternoon' })).toBeVisible();
    await page.getByRole('button', { name: 'Moment at 0:12' }).click();
    await expect(page.getByRole('button', { name: 'Moment at 0:12' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText('We explore selected moments, not every frame.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, '07-video-detail', !desktop(testInfo));
  });

  test('09 glasses unavailable', async ({ page }, testInfo) => {
    await openV2(page, '/capture/glasses', { media: LIBRARY_SEED.slice(0, 3) });
    await expect(page.getByRole('heading', { name: 'Not available yet' })).toBeVisible();
    await expect(
      page.getByText(
        'Glasses capture is not enabled for this app release. Your camera and uploads are ready to use.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your library is unchanged.' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await shot(page, testInfo, '09-glasses-unavailable', true);
  });
});
