/**
 * Interest-graph current-state backfill (PR 8 package B, runbook tooling).
 *   pnpm graph:backfill [--account <uuid>]... [--batch-size 50] [--max-accounts 500]
 *
 * Rebuilds accounts whose private projection is behind current authoritative
 * state — accounts that gathered saves, picks, exclusions and capture
 * corrections before the projection flag existed have no historical intents, so
 * they are labeled backfill_current_state, never invented event provenance.
 * Checkpointed and resumable; replay adds nothing. Requires the operator
 * opt-in (INTEREST_GRAPH_PROJECTION_ENABLED) and never writes live
 * recommendations (projection is shadow-only).
 */
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import { runInterestGraphBackfill } from '../packages/domain/src/interest-graph/backfill';

loadRootEnv(path.resolve(import.meta.dirname, '..'));

interface Args {
  accountIds: string[];
  batchSize: number;
  maxAccounts: number;
}

function parseArgs(argv: string[]): Args {
  const accountIds: string[] = [];
  let batchSize = 50;
  let maxAccounts = 500;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--account') {
      const id = argv[++i];
      if (!id) throw new Error('--account requires a uuid');
      accountIds.push(id);
    } else if (arg === '--batch-size') {
      batchSize = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('--batch-size requires a positive integer');
    } else if (arg === '--max-accounts') {
      maxAccounts = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isInteger(maxAccounts) || maxAccounts < 0) throw new Error('--max-accounts requires a non-negative integer');
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { accountIds, batchSize, maxAccounts };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
if (process.env.INTEREST_GRAPH_PROJECTION_ENABLED !== 'true' && process.env.INTEREST_GRAPH_PROJECTION_ENABLED !== '1') {
  console.error('INTEREST_GRAPH_PROJECTION_ENABLED must be true to backfill graph projections.');
  process.exit(2);
}

const db = createDb(url, 1);
try {
  const result = await runInterestGraphBackfill(db, {
    // Environment strings satisfy the projection gate (opt-in + kill list).
    config: process.env,
    ...(args.accountIds.length > 0 ? { accountIds: args.accountIds } : {}),
    batchSize: args.batchSize,
    maxAccounts: args.maxAccounts,
  });
  console.log(
    JSON.stringify({
      state: result.state,
      accounts_projected: result.accountsProjected,
      sweeps: result.sweeps,
      due_remaining: result.dueRemaining,
      checkpoint: result.checkpoint,
    }),
  );
  process.exitCode = result.state === 'complete' ? 0 : 1;
} catch (error) {
  console.error(`Backfill failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
