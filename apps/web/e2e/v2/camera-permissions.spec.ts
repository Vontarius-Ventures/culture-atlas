import { expect, test } from '@playwright/test';
import { openV2 } from './mock-v2';

declare global {
  interface Window {
    __cameraPermissionTest: {
      requests: Array<{ grant: () => void; deny: () => void }>;
      stopped: number;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const state: Window['__cameraPermissionTest'] = { requests: [], stopped: 0 };
    window.__cameraPermissionTest = state;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!constraints?.audio) return original(constraints);
      return new Promise<MediaStream>((resolve, reject) => {
        state.requests.push({
          grant: () => {
            const stream = new MediaStream();
            stream.getTracks = () => [
              {
                stop: () => {
                  state.stopped += 1;
                },
              } as MediaStreamTrack,
            ];
            resolve(stream);
          },
          deny: () => reject(new DOMException('Permission denied', 'NotAllowedError')),
        });
      });
    };
  });
});

test('a pending microphone prompt times out honestly, disposes late grants, and can be retried', async ({
  page,
}) => {
  await openV2(page, '/capture/camera');
  await page.clock.install();
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByRole('button', { name: 'Microphone off' }).click();
  await expect(page.getByRole('button', { name: 'Asking for microphone…' })).toBeDisabled();
  await page.clock.fastForward(8000);
  await expect(page.getByRole('button', { name: 'Microphone off' })).toBeEnabled();
  await expect(page.locator('.camera__status[role="status"]')).toContainText(
    'taking longer than expected',
  );
  await expect(page.getByText('Microphone blocked')).toHaveCount(0);

  await page.getByRole('button', { name: 'Microphone off' }).click();
  await page.evaluate(() => window.__cameraPermissionTest.requests[0]!.grant());
  await expect.poll(() => page.evaluate(() => window.__cameraPermissionTest.stopped)).toBe(1);
  await expect(page.getByRole('button', { name: 'Asking for microphone…' })).toBeDisabled();
  await page.evaluate(() => window.__cameraPermissionTest.requests[1]!.deny());
  await expect(page.getByRole('button', { name: 'Microphone blocked' })).toBeEnabled();
  await expect(page.getByText('Videos record without sound.')).toBeVisible();
});

test('leaving the camera disposes microphone permission granted after navigation', async ({
  page,
}) => {
  await openV2(page, '/capture/camera');
  await page.getByRole('button', { name: 'Video', exact: true }).click();
  await page.getByRole('button', { name: 'Microphone off' }).click();
  await page.getByRole('link', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/capture$/);
  await page.evaluate(() => window.__cameraPermissionTest.requests[0]!.grant());
  await expect.poll(() => page.evaluate(() => window.__cameraPermissionTest.stopped)).toBe(1);
});
