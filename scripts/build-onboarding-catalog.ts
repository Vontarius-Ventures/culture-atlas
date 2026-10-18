/**
 * Build fixtures/onboarding/catalog.json from LIVE Qloo /v2/tags lookups
 * (spec amendment 2.2). Operator script; nothing is simulated: without
 * QLOO_API_KEY it exits, and labels Qloo has no matching tag for are dropped.
 *
 * Usage:
 *   pnpm onboarding:catalog [--refresh] [--previous file] [--budget 40] [--dry-run] [--env-file /path/to/.env]
 *
 *   --refresh   ignore the committed catalog and resolve every label again
 *               (default: unchanged chips/images keep their ids and dates)
 *   --budget    hard cap on Qloo HTTP attempts, retries included (default 40)
 *   --dry-run   print the result without writing the file
 *   --env-file  load keys from another .env (e.g. the main checkout's)
 *   --previous  reuse ids from this file instead of the committed catalog
 *
 * At most 3 requests are in flight, with a pause between requests per lane.
 * The API key is never printed or written.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { OnboardingCatalogFile } from '../packages/domain/src/schemas/onboarding';
import { loadProviderConfig } from '../packages/providers/src/config';
import { QlooHttpProvider } from '../packages/providers/src/qloo/client';
import { buildOnboardingCatalog, catalogProblems, DEFAULT_REQUEST_BUDGET } from './onboarding-catalog-lib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'fixtures/onboarding/catalog.json');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const envFile = arg('env-file');
if (envFile) process.loadEnvFile(path.resolve(envFile));
else loadRootEnv(ROOT);

const config = loadProviderConfig();
if (!config.QLOO_API_KEY) {
  console.error('QLOO_API_KEY is not set: the catalog needs live Qloo ids. Nothing was written.');
  process.exit(2);
}

const previousPath = path.resolve(arg('previous') ?? OUT);
const previous = !process.argv.includes('--refresh') && existsSync(previousPath)
  ? OnboardingCatalogFile.parse(JSON.parse(readFileSync(previousPath, 'utf8')))
  : null;
const budget = Number(arg('budget') ?? DEFAULT_REQUEST_BUDGET);
if (!Number.isInteger(budget) || budget < 1 || budget > DEFAULT_REQUEST_BUDGET) {
  console.error(`--budget must be an integer from 1 to ${DEFAULT_REQUEST_BUDGET}.`);
  process.exit(2);
}

const qloo = new QlooHttpProvider({ apiKey: config.QLOO_API_KEY, baseUrl: config.QLOO_API_URL, timeoutMs: config.QLOO_TIMEOUT_MS, defaultRetries: 1 });
const report = await buildOnboardingCatalog({
  qloo,
  now: () => new Date(),
  previous,
  budget,
  pauseMs: 1200,
  log: (line) => console.log(`  ${line}`),
});

console.log(`\nQloo requests: ${report.requests}/${budget} · reused: ${report.reused.length} · items: ${report.catalog.items.length}`);
for (const d of report.dropped) console.log(`  dropped ${d.id}: ${d.reason}`);
const problems = catalogProblems(report.catalog);
for (const p of problems) console.log(`  problem: ${p}`);

if (process.argv.includes('--dry-run')) {
  console.log('\n--dry-run: nothing written.');
} else if (problems.length) {
  console.error('\nThe catalog does not meet the questionnaire rules; nothing was written. Adjust the labels in scripts/onboarding-catalog-lib.ts and rerun (resolved labels are reused).');
  // Keep what resolved so the rerun only spends requests on what is missing.
  if (report.catalog.items.length) {
    const partial = path.join(ROOT, 'fixtures/onboarding/catalog.partial.json');
    writeFileSync(partial, `${JSON.stringify(report.catalog, null, 2)}\n`);
    console.error(`Partial result: ${path.relative(ROOT, partial)}; rerun with --previous ${path.relative(ROOT, partial)} (it is not committed).`);
  }
  process.exit(1);
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(report.catalog, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(ROOT, OUT)} (catalog_version ${report.catalog.catalog_version}).`);
}
