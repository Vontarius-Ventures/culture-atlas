import { loadGoldenSet } from './eval/labels';
import { labelOverlaps } from './eval/label-lint';

/**
 * Lists names a golden set's labels both accept and forbid (docs/quality-plan.md §19.8). Run it on a new
 * blind split before the freeze: `pnpm eval:lint-labels --golden fixtures/eval/golden-v5`. Exits 1 when
 * an overlap is not resolved by score-v10 (the forbidden pattern would win it), so the labeller decides.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--golden');
  const dir = i >= 0 ? args[i + 1] : undefined;
  if (!dir) throw new Error('usage: eval:lint-labels --golden <dir>');
  const golden = await loadGoldenSet(dir);
  let unresolved = 0;
  for (const label of [...golden.labels.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const o of labelOverlaps(label)) {
      if (!o.resolved) unresolved++;
      console.log(
        `${o.photoId} ${o.resolved ? 'resolved' : 'CONFLICT'}: ${o.list} "${o.sample}" matches forbidden /${o.forbidden.slice(0, 80)}/`,
      );
    }
  }
  console.log(
    `[eval-lint-labels] ${golden.labels.size} label(s), ${unresolved} unresolved overlap(s)`,
  );
  if (unresolved) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
