/**
 * Run the Qloo contract probes and record the results in
 * docs/capability-matrix.md. See docs/qloo-probes.md.
 *
 *   pnpm qloo:probe [--brand "Levi's"] [--tag streetwear] [--dry-run] [--json]
 *
 * Reads QLOO_API_KEY and QLOO_API_URL (default https://hackathon.api.qloo.com)
 * from the environment or the repo-root .env. Without a key it exits with
 * code 2 and changes nothing: every Qloo capability stays unavailable
 * (not_configured). The key is never printed or written.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderProbeSection, runQlooProbes, summarizeCapabilities, updateCapabilityMatrix } from './qloo-probe-lib';

const ROOT = path.resolve(import.meta.dirname, '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const apiKey = process.env.QLOO_API_KEY?.trim();
const baseUrl = process.env.QLOO_API_URL?.trim() || 'https://hackathon.api.qloo.com';

if (!apiKey) {
  console.error('QLOO_API_KEY is not set. Every Qloo capability stays unavailable (not_configured); nothing was probed or written.');
  process.exit(2);
}

const run = await runQlooProbes({ baseUrl, apiKey, brand: arg('brand'), tag: arg('tag') });

if (flag('json')) {
  console.log(JSON.stringify(run, null, 2));
} else {
  console.log(renderProbeSection(run));
  console.log('\nCapabilities:');
  for (const [cap, s] of summarizeCapabilities(run)) console.log(`  ${cap.padEnd(30)} ${s.status.padEnd(12)} ${s.detail}`);
}

if (!flag('dry-run')) {
  const file = path.join(ROOT, 'docs/capability-matrix.md');
  writeFileSync(file, updateCapabilityMatrix(readFileSync(file, 'utf8'), run));
  console.log(`\nUpdated ${path.relative(ROOT, file)}. Review the diff, then fill in the storage/display answers by hand.`);
}

const failed = run.results.filter((r) => r.status === 'unavailable' && r.capability !== 'qloo.trending' && r.capability !== 'qloo.trends_entity');
process.exitCode = failed.length > 0 ? 1 : 0;
