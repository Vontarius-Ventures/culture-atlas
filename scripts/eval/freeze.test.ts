import { describe, expect, it } from 'vitest';
import { BlindRunSchema, FreezeRecordSchema, blindConsumed, freezeViolations, type FreezeRecord } from './freeze';
import { sha256Hex } from './labels';

/*
 * The blind-set freeze check (fixtures/eval/golden-v2/FREEZE.md): held-out
 * labels and manifest entries are exactly the frozen ones, and the only change
 * ever allowed is every held-out entry going from blind: true to blind: false
 * once a failed blind run is recorded. Synthetic records only.
 */

const SHA = (c: string) => c.repeat(64);
const COMMIT = (c: string) => c.repeat(40);

function photo(id: string, blind: boolean) {
  return { id, split: 'holdout', blind, file: `${id}.jpg`, sha256: SHA(id === 'h14' ? 'a' : 'b'), width: 10, height: 10, source: { repo: 'o/r' } };
}
const tune = { id: 'p01', split: 'tune', file: 'p01.jpg', sha256: SHA('c'), width: 10, height: 10, source: { repo: 'o/r' } };
const labelText = new Map([
  ['h14', '{"id":"h14"}\n'],
  ['h15', '{"id":"h15"}\n'],
]);
const failedRun = {
  date: '2026-10-19',
  binding_commit: COMMIT('1'),
  code_commit: COMMIT('2'),
  result: 'fail' as const,
  failed_gates: ['M1'],
  requests: { concentrate: 4, qloo: 4 },
  report: 'docs/quality-plan.md section 16',
};

/** The freeze as it was written before any run: hashes over the blind: true entries. */
function frozen(): FreezeRecord {
  const holdout = [photo('h14', true), photo('h15', true)];
  return {
    golden_set: 'golden-v9',
    split: 'holdout',
    labelled_on: '2026-10-19',
    labelled_from: COMMIT('3'),
    model_runs_before_freeze: 0,
    holdout_manifest_sha256: sha256Hex(JSON.stringify(holdout)),
    photos: Object.fromEntries(holdout.map((p) => [p.id, { label_sha256: sha256Hex(labelText.get(p.id)!), photo_sha256: p.sha256 }])),
  };
}
const check = (photos: ReturnType<typeof photo>[], freeze = frozen(), labels = labelText) =>
  freezeViolations({ manifestVersion: 'golden-v9', manifestPhotos: [tune, ...photos], labelText: labels, freeze });

describe('blind-set freeze (FREEZE.md)', () => {
  it('holds before the blind run: blind entries, frozen labels', () => {
    expect(check([photo('h14', true), photo('h15', true)])).toEqual([]);
    expect(blindConsumed(frozen())).toBe(false);
    expect(blindConsumed(null)).toBe(false);
  });

  it('after a failed blind run, allows exactly the blind true -> false transition of every held-out entry', () => {
    const after = { ...frozen(), blind_run: failedRun };
    expect(blindConsumed(after)).toBe(true);
    expect(check([photo('h14', false), photo('h15', false)], after)).toEqual([]);
    // The run is recorded but the split still claims to be blind: a later qualification would count it as blind.
    expect(check([photo('h14', true), photo('h15', true)], after)).toEqual([expect.stringContaining('still blind: h14,h15')]);
    // All or nothing.
    expect(check([photo('h14', false), photo('h15', true)], after)).toEqual([expect.stringContaining('still blind: h15')]);
  });

  it('refuses dropping the blind flag without a recorded failed blind run (a pass does not consume the split)', () => {
    expect(check([photo('h14', false), photo('h15', false)])).toEqual([expect.stringContaining('not blind: h14,h15')]);
    const passed = { ...frozen(), blind_run: { ...failedRun, result: 'pass' as const, failed_gates: [] } };
    expect(blindConsumed(passed)).toBe(false);
    expect(check([photo('h14', true), photo('h15', true)], passed)).toEqual([]);
    expect(check([photo('h14', false), photo('h15', false)], passed)).toEqual([expect.stringContaining('not blind')]);
  });

  it('refuses any other change: a label edit, a manifest field, a photo hash, an added or removed held-out photo', () => {
    const after = { ...frozen(), blind_run: failedRun };
    const flipped = [photo('h14', false), photo('h15', false)];
    expect(check(flipped, after, new Map([...labelText, ['h15', '{"id":"h15","notes":"x"}\n']]))).toEqual(['h15: label differs from the frozen one']);
    expect(check([{ ...photo('h14', false), width: 11 }, photo('h15', false)], after)).toEqual([expect.stringContaining('differ from the frozen ones')]);
    expect(check([{ ...photo('h14', false), sha256: SHA('d') }, photo('h15', false)], after)).toEqual([
      expect.stringContaining('differ from the frozen ones'),
      'h14: photo sha256 differs from the frozen one',
    ]);
    expect(check([photo('h14', false)], after)).toEqual([expect.stringContaining('differ from the frozen h14,h15'), expect.stringContaining('differ from the frozen ones')]);
    expect(check(flipped, after, new Map([['h14', labelText.get('h14')!]]))).toEqual(['h15: label missing']);
    // A record for another set.
    expect(freezeViolations({ manifestVersion: 'golden-v8', manifestPhotos: [tune, ...flipped], labelText, freeze: after })).toEqual([
      'freeze.json is for golden-v9, the manifest is golden-v8',
    ]);
  });

  it('the blind-run record is strict: a failure names its gates, a pass names none, no extra keys', () => {
    expect(BlindRunSchema.safeParse(failedRun).success).toBe(true);
    expect(BlindRunSchema.safeParse({ ...failedRun, failed_gates: [] }).success).toBe(false);
    expect(BlindRunSchema.safeParse({ ...failedRun, result: 'pass' }).success).toBe(false);
    expect(BlindRunSchema.safeParse({ ...failedRun, code_commit: '303b29b' }).success).toBe(false);
    expect(BlindRunSchema.safeParse({ ...failedRun, outputs: [] }).success).toBe(false);
    expect(FreezeRecordSchema.safeParse({ ...frozen(), blind_run: failedRun }).success).toBe(true);
    expect(FreezeRecordSchema.safeParse({ ...frozen(), model_runs_before_freeze: 1 }).success).toBe(false);
  });
});
