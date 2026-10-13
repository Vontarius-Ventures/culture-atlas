import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { notImplemented } from '../errors';
import type { CorrectionRequest, CorrectionResponse } from '../schemas/captures';

/**
 * Analyses are immutable versions of a capture's compilation. Corrections
 * ("Something else?" / focus) record a private PreferenceEvent(action=correct),
 * never overwrite global reference facts, invalidate affected recommendations
 * and queue a new analysis version.
 */

/**
 * POST /v1/captures/{id}/corrections — 202. expected_analysis_version must
 * match the active version (else 409 conflict).
 * TODO(analysis owner): implement.
 */
export async function submitCorrection(
  ctx: ServiceContext,
  input: { id: string; body: CorrectionRequest },
): Promise<CorrectionResponse> {
  void ctx;
  void input;
  notImplemented('analyses.submitCorrection');
}

/**
 * Create the analysis row for a job (version N) if absent; idempotent on
 * (capture_id, version). Used by the analyze_capture handler.
 * TODO(analysis owner): implement.
 */
export async function ensureAnalysisRow(
  db: Queryable,
  input: { captureId: string; version: number; compilerVersion: string; focus: unknown; jobId: string },
): Promise<{ id: string; created: boolean }> {
  void db;
  void input;
  notImplemented('analyses.ensureAnalysisRow');
}

/**
 * Point captures.active_analysis_id at a completed/partial analysis, unless the
 * capture was deleted meanwhile (returns false; caller must not publish).
 * TODO(analysis owner): implement.
 */
export async function activateAnalysis(
  db: Queryable,
  input: { captureId: string; analysisId: string },
): Promise<boolean> {
  void db;
  void input;
  notImplemented('analyses.activateAnalysis');
}
