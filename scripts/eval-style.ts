/**
 * pnpm eval:style --run <live-check out dir> [--labels fixtures/eval/style-v1/labels]
 *
 * Scores the captures a live check saved (scripts/style/live-check.ts:
 * live-check.json plus <photo>.capture.json) with score-style-v1
 * (scripts/eval/style-scorer.ts). No network, no spend: the paid part is the
 * live check itself. Prints the scorecard JSON.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { StyleLabel, scoreStyle, type CaptureView, type PhotoInput } from './eval/style-scorer';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const run = flag('--run');
if (!run) {
  console.error('usage: pnpm eval:style --run <live-check out dir> [--labels <dir>]');
  process.exit(2);
}
const labelsDir = flag('--labels');
const labels = new Map<string, StyleLabel>();
if (labelsDir && existsSync(labelsDir))
  for (const f of readdirSync(labelsDir).filter((x) => x.endsWith('.json'))) {
    const l = StyleLabel.parse(JSON.parse(readFileSync(join(labelsDir, f), 'utf8')));
    labels.set(l.photo.split('/').pop()!, l);
  }
const report = JSON.parse(readFileSync(join(run, 'live-check.json'), 'utf8')) as { photo: string; milestones_ms: Record<string, number> }[];
const photos: PhotoInput[] = report.map((r) => ({
  id: r.photo,
  view: JSON.parse(readFileSync(join(run, `${r.photo}.capture.json`), 'utf8')) as CaptureView,
  milestones: r.milestones_ms,
  label: labels.get(r.photo),
}));
console.log(JSON.stringify(scoreStyle(photos), null, 2));
