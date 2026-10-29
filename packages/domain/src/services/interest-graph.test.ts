import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { accountCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { dispatchGraphOutbox } from '../interest-graph/dispatch';
import { projectAccountInterestGraph } from '../interest-graph/projector';
import { graphDiscoveryPausedAt } from '../interest-graph/refresh';
import {
  attachAssertionSupport,
  insertEvidence,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from '../interest-graph/evidence';
import { createGraphRun, insertGraphRecommendation, insertRecommendationProof } from '../interest-graph/store';
import { retractGraphEvidence } from '../interest-graph/validity';
import { recordPreference } from './preferences';
import * as interestGraph from './interest-graph';

/**
 * Owner/native typed graph controls (VAL-API-001): the Zod summary, the
 * optimistic settings PATCH, the tentative-interest suppress/restore PATCH
 * and the recommendation connection route, all through the owner's own
 * authority. Arbitrary account ids, unknown mutation fields, stale
 * revisions and cross-owner ids are typed rejections without writes;
 * desired-state retries are idempotent; explicit edges stay under the
 * existing save/pick controls (action_required), never a graph mutation.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

async function project(accountId: string) {
  return projectAccountInterestGraph(db, { accountId, config: projectionOn, source: 'mutation_intent' });
}

async function code(p: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await p;
    return { code: 'ok' };
  } catch (err) {
    const e = err as { code?: string; details?: unknown };
    return { code: e.code ?? 'other', details: e.details };
  }
}

/** A derived tentative affinity edge on a shared identity (the suppress/restore target). */
async function tentativeEdgeFixture(accountId: string): Promise<{ edgeId: string; nodeId: string }> {
  const name = `Lamp ${randomUUID().slice(0, 6)}`;
  const ref = await insertReference({ name });
  const { rows: node } = await db.query<{ id: string }>(
    `INSERT INTO graph_nodes (cultural_reference_id, canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
     VALUES ($1, $2, $3, $4, 'style', 'design', 'style') RETURNING id`,
    [ref, `atlas:${randomUUID()}`, name, `lamp-${randomUUID().slice(0, 6)}`],
  );
  const cap = await insertCaptureWithAnalysis({ accountId });
  await db.query(
    `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor)
     VALUES ($1, $2, 'resembles', 0.8, 'resolved', true)`,
    [cap.analysisId, ref],
  );
  const ctx = ctxFor({ kind: 'account', accountId, sessionId: null, isDemoOwner: false }, { config: projectionOn });
  await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
  await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: accountId });
  await project(accountId);
  const { rows: edge } = await db.query<{ id: string }>(
    'SELECT id FROM personal_interest_edges WHERE owner_account_id = $1 AND node_id = $2 AND origin = $3',
    [accountId, node[0]!.id, 'derived'],
  );
  return { edgeId: edge[0]!.id, nodeId: node[0]!.id };
}

