/**
 * Operator kill switches (docs/runbooks/glasses-kill-switch.md).
 *   pnpm ops:kill list
 *   pnpm ops:kill kill meta_glasses_capture_enabled --reason "SDK incident"
 *   pnpm ops:kill lift meta_glasses_capture_enabled
 * Uses DATABASE_URL. A kill only turns a feature off; library reads, deletion
 * and already captured media keep working.
 */
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import { parseKillArgs, runKillCommand } from './feature-kill-lib';

loadRootEnv(path.resolve(import.meta.dirname, '..'));
const url = process.env.DATABASE_URL;
let command;
try {
  command = parseKillArgs(
    process.argv.slice(2).filter((a) => a !== '--'),
    process.env.USER,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const db = createDb(url, 1);
try {
  console.log(await runKillCommand(db, command));
} catch {
  console.error('Kill switch update failed. Check database connectivity and permissions.');
  process.exitCode = 1;
} finally {
  await db.end();
}
