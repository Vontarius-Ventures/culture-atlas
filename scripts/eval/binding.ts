import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { blindConsumed, loadFreezeRecord } from './freeze';
import { goldenDigest, loadGoldenSet, sha256Hex } from './labels';
import { SCORER_VERSION } from './scorer';
import { TEXT_SCORER_VERSION } from './text-scorer';

/**
 * The evaluation binding (docs/quality-plan.md §7.5, review findings on the
 * qualification gate): what a qualification artifact must have been scored
 * against for its role to count as qualified. Computed here from the
 * repository files; the committed copy lives in
 * packages/providers/src/concentrate/eval-binding.ts, where
 * qualificationState() reads it at runtime. A hermetic test
 * (binding.test.ts) fails whenever the two differ, so editing a label, the
 * manifest, thresholds.json, a scorer, a prompt builder or a guard rule
 * cannot leave an existing artifact qualified: the committed binding has to
 * be regenerated (`pnpm eval:binding --write`), which makes every artifact
 * scored on the old inputs stale.
 */

/** Source files whose behaviour an evaluation measures, per golden set (paths from the repository root). */
/** The photo reading code an evaluation on a photo golden set measures. */
const PHOTO_CODE: readonly string[] = [
  'packages/providers/src/vlm/guardrails.ts',
  'packages/providers/src/vlm/lexicons.ts',
  'packages/providers/src/vlm/types.ts',
  'packages/providers/src/vlm/prompt.ts',
  // The verifier's target selection, outcome rules and prompt (vision_verify is a photo role).
  'packages/providers/src/vlm/verify.ts',
  'packages/providers/src/concentrate/providers.ts',
  'scripts/eval/scorer.ts',
  'scripts/eval/labels.ts',
  'scripts/eval/pipeline.ts',
  'scripts/eval/golden-photos.ts',
];

/**
 * Photo golden sets in the binding: golden-v1 (replay-v1, earlier artifacts),
 * golden-v2 (the photo roles' set; its blind split is consumed) and golden-v3
 * (round 2: every golden-v2 photo as tune, h14-h29 included, with the h26
 * label fix; it gains a fresh blind split h30+ before a photo role can
 * qualify on it).
 */
export const PHOTO_GOLDEN_SETS = ['golden-v1', 'golden-v2', 'golden-v3'] as const;

export const BOUND_CODE: Record<string, readonly string[]> = {
  'golden-v1': PHOTO_CODE,
  // The requalification set (docs/requalification-plan.md): the photo roles qualify only on it.
  'golden-v2': PHOTO_CODE,
  'golden-v3': PHOTO_CODE,
  'text-v1': [
    'scripts/eval/text-scorer.ts',
    'scripts/eval/text-schemas.ts',
    'scripts/eval/text-golden.ts',
    'scripts/eval/build-text-fixtures.ts',
    // The dietary filters the scorer applies exactly as production does.
    'packages/domain/src/composer/dietary.ts',
  ],
};

export interface EvalSetBinding {
  golden_sha256: string;
  scorer_version: string;
  code_sha256: string;
  /**
   * Photo sets only: true once a failed blind run is recorded in the set's
   * freeze.json (scripts/eval/freeze.ts). The held-out split has then been read
   * and can no longer qualify a photo role, whatever a later run scores.
   */
  blind_consumed?: boolean;
}
export interface EvalBinding {
  thresholds_sha256: string;
  sets: Record<string, EvalSetBinding>;
}

/** sha256 over each bound file's path and contents (line endings normalized), in a fixed order. */
export async function codeDigest(root: string, files: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const rel of [...files].sort()) parts.push(`${rel}\0${(await readFile(path.join(root, rel), 'utf8')).replace(/\r\n/g, '\n')}`);
  return sha256Hex(parts.join('\0\0'));
}

export async function computeEvalBinding(root: string): Promise<EvalBinding> {
  const text = JSON.parse(await readFile(path.join(root, 'fixtures/eval/text-v1/manifest.json'), 'utf8')) as { golden_set: string; golden_sha256: string };
  const sets: EvalBinding['sets'] = {};
  for (const name of PHOTO_GOLDEN_SETS) {
    const golden = await loadGoldenSet(path.join(root, 'fixtures/eval', name));
    if (golden.manifest.version !== name) throw new Error(`fixtures/eval/${name} declares version ${golden.manifest.version}.`);
    sets[name] = {
      golden_sha256: goldenDigest(golden),
      scorer_version: SCORER_VERSION,
      code_sha256: await codeDigest(root, BOUND_CODE[name]!),
      blind_consumed: blindConsumed(await loadFreezeRecord(path.join(root, 'fixtures/eval', name))),
    };
  }
  return {
    thresholds_sha256: sha256Hex(await readFile(path.join(root, 'fixtures/eval/thresholds.json'))),
    sets: {
      ...sets,
      [text.golden_set]: {
        golden_sha256: text.golden_sha256,
        scorer_version: TEXT_SCORER_VERSION,
        code_sha256: await codeDigest(root, BOUND_CODE[text.golden_set]!),
      },
    },
  };
}

/** The TypeScript source of packages/providers/src/concentrate/eval-binding.ts for a binding. */
export function bindingSource(b: EvalBinding): string {
  const sets = Object.entries(b.sets)
    .sort(([x], [y]) => x.localeCompare(y))
    .map(
      ([name, s]) =>
        `    '${name}': {\n      golden_sha256: '${s.golden_sha256}',\n      scorer_version: '${s.scorer_version}',\n      code_sha256: '${s.code_sha256}',\n${
          s.blind_consumed === undefined ? '' : `      blind_consumed: ${s.blind_consumed},\n`
        }    },`,
    )
    .join('\n');
  return `/**
 * GENERATED by \`pnpm eval:binding --write\` (scripts/eval/binding.ts); do not edit by hand.
 *
 * What a qualification artifact's eval block must match for its role to be
 * qualified (docs/quality-plan.md §7.5): the thresholds file, each golden
 * set's digest, its scorer version and the digest of the code the
 * evaluation measured (guardrails, lexicons, prompts and scorer for the
 * photo sets; scorer, schemas and fixture builder for the text set). A photo
 * set whose freeze.json records a failed blind run is \`blind_consumed\`: no
 * photo role qualifies on it any more.
 * scripts/eval/binding.test.ts recomputes every value from the repository
 * and fails when this file is out of date. Regenerating it makes every
 * artifact scored on the old inputs stale, so the affected roles drop to
 * catalog-compatible until they are re-qualified.
 */
export const EVAL_BINDING = {
  thresholds_sha256: '${b.thresholds_sha256}',
  sets: {
${sets}
  },
} as const satisfies { thresholds_sha256: string; sets: Record<string, { golden_sha256: string; scorer_version: string; code_sha256: string; blind_consumed?: boolean }> };
`;
}
