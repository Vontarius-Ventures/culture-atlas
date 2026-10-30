import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolDb } from '../db/pool';
import { dispatchGraphOutbox } from '../interest-graph/dispatch';
import { expandAccountInterestGraph } from '../interest-graph/expansion';
import { projectAccountInterestGraph } from '../interest-graph/projector';
import { claimJobs } from '../jobs/queue';
import { enqueueJob } from '../jobs/queue';
import { insertItem, insertCaptureWithAnalysis, accountCtx, ctxFor } from '../test-support/library';
import {
  closeTestDb,
  getTestDb,
  insertAccount,
  insertAgentConnection,
  insertAnonymousSession,
  testConfig,
} from '../testing';
import { resolvePrincipal, signIn } from './auth';
import { hashToken, randomToken } from './auth';
import { issueNativeSession } from './native-sessions';
import { requestAccountDeletion, getAccountDeletionOverview, getAccountDeletionStatusByToken } from './account-deletion';

/**
 * Account-deletion acceptance (VAL-DELETE-002 / VAL-DELETE-003): one owner
 * request durably revokes every authority surface and fences every producer
 * against the tombstoned account, atomically. Nothing can restore access,
 * and every producer that races acceptance refuses to publish.
 */

const db = getTestDb();
afterAll(closeTestDb);

const graphOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true', INTEREST_GRAPH_DISCOVERY_ENABLED: 'true' });

/** A raw browser session token the test can present post-deletion. */
async function rawSession(dbh: PoolDb, accountId: string): Promise<string> {
  const token = randomToken();
  await dbh.query(`INSERT INTO sessions (account_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
    accountId,
    hashToken(token),
  ]);
  return token;
}

/** A live native installation (cna_ pair) for the account. */
async function nativeInstallation(dbh: PoolDb, accountId: string): Promise<{ token: string; installationId: string }> {
  await dbh.query(
    `INSERT INTO account_emails (account_id, email, verified_at)
     VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
    [accountId, `native-${randomUUID()}@example.com`],
  );
  const { rows: installation } = await dbh.query<{ id: string }>(
    `INSERT INTO mobile_installations (account_id, installation_public_id, platform, app_version)
     VALUES ($1, $2, 'ios', '1') RETURNING id`,
    [accountId, randomUUID()],
  );
  const now = new Date();
  const pair = await dbh.transaction((tx) =>
    issueNativeSession(tx, { accountId, installationId: installation[0]!.id, authenticatedAt: now }, now),
  );
  return { token: pair.access_token, installationId: installation[0]!.id };
}

beforeAll(() => {
  // The graph flags default off; deletion must fence regardless, and the
  // projection/expansion legs need the flags on to prove the fence, not the gate.
});

