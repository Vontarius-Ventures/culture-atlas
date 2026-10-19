/**
 * Fetches the golden-set photos into a directory outside git (docs/quality-plan.md §7.1).
 *
 *   pnpm eval:fetch --dest $EVAL_PHOTOS_DIR [--golden fixtures/eval/golden-v1] [--split all|tune|holdout]
 *
 * Each photo comes from its pinned raw.githubusercontent.com URL and is refused
 * unless its sha256 matches the manifest. Photos already present with the right
 * hash are kept. A photo whose source is withheld (p11) is copied by hand.
 * Network: Node needs NODE_USE_ENV_PROXY=1 (and the proxy CA) behind a proxy.
 */
import path from 'node:path';
import { fetchGoldenPhotos } from './eval/golden-photos';
import { loadGoldenSet } from './eval/labels';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const root = path.resolve(import.meta.dirname, '..');
const dest = arg('dest', process.env.EVAL_PHOTOS_DIR);
if (!dest) {
  console.error('--dest <dir> (or EVAL_PHOTOS_DIR) is required: a directory outside the repository.');
  process.exit(2);
}
if (!path.relative(root, path.resolve(dest)).startsWith('..')) {
  console.error('Refusing to write photos inside the repository; choose a directory outside git.');
  process.exit(2);
}
const split = (arg('split', 'all') ?? 'all') as 'all' | 'tune' | 'holdout';
const golden = await loadGoldenSet(arg('golden', path.join(root, 'fixtures/eval/golden-v1'))!);
const report = await fetchGoldenPhotos({ golden, dest, split, log: (l) => console.log(`[eval-fetch] ${l}`) });
console.log(
  `[eval-fetch] fetched ${report.fetched.length}, already present ${report.present.length}, withheld ${report.withheld.length}, failed ${report.failed.length}`,
);
process.exit(report.failed.length ? 1 : 0);
