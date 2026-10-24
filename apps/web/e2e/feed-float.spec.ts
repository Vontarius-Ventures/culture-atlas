import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, open } from './helpers';

/**
 * The floating feed (owner feedback 2026-10-22: "It should constantly float
 * through to other suggestions. Right now they overlap on top of each other.").
 * Cards drift upward in staggered columns, never overlap, never repeat on
 * screen, pause for hover/focus/touch, and Reduce Motion gets a static grid.
 */

interface Box {
  id: string;
  lane: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Card boxes relative to their conveyor viewport (immune to page scrolling). */
async function boxes(items: Locator): Promise<Box[]> {
  return items.evaluateAll((els) =>
    els.map((el) => {
      const v = el.closest('.conveyor__viewport')!.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const r = {
        top: b.top - v.top,
        bottom: b.bottom - v.top,
        left: b.left - v.left,
        right: b.right - v.left,
      };
      const d = (el as HTMLElement).dataset;
      return {
        id: d.cardId ?? '',
        lane: d.lane ?? '',
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      };
    }),
  );
}

function expectSound(list: Box[]) {
  const ids = list.map((b) => b.id);
  expect(new Set(ids).size, 'a card is never on screen twice').toBe(ids.length);
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const overlap =
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;
      expect(overlap, `${a.id} and ${b.id} must not overlap`).toBe(false);
    }
  }
}

function byId(list: Box[]) {
  return new Map(list.map((b) => [b.id, b]));
}

const feedItems = (page: Page) => page.locator('.feed-conveyor .conveyor__item');

/**
 * Clicks a paused card in the middle of its visible part (cards are partly
 * clipped while they float) and returns its title.
 */
async function openMostVisible(page: Page, scope: string) {
  const viewport = page.locator(`${scope} .conveyor__viewport`);
  const v = (await viewport.boundingBox())!;
  const win = page.viewportSize()!;
  // The part of the conveyor that is on screen, relative to the conveyor.
  const clip = {
    left: Math.max(0, -v.x),
    top: Math.max(0, -v.y),
    right: Math.min(v.width, win.width - v.x),
    bottom: Math.min(v.height, win.height - v.y),
  };
  const list = await boxes(page.locator(`${scope} .conveyor__item`));
  const part = (b: Box) => ({
    left: Math.max(b.left, clip.left),
    right: Math.min(b.right, clip.right),
    top: Math.max(b.top, clip.top),
    bottom: Math.min(b.bottom, clip.bottom),
  });
  const area = (b: Box) => {
    const p = part(b);
    return Math.max(0, p.right - p.left) * Math.max(0, p.bottom - p.top);
  };
  const best = [...list].sort((a, b) => area(b) - area(a))[0]!;
  const title = (await page
    .locator(`${scope} [data-card-id="${best.id}"] .card__link`)
    .textContent())!;
  const p = part(best);
  // Left third of the visible part: clear of the Save chip at the upper right.
  await page.mouse.click(v.x + p.left + (p.right - p.left) / 3, v.y + (p.top + p.bottom) / 2);
  return title;
}

async function awayFromFeed(page: Page) {
  // Park the mouse outside the conveyor (hover pauses the drift).
  await page.mouse.move(2, 2);
}