describe('account deletion acceptance', () => {
  it('accepts deletion atomically: tombstone, revocations, cancellations, kills and the durable purge job commit together', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;

    // A second browser session, an agent credential, a sensor connection, a
    // native phone, a share with a live recipient session, queued + running
    // jobs, v2 media work, and a projected graph: every authority and producer
    // surface in one account.
    const secondSession = await rawSession(db, accountId);
    const agent = await insertAgentConnection({ accountId }, { libraryAccess: 'all' });
    await db.query(
      `INSERT INTO sensor_connections (owner_account_id, configured_origin, mode) VALUES ($1, $2, 'poll')`,
      [accountId, `https://relay.example.test/${randomUUID()}`],
    );
    const phone = await nativeInstallation(db, accountId);

    const item = await insertItem({ accountId }, { title: 'Deletion fixture item' });
    await db.query(`INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)`, [accountId, item]);
    const { rows: collection } = await db.query<{ id: string }>(
      `INSERT INTO collections (owner_account_id, name) VALUES ($1, 'Deletion board') RETURNING id`,
      [accountId],
    );
    await db.query(
      `INSERT INTO collection_items (collection_id, owner_account_id, saved_item_id, position)
       VALUES ($1, $2, (SELECT id FROM saved_items WHERE owner_account_id = $2 AND discovery_item_id = $3), 0)`,
      [collection[0]!.id, accountId, item],
    );
    await db.query(
      `INSERT INTO collection_shares (owner_account_id, collection_id, audience, token_hash, expires_at)
       VALUES ($1, $2, 'link', $3, now() + interval '7 days')`,
      [accountId, collection[0]!.id, hashToken(randomToken())],
    );

    const cap = await insertCaptureWithAnalysis({ accountId }, {}, db);
    const queuedJob = await enqueueJob(db, {
      type: 'analyze_capture',
      owner: { kind: 'account', accountId },
      payload: { capture_id: cap.captureId, analysis_version: 2, compiler_version: 'test', focus: { kind: 'whole' } },
      resultType: 'capture',
      resultId: cap.captureId,
    });
    const runningJob = await enqueueJob(db, {
      type: 'taste_seed',
      owner: { kind: 'account', accountId },
      payload: { taste_revision: 1, catalog_version: null, categories: ['watch'] },
    });
    await db.query(`UPDATE jobs SET state = 'running', lease_owner = 'other', lease_expiry = now() + interval '5 minutes' WHERE id = $1`, [
      runningJob.job.id,
    ]);
    await db.query(
      `INSERT INTO capture_work (account_id, generation, kind, state, available_at) VALUES ($1, 1, 'prepare_media', 'queued', now())`,
      [accountId],
    );
    await db.query(
      `INSERT INTO media_assets (account_id, client_capture_id, kind, source, byte_size, content_type, status)
       VALUES ($1, $2, 'photo', 'upload', 1, 'image/jpeg', 'ready')`,
      [accountId, randomUUID()],
    );
    const { rows: asset } = await db.query<{ id: string }>(`SELECT id FROM media_assets WHERE account_id = $1`, [accountId]);
    await db.query(
      `INSERT INTO media_analysis_requests (account_id, asset_id, generation, mode, selected_frames, request_hash, state)
       VALUES ($1, $2, 1, 'photo', '[]'::jsonb, $3, 'queued')`,
      [accountId, asset[0]!.id, randomUUID()],
    );

    // A projection pass leaves state + a pending outbox intent behind.
    await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });
    const generationBefore = (
      await db.query<{ deletion_generation: number }>(`SELECT deletion_generation FROM personal_graph_state WHERE owner_account_id = $1`, [accountId])
    ).rows[0]!.deletion_generation;
    const projectJobsBefore = (
      await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph'`, [accountId])
    ).rows[0]!.n;

    const statusToken = randomToken(32);
    const response = await requestAccountDeletion(ctx, { confirm: true, status_token: statusToken });
    expect(response.status.state).toBe('pending');
    expect(response.status.retrying).toBe(true);
    expect(response.status.pending_steps.length).toBeGreaterThan(0);
    expect(response.status.completed_steps).toEqual([]);
    expect(response.disclosure.retained.length).toBeGreaterThan(0);

    // The tombstone and the durable record.
    expect(
      (await db.query<{ deleted_at: Date | null }>(`SELECT deleted_at FROM accounts WHERE id = $1`, [accountId])).rows[0]!
        .deleted_at,
    ).toBeInstanceOf(Date);
    const record = (
      await db.query<{ cleanup_state: string; status_token_hash: string; attempts: number; completed_steps: string[]; requested_by_session_id: string | null }>(
        `SELECT cleanup_state, status_token_hash, attempts, completed_steps, requested_by_session_id FROM account_deletions WHERE account_id = $1`,
        [accountId],
      )
    ).rows[0]!;
    expect(record.cleanup_state).toBe('pending');
    expect(record.status_token_hash).toBe(hashToken(statusToken));
    expect(record.attempts).toBe(0);
    expect(record.completed_steps).toEqual([]);

    // Queue cancellation: queued jobs are cancelled now, the running one is
    // flagged and can never be re-claimed (expired-lease retry is fenced).
    expect((await db.query<{ state: string }>(`SELECT state FROM jobs WHERE id = $1`, [queuedJob.job.id])).rows[0]!.state).toBe('cancelled');
    expect(
      (await db.query<{ cancel_requested_at: Date | null }>(`SELECT cancel_requested_at FROM jobs WHERE id = $1`, [runningJob.job.id])).rows[0]!
        .cancel_requested_at,
    ).toBeInstanceOf(Date);
    const claimed = await claimJobs(db, { workerId: 'deletion-test', limit: 50, leaseMs: 60_000 });
    expect(claimed.filter((j) => j.owner_account_id === accountId)).toEqual([]);
    expect(
      (
        await db.query(`SELECT 1 FROM jobs WHERE owner_account_id = $1 AND state IN ('queued','running') AND cancel_requested_at IS NULL`, [accountId])
      ).rows,
    ).toEqual([]);

    // v2 media work is cancelled with the account.
    expect((await db.query(`SELECT 1 FROM capture_work WHERE account_id = $1 AND state IN ('queued','running')`, [accountId])).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM media_analysis_requests WHERE account_id = $1 AND state IN ('queued','running')`, [accountId])).rows).toEqual([]);

    // Graph producers: generation bumped, kills installed, outbox replay fenced.
    expect(
      (await db.query<{ deletion_generation: number }>(`SELECT deletion_generation FROM personal_graph_state WHERE owner_account_id = $1`, [accountId]))
        .rows[0]!.deletion_generation,
    ).toBe(generationBefore + 1);
    const kills = (await db.query<{ flag: string }>(`SELECT flag FROM feature_flag_kills WHERE account_id = $1 AND lifted_at IS NULL ORDER BY flag`, [accountId])).rows;
    expect(kills.map((k) => k.flag)).toEqual([
      'interest_graph_discovery_enabled',
      'interest_graph_framework_shadow_enabled',
      'interest_graph_projection_enabled',
      'interest_graph_research_enabled',
    ]);
    await dispatchGraphOutbox(db, { config: graphOn });
    expect(
      (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE owner_account_id = $1 AND type = 'project_interest_graph'`, [accountId]))
        .rows[0]!.n,
    ).toBe(projectJobsBefore);

    // Every credential surface is revoked in the same transaction.
    expect((await db.query(`SELECT 1 FROM sessions WHERE account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM agent_connections WHERE owner_account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM sensor_connections WHERE owner_account_id = $1 AND enabled`, [accountId])).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM mobile_installations WHERE account_id = $1 AND authority_ended_at IS NULL`, [accountId])).rows).toEqual([]);
    expect((await db.query(`SELECT 1 FROM native_sessions WHERE account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
    expect(
      (await db.query<{ reason: string }>(`SELECT reason FROM identity_authority_events WHERE account_id = $1 ORDER BY created_at DESC`, [accountId])).rows[0]!
        .reason,
    ).toBe('account_deletion');
    expect((await db.query(`SELECT 1 FROM collection_shares WHERE owner_account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
    expect(
      (await db.query(`SELECT 1 FROM share_sessions WHERE owner_account_id = $1 AND revoked_at IS NULL`, [accountId])).rows,
    ).toEqual([]);
    // And the exact fixture credentials stop resolving, not just their rows.
    expect(await resolvePrincipal(db, { sessionToken: secondSession })).toBeNull();
    await expect(resolvePrincipal(db, { authorization: `Bearer ${agent.credential}` })).rejects.toMatchObject({ code: 'token_revoked' });
    await expect(resolvePrincipal(db, { authorization: `Bearer ${phone.token}` })).rejects.toMatchObject({ code: 'token_revoked' });

    // The durable cleanup job is enqueued for the account (system-owned so it
    // survives its own work).
    const purgeJobs = (
      await db.query<{ id: string; owner_account_id: string | null; payload: { account_id: string } }>(
        `SELECT id, owner_account_id, payload FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1`,
        [accountId],
      )
    ).rows;
    expect(purgeJobs).toHaveLength(1);
    expect(purgeJobs[0]!.owner_account_id).toBeNull();
  });

  it('old credentials lose access at once; a retry never recreates authority', async () => {
    const { principal, ctx } = await accountCtx();
    const accountId = principal.accountId;
    const sessionToken = await rawSession(db, accountId);
    const agent = await insertAgentConnection({ accountId }, { libraryAccess: 'all' });
    const phone = await nativeInstallation(db, accountId);
    await db.query(
      `INSERT INTO account_credentials (account_id, email, password_hash) VALUES ($1, $2, $3)`,
      [accountId, `deleted-${randomUUID()}@example.test`, '$argon2id$test$hash'],
    );

    await requestAccountDeletion(ctx, { confirm: true });

    // The browser session resolves to absent (the visitor gets a fresh
    // anonymous session, never the deleted account).
    expect(await resolvePrincipal(db, { sessionToken })).toBeNull();
    expect(await resolvePrincipal(db, { sessionToken: await (async () => {
      const anon = await insertAnonymousSession(db);
      const { rows } = await db.query<{ token_hash: string }>(`SELECT token_hash FROM sessions WHERE id = $1`, [anon.sessionId]);
      return rows[0]!.token_hash; // a hash, not a token: must still resolve to null
    })() })).toBeNull();
    // The agent token and the native phone are refused.
    await expect(resolvePrincipal(db, { authorization: `Bearer ${agent.credential}` })).rejects.toMatchObject({ code: 'token_revoked' });
    await expect(resolvePrincipal(db, { authorization: `Bearer ${phone.token}` })).rejects.toMatchObject({ code: 'token_revoked' });
    // Sign-in is refused for the tombstoned account.
    const anonCtx = ctxFor(await insertAnonymousSession(db));
    await expect(signIn(anonCtx, { email: `deleted@example.test`, password: 'x', claim_session: false })).rejects.toMatchObject({
      code: 'unauthenticated',
    });

    // A retried request is idempotent: the same status comes back, no second
    // purge job, and revocation timestamps never move.
    const firstRevokedAt = (await db.query<{ revoked_at: Date }>(`SELECT min(revoked_at) AS revoked_at FROM sessions WHERE account_id = $1`, [accountId])).rows[0]!.revoked_at;
    const again = await requestAccountDeletion(ctx, { confirm: true });
    expect(again.status.state).toBe('pending');
    expect(again.status_token).toBeNull(); // the server never re-mints the one-time token
    expect(
      (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1`, [accountId]))
        .rows[0]!.n,
    ).toBe(1);
    expect((await db.query<{ revoked_at: Date }>(`SELECT min(revoked_at) AS revoked_at FROM sessions WHERE account_id = $1`, [accountId])).rows[0]!.revoked_at).toEqual(firstRevokedAt);
  });

  it('refuses every non-owner principal and a request that does not confirm', async () => {
    const agent = await insertAgentConnection({ accountId: (await insertAccount(db)).accountId }, { libraryAccess: 'all' });
    await expect(requestAccountDeletion(ctxFor(agent.principal), { confirm: true })).rejects.toMatchObject({ code: 'scope_denied' });
    const anon = await insertAnonymousSession(db);
    await expect(requestAccountDeletion(ctxFor(anon), { confirm: true })).rejects.toMatchObject({ code: 'account_required' });
    const { ctx } = await accountCtx();
    await expect(requestAccountDeletion(ctx, { confirm: false })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(requestAccountDeletion(ctx, { confirm: true, status_token: 'short' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('the status token answers the lifecycle without restoring any authority; the overview is honest before acceptance', async () => {
    const { principal, ctx } = await accountCtx();
    const accountId = principal.accountId;

    const overview = await getAccountDeletionOverview(ctx);
    expect(overview.requested).toBe(false);
    expect(overview.state).toBe('none');
    expect(overview.status).toBeNull();
    expect(overview.disclosure.cleanup_steps.length).toBeGreaterThan(0);

    const token = randomToken(32);
    const accepted = await requestAccountDeletion(ctx, { confirm: true, status_token: token });
    expect(accepted.status_token).toBe(token);

    const byToken = await getAccountDeletionStatusByToken(db, token);
    expect(byToken!.status.state).toBe('pending');
    expect(byToken!.status.pending_steps).toEqual(accepted.status.pending_steps);
    expect(byToken!.status.retrying).toBe(true);
    expect(byToken!.disclosure.retained.length).toBeGreaterThan(0);

    // A wrong or missing token discloses nothing (the same shape as not_found).
    expect(await getAccountDeletionStatusByToken(db, randomToken(32))).toBeNull();
    expect(await getAccountDeletionStatusByToken(db, '')).toBeNull();

    // The overview keeps answering honestly while authority exists, and the
    // token keeps answering after every authority is gone.
    const after = await getAccountDeletionOverview(ctx);
    expect(after.requested).toBe(true);
    expect(after.state).toBe('pending');
    expect(after.status!.state).toBe('pending');

    // No principal surface is restored by reading status.
    expect((await db.query(`SELECT 1 FROM sessions WHERE account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
  });

  it('projection and expansion refuse the tombstoned account (publication fence, not just the gate)', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const item = await insertItem({ accountId }, { title: 'Root save' });
    await db.query(`INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)`, [accountId, item]);
    const projected = await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });
    expect(projected.projected).toBe(true);
    const completeRunsBefore = (
      await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND state = 'complete'`, [
        accountId,
      ])
    ).rows[0]!.n;

    await requestAccountDeletion(ctx, { confirm: true });

    // Projection hits the row/tombstone fence directly.
    const projection = await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });
    expect(projection).toMatchObject({ projected: false, reason: 'account_missing' });
    // Expansion is refused at its first gate (the acceptance's flag kills) or
    // its publication fence (the tombstone) — either way nothing publishes.
    const expansion = await expandAccountInterestGraph(db, { accountId, config: graphOn });
    expect(expansion.expanded).toBe(false);
    expect(['disabled', 'account_missing']).toContain(expansion.reason);
    // No NEW complete runs appeared from the refused passes.
    const completeRuns = async () =>
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM graph_runs WHERE owner_account_id = $1 AND state = 'complete'`,
          [accountId],
        )
      ).rows[0]!.n;
    expect(await completeRuns()).toBe(completeRunsBefore);
  });

  it('the deletion acceptance orders against a live publication: it waits for the pass to commit, then applies and the cleanup purges', async () => {
    const { principal, ctx } = await accountCtx({ config: graphOn });
    const accountId = principal.accountId;
    const item = await insertItem({ accountId }, { title: 'Held root save' });
    await db.query(`INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)`, [accountId, item]);
    await projectAccountInterestGraph(db, { accountId, config: graphOn, source: 'mutation_intent' });

    // The pass parks INSIDE its publication transaction, holding the account's
    // publication-authority lock. The deletion acceptance starts meanwhile: it
    // must wait for that lock (never commit under a live publication).
    let releasePass!: () => void;
    const parked = new Promise<void>((resolve) => (releasePass = resolve));
    let inPublication = false;
    const pass = expandAccountInterestGraph(db, {
      accountId,
      config: graphOn,
      fence: async () => {
        inPublication = true;
        await parked;
      },
    });
    for (let i = 0; i < 200 && !inPublication; i++) await new Promise((r) => setTimeout(r, 10));
    expect(inPublication).toBe(true);
    const deletion = requestAccountDeletion(ctx, { confirm: true });
    await new Promise((r) => setTimeout(r, 150));
    // Not tombstoned yet: the acceptance is waiting on the publication lock.
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1 AND deleted_at IS NOT NULL`, [accountId])).rows).toEqual([]);

    // The pass commits (it won the ordering — its rows are purged next), the
    // deletion applies immediately after, and the durable cleanup takes the
    // account and everything the pass touched away.
    releasePass();
    await pass;
    const accepted = await deletion;
    expect(accepted.status.state).toBe('pending');
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1 AND deleted_at IS NOT NULL`, [accountId])).rows).toHaveLength(1);

    const { runJob } = await import('../test-support/library');
    const { rows: purgeJob } = await db.query<{ id: string }>(
      `SELECT id FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1`,
      [accountId],
    );
    expect((await runJob(purgeJob[0]!.id, { db, config: graphOn })).state).toBe('complete');
    expect((await db.query(`SELECT 1 FROM accounts WHERE id = $1`, [accountId])).rows).toEqual([]);
  });

  it('a research job that slipped past acceptance is refused before any paid call', async () => {
    const { principal, ctx } = await accountCtx({
      config: testConfig({ INTEREST_GRAPH_RESEARCH_ENABLED: 'true' }),
    });
    const accountId = principal.accountId;
    const { rows: nodes } = await db.query<{ id: string }>(
      `INSERT INTO graph_nodes (canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
       VALUES ('atlas:subject-${randomUUID()}', 'Subject', 'subject', 'work', 'art', 'painting'),
              ('atlas:object-${randomUUID()}', 'Object', 'object', 'work', 'art', 'painting')
       RETURNING id`,
    );
    await requestAccountDeletion(ctx, { confirm: true });
    // Enqueued directly after acceptance (the racing case the fence exists for).
    const { job } = await enqueueJob(db, {
      type: 'research_graph_relation',
      owner: { kind: 'account', accountId },
      payload: { account_id: accountId, subject_node_id: nodes[0]!.id, object_node_id: nodes[1]!.id, predicate: 'ABOUT' },
    });
    expect(job.state).toBe('queued');
    const { runJob } = await import('../test-support/library');
    // The account's kill switch refuses the run before any paid provider call:
    // the honest terminal failure propagates and the job fails terminally.
    await expect(runJob(job.id, { db, config: ctx.config })).rejects.toMatchObject({
      code: 'service_unavailable',
    });
    expect((await db.query<{ state: string }>(`SELECT state FROM jobs WHERE id = $1`, [job.id])).rows[0]!.state).toBe(
      'failed',
    );
    expect(
      (await db.query(`SELECT 1 FROM provider_queries WHERE owner_account_id = $1`, [accountId])).rows,
    ).toEqual([]);
    // The refusal happened before a research run or any proposal existed.
    expect((await db.query(`SELECT 1 FROM graph_runs WHERE job_id = $1`, [job.id])).rows).toEqual([]);
  });

  it('an analyze job for the account stops at its first liveness check and publishes nothing', async () => {
    const { principal, ctx } = await accountCtx();
    const accountId = principal.accountId;
    const cap = await insertCaptureWithAnalysis({ accountId }, {}, db);
    const { job } = await enqueueJob(db, {
      type: 'analyze_capture',
      owner: { kind: 'account', accountId },
      payload: { capture_id: cap.captureId, analysis_version: 2, compiler_version: 'test', focus: { kind: 'whole' } },
      resultType: 'capture',
      resultId: cap.captureId,
    });
    await requestAccountDeletion(ctx, { confirm: true });
    // The queued job was cancelled at acceptance and stays unclaimable.
    expect((await db.query<{ state: string }>(`SELECT state FROM jobs WHERE id = $1`, [job.id])).rows[0]!.state).toBe('cancelled');
    expect(await claimJobs(db, { workerId: 'analyze-fence-test', limit: 10, leaseMs: 60_000, ids: [job.id] })).toEqual([]);
    // No second analysis was published for the capture.
    expect((await db.query(`SELECT 1 FROM analyses WHERE capture_id = $1 AND version = 2`, [cap.captureId])).rows).toEqual([]);
  });

  it('the compiler publication transaction refuses the tombstone even after its last liveness check', async () => {
    const { publishForCapture } = await import('../compiler/store');
    const { JobCancelledError } = await import('../jobs/handler');
    const { principal, ctx } = await accountCtx();
    const accountId = principal.accountId;
    const cap = await insertCaptureWithAnalysis({ accountId }, {}, db);
    await requestAccountDeletion(ctx, { confirm: true });
    // A producer that already passed every liveness check (deletion committed
    // in between) still cannot publish: the accounts-row share lock inside the
    // publication transaction sees the tombstone.
    await expect(
      publishForCapture(db, cap.captureId, async () => undefined, async () => {
        throw new Error('the publication body must never run for a deleted account');
      }),
    ).rejects.toBeInstanceOf(JobCancelledError);
  });

  it('the deletion survives restarts: a fresh sweep re-enqueues the purge without restoring anything', async () => {
    const { principal, ctx } = await accountCtx();
    const accountId = principal.accountId;
    await requestAccountDeletion(ctx, { confirm: true });

    // A crash or restart loses nothing: the record is pending and the sweep
    // (ensureAccountDeletionPurgeJobs) re-arms the durable cleanup job.
    const { ensureAccountDeletionPurgeJobs } = await import('../pipeline/account-purge');
    // Simulate the acceptance's job dying terminally before any work.
    await db.query(`DELETE FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1`, [accountId]);
    const enqueued = await ensureAccountDeletionPurgeJobs(db);
    expect(enqueued).toBe(1);
    const jobs = (
      await db.query<{ id: string; state: string }>(`SELECT id, state FROM jobs WHERE type = 'purge_account' AND payload->>'account_id' = $1`, [accountId])
    ).rows;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.state).toBe('queued');
    // A second sweep is deduplicated against the live job.
    expect(await ensureAccountDeletionPurgeJobs(db)).toBe(0);
    // Authority is still gone.
    expect((await db.query(`SELECT 1 FROM sessions WHERE account_id = $1 AND revoked_at IS NULL`, [accountId])).rows).toEqual([]);
  });
});
