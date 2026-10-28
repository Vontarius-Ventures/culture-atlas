import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { claimSession } from '../services/auth';
import { submitCorrection } from '../services/analyses';
import { recordPreference } from '../services/preferences';
import { accountCtx, anonCtx, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { dispatchGraphOutbox } from './dispatch';
import { projectAccountInterestGraph } from './projector';
import { readReconciledInterestGraph } from './read';

/**
 * Reads reconcile current authoritative support while the projection lags
 * (VAL-PROJ-008), and an anonymous claim projects the merged canonical state
 * exactly once. The graph never exposes a removed interest merely because the
 * projector has not caught up, and derived capture affinities stay tentative,
 * bounded and labeled.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

async function project(accountId: string, jobId?: string) {
  return projectAccountInterestGraph(db, { accountId, jobId, config: projectionOn, source: 'mutation_intent' });
}

describe('reconciled reads honor removals before catch-up (VAL-PROJ-008)', () => {
  it('a lagging projection never serves withdrawn support', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const keep = await insertItem({ accountId: principal.accountId }, { key: 'keep', title: 'Keep' });
    const drop = await insertItem({ accountId: principal.accountId }, { key: 'drop', title: 'Drop' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: keep });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: drop });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);

    let read = await readReconciledInterestGraph(db, principal.accountId);
    expect(read.projection.lagging).toBe(false);
    expect(read.projection.pendingEvents).toBe(0);
    expect(read.interests.map((i) => i.canonicalKey).sort()).toEqual(['drop', 'keep'].sort());
    expect(read.interests.every((i) => i.edgeId !== null)).toBe(true);
    expect(read.projection.currentTasteRevision).toBe(read.projection.appliedTasteRevision);

    // The removal commits but the projector has not caught up yet.
    await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: drop });
    read = await readReconciledInterestGraph(db, principal.accountId);
    expect(read.projection.lagging).toBe(true);
    expect(read.projection.pendingEvents).toBe(1);
    expect(read.projection.appliedTasteRevision).toBeLessThan(read.projection.currentTasteRevision);
    // The read still honors the removal even though a stale projected edge exists.
    const { rows: staleEdge } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1 AND discovery_item_id = $2`,
      [principal.accountId, drop],
    );
    expect(Number(staleEdge[0]!.n)).toBe(1);
    expect(read.interests.map((i) => i.canonicalKey)).toEqual(['keep']);

    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);
    read = await readReconciledInterestGraph(db, principal.accountId);
    expect(read.projection.lagging).toBe(false);
    expect(read.interests.map((i) => i.canonicalKey)).toEqual(['keep']);
  });

  it('exposure-only saves and hidden keys never appear as interests', async () => {
    const { fillInterestsBoard } = await import('../services/collections');
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const item = await insertItem({ accountId: principal.accountId }, { title: 'Chosen' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: item });
    const exposure = await insertItem({ accountId: principal.accountId }, { kind: 'film' });
    await fillInterestsBoard(db, principal.accountId, [exposure]);
    await recordPreference(ctx, { action: 'hide', target_type: 'discovery_item', target_id: item });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);

    const read = await readReconciledInterestGraph(db, principal.accountId);
    expect(read.interests).toEqual([]);
    expect(read.projection.lagging).toBe(false);
  });

  it('a shared-row save reads as a confirmed interest decorated with its private edge', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const shared = await insertItem(null, { title: 'Shared sample' });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: shared });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    await project(principal.accountId);

    const read = await readReconciledInterestGraph(db, principal.accountId);
    expect(read.projection.lagging).toBe(false);
    expect(read.interests).toHaveLength(1);
    expect(read.interests[0]).toMatchObject({
      itemId: shared,
      state: 'confirmed',
      edgeId: expect.any(String),
    });
    const { rows: edge } = await db.query<{ saved_item_id: string | null }>(
      'SELECT saved_item_id FROM personal_interest_edges WHERE owner_account_id = $1',
      [principal.accountId],
    );
    expect(edge[0]!.saved_item_id).toBe(read.interests[0]!.savedItemId);

    // Removal is honored before catch-up, exactly like owned roots.
    await recordPreference(ctx, { action: 'remove', target_type: 'discovery_item', target_id: shared });
    const after = await readReconciledInterestGraph(db, principal.accountId);
    expect(after.interests).toEqual([]);
    expect(after.projection.lagging).toBe(true);
  });
});

describe('claim merges canonical saves and projects once', () => {
  it('a claimed session projects one merged root per canonical key', async () => {
    const key = `qloo:${randomUUID()}`;
    const otherKey = `qloo:${randomUUID()}`;
    const { principal: account, ctx: actx } = await accountCtx({ config: projectionOn });
    const accountFilm = await insertItem({ accountId: account.accountId }, { key, title: 'Amélie' });
    await recordPreference(actx, { action: 'save', target_type: 'discovery_item', target_id: accountFilm });

    const { principal: anon } = await anonCtx();
    const dupFilm = await insertItem({ sessionId: anon.sessionId }, { key, title: 'Amélie' });
    const newFilm = await insertItem({ sessionId: anon.sessionId }, { key: otherKey, title: 'Persepolis' });
    for (const item of [dupFilm, newFilm]) {
      const { rows } = await db.query<{ canonical_key: string }>('SELECT canonical_key FROM discovery_items WHERE id = $1', [item]);
      await db.query('INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2)', [anon.sessionId, item]);
      await db.query(
        `INSERT INTO preference_events (owner_session_id, action, target_type, target_id, payload)
         VALUES ($1, 'save', 'discovery_item', $2, $3::jsonb)`,
        [anon.sessionId, item, JSON.stringify({ canonical_key: rows[0]!.canonical_key })],
      );
    }

    await db.transaction((tx) => claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn));
    const claimed = await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: account.accountId });
    expect(claimed.accounts.map((a) => a.accountId)).toContain(account.accountId);
    const result = await project(account.accountId, claimed.accounts.find((a) => a.accountId === account.accountId)!.jobId);
    expect(result.projected).toBe(true);

    // One merged canonical root, one explicit support contribution: the
    // duplicate dropped and the fresh save moved during the claim.
    const read = await readReconciledInterestGraph(db, account.accountId);
    expect(read.interests.map((i) => i.canonicalKey).sort()).toEqual([key, otherKey].sort());
    const { rows: support } = await db.query<{ origin_kind: string }>(
      `SELECT s.origin_kind FROM personal_interest_support s
        JOIN personal_interest_edges e ON e.id = s.edge_id
       WHERE s.owner_account_id = $1 AND s.origin_kind = 'saved_item'`,
      [account.accountId],
    );
    expect(support).toHaveLength(2);
    expect(read.projection.lagging).toBe(false);

    // A retried claim adds nothing and the projection stays identical.
    const retry = await db.transaction((tx) => claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn));
    expect(retry).toEqual({ captures: 0, saved_items: 0 });
    const before = read.interests.map((i) => i.itemId).sort();
    await project(account.accountId);
    const reread = await readReconciledInterestGraph(db, account.accountId);
    expect(reread.interests.map((i) => i.itemId).sort()).toEqual(before);
  });
});

describe('derived capture affinities stay tentative and labeled', () => {
  it('a resolved reference of a saved capture is derived support at exact versions', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const ref = await insertReference({ name: 'Noguchi lamp' });
    const { rows: node } = await db.query<{ id: string }>(
      `INSERT INTO graph_nodes (cultural_reference_id, canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
       VALUES ($1, $2, $3, $4, 'style', 'design', 'style') RETURNING id`,
      [ref, `atlas:${randomUUID()}`, 'Noguchi lamp', 'noguchi lamp'],
    );
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await db.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor)
       VALUES ($1, $2, 'resembles', 0.8, 'resolved', true)`,
      [cap.analysisId, ref],
    );
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    await dispatchGraphOutbox(db, { config: projectionOn, ownerAccountId: principal.accountId });
    const projected = await project(principal.accountId);
    expect(projected.derivedSupport).toBe(1);

    const read = await readReconciledInterestGraph(db, principal.accountId);
    // The saved capture is the confirmed root; the referenced work is a
    // tentative derived affinity, never a confirmed interest.
    expect(read.interests.map((i) => i.itemId)).toEqual([cap.itemId]);
    expect(read.interests[0]!.capturedBy).toMatchObject({ captureId: cap.captureId, analysisId: cap.analysisId });
    expect(read.derived).toHaveLength(1);
    expect(read.derived[0]).toMatchObject({
      captureId: cap.captureId,
      captureReferenceId: expect.any(String) as unknown,
      referenceId: ref,
      name: 'Noguchi lamp',
      relation: 'resembles',
      resolutionStatus: 'resolved',
      isAnchor: true,
      nodeId: node[0]!.id,
      origin: 'derived',
      state: 'tentative',
      analysisVersion: 1,
    });
    expect(read.derived[0]!.edgeId).toBeTruthy();

    // Suppressing the derived edge survives a rebuild; withdrawing the
    // reference removes the affinity and the edge.
    await db.query(
      `INSERT INTO personal_edge_suppressions (owner_account_id, node_id, policy_version) VALUES ($1, $2, 'graph-policy-1')`,
      [principal.accountId, node[0]!.id],
    );
    await project(principal.accountId);
    let suppressed = await readReconciledInterestGraph(db, principal.accountId);
    expect(suppressed.derived[0]!.state).toBe('suppressed');

    // The user withdraws the reference through the real correction path.
    await submitCorrection(ctx, {
      id: cap.captureId,
      body: { expected_analysis_version: 1, reject_reference_ids: [ref] },
    });
    const dropped = await project(principal.accountId);
    expect(dropped.derivedSupport).toBe(0);
    const { rows: nodeEdges } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_interest_edges WHERE owner_account_id = $1 AND node_id = $2',
      [principal.accountId, node[0]!.id],
    );
    expect(Number(nodeEdges[0]!.n)).toBe(0);
    // The suppression marker itself survives the rebuild for when the node returns.
    const { rows: markers } = await db.query<{ n: number }>(
      'SELECT count(*) AS n FROM personal_edge_suppressions WHERE owner_account_id = $1 AND restored_at IS NULL',
      [principal.accountId],
    );
    expect(Number(markers[0]!.n)).toBe(1);
    suppressed = await readReconciledInterestGraph(db, principal.accountId);
    expect(suppressed.derived).toHaveLength(0);
  });
});
