import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVAL_BINDING } from '../../packages/providers/src/concentrate/eval-binding';
import { BOUND_CODE, bindingSource, codeDigest, computeEvalBinding } from './binding';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('evaluation binding (qualification gate, quality plan §7.5)', () => {
  it('the committed binding is what the repository computes: regenerate it with pnpm eval:binding --write', async () => {
    const computed = await computeEvalBinding(ROOT);
    expect(EVAL_BINDING).toEqual(computed);
    expect(await readFile(path.join(ROOT, 'packages/providers/src/concentrate/eval-binding.ts'), 'utf8')).toBe(bindingSource(computed));
  });

  it('binds the guard rules, lexicons, prompts and scorer for photos, and the text scorer and builders for text', () => {
    expect(BOUND_CODE['golden-v1']).toEqual(
      expect.arrayContaining([
        'packages/providers/src/vlm/guardrails.ts',
        'packages/providers/src/vlm/lexicons.ts',
        'packages/providers/src/vlm/prompt.ts',
        'scripts/eval/scorer.ts',
      ]),
    );
    // The photo roles' set binds the same photo code as golden-v1.
    expect(BOUND_CODE['golden-v2']).toEqual(BOUND_CODE['golden-v1']);
    expect(EVAL_BINDING.sets).toHaveProperty('golden-v2');
    // Round 2's set (tune + the h30+ blind split) binds the same photo code; its blind run failed and is recorded
    // (golden-v3/freeze.json), so it is consumed like golden-v2.
    expect(BOUND_CODE['golden-v3']).toEqual(BOUND_CODE['golden-v1']);
    expect(EVAL_BINDING.sets['golden-v2'].blind_consumed).toBe(true);
    expect(EVAL_BINDING.sets['golden-v3'].blind_consumed).toBe(true);
    expect(BOUND_CODE['text-v1']).toEqual(expect.arrayContaining(['scripts/eval/text-scorer.ts', 'scripts/eval/build-text-fixtures.ts']));
  });

  it('any edit to a bound file changes the code digest (no version to remember to bump)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-binding-'));
    await mkdir(path.join(dir, 'a'), { recursive: true });
    await writeFile(path.join(dir, 'a/rules.ts'), "export const WORDS = ['nissan'];\n");
    await writeFile(path.join(dir, 'a/scorer.ts'), 'export const V = 1;\n');
    const before = await codeDigest(dir, ['a/rules.ts', 'a/scorer.ts']);
    expect(await codeDigest(dir, ['a/scorer.ts', 'a/rules.ts'])).toBe(before);
    await writeFile(path.join(dir, 'a/rules.ts'), "export const WORDS = ['nissan', 'trek'];\n");
    expect(await codeDigest(dir, ['a/rules.ts', 'a/scorer.ts'])).not.toBe(before);
    // Line endings do not matter.
    await writeFile(path.join(dir, 'a/scorer.ts'), 'export const V = 1;\r\n');
    await writeFile(path.join(dir, 'a/rules.ts'), "export const WORDS = ['nissan'];\n");
    expect(await codeDigest(dir, ['a/rules.ts', 'a/scorer.ts'])).toBe(before);
  });
});
