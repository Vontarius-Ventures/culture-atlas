/**
 * Fresh personal-preference discovery comparison (VAL-QUAL-002): drives the
 * frozen journey manifest (fixtures/eval/personal-journeys/manifest.json)
 * through the REAL application stack — the real web API on 127.0.0.1:3200,
 * the real job worker, real PostgreSQL — for the three predeclared variants
 * (existing / curated-only / graph-assisted). Nothing is mocked and no
 * assertion lives here: the runner only records raw per-journey outcomes
 * (cards, jobs, provider call counts, ledger deltas, latency) for review
 * against the frozen rubric; empty/error/unavailable outcomes stay in the
 * output and are never retried away.
 *
 * The manifest, rubric and denominators are frozen BEFORE any output is
 * reviewed. Do not change them after seeing results.
 *
 * Known counting limitation (documented from the 2026-10-30 run): each
 * journey's provider_calls is read from provider_queries when the journey
 * ends, and a taste_seed run's last insights row can land in the DB after
 * that read (observed: the runner recorded 22 while the DB holds 28 — one
 * late row per journey). For spend accounting the durable provider_queries
 * table is authoritative; never report the runner's count as the call total,
 * and re-check the DB before any per-provider claim.
 *
 * Usage (stack must be up for the variant — see the manifest's stack note):
 *   DATABASE_URL=postgres://...ca_graph_pr8_3bb8f6d4 pnpm tsx scripts/personal-journey-eval.ts \
 *     --variant existing --out-file <report.json>
 *
 * Cost bounds: only the `existing` variant makes live paid Qloo requests
 * (the real taste_seed job through the real worker, job-capped). `graph` and
 * `curated` must record zero provider calls. The runner never calls a model
 * role (photo roles are unqualified and non-photo roles are gated elsewhere).
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { getDb } from '../packages/domain/src/db/pool';
import { upsertReference } from '../packages/domain/src/compiler/store';
import { linkGraphReferenceIdentities } from '../packages/domain/src/interest-graph/identity-links';
import {
  aggregate,
  domainCoverage,
  type FeedCard,
  type JourneyOutcome,
} from './personal-journey-eval-lib';

const ROOT = path.resolve(import.meta.dirname, '..');
loadRootEnv(ROOT);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const variant = arg('variant');
const outFile = arg('out-file');
const only = arg('only')?.split(',').filter(Boolean);
const baseUrl = arg('base-url', 'http://127.0.0.1:3200')!;
const pollEveryMs = Number(arg('poll-every-ms', '2000'));
const timeoutMs = Number(arg('timeout-ms', '120000'));

const VARIANTS = ['existing', 'curated', 'graph'] as const;
type VariantName = (typeof VARIANTS)[number];
if (!VARIANTS.includes(variant as VariantName)) {
  console.error('--variant must be existing | curated | graph (one per stack phase).');
  process.exit(2);
}
const variantName = variant as VariantName;
if (!outFile) {
  console.error('--out-file is required (the raw report path, outside the repository).');
  process.exit(2);
}

interface JourneySpec {
  id: string;
  profile: string;
  domain: string;
  picks: string[];
  save: {
    title: string;
    detail: string;
    reference: {
      canonical_key: string;
      name: string;
      type: string;
      external_ids: Record<string, unknown>;
    };
    expected_linkage: string;
  };
}

interface Manifest {
  journeys: JourneySpec[];
}

const manifest = JSON.parse(
  await readFile(path.join(ROOT, 'fixtures/eval/personal-journeys/manifest.json'), 'utf8'),
) as Manifest;
const journeys = manifest.journeys.filter((j) => !only || only.includes(j.id));
if (journeys.length === 0) {
  console.error('No journeys selected.');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// A tiny cookie-session HTTP client: the journeys are first-party browser
// sessions driven through the same REST surface the web client uses.
// ---------------------------------------------------------------------------

class Session {
  private cookies = new Map<string, string>();
  constructor(private readonly base: string) {}

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const clear = attrs.some((a) => a.trim().toLowerCase() === 'max-age=0');
      if (clear) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request<T = unknown>(
    method: string,
    pathname: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; ok: boolean; body: T }> {
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (this.cookies.size > 0) headers.cookie = this.cookieHeader();
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.base}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 400) };
    }
    return { status: res.status, ok: res.ok, body: parsed as T };
  }
}

interface SessionInfo {
  principal: { kind: string; account_id: string | null };
  csrf_token: string;
}

async function sessionInfo(s: Session): Promise<SessionInfo> {
  const r = await s.request<SessionInfo>('GET', '/v1/session');
  if (r.status !== 200) throw new Error(`GET /v1/session -> ${r.status}`);
  return r.body;
}

function mutationHeaders(info: SessionInfo, idempotent = true): Record<string, string> {
  const h: Record<string, string> = { 'x-csrf-token': info.csrf_token, 'content-type': 'application/json' };
  if (info.principal.account_id) h['x-atlas-expected-account'] = info.principal.account_id;
  if (idempotent) h['idempotency-key'] = randomUUID();
  return h;
}

// ---------------------------------------------------------------------------
// Feed reading
// ---------------------------------------------------------------------------

interface FeedResponse {
  items: FeedCard[];
  next_cursor: string | null;
  feed_id: string;
  feed_revision: number;
  is_example_feed: boolean;
}

async function readFeed(s: Session, maxPages = 3): Promise<FeedCard[]> {
  const cards: FeedCard[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: '24' });
    if (cursor) q.set('cursor', cursor);
    const r = await s.request<FeedResponse>('GET', `/v1/discoveries?${q.toString()}`);
    if (r.status !== 200) throw new Error(`GET /v1/discoveries -> ${r.status}`);
    cards.push(...r.body.items);
    cursor = r.body.next_cursor;
    if (!cursor) break;
  }
  return cards;
}

interface ConnectionResponse {
  state?: string;
  origin?: { label?: string } | null;
  connection?: { text?: string; sources?: Array<{ label?: string; url?: string }> } | null;
  error?: { code?: string; message?: string };
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// DB observations (read-only apart from the journey's own fixture rows)
// ---------------------------------------------------------------------------

const db = getDb();

async function scalar(sql: string, params: readonly unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

interface JobRow {
  id: string;
  type: string;
  state: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
}

async function jobsOf(accountId: string): Promise<JobRow[]> {
  const { rows } = await db.query<JobRow>(
    `SELECT id, type, state, created_at, started_at, finished_at, error_code
       FROM jobs WHERE owner_account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return rows;
}

async function providerQueriesOf(accountId: string): Promise<Array<{ provider: string; operation: string; status: string }>> {
  const { rows } = await db.query<{ provider: string; operation: string; status: string }>(
    `SELECT provider, operation, status
       FROM provider_queries
      WHERE owner_account_id = $1 OR taste_seed_run_id IN (
        SELECT id FROM taste_seed_runs WHERE owner_account_id = $1
      )
      ORDER BY retrieved_at`,
    [accountId],
  );
  return rows;
}

async function modelAttempts(): Promise<number> {
  return scalar('SELECT count(*) AS n FROM model_gateway_attempts');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Journey runner
// ---------------------------------------------------------------------------

async function createAccount(journey: JourneySpec, tag: string): Promise<{ session: Session; info: SessionInfo }> {
  const session = new Session(baseUrl);
  // The first-party flow: mint the anonymous session (cookie + CSRF token)
  // exactly like the web client does, then claim it with the new account.
  const anon = await sessionInfo(session);
  const email = `qual-${variantName}-${journey.id}-${tag}@journey.test`;
  const created = await session.request<{ account_id?: string }>(
    'POST',
    '/v1/accounts',
    { display_name: `Journey ${journey.id}`, email, password: 'a fine password', claim_session: true },
    mutationHeaders(anon),
  );
  if (created.status !== 201) throw new Error(`POST /v1/accounts -> ${created.status}`);
  const info = await sessionInfo(session);
  if (info.principal.kind !== 'account' || !info.principal.account_id) {
    throw new Error(`session did not become an account: ${info.principal.kind}`);
  }
  return { session, info };
}

async function runOnboarding(session: Session, info: SessionInfo, journey: JourneySpec): Promise<void> {
  for (const pick of journey.picks) {
    const r = await session.request(
      'POST',
      '/v1/onboarding/picks',
      { source: 'catalog', catalog_item_id: pick },
      mutationHeaders(info),
    );
    if (r.status !== 201) throw new Error(`pick ${pick} -> ${r.status}`);
  }
  const done = await session.request('POST', '/v1/onboarding/complete', {}, mutationHeaders(info));
  if (done.status !== 200) throw new Error(`complete -> ${done.status}`);
}

/** The graph journey's corpus-linked account item and its explicit save. */
async function seedGraphSave(
  accountId: string,
  journey: JourneySpec,
): Promise<{ itemId: string; linked: boolean }> {
  const referenceId = await upsertReference(db, {
    canonicalKey: journey.save.reference.canonical_key,
    name: journey.save.reference.name,
    type: journey.save.reference.type as 'creator',
    externalIds: journey.save.reference.external_ids,
  });
  // The idempotent verified linkage pass — exactly the production pass corpus
  // admission runs. Unresolvable references simply stay unlinked (honest).
  await linkGraphReferenceIdentities(db);
  // This reference is linked only when an active corpus identity holds it.
  const linked =
    (await scalar(`SELECT count(*) AS n FROM graph_nodes WHERE cultural_reference_id = $1`, [referenceId])) > 0;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, is_sample, kind, category, canonical_key, title,
                                  display_metadata, external_ids, reference_id)
     VALUES ($1, false, 'artist', 'play', $2, $3, $4::jsonb, $5::jsonb, $6)
     ON CONFLICT (owner_account_id, canonical_key)
       DO UPDATE SET reference_id = EXCLUDED.reference_id, updated_at = now()
     RETURNING id`,
    [
      accountId,
      journey.save.reference.canonical_key,
      journey.save.title,
      JSON.stringify({ subtitle: journey.save.detail }),
      JSON.stringify(journey.save.reference.external_ids),
      referenceId,
    ],
  );
  return { itemId: rows[0]!.id, linked };
}

async function waitFor(
  condition: () => Promise<boolean>,
  everyMs: number,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(everyMs);
  }
}

async function runJourney(journey: JourneySpec, tag: string): Promise<JourneyOutcome> {
  const outcome: JourneyOutcome = {
    journey_id: journey.id,
    variant: variantName,
    account_email: '',
    account_id: null,
    picks: journey.picks,
    saved_item: null,
    errors: [],
    jobs: [],
    provider_queries: [],
    model_attempts_delta: 0,
    latency_ms: null,
    outcome: 'error',
    cards: [],
    graph_cards: [],
    notes: [],
  };
  const attemptsBefore = await modelAttempts();
  try {
    const account = await createAccount(journey, tag);
    const session = account.session;
    outcome.account_email = `qual-${variantName}-${journey.id}-${tag}@journey.test`;
    outcome.account_id = account.info.principal.account_id;

    await runOnboarding(session, account.info, journey);
    let startedAt = Date.now();

    if (variantName === 'graph') {
      const seeded = await seedGraphSave(outcome.account_id!, journey);
      outcome.saved_item = {
        title: journey.save.title,
        reference_key: journey.save.reference.canonical_key,
        item_id: seeded.itemId,
        linked: seeded.linked,
      };
      if (!seeded.linked) {
        outcome.notes.push(
          `reference not verified-linked to a corpus identity (expected: ${journey.save.expected_linkage})`,
        );
      }
      const saved = await session.request(
        'POST',
        '/v1/preferences',
        { action: 'save', target_type: 'discovery_item', target_id: seeded.itemId },
        mutationHeaders(account.info),
      );
      if (saved.status !== 200) throw new Error(`save -> ${saved.status}`);
      startedAt = Date.now();
    }

    // Wait for the variantName's real pipeline to reach a terminal state.
    let pipelineDone = false;
    if (variantName === 'existing') {
      pipelineDone = await waitFor(async () => {
        const jobs = await jobsOf(outcome.account_id!);
        const seed = jobs.filter((j) => j.type === 'taste_seed');
        return seed.length > 0 && seed.every((j) => ['complete', 'failed', 'cancelled'].includes(j.state));
      }, pollEveryMs, timeoutMs);
    } else if (variantName === 'graph') {
      pipelineDone = await waitFor(async () => {
        const jobs = await jobsOf(outcome.account_id!);
        const expansions = jobs.filter((j) => j.type === 'expand_interest_graph');
        return (
          expansions.length > 0 &&
          expansions.every((j) => ['complete', 'failed', 'cancelled'].includes(j.state))
        );
      }, pollEveryMs, timeoutMs);
      if (!pipelineDone) outcome.notes.push('expansion job did not reach a terminal state within the timeout');
    } else {
      // curated-only: no pipeline; let the example feed settle.
      await sleep(5_000);
      pipelineDone = true;
    }
    if (!pipelineDone && variantName === 'existing') {
      outcome.notes.push('taste seed job did not reach a terminal state within the timeout');
    }

    // Poll the feed for non-example cards (existing/graph); read once for curated.
    const deadline = Date.now() + (variantName === 'curated' ? 5_000 : timeoutMs);
    let cards: FeedCard[] = [];
    for (;;) {
      cards = await readFeed(session);
      const personal = cards.filter((c) => !c.is_example);
      if (personal.length > 0 || variantName === 'curated' || Date.now() >= deadline) break;
      await sleep(pollEveryMs);
    }
    outcome.cards = cards;
    const personalCards = cards.filter((c) => !c.is_example);
    outcome.latency_ms = personalCards.length > 0 ? Date.now() - startedAt : null;
    outcome.outcome = personalCards.length > 0 ? 'cards' : pipelineDone ? 'empty' : 'error';

    // Why-this disclosure for every graph-backed card (the pinned connection).
    if (variantName === 'graph') {
      for (const card of personalCards) {
        if (!card.recommendation_id) {
          outcome.graph_cards.push({
            title: card.title,
            connection: null,
            why_state: 'no_recommendation_id',
          });
          continue;
        }
        const conn = await session.request<ConnectionResponse>(
          'GET',
          `/v2/me/recommendations/${card.recommendation_id}/connection`,
        );
        outcome.graph_cards.push({
          title: card.title,
          connection: conn.status === 200 ? conn.body : { error_status: conn.status, body: conn.body },
          why_state: conn.status === 200 ? (conn.body.state ?? 'unknown') : `http_${conn.status}`,
        });
      }
    }
  } catch (err) {
    outcome.errors.push((err as Error).message);
    outcome.outcome = 'error';
  } finally {
    outcome.jobs = await jobsOf(outcome.account_id ?? '00000000-0000-0000-0000-000000000000').catch(() => []);
    if (outcome.account_id) {
      outcome.provider_queries = await providerQueriesOf(outcome.account_id).catch(() => []);
    }
    outcome.model_attempts_delta = (await modelAttempts().catch(() => attemptsBefore)) - attemptsBefore;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const tag = `${Date.now()}`;
const outcomes: JourneyOutcome[] = [];
for (const journey of journeys) {
  process.stdout.write(`[${variantName}] journey ${journey.id}... `);
  const outcome = await runJourney(journey, tag);
  outcomes.push(outcome);
  process.stdout.write(
    `${outcome.outcome} (${outcome.cards.filter((c) => !c.is_example).length} personal cards, ` +
      `${outcome.provider_queries.length} provider calls)\n`,
  );
}
await db.end().catch(() => undefined);

const report = {
  recorded_at: new Date().toISOString(),
  variant: variantName,
  base_url: baseUrl,
  poll_every_ms: pollEveryMs,
  timeout_ms: timeoutMs,
  journeys_selected: journeys.map((j) => j.id),
  aggregate: aggregate(outcomes),
  domain_coverage: domainCoverage(outcomes),
  outcomes,
};
await mkdir(path.dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
const a = report.aggregate;
console.log(
  `[personal-journey-eval] ${variantName}: journeys ${a.journeys_attempted} ` +
    `(cards ${a.journeys_with_cards}, empty ${a.journeys_empty}, error ${a.journeys_error}); ` +
    `non-example cards ${a.non_example_cards} (${a.distinct_non_example_titles} distinct); ` +
    `provider calls ${a.provider_calls}; model attempts ${a.model_attempts_delta}.`,
);
