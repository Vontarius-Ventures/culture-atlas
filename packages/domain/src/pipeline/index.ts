import type { JobHandlerMap } from '../jobs/handler';
import { analyzeCapture } from './analyze-capture';
import { discoverRelated } from './discover-related';
import { generatePlan } from './generate-plan';
import { purgeDeleted } from './purge';
import { replacePlanSection } from './replace-plan-section';
import { sensorPoll } from './sensor-poll';
import { tasteSeed } from './taste-seed';

/** JobType -> handler. apps/worker dispatches through this map. */
export const JOB_HANDLERS: JobHandlerMap = {
  analyze_capture: analyzeCapture,
  discover_related: discoverRelated,
  generate_plan: generatePlan,
  replace_plan_section: replacePlanSection,
  sensor_poll: sensorPoll,
  purge_deleted: purgeDeleted,
  taste_seed: tasteSeed,
};
