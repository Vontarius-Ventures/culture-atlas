import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/**
 * Movie night: one film + two alternates, up to three dishes, music before/
 * after (artist mix acceptable; verified tracks only via a catalog adapter).
 * Uses the plan_versions.input_snapshot only (never live collection state).
 * Enforces fixed film and dietary exclusions; discloses weak inputs in the
 * rationale; combinations of influences are described as creative choices.
 * TODO(plans owner): implement.
 */
export const generatePlan: JobHandler<'generate_plan'> = async (ctx) => {
  void ctx;
  notImplemented('pipeline.generatePlan');
};
