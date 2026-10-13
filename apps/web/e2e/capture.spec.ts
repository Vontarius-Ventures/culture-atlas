import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, open, SAMPLE_JPEG } from './helpers';

test.describe('Capture', () => {
  test('upload → preview → optional crop → Discover → processing → results with Load more', async ({
    page,
  }) => {
    const api = await open(page, '/capture');
    await expect(page.getByRole('heading', { name: 'Capture something you like.' })).toBeVisible();
    await page.getByTestId('upload-input').setInputFiles(SAMPLE_JPEG);
    await expect(page.getByRole('img', { name: 'Your selected photo' })).toBeVisible();
    // No analysis settings panel: just crop, choose another, Discover.
    await page.getByRole('button', { name: 'Crop' }).click();
    const frame = page.getByRole('group', { name: /Crop area/ });
    await frame.focus();
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Shift+ArrowUp');
    await expect(page.getByRole('button', { name: 'Reset crop' })).toBeVisible();
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page).toHaveURL(/\/captures\//);
    await expect(page.getByRole('heading', { name: 'Vintage racing' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('A few vintage racing references stood out.')).toBeVisible();
    const grid = page.getByRole('list', { name: 'Discoveries from your photo' });
    await expect(grid.getByRole('listitem')).toHaveCount(6);
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(grid.getByRole('listitem')).toHaveCount(12);
    // Filters only for categories with results.
    await page
      .getByRole('group', { name: 'Filter discoveries' })
      .getByRole('button', { name: 'Watch' })
      .click();
    await expect(grid.getByRole('listitem')).toHaveCount(3);
    const uploads = api.log.filter((r) => r.method === 'POST' && r.path === '/v1/captures');
    expect(uploads).toHaveLength(1);
    // Explore the references is closed by default and phrases resemblances.
    const refs = page.getByRole('button', { name: 'Explore the references' });
    await expect(refs).toHaveAttribute('aria-expanded', 'false');
    await refs.click();
    await expect(
      page.getByRole('link', { name: /Resembles Endurance racing jackets/ }),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('processing keeps the photo and says "Finding your next favorites…"', async ({ page }) => {
    await open(page, '/', { holdJobs: true });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await expect(page.getByRole('dialog', { name: 'Try an example' })).toBeVisible();
    await page.getByRole('button', { name: 'A café table' }).click();
    await expect(page.getByRole('heading', { name: 'Finding your next favorites…' })).toBeVisible();
    await expect(page.locator('.result-photo__img')).toHaveAttribute('src', '/samples/cafe.jpg');
  });

  test('polling stops while the tab is hidden and resumes when visible', async ({ page }) => {
    const api = await open(page, '/', { holdJobs: true });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page.getByRole('heading', { name: 'Finding your next favorites…' })).toBeVisible();
    await expect
      .poll(() => api.log.filter((r) => r.path.startsWith('/v1/jobs/')).length)
      .toBeGreaterThan(1);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(400);
    const hiddenCount = api.log.filter((r) => r.path.startsWith('/v1/jobs/')).length;
    await page.waitForTimeout(1500);
    expect(api.log.filter((r) => r.path.startsWith('/v1/jobs/')).length).toBe(hiddenCount);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(() => api.log.filter((r) => r.path.startsWith('/v1/jobs/')).length)
      .toBeGreaterThan(hiddenCount);
  });

  test('try an example is labeled "Example result"', async ({ page }) => {
    await open(page, '/', { pollsToComplete: 1 });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'A room' }).click();
    await expect(page.getByRole('heading', { name: 'Quiet corners' })).toBeVisible();
    await expect(page.locator('.example-label')).toHaveText('Example result');
  });

  test('unsupported file types explain accepted formats and keep the selection', async ({
    page,
  }) => {
    await open(page, '/capture');
    await page
      .getByTestId('upload-input')
      .setInputFiles({ name: 'notes.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
    await expect(
      page.getByText('That file type isn’t supported. Use a JPEG, PNG or WebP photo up to 15 MB.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discover' })).toBeDisabled();
    // Server-side rejection (HEIC without a decoder) keeps the selection too.
    await page
      .getByTestId('replace-input')
      .setInputFiles({
        name: 'IMG_0001.heic',
        mimeType: 'image/heic',
        buffer: Buffer.from('heic'),
      });
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(page.getByText(/HEIC photos can’t be read yet/)).toBeVisible();
    await expect(page.getByText('IMG_0001.heic')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discover' })).toBeEnabled();
  });

  test('related discoveries unavailable: keep results, say they are taking longer, retry', async ({
    page,
  }) => {
    await open(page, '/', { qlooUnavailable: true, pollsToComplete: 1 });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(page.getByText('Related discoveries are taking longer.')).toBeVisible();
    const grid = page.getByRole('list', { name: 'Discoveries from your photo' });
    await expect(grid.getByRole('listitem')).toHaveCount(6);
    await expect(
      page.getByRole('group', { name: 'Filter discoveries' }).getByRole('button'),
    ).toHaveText(['All', 'Wear', 'Eat']);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('Related discoveries are taking longer.')).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(
      page.getByRole('group', { name: 'Filter discoveries' }).getByRole('button'),
    ).toHaveText(['All', 'Wear', 'Play', 'Watch', 'Eat']);
  });

  test('no useful subject asks for a clearer photo or what caught your eye', async ({ page }) => {
    const api = await open(page, '/', { noSubject: true, pollsToComplete: 1 });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    await expect(
      page.getByText('Try a clearer photo, or tell us what caught your eye.'),
    ).toBeVisible();
    await page.getByLabel('What caught your eye?').fill('The striped jacket');
    await page.getByRole('main').getByRole('button', { name: 'Discover' }).click();
    await expect
      .poll(() => api.log.some((r) => r.method === 'POST' && r.path.endsWith('/corrections')))
      .toBe(true);
  });

  test('"What caught your eye?" offers choices and The whole photo without blocking results', async ({
    page,
  }) => {
    const api = await open(page, '/', { question: true, pollsToComplete: 1 });
    await page.getByRole('button', { name: 'Try an example' }).click();
    await page.getByRole('button', { name: 'An outfit' }).click();
    const q = page.getByRole('group', { name: 'What caught your eye?' });
    await expect(q.getByRole('button')).toHaveText(['The jacket', 'The chair', 'The whole photo']);
    await expect(
      page.getByRole('list', { name: 'Discoveries from your photo' }).getByRole('listitem'),
    ).toHaveCount(6);
    await q.getByRole('button', { name: 'The jacket' }).click();
    await expect
      .poll(() => api.log.some((r) => r.method === 'POST' && r.path.endsWith('/corrections')))
      .toBe(true);
  });
});
