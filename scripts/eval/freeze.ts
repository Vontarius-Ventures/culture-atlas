import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sha256Hex } from './labels';

/**
 * The blind-set freeze record (`<golden dir>/freeze.json`, see
 * fixtures/eval/golden-v2/FREEZE.md): the sha256 of every held-out label and
 * of the held-out manifest entries as they were frozen before any model saw
 * them, and, once the blind split has been read, the record of that run.
 *
 * A failed blind run consumes the split (docs/requalification-plan.md: "If the
 * blind run fails ... fixes go into a future round with yet another fresh
 * set"). The record is what the code reads to enforce that: the evaluation
 * binding carries it as `blind_consumed` (scripts/eval/binding.ts), so
 * evalGateFailure() refuses every photo-role artifact on the set, and
 * qualifyProfile() refuses the set before any request.
 */

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);
const COMMIT = z.string().regex(/^[0-9a-f]{40}$/);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const BlindRunSchema = z
  .object({
    date: DAY,
    /** The commit that bound the frozen rules and the set (FREEZE.md step 4). */
    binding_commit: COMMIT,
    /** The code the blind run was made with. */
    code_commit: COMMIT,
    result: z.enum(['pass', 'fail']),
    /** Live gates the run failed (empty on a pass). */
    failed_gates: z.array(z.string().regex(/^[A-Za-z0-9_]{1,40}$/)),
    requests: z.object({ concentrate: z.number().int().nonnegative(), qloo: z.number().int().nonnegative() }).strict(),
    /** Where the result is reported (repository-relative document and section). */
    report: z.string().min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.result === 'fail') !== r.failed_gates.length > 0)
      ctx.addIssue({ code: 'custom', message: 'a failed blind run names its failed gates; a passing one names none' });
  });
export type BlindRun = z.infer<typeof BlindRunSchema>;

export const FreezeRecordSchema = z
  .object({
    golden_set: z.string().regex(/^golden-v\d+$/),
    split: z.literal('holdout'),
    labelled_on: DAY,
    labelled_from: COMMIT,
    model_runs_before_freeze: z.literal(0),
    holdout_manifest_sha256: SHA256,
    photos: z.record(z.string(), z.object({ label_sha256: SHA256, photo_sha256: SHA256 }).strict()),
    /** Added once, after the blind run; never edited afterwards. */
    blind_run: BlindRunSchema.optional(),
  })
  .strict();
export type FreezeRecord = z.infer<typeof FreezeRecordSchema>;

export const FREEZE_FILE = 'freeze.json';

/** The freeze record of a golden set directory, or null when the set has none (golden-v1). */
export async function loadFreezeRecord(goldenDir: string): Promise<FreezeRecord | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(goldenDir, FREEZE_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return FreezeRecordSchema.parse(JSON.parse(raw));
}

/** True when a failed blind run is recorded: the held-out split can no longer qualify a role. */
export function blindConsumed(freeze: FreezeRecord | null): boolean {
  return freeze?.blind_run?.result === 'fail';
}

type RawManifestPhoto = { id: string; split: string; sha256: string; blind?: boolean } & Record<string, unknown>;

/**
 * Every way the held-out split differs from its freeze (empty when it holds).
 * The labels and the manifest entries must be exactly the frozen ones, with one
 * permitted transition: after a recorded failed blind run every held-out entry
 * flips `blind` from true to false (and only then, and all of them), because
 * the split has been read and is no longer blind. Nothing else may change.
 *
 * `manifestPhotos` are the manifest entries as written in the file (key order
 * matters for the hash), `labelText` the raw label files by photo id.
 */
export function freezeViolations(input: {
  manifestVersion: string;
  manifestPhotos: readonly RawManifestPhoto[];
  labelText: ReadonlyMap<string, string>;
  freeze: FreezeRecord;
}): string[] {
  const { freeze } = input;
  const out: string[] = [];
  if (freeze.golden_set !== input.manifestVersion) out.push(`freeze.json is for ${freeze.golden_set}, the manifest is ${input.manifestVersion}`);
  const holdout = input.manifestPhotos.filter((p) => p.split === 'holdout');
  const ids = holdout.map((p) => p.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(Object.keys(freeze.photos).sort()))
    out.push(`held-out ids ${ids.join(',')} differ from the frozen ${Object.keys(freeze.photos).sort().join(',')}`);
  const consumed = blindConsumed(freeze);
  const expectedBlind = !consumed;
  const wrongFlag = holdout.filter((p) => p.blind !== expectedBlind).map((p) => p.id);
  if (wrongFlag.length)
    out.push(
      consumed
        ? `a failed blind run is recorded, so every held-out entry is blind: false; still blind: ${wrongFlag.join(',')}`
        : `no failed blind run is recorded, so every held-out entry is blind: true; not blind: ${wrongFlag.join(',')}`,
    );
  // The frozen hash was taken with blind: true; restore exactly that value (and nothing else) before hashing.
  const asFrozen = holdout.map((p) => ('blind' in p ? { ...p, blind: true } : p));
  if (sha256Hex(JSON.stringify(asFrozen)) !== freeze.holdout_manifest_sha256)
    out.push('the held-out manifest entries differ from the frozen ones (beyond the blind flag)');
  for (const p of holdout) {
    const frozen = freeze.photos[p.id];
    if (!frozen) continue;
    const text = input.labelText.get(p.id);
    if (text === undefined) out.push(`${p.id}: label missing`);
    else if (sha256Hex(text.replace(/\r\n/g, '\n')) !== frozen.label_sha256) out.push(`${p.id}: label differs from the frozen one`);
    if (p.sha256 !== frozen.photo_sha256) out.push(`${p.id}: photo sha256 differs from the frozen one`);
  }
  return out;
}

/** freezeViolations() for a golden set directory (reads manifest.json and the held-out labels as written). */
export async function checkFreeze(goldenDir: string): Promise<{ freeze: FreezeRecord | null; violations: string[] }> {
  const freeze = await loadFreezeRecord(goldenDir);
  if (!freeze) return { freeze, violations: [] };
  const manifest = JSON.parse(await readFile(path.join(goldenDir, 'manifest.json'), 'utf8')) as { version: string; photos: RawManifestPhoto[] };
  const labelText = new Map<string, string>();
  for (const p of manifest.photos.filter((x) => x.split === 'holdout')) {
    try {
      labelText.set(p.id, await readFile(path.join(goldenDir, 'labels', `${p.id}.json`), 'utf8'));
    } catch {
      /* reported as missing */
    }
  }
  return { freeze, violations: freezeViolations({ manifestVersion: manifest.version, manifestPhotos: manifest.photos, labelText, freeze }) };
}
