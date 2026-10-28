import { afterAll, describe, expect, it } from 'vitest';
import { accountCtx, anonCtx, ctxFor, insertCaptureWithAnalysis, insertItem, insertReference } from '../test-support/library';
import { closeTestDb, getTestDb, testConfig } from '../testing';
import { claimSession } from '../services/auth';
import { submitCorrection, activateAnalysis } from '../services/analyses';
import { deleteCapture } from '../services/captures';
import { recordPreference } from '../services/preferences';
import { loadExplicitSupport } from './explicit-support';
import { markGraphOutboxDispatched } from './store';

/**
 * VAL-PROJ-006: saved captures use current authorized dependencies. Saving a
 * capture preserves its explicit inspiration save, while the support derived
 * from it flows only through the capture's CURRENT active analysis and the
 * references that are currently resolved or user-confirmed. A correction or an
 * analysis replacement dirties the projection and immediately withdraws the
 * superseded support (the reader reflects it before any projector catches up),
 * without erasing independent saves. Stale expected-analysis-version
 * corrections mutate nothing, unresolved fallback names establish no factual
 * assertion, and deleting a capture withdraws only its own lineage.
 */

const db = getTestDb();
afterAll(closeTestDb);

const projectionOn = testConfig({ INTEREST_GRAPH_PROJECTION_ENABLED: 'true' });

interface OutboxRow {
  id: string;
  event_type: string;
  logical_event_key: string;
  target_taste_revision: number;
  dispatch_state: string;
  dispatched_at: string | null;
  processed_at: string | null;
  payload: Record<string, unknown>;
}

async function outbox(accountId: string): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, event_type, logical_event_key, target_taste_revision, dispatch_state, dispatched_at, processed_at, payload
       FROM graph_outbox WHERE owner_account_id = $1
      ORDER BY target_taste_revision, created_at, id`,
    [accountId],
  );
  return rows;
}

async function tasteRevision(accountId: string): Promise<number> {
  const { rows } = await db.query<{ revision: number }>('SELECT revision FROM taste_profiles WHERE owner_account_id = $1', [
    accountId,
  ]);
  return rows[0]?.revision ?? 0;
}

/** One capture_references row in the given state. */
async function captureReference(
  analysisId: string,
  referenceId: string,
  input: { relation?: 'depicted' | 'resembles' | 'user_selected'; resolution?: string; isAnchor?: boolean; certainty?: number; textOnly?: boolean } = {},
): Promise<void> {
  await db.query(
    `INSERT INTO capture_references (analysis_id, reference_id, relation, certainty, resolution_status, is_anchor, text_only, read_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      analysisId,
      referenceId,
      input.relation ?? 'resembles',
      input.certainty ?? 0.8,
      input.resolution ?? 'resolved',
      input.isAnchor ?? false,
      input.textOnly ?? false,
      input.textOnly ? 'read from the photo caption' : null,
    ],
  );
}

