/**
 * Budgeted live photo evaluation (docs/quality-plan.md §7.4). Dry run by default.
 *
 *   pnpm eval:live --golden fixtures/eval/golden-v1 --photos $EVAL_PHOTOS_DIR --split all \
 *     --profile-file <operator>/profiles.json --roles vision_photo,vision_photo_enrich \
 *     --out-dir <outside git, holding catalog-snapshot.json> --max-requests 60 --spend-cap-usd 0.5 \
 *     [--qloo --max-qloo-requests 40 --qloo-concurrency 2 --qloo-spacing-ms 700 [--grounding-judgements <file>]] \
 *     [--only p13,h01] [--ledger <file>] [--confirm-paid-requests]
 *
 * Every photo is sha256-checked before anything is planned. With
 * --confirm-paid-requests it sends real, billed requests under a persistent
 * request counter (no retries; stops on 401/402/403/404/422/429), logs every call
 * to the ledger, scores the readings through the runtime guardrails against the
 * live gates, and writes raw outputs (replay format) and scorecard.json to --out-dir
 * only. Keys: CONCENTRATE_API_KEY_FILE or CONCENTRATE_API_KEY; QLOO_API_KEY for --qloo.
 * The keys are never printed or written.
 */
import path from 'node:path';
import { loadModelProfiles } from '../packages/providers/src/concentrate/profiles';
import { loadGoldenSet, loadThresholds } from './eval/labels';
import * as grounding from '../packages/domain/src/compiler/grounding';
import { runLiveEval, type GroundingModule } from './eval/live';
import { RUNTIME_GUARDS, runtimeGuardedPipeline } from './eval/pipeline';
import { summarize } from './eval/replay';
import { gateLines, type GroundingJudgement } from './eval/release-gates';
import { readFile } from 'node:fs/promises';
import { readApiKey } from './qualify-concentrate-lib';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (line: string) => console.log(`[eval-live] ${line}`);
const root = path.resolve(import.meta.dirname, '..');

const photosDir = arg('photos', process.env.EVAL_PHOTOS_DIR);
const profileFile = arg('profile-file');
const outDir = arg('out-dir');
const maxRequests = Number(arg('max-requests') ?? 0);
const spendCapUsd = Number(arg('spend-cap-usd') ?? 0);
if (!photosDir || !profileFile || !outDir || !Number.isSafeInteger(maxRequests) || maxRequests <= 0 || !(spendCapUsd > 0)) {
  console.error('--photos, --profile-file, --out-dir, --max-requests (positive integer) and --spend-cap-usd (positive) are required.');
  process.exit(2);
}
const roles = (arg('roles', 'vision_photo,vision_photo_enrich') ?? '').split(',').filter(Boolean);
if (roles.some((r) => r !== 'vision_photo' && r !== 'vision_photo_enrich')) {
  console.error('--roles takes vision_photo and vision_photo_enrich only.');
  process.exit(2);
}
const golden = await loadGoldenSet(arg('golden', path.join(root, 'fixtures/eval/golden-v1'))!);
const { thresholds } = await loadThresholds(arg('thresholds', path.join(root, 'fixtures/eval/thresholds.json'))!);
const confirm = flag('confirm-paid-requests');

let qloo: Parameters<typeof runLiveEval>[0]['qloo'];
if (flag('qloo')) {
  const concurrency = Number(arg('qloo-concurrency', '1'));
  const spacingMs = Number(arg('qloo-spacing-ms', '700'));
  const maxQloo = Number(arg('max-qloo-requests', '0'));
  if (!(concurrency >= 1 && concurrency <= 3) || !(spacingMs >= 700) || !Number.isSafeInteger(maxQloo) || maxQloo <= 0) {
    console.error('--qloo needs --max-qloo-requests > 0, --qloo-concurrency 1..3 and --qloo-spacing-ms >= 700.');
    process.exit(2);
  }
  const apiKey = process.env.QLOO_API_KEY?.trim();
  if (confirm && !apiKey) {
    console.error('Set QLOO_API_KEY for --qloo.');
    process.exit(2);
  }
  qloo = {
    apiKey: apiKey ?? '',
    baseUrl: process.env.QLOO_API_URL ?? 'https://hackathon.api.qloo.com',
    maxRequests: maxQloo,
    spacingMs,
    grounding: grounding satisfies GroundingModule,
    // Hand judgements of accepted matches ([{ photo, candidate, correct_match, good_candidate, findable }]).
    judgements: arg('grounding-judgements')
      ? (JSON.parse(await readFile(arg('grounding-judgements')!, 'utf8')) as GroundingJudgement[])
      : undefined,
  };
}

const apiKey = confirm
  ? await readApiKey({ keyFile: process.env.CONCENTRATE_API_KEY_FILE, env: process.env.CONCENTRATE_API_KEY })
  : undefined;
const result = await runLiveEval({
  golden,
  photosDir,
  split: (arg('split', 'all') ?? 'all') as 'all' | 'tune' | 'holdout',
  only: arg('only')?.split(',').filter(Boolean),
  profiles: loadModelProfiles(profileFile),
  roles: roles as ('vision_photo' | 'vision_photo_enrich')[],
  outDir,
  repoRoot: root,
  maxRequests,
  spendCapMicros: Math.floor(spendCapUsd * 1_000_000),
  confirmPaidRequests: confirm,
  apiKey,
  pipeline: runtimeGuardedPipeline,
  thresholds,
  qloo,
  ledgerFile: arg('ledger'),
  packageName: arg('package', 'eval'),
  log,
});
if (result.dryRun) {
  log(`dry run only: ${result.plannedRequests} Concentrate request(s), at most ${result.plannedQlooMax} Qloo. Re-run with --confirm-paid-requests to send them.`);
  process.exit(0);
}
for (const line of summarize({ pipeline: 'guarded', guardrail_version: RUNTIME_GUARDS.GUARDRAIL_VERSION, scorecard: result.scorecard!, decisions: {}, runs: [] }))
  log(line);
if (result.grounding) for (const line of gateLines('grounding gate (thresholds.json)', result.grounding)) log(line);
log(`requests sent ${result.requestsSent}, Qloo ${result.qlooSent}${result.stoppedBy ? `, stopped by ${result.stoppedBy}` : ''}; scorecard.json written to --out-dir`);
process.exit(result.scorecard!.pass && (!result.grounding || result.grounding.pass) && !result.stoppedBy ? 0 : 1);
