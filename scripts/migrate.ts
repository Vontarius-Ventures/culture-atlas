/**
 * Usage: pnpm db:migrate            (uses DATABASE_URL)
 *        pnpm db:migrate -- --url postgres://...
 */
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { runMigrations } from '../packages/domain/src/db/migrate';

loadRootEnv(path.resolve(import.meta.dirname, '..'));

const urlFlag = process.argv.indexOf('--url');
const url =
  (urlFlag >= 0 ? process.argv[urlFlag + 1] : undefined) ??
  process.env.DATABASE_URL ??
  'postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas';

const redacted = url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
console.log(`Migrating ${redacted}`);
runMigrations(url, { log: (m) => console.log(`  ${m}`) })
  .then((r) => {
    console.log(`Done: ${r.applied.length} applied, ${r.skipped.length} already applied, ${r.reconciled.length} reconciled.`);
  })
  .catch((err: unknown) => {
    console.error((err as Error).message);
    process.exit(1);
  });
