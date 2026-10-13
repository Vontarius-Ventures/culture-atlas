import { notImplemented } from '../errors';
import type { JobHandler } from '../jobs/handler';

/** Regenerates one section into the new version, preserving the others. TODO(plans owner). */
export const replacePlanSection: JobHandler<'replace_plan_section'> = async (ctx) => {
  void ctx;
  notImplemented('pipeline.replacePlanSection');
};
