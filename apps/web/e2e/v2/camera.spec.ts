/**
 * Browser camera (reference 03) with Chromium's fake camera/microphone. The
 * fake device draws a moving test pattern, so screenshots show that pattern
 * instead of a photograph (recorded in docs/design-deviations.md).
 */
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll } from '../helpers';
import { openV2 } from './mock-v2';

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const DIR = path.join(import.meta.dirname, '..', 'screenshots', 'v2');

test.describe('camera', () => {
  test('video: mic is off until asked, records with elapsed time, Stop → Keep/Delete → upload', async ({
    page,
    context,
  }, testInfo) => {
    await context.grantPermissions(['camera', 'microphone']);
    const v2 = await openV2(page, '/capture/camera?start=1');
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeEnabled();
    await page.getByRole('button', { name: 'Video', exact: true }).click();
    // Microphone defaults off and is only requested on action.
    const micOff = page.getByRole('button', { name: 'Microphone off' });
    await expect(micOff).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByText('60 sec max')).toBeVisible();
    await micOff.click();
    await expect(page.getByRole('button', { name: 'Microphone on' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('timer')).toContainText('Recording 0:0');
    await expect(page.getByText(/Recording on this (phone|device)/)).toBeVisible();
    // Mode and source are locked while recording; the bottom bar is never shown.
    await expect(page.getByRole('button', { name: 'Photo', exact: true })).toBeDisabled();
    await expect(page.locator('.bottom-nav')).toHaveCount(0);
    await page.waitForTimeout(1500);
    await expectNoHorizontalScroll(page);
    await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
    await page.screenshot({ path: path.join(DIR, `03-camera-${testInfo.project.name}.png`) });
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('button', { name: 'Keep' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete' })).toBeVisible();
    await page.screenshot({
      path: path.join(DIR, `03-camera-review-${testInfo.project.name}.png`),
    });
    await page.getByRole('button', { name: 'Keep' }).click();
    await expect(page.getByText(/In your library|Uploaded|Uploading|Saved on this/)).toBeVisible();
    await expect(page.getByText('In your library')).toBeVisible({ timeout: 15_000 });
    const create = v2.log.find((r) => r.method === 'POST' && r.path === '/v2/uploads');
    expect(create?.body).toMatchObject({ kind: 'video', source: 'browser_camera' });
    expect((create?.body as { content_type: string }).content_type).toMatch(/^video\/(webm|mp4)$/);
    expect(v2.log.filter((r) => r.path.endsWith('/complete'))).toHaveLength(1);
  });

  test('photo: Retake discards, Keep uploads once', async ({ page, context }) => {
    await context.grantPermissions(['camera']);
    const v2 = await openV2(page, '/capture/camera?start=1');
    await page.getByRole('button', { name: 'Take photo' }).click();
    await expect(page.getByRole('img', { name: 'Your photo' })).toBeVisible();
    await page.getByRole('button', { name: 'Retake' }).click();
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeFocused();
    expect(v2.log.some((r) => r.path === '/v2/uploads')).toBe(false);
    await page.getByRole('button', { name: 'Take photo' }).click();
    await page.getByRole('button', { name: 'Keep' }).click();
    await expect(page.getByText('In your library')).toBeVisible({ timeout: 15_000 });
    const creates = v2.log.filter((r) => r.method === 'POST' && r.path === '/v2/uploads');
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body).toMatchObject({
      kind: 'photo',
      source: 'browser_camera',
      content_type: 'image/jpeg',
    });
    await page.getByRole('link', { name: 'Open' }).click();
    await expect(page).toHaveURL(/\/library\/media\//);
  });

  test('a direct visit asks before turning the camera on', async ({ page }) => {
    await openV2(page, '/capture/camera');
    await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take photo' })).toBeDisabled();
  });
});

test.describe('camera denied', () => {
  test('denied permission explains settings and offers upload', async ({ page, context }) => {
    await context.clearPermissions();
    await openV2(page, '');
    await page.goto('/capture/camera');
    // Simulate the browser's refusal (the fake media UI would otherwise allow).
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await page.getByRole('button', { name: 'Turn on camera' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Camera access is off' });
    await expect(alert).toContainText('browser settings');
    await expect(page.getByRole('button', { name: 'Upload instead' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('no camera API falls back to a file picker', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    });
    await openV2(page, '/capture/camera?start=1');
    await expect(page.getByRole('alert').filter({ hasText: 'No camera found' })).toBeVisible();
    await page
      .getByTestId('camera-file-input')
      .setInputFiles(path.join(import.meta.dirname, 'fixtures', 'quiet-corners.jpg'));
    await expect(page.getByRole('img', { name: 'Your photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep' })).toBeVisible();
  });
});
