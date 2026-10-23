/**
 * Prints, or with --write regenerates, the committed evaluation binding
 * (packages/providers/src/concentrate/eval-binding.ts). Regenerating it
 * un-qualifies every role whose artifact was scored on other inputs.
 *
 *   pnpm eval:binding [--write]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bindingSource, computeEvalBinding } from './eval/binding';

const root = path.resolve(import.meta.dirname, '..');
const target = path.join(root, 'packages/providers/src/concentrate/eval-binding.ts');
const source = bindingSource(await computeEvalBinding(root));
const current = await readFile(target, 'utf8').catch(() => '');
if (current === source) {
  console.log('[eval-binding] up to date');
  process.exit(0);
}
if (process.argv.includes('--write')) {
  await writeFile(target, source);
  console.log(`[eval-binding] wrote ${path.relative(root, target)}; roles qualified on the old inputs are now stale.`);
  process.exit(0);
}
console.log(source);
console.error('[eval-binding] the committed binding is out of date; re-run with --write.');
process.exit(1);
