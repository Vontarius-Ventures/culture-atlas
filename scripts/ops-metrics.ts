/**
 * Prints one CloudWatch Embedded Metric Format line with queue/cleanup/spend
 * health (packages/domain/src/ops/metrics.ts).
 *   pnpm ops:metrics                 one snapshot, then exit
 *   pnpm ops:metrics -- --every 300  loop (seconds)
 * Uses DATABASE_URL. Prints counts only: no IDs, payloads or account data.
 * On AWS the container's awslogs driver ships the line to CloudWatch Logs,
 * which extracts the metrics (see infra/aws and docs/deploy-aws.md).
 */
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import { collectOpsSnapshot, toEmbeddedMetricLine } from '../packages/domain/src/ops/metrics';

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
      console.log(toEmbeddedMetricLine(await collectOpsSnapshot(db), options));
    } catch {
      // A missing snapshot is itself the signal (alarms treat missing data as breaching).
      console.error(JSON.stringify({ level: 'error', event: 'ops_snapshot_failed' }));
      if (!every) process.exitCode = 1;
    }
    if (every) await sleep(every * 1000);
  } while (every && !stopping);
} finally {
  await db.end();
}
