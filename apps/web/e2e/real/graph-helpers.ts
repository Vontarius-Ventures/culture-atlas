import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { loadRootEnv } from '../../../../packages/domain/src/config';
import { getDb, type PoolDb } from '../../../../packages/domain/src/db/pool';
import { SCREENSHOT_DIR, settleImages } from '../helpers';

/**
 * Shared helpers for the PR 8 real-stack graph journeys (graph-off-visit and
 * graph-claim). The browser drives the real web app; these helpers only READ
 * the isolated journey database (merged rows, projection state, spend ledger)
 * so the specs can assert the server's own record of what happened.
 *
 * The specs must run with DATABASE_URL pointing at the same isolated database
 * the web/worker services use; the repo-root .env supplies the remaining
 * configuration exactly as it does for the server.
 */

let rootLoaded = false;
export function journeyDb(): PoolDb {
  if (!rootLoaded) {
    rootLoaded = true;
    loadRootEnv(path.resolve(import.meta.dirname, '../../../..'));
  }
  return getDb();
}

/** Playwright afterAll hook: release the read-only pool cleanly. */
export async function closeJourneyDb(): Promise<void> {
  await getDb()
    .end()
    .catch(() => undefined);
}

export async function one<R extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<R | undefined> {
  const { rows } = await journeyDb().query<R>(sql, params);
  return rows[0];
}

export async function scalar(sql: string, params: readonly unknown[] = []): Promise<number> {
  const row = await one<{ n: number }>(sql, params);
  return Number(row?.n ?? 0);
}

/** Rows in the paid-provider ledger; the journeys must add none. */
export async function paidModelAttempts(): Promise<number> {
  return scalar('SELECT count(*) AS n FROM model_gateway_attempts');
}

/** The account's current authoritative taste revision. */
export async function tasteRevision(accountId: string): Promise<number> {
  const row = await one<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [accountId]);
  return Number(row?.revision ?? 0);
}

export interface GraphStateRow {
  [key: string]: unknown;
  state: string;
  applied: number;
  target: number;
  projection_revision: number;
  last_graph_run_id: string | null;
}

export async function graphState(accountId: string): Promise<GraphStateRow | null> {
  return (
    (await one<GraphStateRow>(
      `SELECT state, applied_taste_revision AS applied, target_taste_revision AS target,
              projection_revision, last_graph_run_id
         FROM personal_graph_state WHERE owner_account_id = $1`,
      [accountId],
    )) ?? null
  );
}

/**
 * Wait until the real worker's projection has caught up with the account's
 * authoritative revision (state ready, applied >= current taste revision).
 */
export async function waitForProjectionReady(accountId: string, timeoutMs = 90_000): Promise<GraphStateRow> {
  let last: GraphStateRow | null = null;
  await expect
    .poll(
      async () => {
        last = await graphState(accountId);
        if (!last) return false;
        return last.state === 'ready' && last.applied >= (await tasteRevision(accountId));
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
  return last!;
}

/**
 * The account's projected support rows as a comparable semantic set: edge
 * target (discovery item, graph node, or the account's own save of a shared
 * row), source kind and source id, ignoring row ids (the projector
 * legitimately rewrites rows on every rebuild).
 */
export interface SupportRow {
  discovery_item_id: string | null;
  node_id: string | null;
  saved_item_id: string | null;
  origin_kind: string;
  saved_item_source_id: string | null;
  pick_id: string | null;
  capture_id: string | null;
  active: boolean;
}

export async function supportRows(accountId: string): Promise<SupportRow[]> {
  const { rows } = await journeyDb().query<SupportRow>(
    `SELECT e.discovery_item_id, e.node_id, e.saved_item_id, s.origin_kind, s.saved_item_id AS saved_item_source_id,
            s.pick_id, s.capture_id, s.active
       FROM personal_interest_support s
       JOIN personal_interest_edges e ON e.id = s.edge_id AND e.owner_account_id = s.owner_account_id
      WHERE s.owner_account_id = $1
      ORDER BY COALESCE(e.discovery_item_id::text, e.node_id::text, e.saved_item_id::text), s.origin_kind,
               COALESCE(s.saved_item_id::text, s.pick_id::text, s.capture_id::text)`,
    [accountId],
  );
  return rows;
}

/** The browser session's own view (GET /v1/session) with its cookies. */
export async function sessionOf(page: Page): Promise<{
  principal: { kind: string; account_id: string | null; session_id: string };
}> {
  return page.evaluate(async () => (await fetch('/v1/session', { cache: 'no-store' })).json());
}

export const isGraphOn = ['true', '1'].includes(process.env.INTEREST_GRAPH_PROJECTION_ENABLED ?? '');

/** The expansion/discovery flag (feed + photo graph arms and the expansion sweep). */
export const isGraphDiscoveryOn =
  isGraphOn && ['true', '1'].includes(process.env.INTEREST_GRAPH_DISCOVERY_ENABLED ?? '');

/** Complete expansion runs the real worker published for the account. */
export async function expansionRuns(accountId: string): Promise<number> {
  return scalar(
    `SELECT count(*) AS n FROM graph_runs WHERE owner_account_id = $1 AND run_kind = 'expansion' AND state = 'complete'`,
    [accountId],
  );
}

/** Expansion jobs the account still has queued or running. */
export async function activeExpansionJobs(accountId: string): Promise<number> {
  return scalar(
    `SELECT count(*) AS n FROM jobs WHERE type = 'expand_interest_graph' AND payload->>'account_id' = $1 AND state IN ('queued','running')`,
    [accountId],
  );
}

/** Wait until the worker published at least `min` complete expansion runs. */
export async function waitForExpansionRuns(accountId: string, min: number, timeoutMs = 120_000): Promise<number> {
  let runs = 0;
  await expect
    .poll(async () => (runs = await expansionRuns(accountId)), { timeout: timeoutMs })
    .toBeGreaterThanOrEqual(min);
  return runs;
}

/** Journey screenshot; never captures a credential (the flows type passwords into masked inputs). */
export async function shot(page: Page, info: TestInfo, name: string, fullPage = true) {
  await page.evaluate(() =>
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => img.setAttribute('loading', 'eager')),
  );
  await settleImages(page, fullPage);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `real-graph-${name}-${info.project.name}.png`),
    fullPage,
    animations: 'disabled',
    mask: [page.locator('input[type="password"], input[type="email"]')],
  });
}
