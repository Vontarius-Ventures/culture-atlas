/**
 * Prints the durable spend-ledger reconciliation against the configured
 * ceilings (packages/domain/src/ops/spend-report.ts, VAL-OPS-002):
 * reserved/unknown/billed micros, charged total, remaining all-time
 * allowance and per-provider request counts.
 *   pnpm ops:spend
 * Uses DATABASE_URL plus the MODEL_*_SPEND_LIMIT_USD settings (their absence
 * is reported as not_configured, never as a pass). Counts and micros only:
 * no payloads, identities or secrets are read or echoed. Before any further
 * paid call, reconcile the printed charged total against the real provider
 * billing dashboard.
 */
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import {
  buildSpendReconciliation,
  collectProviderQueryActivity,
  collectSpendLedgerTotals,
  spendCeilingsFromEnv,
  toSpendReconciliationLine,
} from '../packages/domain/src/ops/spend-report';

loadRootEnv(path.resolve(import.meta.dirname, '..'));
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}
const db = createDb(url, 1);
try {
  const ceilings = spendCeilingsFromEnv(process.env);
  const report = buildSpendReconciliation({
    totals: await collectSpendLedgerTotals(db),
    activity: await collectProviderQueryActivity(db),
    ceilings,
  });
  console.log(toSpendReconciliationLine(report));
  for (const note of report.notes) console.error(`# ${note}`);
  if (report.ceilingStatus === 'exceeded' || report.ceilingStatus === 'not_configured') process.exitCode = 1;
} finally {
  await db.end();
}