/** A new immutable analysis version with its own reference rows. */
async function addAnalysisVersion(
  captureId: string,
  version: number,
  refs: Array<{ referenceId: string; relation?: 'depicted' | 'resembles' | 'user_selected'; resolution?: string }>,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO analyses (capture_id, version, compiler_version, title, interpretation, section_statuses)
     VALUES ($1, $2, 'test', $3, 'A corrected reading.', '{"observations":"complete"}') RETURNING id`,
    [captureId, version, `Version ${version}`],
  );
  const analysisId = rows[0]!.id;
  for (const r of refs) await captureReference(analysisId, r.referenceId, r);
  return analysisId;
}

describe('saved captures link current authorized dependencies (VAL-PROJ-006)', () => {
  it('derives support only from resolved/user-confirmed references of the active analysis, at exact versions', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const resolvedRef = await insertReference({ name: 'Noguchi lamp' });
    const confirmedRef = await insertReference({ name: 'Bauhaus chair' });
    const unmatchedRef = await insertReference({ name: 'Guessed name' });
    const ambiguousRef = await insertReference({ name: 'Could be either' });
    const rejectedRef = await insertReference({ name: 'Wrong guess' });
    const textOnlyRef = await insertReference({ name: 'Caption mention' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, resolvedRef, { resolution: 'resolved', isAnchor: true });
    await captureReference(cap.analysisId, confirmedRef, { resolution: 'user_confirmed', relation: 'user_selected' });
    await captureReference(cap.analysisId, unmatchedRef, { resolution: 'unmatched' });
    await captureReference(cap.analysisId, ambiguousRef, { resolution: 'ambiguous' });
    await captureReference(cap.analysisId, rejectedRef, { resolution: 'rejected' });
    await captureReference(cap.analysisId, textOnlyRef, { resolution: 'resolved', textOnly: true });

    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    const snapshot = await loadExplicitSupport(db, principal.accountId);

    // The explicit inspiration save is preserved as the confirmed root.
    expect(snapshot.saves.map((s) => s.itemId)).toContain(cap.itemId);
    expect(snapshot.captures).toHaveLength(1);
    const support = snapshot.captures[0]!;
    // Exact current dependency versions: the active analysis, not any other.
    expect(support).toMatchObject({
      captureId: cap.captureId,
      captureItemId: cap.itemId,
      savedItemId: snapshot.saves.find((s) => s.itemId === cap.itemId)!.savedItemId,
      analysisId: cap.analysisId,
      analysisVersion: 1,
    });
    // Only resolved/user-confirmed references count. Unmatched fallback names,
    // ambiguous matches, rejected rows and text-only mentions are never facts.
    expect(support.references.map((r) => r.name).sort()).toEqual(['Bauhaus chair', 'Noguchi lamp']);
    expect(support.references.find((r) => r.name === 'Noguchi lamp')!).toMatchObject({
      referenceId: resolvedRef,
      relation: 'resembles',
      resolutionStatus: 'resolved',
      isAnchor: true,
    });
    expect(support.references.find((r) => r.name === 'Bauhaus chair')!).toMatchObject({
      referenceId: confirmedRef,
      relation: 'user_selected',
      resolutionStatus: 'user_confirmed',
    });
  });

  it('an analyzed but unsaved capture contributes nothing; only the explicit save links it', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const saved = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    const unsaved = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    const ref = await insertReference({ name: 'Shared reference' });
    await captureReference(saved.analysisId, ref);
    await captureReference(unsaved.analysisId, ref);
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: saved.captureId });

    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures.map((c) => c.captureId)).toEqual([saved.captureId]);
    expect(snapshot.saves.map((s) => s.itemId)).toEqual([saved.itemId]);
  });

  it('a correction immediately withdraws rejected support, dirties projection and preserves the save and independent references', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const keepRef = await insertReference({ name: 'Keep me' });
    const dropRef = await insertReference({ name: 'Drop me' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, keepRef, { resolution: 'resolved', isAnchor: true });
    await captureReference(cap.analysisId, dropRef, { resolution: 'resolved' });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });

    let snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures[0]!.references.map((r) => r.name).sort()).toEqual(['Drop me', 'Keep me']);

    const before = await outbox(principal.accountId);
    const revisionBefore = await tasteRevision(principal.accountId);
    await submitCorrection(ctx, { id: cap.captureId, body: { expected_analysis_version: 1, reject_reference_ids: [dropRef] } });

    // The correction commits its projection intent in the same transaction, at the new revision.
    const rows = (await outbox(principal.accountId)).filter((r) => !before.some((b) => b.id === r.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'analysis',
      logical_event_key: `analysis:${cap.captureId}`,
      dispatch_state: 'pending',
      payload: { action: 'correct', capture_id: cap.captureId, rejected_reference_ids: [dropRef] },
    });
    expect(rows[0]!.target_taste_revision).toBeGreaterThan(revisionBefore);
    expect(rows[0]!.target_taste_revision).toBe(await tasteRevision(principal.accountId));

    // Lagging-read support: the rejection applies immediately, even though the
    // replacement analysis has not run yet and the active analysis still lists
    // the reference as resolved.
    snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures[0]!.references.map((r) => r.name)).toEqual(['Keep me']);
    // The explicit inspiration save survives the correction untouched.
    expect(snapshot.saves.map((s) => s.itemId)).toContain(cap.itemId);
  });

  it('stale expected-analysis-version corrections cannot mutate support', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const ref = await insertReference({ name: 'Only reference' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, ref, { resolution: 'resolved' });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });

    const before = await loadExplicitSupport(db, principal.accountId);
    const outboxBefore = await outbox(principal.accountId);
    const revisionBefore = await tasteRevision(principal.accountId);

    await expect(
      submitCorrection(ctx, { id: cap.captureId, body: { expected_analysis_version: 2, reject_reference_ids: [ref] } }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(await loadExplicitSupport(db, principal.accountId)).toEqual(before);
    expect(await outbox(principal.accountId)).toEqual(outboxBefore);
    expect(await tasteRevision(principal.accountId)).toBe(revisionBefore);
  });

  it('a confirmed reference the user re-selected counts even while the active analysis still rejects it', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const ref = await insertReference({ name: 'Re-selected' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, ref, { resolution: 'rejected' });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });

    let snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures[0]!.references).toEqual([]);
    // The user re-selects the rejected reference: the correction is the
    // current user-confirmed intent, effective before the new analysis runs.
    await submitCorrection(ctx, { id: cap.captureId, body: { expected_analysis_version: 1, confirm_reference_id: ref } });
    snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures[0]!.references).toHaveLength(1);
    expect(snapshot.captures[0]!.references[0]).toMatchObject({ referenceId: ref, resolutionStatus: 'user_confirmed' });
  });

  it('unresolved fallback names and user-named replacements establish no factual assertion', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const fallbackRef = await insertReference({ name: 'Fallback guess' });
    const resolvedRef = await insertReference({ name: 'Real match' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, fallbackRef, { resolution: 'unmatched' });
    await captureReference(cap.analysisId, resolvedRef, { resolution: 'resolved' });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });

    await submitCorrection(ctx, {
      id: cap.captureId,
      body: { expected_analysis_version: 1, reject_reference_ids: [resolvedRef], replacement: { name: 'A user-named chair', type: 'object' } },
    });

    // Before the replacement resolves through a reviewed analysis, the name the
    // user typed contributes nothing, and the rejected match is withdrawn.
    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures[0]!.references).toEqual([]);
    // The explicit save is still the only confirmed root for the capture.
    expect(snapshot.saves.map((s) => s.itemId)).toContain(cap.itemId);
  });

  it('activating a replacement analysis switches dependencies to the new version and re-arms the dispatched intent', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const keptRef = await insertReference({ name: 'Kept reference' });
    const droppedRef = await insertReference({ name: 'Dropped reference' });
    const freshRef = await insertReference({ name: 'Fresh reference' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, keptRef, { resolution: 'resolved', isAnchor: true });
    await captureReference(cap.analysisId, droppedRef, { resolution: 'resolved' });
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    await submitCorrection(ctx, { id: cap.captureId, body: { expected_analysis_version: 1, reject_reference_ids: [droppedRef] } });

    // The correction intent was dispatched and processed before activation.
    const correctionRow = (await outbox(principal.accountId)).find((r) => r.event_type === 'analysis')!;
    await markGraphOutboxDispatched(db, [correctionRow.id]);
    await db.query(`UPDATE graph_outbox SET dispatch_state = 'done', processed_at = now() WHERE id = $1`, [correctionRow.id]);

    const v2 = await addAnalysisVersion(cap.captureId, 2, [
      { referenceId: keptRef, resolution: 'resolved' },
      { referenceId: freshRef, resolution: 'resolved', relation: 'user_selected' },
    ]);
    await db.transaction((tx) => activateAnalysis(tx, { captureId: cap.captureId, analysisId: v2, config: projectionOn }));

    // The activation re-arms the same (owner, key, revision) row: the newest
    // intent is never lost to an already-processed one.
    const after = await outbox(principal.accountId);
    const row = after.find((r) => r.id === correctionRow.id)!;
    expect(row).toMatchObject({
      event_type: 'analysis',
      logical_event_key: `analysis:${cap.captureId}`,
      dispatch_state: 'pending',
      payload: { action: 'analysis_activated', capture_id: cap.captureId, analysis_id: v2 },
    });
    expect((row as { dispatched_at?: string | null }).dispatched_at).toBeNull();
    expect((row as { processed_at?: string | null }).processed_at).toBeNull();

    // Current dependencies: version 2, its own references, at the same revision.
    expect(row.target_taste_revision).toBe(await tasteRevision(principal.accountId));
    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures[0]!.analysisVersion).toBe(2);
    expect(snapshot.captures[0]!.analysisId).toBe(v2);
    expect(snapshot.captures[0]!.references.map((r) => r.name).sort()).toEqual(['Fresh reference', 'Kept reference']);

    // A re-run that does not move the pointer (idempotent retry) does not re-arm.
    await db.query(`UPDATE graph_outbox SET dispatch_state = 'done', processed_at = now() WHERE id = $1`, [row.id]);
    await db.transaction((tx) => activateAnalysis(tx, { captureId: cap.captureId, analysisId: v2, config: projectionOn }));
    const settled = (await outbox(principal.accountId)).find((r) => r.id === row.id)!;
    expect(settled.dispatch_state).toBe('done');
  });

  it('deleting a capture withdraws only its lineage; independent saves and shared references survive', async () => {
    const { principal, ctx } = await accountCtx({ config: projectionOn });
    const ref = await insertReference({ name: 'Shared fact' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, ref, { resolution: 'resolved', isAnchor: true });
    const inspired = await insertItem({ accountId: principal.accountId }, { title: 'Inspired save' });
    const independent = await insertItem({ accountId: principal.accountId }, { title: 'Independent save' });
    // The capture's analysis recommended `inspired`; the user then saved it
    // independently, so it must survive the capture's deletion.
    await db.query(
      `INSERT INTO recommendations (analysis_id, discovery_item_id, category, rank, title, origin, display_reason)
       VALUES ($1, $2, 'watch', 1, 'Inspired save', 'vlm_creative', 'Inspired by your photo.')`,
      [cap.analysisId, inspired],
    );
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: inspired });
    await recordPreference(ctx, { action: 'save', target_type: 'discovery_item', target_id: independent });

    const revisionBefore = await tasteRevision(principal.accountId);
    await deleteCapture(ctx, { id: cap.captureId });

    const rows = (await outbox(principal.accountId)).filter((r) => r.event_type === 'analysis');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      logical_event_key: `analysis:${cap.captureId}`,
      dispatch_state: 'pending',
      payload: { action: 'capture_deleted', capture_id: cap.captureId },
    });
    expect(rows[0]!.target_taste_revision).toBeGreaterThan(revisionBefore);

    const snapshot = await loadExplicitSupport(db, principal.accountId);
    expect(snapshot.captures).toEqual([]);
    // The capture's own save is gone with it; independent saves survive.
    expect(snapshot.saves.map((s) => s.itemId).sort()).toEqual([independent, inspired].sort());
    // The shared cultural reference survives as a shared fact (only the
    // private capture linkage is withdrawn).
    const shared = await db.query('SELECT id FROM cultural_references WHERE id = $1', [ref]);
    expect(shared.rows).toHaveLength(1);
  });

  it('keeps the hooks silent while the projection flag is off by default', async () => {
    const { principal, ctx } = await accountCtx();
    const ref = await insertReference({ name: 'Flag-off reference' });
    const cap = await insertCaptureWithAnalysis({ accountId: principal.accountId });
    await captureReference(cap.analysisId, ref);
    await recordPreference(ctx, { action: 'save', target_type: 'capture', target_id: cap.captureId });
    await submitCorrection(ctx, { id: cap.captureId, body: { expected_analysis_version: 1, reject_reference_ids: [ref] } });
    const v2 = await addAnalysisVersion(cap.captureId, 2, [{ referenceId: ref }]);
    await db.transaction((tx) => activateAnalysis(tx, { captureId: cap.captureId, analysisId: v2, config: ctx.config }));
    await deleteCapture(ctx, { id: cap.captureId });
    expect(await outbox(principal.accountId)).toEqual([]);
  });

  it('session-owned captures never queue graph intents', async () => {
    const { principal: anon } = await anonCtx();
    const ctx = ctxFor(anon, { config: projectionOn });
    const ref = await insertReference({ name: 'Anonymous reference' });
    const cap = await insertCaptureWithAnalysis({ sessionId: anon.sessionId });
    await captureReference(cap.analysisId, ref);
    await submitCorrection(ctx, { id: cap.captureId, body: { expected_analysis_version: 1, reject_reference_ids: [ref] } });
    const v2 = await addAnalysisVersion(cap.captureId, 2, [{ referenceId: ref }]);
    await db.transaction((tx) => activateAnalysis(tx, { captureId: cap.captureId, analysisId: v2, config: projectionOn }));
    await deleteCapture(ctx, { id: cap.captureId });
    const { rows } = await db.query(`SELECT id FROM graph_outbox WHERE payload->>'capture_id' = $1`, [cap.captureId]);
    expect(rows).toEqual([]);
  });

  it('a claimed anonymous capture brings its current dependencies under the account', async () => {
    const { principal: anon } = await anonCtx();
    const ref = await insertReference({ name: 'Claimed reference' });
    const cap = await insertCaptureWithAnalysis({ sessionId: anon.sessionId });
    await captureReference(cap.analysisId, ref, { resolution: 'resolved', isAnchor: true });
    // The shape a claimed history leaves behind: a session save with its event.
    await db.query('INSERT INTO saved_items (owner_session_id, discovery_item_id) VALUES ($1, $2)', [anon.sessionId, cap.itemId]);
    await db.query(
      `INSERT INTO preference_events (owner_session_id, action, target_type, target_id, payload)
       VALUES ($1, 'save', 'capture', $2, $3::jsonb)`,
      [anon.sessionId, cap.captureId, JSON.stringify({ canonical_key: `capture:${cap.captureId}` })],
    );

    const { principal: account } = await accountCtx({ config: projectionOn });
    await db.transaction((tx) => claimSession(tx, anon.sessionId, account.accountId, new Date(), projectionOn));

    const snapshot = await loadExplicitSupport(db, account.accountId);
    expect(snapshot.saves.map((s) => s.itemId)).toContain(cap.itemId);
    expect(snapshot.captures).toHaveLength(1);
    expect(snapshot.captures[0]).toMatchObject({ captureId: cap.captureId, analysisVersion: 1 });
    expect(snapshot.captures[0]!.references.map((r) => r.referenceId)).toEqual([ref]);
    // The claim projected the merged state once (the existing claim intent).
    const claimRows = (await outbox(account.accountId)).filter((r) => r.event_type === 'claim');
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]!.payload).toMatchObject({ action: 'claim', captures: 1 });
  });
});