test.describe('Floating feed', () => {
  test('cards drift upward in staggered columns without overlap or repeats', async ({
    page,
  }, testInfo) => {
    await open(page, '/');
    const list = page.getByRole('list', { name: 'Discoveries' });
    await expect(list.getByRole('listitem').first()).toBeVisible();
    await awayFromFeed(page);
    const before = await boxes(feedItems(page));
    expectSound(before);
    const lanes = new Set(before.map((b) => b.lane));
    expect(lanes.size).toBe(testInfo.project.name === 'desktop' ? 4 : 2);

    await page.waitForTimeout(1500);
    const after = await boxes(feedItems(page));
    expectSound(after);
    const was = byId(before);
    const moved = new Map<string, number>();
    for (const b of after) {
      const a = was.get(b.id);
      if (!a) continue;
      expect(b.top, `${b.id} floats upward`).toBeLessThan(a.top - 5);
      expect(b.left).toBeCloseTo(a.left, 0);
      moved.set(b.lane, a.top - b.top);
    }
    // Columns do not move in lockstep.
    expect(new Set([...moved.values()].map((d) => Math.round(d / 3))).size).toBeGreaterThan(1);
    await expectNoHorizontalScroll(page);
  });

  test('hover pauses the drift, and a card still opens on click', async ({ page }) => {
    await open(page, '/');
    const viewport = page.locator('.feed-conveyor .conveyor__viewport');
    await expect(feedItems(page).first()).toBeVisible();
    const vbox = (await viewport.boundingBox())!;
    await page.mouse.move(vbox.x + vbox.width / 2, vbox.y + 40);
    await page.waitForTimeout(300);
    const a = await boxes(feedItems(page));
    await page.waitForTimeout(1000);
    const b = await boxes(feedItems(page));
    const first = byId(a);
    for (const box of b) expect(box.top).toBeCloseTo(first.get(box.id)!.top, 0);

    // Clicking a card (anywhere on it) opens its detail.
    const title = await openMostVisible(page, '.feed-conveyor');
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  });

  test('Pause motion stops the feed until resumed', async ({ page }) => {
    await open(page, '/');
    await expect(feedItems(page).first()).toBeVisible();
    const toggle = page.getByRole('button', { name: 'Pause motion' });
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Resume motion' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await awayFromFeed(page);
    await page.waitForTimeout(600);
    const a = byId(await boxes(feedItems(page)));
    await page.waitForTimeout(1200);
    for (const box of await boxes(feedItems(page))) {
      expect(box.top).toBeCloseTo(a.get(box.id)!.top, 0);
    }
  });

  test('keyboard focus pauses the drift and keeps the focused card fully visible', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'keyboard flow checked on desktop');
    await open(page, '/');
    await expect(feedItems(page).first()).toBeVisible();
    const viewport = page.locator('.feed-conveyor .conveyor__viewport');
    await feedItems(page).first().locator('.card__link').focus();
    for (let i = 0; i < 16; i++) {
      // Wait out any focus-driven page scroll before measuring.
      await page.waitForTimeout(150);
      const vbox = (await viewport.boundingBox())!;
      const focused = await page.evaluate(() => {
        const li = document.activeElement?.closest<HTMLElement>('.conveyor__item');
        if (!li) return null;
        const r = li.getBoundingClientRect();
        return { id: li.dataset.cardId, top: r.top, bottom: r.bottom };
      });
      if (!focused) break; // tabbed past the feed
      expect(focused.top, `${focused.id} top visible`).toBeGreaterThanOrEqual(vbox.y - 0.5);
      expect(focused.bottom, `${focused.id} bottom visible`).toBeLessThanOrEqual(
        vbox.y + vbox.height + 0.5,
      );
      await page.keyboard.press('Tab');
    }
    // While a card has focus nothing on screen moves.
    await feedItems(page).nth(5).locator('.card__link').focus();
    await page.waitForTimeout(150);
    const height = (await viewport.boundingBox())!.height;
    const onScreen = (b: Box) => b.bottom > 0 && b.top < height;
    const a = byId((await boxes(feedItems(page))).filter(onScreen));
    await page.waitForTimeout(1000);
    for (const box of await boxes(feedItems(page))) {
      const was = a.get(box.id);
      if (was) expect(box.top).toBeCloseTo(was.top, 0);
    }
  });

  test('Refresh asks for a new snapshot and never empties the feed, even on error', async ({
    page,
  }) => {
    const api = await open(page, '/');
    await expect(feedItems(page).first()).toBeVisible();
    const count = await feedItems(page).count();
    await page.getByRole('button', { name: 'Refresh discoveries' }).click();
    await expect
      .poll(() => api.log.filter((r) => r.path === '/v1/discoveries').map((r) => r.search))
      .toContain('?limit=12&refresh=true');
    await expect(page.getByRole('button', { name: 'Refresh discoveries' })).toBeEnabled();
    expect(await feedItems(page).count()).toBe(count);
    // Refresh never starts generation from the web client.
    expect(api.log.filter((r) => r.method !== 'GET')).toEqual([]);

    api.failures.set('getDiscoveries', {
      status: 503,
      code: 'unavailable',
      message: 'Discoveries are briefly unavailable.',
    });
    await page.getByRole('button', { name: 'Refresh discoveries' }).click();
    await expect(page.getByText('Discoveries are briefly unavailable.').first()).toBeVisible();
    expect(await feedItems(page).count()).toBe(count);
    expectSound(await boxes(feedItems(page)));
  });

  test.describe('Reduce Motion', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    test('shows a static grid of every loaded card, no drift', async ({ page }) => {
      await open(page, '/');
      const list = page.getByRole('list', { name: 'Discoveries' });
      await expect(list.getByRole('listitem')).toHaveCount(12);
      await expect(page.locator('.conveyor')).toHaveCount(0);
      const a = await list.getByRole('listitem').first().boundingBox();
      await page.waitForTimeout(800);
      expect(await list.getByRole('listitem').first().boundingBox()).toEqual(a);
    });
  });
});

test.describe('Similar rail', () => {
  test('related cards float leftward without overlap and stay tappable', async ({ page }) => {
    const api = await open(page, '/');
    await page.goto(`/items/${api.feedCard('vintage-racing').id}?from=discover`);
    await page.getByRole('button', { name: 'Discover more' }).click();
    const rail = page.locator('.related-rail .conveyor__item');
    await expect(rail.first()).toBeVisible({ timeout: 15_000 });
    await awayFromFeed(page);
    // Page scrolling (the click scrolled Discover more into view) pauses the drift for ~2s.
    await page.waitForTimeout(2200);
    const before = await boxes(rail);
    expectSound(before);
    await page.waitForTimeout(1500);
    const after = await boxes(rail);
    expectSound(after);
    const was = byId(before);
    let compared = 0;
    for (const b of after) {
      const a = was.get(b.id);
      if (!a) continue;
      compared++;
      expect(b.left, `${b.id} drifts left`).toBeLessThan(a.left - 5);
      expect(b.top).toBeCloseTo(a.top, 0);
    }
    expect(compared).toBeGreaterThan(0);

    const railBox = (await page.locator('.related-rail .conveyor__viewport').boundingBox())!;
    await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 20);
    await page.waitForTimeout(300);
    const title = await openMostVisible(page, '.related-rail');
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  });
});
