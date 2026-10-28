import { randomUUID } from 'node:crypto';
import { requireScopes } from '../authz';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { ANALYSIS_SECTIONS } from '../enums';
import { AppError } from '../errors';
import { noteAnalysisIntent, type ProjectionGateConfig } from '../interest-graph/intent';
import { analysisDedupeKey } from '../jobs/dedupe';
import { cancelJobsForResult, enqueueJob } from '../jobs/queue';
import { ownerOf } from '../principal';
import type { CorrectionRequest, CorrectionResponse } from '../schemas/captures';
import { stableStringify } from '../util/stable-json';
import { consumeAnalysisQuota, loadAccessibleCapture } from './captures';
import { bumpTasteRevision, getTasteRevision } from './taste';

/**
 * Analyses are immutable versions of a capture's compilation. Corrections
 * ("Something else?" / focus) record a private PreferenceEvent(action=correct),
 * never overwrite global reference facts, invalidate affected recommendations
 * and queue a new analysis version.
 */

/**
 * POST /v1/captures/{id}/corrections — 202. expected_analysis_version must
 * match the active version (else 409 conflict).
 */
export async function submitCorrection(
  ctx: ServiceContext,
  input: { id: string; body: CorrectionRequest },
): Promise<CorrectionResponse> {
  requireScopes(ctx.principal, 'captures:write');
  const owner = ownerOf(ctx.principal);
  const p = ctx.principal;
  const body = input.body;

  return ctx.db.transaction(async (tx) => {
    const capture = await loadAccessibleCapture(ctx, input.id, { db: tx, forUpdate: true });
    const { rows: active } = await tx.query<{ id: string; version: number }>('SELECT id, version FROM analyses WHERE id = $1', [capture.active_analysis_id]);
    const current = active[0];
    if (!current || current.version !== body.expected_analysis_version) {
      throw new AppError('conflict', { message: 'This photo was updated. Review the latest result and try again.' });
    }

    // Referenced ids must belong to the analysis the user was looking at.
    const mentioned = [...(body.reject_reference_ids ?? []), ...(body.confirm_reference_id ? [body.confirm_reference_id] : [])];
    if (mentioned.length) {
      const { rows } = await tx.query<{ reference_id: string }>(
        'SELECT DISTINCT reference_id FROM capture_references WHERE analysis_id = $1 AND reference_id = ANY($2::uuid[])',
        [current.id, mentioned],
      );
      if (rows.length !== new Set(mentioned).size) throw new AppError('invalid_input', { message: 'That reference is not part of this result.' });
    }

    const focus = body.focus ?? capture.focus;
    const correction = {
      previous_analysis_id: current.id,
      reject_reference_ids: body.reject_reference_ids ?? [],
      confirm_reference_id: body.confirm_reference_id,
      replacement: body.replacement,
    };

    // Private record of the correction (never written to the public reference).
    await tx.query(
      `INSERT INTO preference_events (owner_account_id, owner_session_id, action, target_type, target_id, payload, agent_connection_id)
       VALUES ($1, $2, 'correct', 'capture', $3, $4::jsonb, $5)`,
      [
        owner.kind === 'account' ? owner.accountId : null,
        owner.kind === 'session' ? owner.sessionId : null,
        capture.id,
        JSON.stringify({ analysis_id: current.id, ...correction, focus: body.focus ?? null }),
        p.kind === 'agent' ? p.connectionId : null,
      ],
    );
    const revision = await bumpTasteRevision(tx, owner);
    if (body.focus) await tx.query('UPDATE captures SET focus = $2::jsonb, updated_at = now() WHERE id = $1', [capture.id, JSON.stringify(body.focus)]);

    // PR 8: the correction withdraws the rejected reference's derived support.
    // The intent commits in this same transaction (dirties the projection);
    // the support reader already reflects the rejection immediately, before
    // the replacement analysis exists, because it reads current intent.
    if (owner.kind === 'account') {
      await noteAnalysisIntent(tx, {
        ownerAccountId: owner.accountId,
        captureId: capture.id,
        action: 'correct',
        targetTasteRevision: revision,
        config: ctx.config,
        payload: {
          analysis_id: current.id,
          rejected_reference_ids: correction.reject_reference_ids,
          ...(correction.confirm_reference_id ? { confirmed_reference_id: correction.confirm_reference_id } : {}),
        },
      });
    }

    // Invalidate recommendations that relied on rejected references.
    if (correction.reject_reference_ids.length) {
      await tx.query('DELETE FROM recommendations WHERE analysis_id = $1 AND contributing_reference_ids && $2::uuid[]', [current.id, correction.reject_reference_ids]);
    }

    // A newer correction supersedes pending ones.
    await cancelJobsForResult(tx, 'capture', capture.id);
    const { rows: versions } = await tx.query<{ v: number | null }>(
      `SELECT GREATEST(
          (SELECT MAX(version) FROM analyses WHERE capture_id = $1),
          (SELECT MAX((payload->>'analysis_version')::int) FROM jobs WHERE result_type = 'capture' AND result_id = $1)
        ) AS v`,
      [capture.id],
    );
    const nextVersion = (versions[0]?.v ?? current.version) + 1;
    await consumeAnalysisQuota(ctx, tx, owner);

    const { job } = await enqueueJob(tx, {
      type: 'analyze_capture',
      owner,
      payload: {
        capture_id: capture.id,
        analysis_version: nextVersion,
        compiler_version: ctx.config.COMPILER_VERSION,
        focus,
        correction,
      },
      dedupeKey: analysisDedupeKey({
        owner,
        imageSha256: capture.image_sha256,
        focus,
        compilerVersion: ctx.config.COMPILER_VERSION,
        correctionOf: `${current.id}:${stableStringify(correction)}`,
      }),
      agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
      maxAttempts: ctx.config.JOB_MAX_ATTEMPTS,
      budget: {
        qloo_requests: ctx.config.JOB_MAX_QLOO_REQUESTS,
        research_refs: ctx.config.JOB_MAX_RESEARCH_REFS,
        provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES,
        deadline_ms: ctx.config.ANALYSIS_DEADLINE_MS,
      },
      traceId: randomUUID(),
      resultType: 'capture',
      resultId: capture.id,
    });
    await tx.query(`UPDATE captures SET status = 'processing', updated_at = now() WHERE id = $1`, [capture.id]);
    return { capture_id: capture.id, job_id: job.id, pending_analysis_version: nextVersion };
  });
}

