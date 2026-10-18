/**
 * Deliberate operator qualification of a Concentrate role profile.
 * See docs/concentrate.md ("Qualification"). Nothing runs on deploy or startup.
 *
 *   # 1. Catalog snapshot only (GET /v1/models, paginated; no inference):
 *   pnpm qualify:concentrate --catalog --out-dir /secure/concentrate-qualification
 *
 *   # 2. Pin a model/provider from the snapshot in the profile; set catalogSnapshotAt
 *   #    to the snapshot's fetched_at. Dry run (prints the plan, sends nothing):
 *   pnpm qualify:concentrate --profile-file profiles.json --role vision_photo \
 *     --fixtures /secure/owned-fixtures/photos --out-dir /secure/concentrate-qualification \
 *     --max-requests 12 --spend-cap-usd 2
 *
 *   # 3. The same command plus --confirm-paid-requests sends real, billed requests.
 *
 *   # Two-stage photo reading (amendment 2.2): qualify the stage-1 quick read
 *   # (vision_photo, schemaVersion atlas_quick_read_v1) and then stage 2
 *   # (--role vision_photo_enrich). Stage 2 runs a real stage-1 quick read per
 *   # photo as its input, so it needs both profiles in the file and twice the
 *   # requests. A profile's reasoningEffort is sent as reasoning.effort and is
 *   # bound into the artifact through the profile hash; without it nothing is sent.
 *
 * Key: CONCENTRATE_API_KEY_FILE (preferred; must be chmod 600) or CONCENTRATE_API_KEY.
 * The key is never printed or written. The artifact holds aggregates only; copy
 * the out dir to the worker as CONCENTRATE_QUALIFICATION_DIR to mark the role qualified.
 */
import { fetchCatalog, qualifyProfile, readApiKey } from './qualify-concentrate-lib';
import { loadModelProfiles } from '../packages/providers/src/concentrate/profiles';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (line: string) => console.log(`[qualify-concentrate] ${line}`);

const outDir = arg('out-dir');
if (!outDir) {
  console.error('--out-dir is required (a private directory outside the repository).');
  process.exit(2);
}
let apiKey: string;
try {
  apiKey = await readApiKey({
    keyFile: process.env.CONCENTRATE_API_KEY_FILE,
    env: process.env.CONCENTRATE_API_KEY,
  });
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}

if (flag('catalog')) {
  const snapshot = await fetchCatalog({ apiKey, outDir, log });
  log(
    `catalog snapshot: ${snapshot.models.length} models over ${snapshot.pages} page(s), fetched_at ${snapshot.fetched_at}`,
  );
  process.exit(0);
}

const profileFile = arg('profile-file');
const role = arg('role');
const fixturesDir = arg('fixtures');
if (!profileFile || !role || !fixturesDir) {
  console.error('--profile-file, --role and --fixtures are required (or use --catalog).');
  process.exit(2);
}
const profiles = loadModelProfiles(profileFile);
const profile = profiles[role as 'vision_photo'];
if (!profile) {
  console.error(`No ${role} profile in ${profileFile}.`);
  process.exit(2);
}
// Stage 2 (amendment 2.2) is qualified on real stage-1 readings: the same profile
// file must hold the vision_photo quick-read profile, whose requests count too.
const stage1Profile = role === 'vision_photo_enrich' ? profiles.vision_photo : undefined;
if (role === 'vision_photo_enrich' && !stage1Profile) {
  console.error(`Qualifying vision_photo_enrich needs the vision_photo profile in ${profileFile}.`);
  process.exit(2);
}
const maxRequests = Number(arg('max-requests') ?? 0);
const spendCapUsd = Number(arg('spend-cap-usd') ?? 0);
if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0 || !(spendCapUsd > 0)) {
  console.error('--max-requests (positive integer) and --spend-cap-usd (positive) are required.');
  process.exit(2);
}
const run = await qualifyProfile({
  apiKey,
  outDir,
  profile,
  fixturesDir,
  maxRequests,
  spendCapMicros: Math.floor(spendCapUsd * 1_000_000),
  confirmPaidRequests: flag('confirm-paid-requests'),
  stage1Profile,
  log,
});
if (run.dryRun) {
  log(
    `dry run only: ${run.plannedRequests} request(s) planned. Re-run with --confirm-paid-requests to send them.`,
  );
} else {
  const a = run.artifact!;
  log(
    `${a.result.toUpperCase()}: ${a.fixtures.passed}/${a.fixtures.total} fixtures, ${a.requests_sent} request(s), outcomes ${JSON.stringify(a.fixtures.outcomes)}`,
  );
  log(`artifact written: ${a.artifact_id}.json (profile hash ${a.profile_hash.slice(0, 12)}...)`);
  process.exit(a.result === 'pass' ? 0 : 1);
}