/** A justified shared assertion with reviewed evidence (cultural-path fixture). */
async function justifiedAssertion() {
  const work = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: `Work ${randomUUID().slice(0, 6)}`,
    nodeKind: 'work',
    domain: 'art',
    senseKey: 'painting',
  });
  const creator = await upsertGraphIdentity(db, {
    canonicalKey: `atlas:${randomUUID()}`,
    canonicalName: `Creator ${randomUUID().slice(0, 6)}`,
    nodeKind: 'creator',
    domain: 'art',
    senseKey: 'painter',
  });
  const family = `artic:${randomUUID()}`;
  const url = `https://www.artic.edu/artworks/${randomUUID().slice(0, 8)}`;
  const recorded = await recordSourceRevision(db, {
    provider: 'artic_open_access',
    url,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
    documentHash: randomUUID(),
    rightsExpiresAt: null,
  });
  const inserted = await insertEvidence(db, {
    sourceRevisionId: recorded.sourceRevisionId,
    permittedExcerpt: `Reviewed support ${randomUUID().slice(0, 8)}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
    expiresAt: null,
  });
  const upserted = await upsertGraphAssertion(db, {
    subjectNodeId: work.id,
    predicate: 'CREATED_BY',
    objectNodeId: creator.id,
    status: 'validated',
  });
  await attachAssertionSupport(db, {
    assertionId: upserted.row.id,
    evidenceId: inserted.row.id,
    derivation: 'primary',
    sourceFamilyKey: family,
  });
  const { rows } = await db.query<{ id: string; revision: number }>('SELECT id, revision FROM graph_assertions WHERE id = $1', [
    upserted.row.id,
  ]);
  return {
    assertion: rows[0]!,
    evidence: { id: inserted.row.id, revision: inserted.revision },
    work,
    creator,
    source: { url, title: 'A reviewed collection record', publisher: 'A museum' },
  };
}

/** The canonical display name of an identity row (zod rows are snake_case). */
function nameOf(node: { canonical_name: string }): string {
  return node.canonical_name;
}

/** The account's own graph-parented recommendation with a pinned proof. */
async function graphBackedCard(
  account: { accountId: string },
  path: Awaited<ReturnType<typeof justifiedAssertion>>,
  over: { supportEdgeIds?: string[]; intent?: 'personal' | 'photo' } = {},
) {
  const itemId = await insertItem({ accountId: account.accountId }, { title: 'A graph-backed card' });
  const run = await createGraphRun(db, {
    ownerAccountId: account.accountId,
    runKind: 'expansion',
    policyVersion: 'graph-policy-1',
  });
  const rec = await insertGraphRecommendation(db, {
    ownerAccountId: account.accountId,
    runId: run.id,
    discoveryItemId: itemId,
    origin: 'catalog',
    title: 'A graph-backed card',
    displayReason: `By the same creator (${nameOf(path.creator)})`,
  });
  const proof = await insertRecommendationProof(db, {
    ownerAccountId: account.accountId,
    recommendationId: rec.id,
    graphRunId: run.id,
    intent: over.intent ?? 'personal',
    reasonTemplate: 'same_creator',
    assertions: [{ id: path.assertion.id, revision: path.assertion.revision }],
    evidence: [{ id: path.evidence.id, revision: path.evidence.revision }],
    supportEdgeIds: over.supportEdgeIds ?? [],
  });
  return { runId: run.id, recommendationId: rec.id, proofId: proof.id, itemId };
}

describe('owner/native graph summary (GET /v2/me/interest-graph)', () => {
  it('reports honest empty state: zero counts, revision 0, unpaused, never_projected', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const summary = await interestGraph.getInterestGraphSummary(ctx, {});
    expect(summary.settings).toEqual({ revision: 0, discovery_paused: false, paused_at: null });
    expect(summary.counts).toEqual({ confirmed: 0, tentative: 0, suppressed: 0 });
    expect(summary.projection.state).toBe('never_projected');
    expect(summary.projection.lagging).toBe(false);
    expect(summary.interests.items).toEqual([]);
    expect(summary.tentative.items).toEqual([]);
    expect(summary.owner_account_id).toBe(principal.accountId);
  });

  it('separates confirmed explicit interests from tentative derived affinities with stable edge ids and titles', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const saved = await insertItem({ accountId: principal.accountId }, { title: 'Chosen film' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: saved });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);

    const summary = await interestGraph.getInterestGraphSummary(ctx, {});
    expect(summary.counts).toEqual({ confirmed: 1, tentative: 0, suppressed: 0 });
    expect(summary.interests.items).toHaveLength(1);
    expect(summary.interests.items[0]).toMatchObject({
      item_id: saved,
      title: 'Chosen film',
      state: 'confirmed',
      origin: 'explicit',
      edge_id: expect.any(String),
      saved_item_id: expect.any(String),
      pick_ids: [],
    });
  });

  it('paginates both lists with bounded cursors and rejects invalid bounds and foreign cursors', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    for (let i = 0; i < 3; i++) {
      const item = await insertItem({ accountId: principal.accountId }, { title: `Pick ${i}` });
      await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    }
    const page = await interestGraph.getInterestGraphSummary(ctx, { limit: 2 });
    expect(page.interests.items).toHaveLength(2);
    expect(page.interests.next_cursor).toBeTruthy();
    expect(page.counts.confirmed).toBe(3);

    const next = await interestGraph.getInterestGraphSummary(ctx, { limit: 2, interests_cursor: page.interests.next_cursor! });
    expect(next.interests.items).toHaveLength(1);
    expect(next.interests.next_cursor).toBeNull();
    const ids = [...page.interests.items, ...next.interests.items].map((i) => i.item_id);
    expect(new Set(ids).size).toBe(3);

    // Limit bounds are typed rejections.
    for (const limit of [0, 101, -1]) {
      const res = await code(interestGraph.getInterestGraphSummary(ctx, { limit }));
      expect(res.code, `limit ${limit}`).toBe('invalid_input');
    }
    // Malformed cursors are rejected.
    expect((await code(interestGraph.getInterestGraphSummary(ctx, { interests_cursor: 'not-a-cursor' }))).code).toBe('invalid_input');
    // A copied cursor from another owner never serves that owner's page.
    const stranger = await accountCtx({ config: projectionOn });
    const strangerItem = await insertItem({ accountId: stranger.principal.accountId }, { title: 'Theirs' });
    await recordPreference(stranger.ctx, { action: 'save', target_type: 'discovery_item', target_id: strangerItem });
    const foreign = await interestGraph.getInterestGraphSummary(stranger.ctx, { limit: 1 });
    const foreignCursor = foreign.interests.next_cursor ?? Buffer.from(JSON.stringify({ v: 1, o: 1, owner: stranger.principal.accountId, at: Date.now() })).toString('base64url');
    expect((await code(interestGraph.getInterestGraphSummary(ctx, { interests_cursor: foreignCursor }))).code).toBe('invalid_input');
  });
});

describe('optimistic settings (PATCH /v2/me/interest-graph/settings)', () => {
  it('pauses and resumes through the existing discovery pause, bumping the shared control revision', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const paused = await interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0, discovery_paused: true });
    expect(paused.settings).toMatchObject({ revision: 1, discovery_paused: true });
    expect(paused.settings.paused_at).toBeTruthy();
    // The authoritative pause primitive the sweeper and publishers read.
    expect(await graphDiscoveryPausedAt(db, principal.accountId)).toBeTruthy();

    const resumed = await interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 1, discovery_paused: false });
    expect(resumed.settings).toMatchObject({ revision: 2, discovery_paused: false, paused_at: null });
    expect(await graphDiscoveryPausedAt(db, principal.accountId)).toBeNull();
  });

  it('desired-state retries are idempotent: a satisfied pause neither bumps nor conflicts', async () => {
    const { ctx } = await accountCtx({ config: projectionOn });
    const paused = await interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0, discovery_paused: true });
    const retried = await interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0, discovery_paused: true });
    expect(retried.settings.revision).toBe(paused.settings.revision);
    expect(retried.settings.discovery_paused).toBe(true);
  });

  it('a stale revision with a different desired state is a typed revision_conflict', async () => {
    const { ctx } = await accountCtx({ config: projectionOn });
    await interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0, discovery_paused: true });
    const res = await code(interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0, discovery_paused: false }));
    expect(res.code).toBe('revision_conflict');
    expect(res.details).toMatchObject({ current_revision: 1 });
  });

  it('rejects unknown mutation fields and missing revisions without writes', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    expect((await code(interestGraph.updateInterestGraphSettings(ctx, { discovery_paused: true } as never))).code).toBe('invalid_input');
    expect((await code(interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0 } as never))).code).toBe('invalid_input');
    expect(
      (
        await code(
          interestGraph.updateInterestGraphSettings(ctx, { expected_revision: 0, discovery_paused: true, account_id: randomUUID() } as never),
        )
      ).code,
    ).toBe('invalid_input');
    expect(await graphDiscoveryPausedAt(db, principal.accountId)).toBeNull();
  });
});

describe('tentative-interest controls (PATCH /v2/me/interest-graph/interests/{id})', () => {
  it('suppressing a tentative edge writes the durable owner-bound marker and bumps the shared revision', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const fixture = await tentativeEdgeFixture(principal.accountId);
    const summary = await interestGraph.getInterestGraphSummary(ctx, {});
    expect(summary.tentative.items).toHaveLength(1);
    expect(summary.tentative.items[0]!.edge_id).toBe(fixture.edgeId);

    const suppressed = await interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, {
      expected_revision: 0,
      state: 'suppressed',
    });
    expect(suppressed).toMatchObject({ edge_id: fixture.edgeId, node_id: fixture.nodeId, state: 'suppressed' });
    expect(suppressed.settings.revision).toBe(1);

    const { rows: markers } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_edge_suppressions WHERE owner_account_id = $1 AND node_id = $2 AND restored_at IS NULL',
      [principal.accountId, fixture.nodeId],
    );
    expect(Number(markers[0]!.n)).toBe(1);
    // The summary labels the affinity suppressed, never removes it silently.
    const after = await interestGraph.getInterestGraphSummary(ctx, {});
    expect(after.counts.suppressed).toBe(1);
    expect(after.tentative.items[0]!.state).toBe('suppressed');

    // Suppression survives a real projector rebuild.
    await project(principal.accountId);
    const rebuilt = await interestGraph.getInterestGraphSummary(ctx, {});
    expect(rebuilt.tentative.items[0]!.state).toBe('suppressed');
  });

  it('restoring frees the edge and survives another rebuild; retries and re-suppression work', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const fixture = await tentativeEdgeFixture(principal.accountId);

    await interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { expected_revision: 0, state: 'suppressed' });
    // Retry with the stale revision: satisfied desired state, idempotent.
    const retried = await interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { expected_revision: 0, state: 'suppressed' });
    expect(retried.settings.revision).toBe(1);

    const restored = await interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { expected_revision: 1, state: 'tentative' });
    expect(restored.state).toBe('tentative');
    expect(restored.settings.revision).toBe(2);
    const { rows: marker } = await db.query<{ restored_at: Date | null }>(
      'SELECT restored_at FROM personal_edge_suppressions WHERE owner_account_id = $1 AND node_id = $2',
      [principal.accountId, fixture.nodeId],
    );
    expect(marker[0]!.restored_at).toBeTruthy();

    // Restoration survives a rebuild: the edge stays tentative.
    await project(principal.accountId);
    const after = await interestGraph.getInterestGraphSummary(ctx, {});
    expect(after.tentative.items.find((t) => t.edge_id === fixture.edgeId)?.state).toBe('tentative');

    const again = await interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { expected_revision: 2, state: 'suppressed' });
    expect(again.state).toBe('suppressed');
    expect(again.settings.revision).toBe(3);
  });

  it('explicit edges answer action_required; foreign and missing edge ids are a non-disclosing 404', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId }, { title: 'Saved' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);
    const { rows: explicitEdge } = await db.query<{ id: string }>(
      'SELECT id FROM personal_interest_edges WHERE owner_account_id = $1 AND origin = $2',
      [principal.accountId, 'explicit'],
    );

    const res = await code(
      interestGraph.updateInterestGraphInterest(ctx, explicitEdge[0]!.id, { expected_revision: 0, state: 'suppressed' }),
    );
    expect(res.code).toBe('action_required');

    const stranger = await accountCtx({ config: projectionOn });
    const strangerFixture = await tentativeEdgeFixture(stranger.principal.accountId);
    const foreign = await code(
      interestGraph.updateInterestGraphInterest(ctx, strangerFixture.edgeId, { expected_revision: 0, state: 'suppressed' }),
    );
    expect(foreign.code).toBe('not_found');
    expect(
      (await code(interestGraph.updateInterestGraphInterest(ctx, randomUUID(), { expected_revision: 0, state: 'suppressed' }))).code,
    ).toBe('not_found');
  });

  it('unknown fields and stale revisions are rejected without writes', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const fixture = await tentativeEdgeFixture(principal.accountId);
    expect(
      (
        await code(
          interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { expected_revision: 0, state: 'suppressed', force: true } as never),
        )
      ).code,
    ).toBe('invalid_input');
    expect((await code(interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { state: 'suppressed' } as never))).code).toBe(
      'invalid_input',
    );
    expect((await code(interestGraph.updateInterestGraphInterest(ctx, fixture.edgeId, { expected_revision: 7, state: 'suppressed' }))).code).toBe(
      'revision_conflict',
    );
    const { rows: edge } = await db.query<{ state: string }>('SELECT state FROM personal_interest_edges WHERE id = $1', [fixture.edgeId]);
    expect(edge[0]!.state).toBe('tentative');
  });
});

describe('recommendation connection (GET /v2/me/recommendations/{id}/connection)', () => {
  it('serves a valid pinned proof: cultural path, permitted sources and owner support roots, no scores', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const path = await justifiedAssertion();
    const saved = await insertItem({ accountId: principal.accountId }, { title: 'My saved root' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: saved });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);
    const { rows: supportEdge } = await db.query<{ id: string }>(
      'SELECT id FROM personal_interest_edges WHERE owner_account_id = $1 AND discovery_item_id = $2',
      [principal.accountId, saved],
    );
    const card = await graphBackedCard(principal, path, { supportEdgeIds: [supportEdge[0]!.id] });

    const connection = await interestGraph.getRecommendationConnection(ctx, card.recommendationId);
    expect(connection).toMatchObject({
      recommendation_id: card.recommendationId,
      provenance: 'graph_run',
      state: 'connected',
      intent: 'personal',
      graph_run_id: card.runId,
    });
    expect(connection.reason.text).toBe(`By the same creator (${nameOf(path.creator)})`);
    expect(connection.reason.template).toBe('same_creator');
    expect(connection.path).toHaveLength(1);
    expect(connection.path![0]).toMatchObject({
      subject: { node_id: path.work.id, name: nameOf(path.work) },
      predicate: 'CREATED_BY',
      object: { node_id: path.creator.id, name: nameOf(path.creator) },
      association_subtype: null,
    });
    expect(connection.sources).toHaveLength(1);
    expect(connection.sources![0]).toMatchObject({
      url: path.source.url,
      title: 'A reviewed collection record',
      publisher: 'A museum',
      excerpt: expect.any(String),
    });
    expect(connection.sources![0]!.retrieved_at).toBeTruthy();
    expect(connection.support?.roots).toEqual([
      { edge_id: supportEdge[0]!.id, origin: 'explicit_save', label: 'My saved root' },
    ]);
    // No raw affinity scores anywhere in the response.
    expect(JSON.stringify(connection)).not.toMatch(/score|strength|weight/);
  });

  it('a retracted sole evidence makes the connection honestly unavailable, without substitution', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const path = await justifiedAssertion();
    const card = await graphBackedCard(principal, path);
    await retractGraphEvidence(db, { evidenceId: path.evidence.id, reason: 'test retraction' });

    const connection = await interestGraph.getRecommendationConnection(ctx, card.recommendationId);
    expect(connection.state).toBe('unavailable');
    expect(connection.unavailable_reason).toBeTruthy();
    expect(connection.reason.text).toBeNull();
    expect(connection.path).toBeNull();
    expect(connection.support).toBeNull();
    expect(connection.sources).toEqual([]);
  });

  it('serves a scoped result through its pinned scoped proof', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const path = await justifiedAssertion();
    const origin = await insertItem({ accountId: principal.accountId }, { title: 'Origin item' });
    const candidate = await insertItem({ accountId: principal.accountId }, { title: 'Scoped candidate' });
    const { rows: job } = await db.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id, status) VALUES ($1, $2, 'complete') RETURNING id`,
      [principal.accountId, origin],
    );
    const { rows: rec } = await db.query<{ id: string }>(
      `INSERT INTO recommendations (discovery_job_id, discovery_item_id, category, rank, title, origin, display_reason)
       VALUES ($1, $2, 'watch', 1, 'Scoped candidate', 'catalog', 'Also displayed at the same museum') RETURNING id`,
      [job[0]!.id, candidate],
    );
    await db.query(
      `INSERT INTO scoped_discovery_result_proofs
         (owner_account_id, discovery_job_id, recommendation_id, assertion_ids, assertion_revisions,
          evidence_ids, evidence_revisions, reason_template, reason_template_version,
          root_node_id, mid_node_id, candidate_node_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'co_documented_association', 'grammar-1', $8, $9, $10)`,
      [
        principal.accountId,
        job[0]!.id,
        rec[0]!.id,
        [path.assertion.id],
        [path.assertion.revision],
        [path.evidence.id],
        [path.evidence.revision],
        path.work.id,
        path.creator.id,
        path.creator.id,
      ],
    );

    const connection = await interestGraph.getRecommendationConnection(ctx, rec[0]!.id);
    expect(connection).toMatchObject({ provenance: 'scoped_discovery', state: 'connected' });
    expect(connection.reason.text).toBe('Also displayed at the same museum');
    expect(connection.path).toHaveLength(1);
    expect(connection.sources).toHaveLength(1);
    expect(connection.support).toBeNull();
  });

  it('legacy recommendations keep their actual origin and are never retroactively graph-proven', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const { rows: source } = await db.query<{ id: string }>(
      `INSERT INTO sources (url, title, publisher) VALUES ($1, 'A source page', 'A publisher') RETURNING id`,
      [`https://example.com/${randomUUID().slice(0, 8)}`],
    );
    const recommended = await insertItem({ accountId: principal.accountId }, { title: 'Legacy card' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId }, { recommendItemIds: [recommended] });
    const { rows: rec } = await db.query<{ id: string }>('SELECT id FROM recommendations WHERE analysis_id = $1', [cap.analysisId]);
    await db.query('UPDATE recommendations SET source_ids = ARRAY[$2::uuid] WHERE id = $1', [rec[0]!.id, source[0]!.id]);

    const connection = await interestGraph.getRecommendationConnection(ctx, rec[0]!.id);
    expect(connection).toMatchObject({
      provenance: 'legacy',
      origin: 'vlm_creative',
      state: 'connected',
      graph_run_id: null,
      intent: null,
    });
    expect(connection.reason.text).toBe('Inspired by your photo.');
    expect(connection.path).toBeNull();
    expect(connection.support).toBeNull();
    expect(connection.sources).toEqual([
      expect.objectContaining({ id: source[0]!.id, url: expect.any(String), title: 'A source page', publisher: 'A publisher' }),
    ]);
  });

  it('cross-owner recommendation ids are a non-disclosing 404', async () => {
    const { ctx } = await accountCtx({ config: projectionOn });
    const stranger = await accountCtx({ config: projectionOn });
    const path = await justifiedAssertion();
    const card = await graphBackedCard(stranger.principal, path);
    expect((await code(interestGraph.getRecommendationConnection(ctx, card.recommendationId))).code).toBe('not_found');
    expect((await code(interestGraph.getRecommendationConnection(ctx, randomUUID()))).code).toBe('not_found');
  });
});
