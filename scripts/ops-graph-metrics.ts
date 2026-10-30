/**
 * Prints the interest-graph operational snapshot as one CloudWatch Embedded
 * Metric Format line (packages/domain/src/ops/graph-metrics.ts): projection
 * lag, pending outbox, run failures/lag, rollback/fence rejections, stuck
 * work-budget windows, durable spend-ledger state and deletion purge lag.
 *   pnpm ops:graph-metrics                 one snapshot, then exit
 *   pnpm ops:graph-metrics -- --every 300  loop (seconds)
 * Uses DATABASE_URL. Counts and lags only: no IDs, payloads, titles or
 * private interest text (VAL-OPS-003).
 */
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import {
  collectGraphOpsSnapshot,
  graphRunOutcomeLine,
  recentGraphRunOutcomes,
  toGraphOpsMetricLine,
} from '../packages/domain/src/ops/graph-metrics';

loadRootEnv(path.resolve(import.meta.dirname, '..'));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const everyFlag = process.argv.indexOf('--every');
const every = everyFlag >= 0 ? Number(process.argv[everyFlag + 1]) : 0;
if (everyFlag >= 0 && (!Number.isInteger(every) || every < 30)) {
  console.error('--every must be an integer number of seconds, at least 30.');
  process.exit(2);
}
const db = createDb(url, 1);
const options = {
  namespace: process.env.OPS_METRICS_NAMESPACE ?? 'CultureAtlas',
  environment: process.env.OPS_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
};
let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));
try {
  do {
    try {
      console.log(toGraphOpsMetricLine(await collectGraphOpsSnapshot(db), options));
      // A few sanitized run-outcome samples travel with the snapshot: ids,
      // kinds, states and revisions only.
      for (const outcome of await recentGraphRunOutcomes(db, 3)) graphRunOutcomeLine(outcome);
    } catch {
      // A missing snapshot is itself the signal (alarms treat missing data as breaching).
      console.error(JSON.stringify({ level: 'error', event: 'graph_ops_snapshot_failed' }));
      if (!every) process.exitCode = 1;
    }
    if (every) await sleep(every * 1000);
  } while (every && !stopping);
} finally {
  await db.end();
}
