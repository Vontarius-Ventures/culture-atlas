// Screenshots of the editable mockups (screens 14-18) at 1440, 390 and 320 px.
// Usage, from the repository root (uses the Playwright already installed for apps/web):
//   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node specs/capture-platform-v2/design/html/capture-screens.mjs [filter]
// Writes specs/capture-platform-v2/design/screens/<name>-<width>.png.
/* global document, window -- page.evaluate callbacks run in the browser */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const out = resolve(here, '../screens');
const require = createRequire(join(root, 'apps/web/package.json'));
const { chromium } = require('@playwright/test');

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
  const file = resolve(root, path);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/specs/capture-platform-v2/design/html/`;

const WIDTHS = { 1440: 900, 390: 844, 320: 700 };
// [name, page + query, widths, full page?]
const SHOTS = [
  ['14-taste-picks', '14-taste-picks.html', [1440], true],
  ['14-taste-picks-ready', '14-taste-picks.html?picks=img-tea,img-listening,chip-wear-japandi,search-nina-simone&search=ok', [1440], true],
  ['14-taste-picks-search-unavailable', '14-taste-picks.html?search=unavailable&step=2', [1440, 390, 320], true],
  ['14-taste-picks-step1', '14-taste-picks.html?picks=img-tea&step=1', [390, 320], true],
  ['14-taste-picks-step2', '14-taste-picks.html?picks=img-tea,chip-wear-japandi&step=2', [390, 320], true],
  ['14-taste-picks-step3', '14-taste-picks.html?picks=img-tea,chip-wear-japandi,search-nina-simone&step=3', [390, 320], true],
  ['14-taste-picks-step3-disabled', '14-taste-picks.html?picks=img-tea,chip-wear-japandi&step=3', [390, 320], true],
  ['15-building-feed', '15-building-feed.html', [1440, 390, 320], false],
  ['15-building-feed-unavailable', '15-building-feed.html?state=unavailable', [1440, 390, 320], false],
  ['16-while-we-look', '16-while-we-look.html', [1440, 390, 320], true],
  ['16-more-to-explore', '16-while-we-look.html?state=results', [1440, 390, 320], true],
  ['17-ready-notice', '17-ready-notice.html', [1440, 390, 320], false],
  ['18-taste-settings', '18-taste-settings.html', [1440, 390, 320], true],
];

const filter = process.argv[2];
await mkdir(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, path, widths, fullPage] of SHOTS) {
    if (filter && !name.startsWith(filter)) continue;
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: WIDTHS[width] }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
      await page.goto(base + path, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) console.warn(`${name} @${width}: horizontal overflow ${overflow}px`);
      const file = join(out, `${name}-${width}.png`);
      if (fullPage) {
        // Grow the viewport to the whole document so sticky and fixed bars sit where a reader
        // scrolled to the end would see them, instead of mid-page.
        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width, height: Math.max(height, WIDTHS[width]) });
        const settled = await page.evaluate(() => document.documentElement.scrollHeight);
        if (settled !== height) await page.setViewportSize({ width, height: Math.max(settled, WIDTHS[width]) });
      }
      await page.screenshot({ path: file });
      console.log(file.slice(root.length + 1));
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