/**
 * Create the analysis row for a job (version N) if absent; idempotent on
 * (capture_id, version). Used by the analyze_capture handler.
 */
export async function ensureAnalysisRow(
  db: Queryable,
  input: { captureId: string; version: number; compilerVersion: string; focus: unknown; jobId: string },
): Promise<{ id: string; created: boolean }> {
  const pending = Object.fromEntries(ANALYSIS_SECTIONS.map((s) => [s, s === 'observations' ? 'running' : 'pending']));
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO analyses (capture_id, version, compiler_version, focus, job_id, section_statuses)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)
     ON CONFLICT (capture_id, version) DO NOTHING
     RETURNING id`,
    [input.captureId, input.version, input.compilerVersion, JSON.stringify(input.focus ?? { kind: 'whole' }), input.jobId, JSON.stringify(pending)],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };
  const { rows } = await db.query<{ id: string }>('SELECT id FROM analyses WHERE capture_id = $1 AND version = $2', [input.captureId, input.version]);
  if (!rows[0]) throw new AppError('internal', { message: 'analysis row vanished', retryable: true });
  // A newer attempt of the same job (or a superseding correction job) owns it now.
  await db.query('UPDATE analyses SET job_id = $2 WHERE id = $1', [rows[0].id, input.jobId]);
  return { id: rows[0].id, created: false };
}

/**
 * Point captures.active_analysis_id at a completed/partial analysis, unless the
 * capture was deleted meanwhile (returns false; caller must not publish).
 * Never moves the pointer back to an older version.
 *
 * PR 8 (capture-support-projection): when the pointer MOVES to this analysis
 * and a projection config is given (the worker passes its job config inside
 * the publish transaction), the activation commits its graph intent in the
 * same transaction — the derived support of a saved capture must follow the
 * new active version. Idempotent re-activation (pointer already there) and
 * session-owned captures write nothing. Analysis activation does not bump the
 * taste revision; the intent targets the current revision and the outbox
 * re-arms the row if the correction intent at that revision was already
 * processed.
 */
export async function activateAnalysis(
  db: Queryable,
  input: { captureId: string; analysisId: string; config?: ProjectionGateConfig },
): Promise<boolean> {
  // The CTE snapshots the pre-update pointer/owner (data-modifying statements
  // read the statement-start snapshot), so the intent fires exactly once per
  // actual pointer move, for account-owned captures only.
  const { rows } = await db.query<{ id: string; prev_active_analysis_id: string | null; owner_account_id: string | null }>(
    `WITH prev AS (
       SELECT id, active_analysis_id AS prev_active_analysis_id, owner_account_id
         FROM captures WHERE id = $1
     )
     UPDATE captures c SET active_analysis_id = $2, updated_at = now()
      WHERE c.id = $1 AND c.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM analyses a WHERE a.id = $2 AND a.capture_id = c.id)
        AND (c.active_analysis_id IS NULL OR c.active_analysis_id = $2
             OR (SELECT version FROM analyses WHERE id = c.active_analysis_id) < (SELECT version FROM analyses WHERE id = $2))
      RETURNING c.id,
                (SELECT prev_active_analysis_id FROM prev WHERE prev.id = c.id) AS prev_active_analysis_id,
                (SELECT owner_account_id FROM prev WHERE prev.id = c.id) AS owner_account_id`,
    [input.captureId, input.analysisId],
  );
  if (rows.length === 1) {
    const moved = rows[0] && rows[0].prev_active_analysis_id !== input.analysisId;
    const accountId = rows[0]!.owner_account_id;
    if (moved && accountId && input.config) {
      await noteAnalysisIntent(db, {
        ownerAccountId: accountId,
        captureId: input.captureId,
        action: 'analysis_activated',
        targetTasteRevision: await getTasteRevision(db, { kind: 'account', accountId }),
        config: input.config,
        payload: { analysis_id: input.analysisId },
      });
    }
    return true;
  }
  // Already pointing at a newer version is not a deletion: true while the capture is live.
  const live = await db.query('SELECT 1 FROM captures WHERE id = $1 AND deleted_at IS NULL', [input.captureId]);
  return live.rows.length === 1;
}
