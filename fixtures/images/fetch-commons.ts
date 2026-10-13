/**
 * Optional: fetch public-domain / CC0 photographs from Wikimedia Commons to
 * replace the generated sample illustrations. Run where Commons is reachable:
 *
 *   WIKIMEDIA_USER_AGENT="culture-atlas/0.1 (you@example.com)" \
 *     pnpm exec tsx fixtures/images/fetch-commons.ts outfit "racing jacket" room "japanese room interior" cafe "cafe table coffee"
 *
 * Arguments are pairs of <name> <search terms>. For each pair the script takes
 * the first bitmap whose license metadata is Public domain or CC0, downloads a
 * 1200 px rendition to apps/web/public/samples/commons/<name>.jpg and appends a
 * row (title, author, license, source URL) to fixtures/images/LICENSES.md.
 * Review every image (no identifiable people, logos or watermarks) before use.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const API = 'https://commons.wikimedia.org/w/api.php';
const UA = process.env.WIKIMEDIA_USER_AGENT;
const ALLOWED = /^(public domain|pd\b|pd-|cc0)/i;

interface ImageInfo {
  thumburl?: string;
  descriptionurl: string;
  extmetadata?: Record<string, { value: string }>;
}

const strip = (html: string | undefined) => (html ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

async function findFile(terms: string) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrnamespace: '6',
    gsrsearch: `${terms} haslicense:unrestricted filetype:bitmap`,
    gsrlimit: '20',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '1200',
    iiextmetadatafilter: 'LicenseShortName|Artist|ImageDescription',
  });
  const res = await fetch(`${API}?${params}`, { headers: { 'user-agent': UA! } });
  if (!res.ok) throw new Error(`Commons search failed: ${res.status}`);
  const body = (await res.json()) as { query?: { pages?: Record<string, { title: string; index: number; imageinfo?: ImageInfo[] }> } };
  const pages = Object.values(body.query?.pages ?? {}).sort((a, b) => a.index - b.index);
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    const license = strip(info?.extmetadata?.LicenseShortName?.value);
    if (info?.thumburl && ALLOWED.test(license)) {
      return { title: page.title, url: info.thumburl, source: info.descriptionurl, license, author: strip(info.extmetadata?.Artist?.value) || 'Unknown' };
    }
  }
  return null;
}

async function main() {
  if (!UA) throw new Error('Set WIKIMEDIA_USER_AGENT to a descriptive User-Agent with contact details.');
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2) throw new Error('Pass pairs of <name> <search terms>.');
  const outDir = path.join(root, 'apps/web/public/samples/commons');
  mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < args.length; i += 2) {
    const [name, terms] = [args[i]!, args[i + 1]!];
    const file = await findFile(terms);
    if (!file) {
      console.warn(`No public-domain/CC0 match for "${terms}"`);
      continue;
    }
    const img = await fetch(file.url, { headers: { 'user-agent': UA } });
    if (!img.ok || !img.headers.get('content-type')?.startsWith('image/')) throw new Error(`Download failed for ${file.title}`);
    writeFileSync(path.join(outDir, `${name}.jpg`), Buffer.from(await img.arrayBuffer()));
    appendFileSync(
      path.join(root, 'fixtures/images/LICENSES.md'),
      `| \`samples/commons/${name}.jpg\` | ${file.title} | ${file.author.replace(/\|/g, '/')} | ${file.license} | ${file.source} |\n`,
    );
    console.log(`${name}: ${file.title} (${file.license})`);
  }
}

await main();
