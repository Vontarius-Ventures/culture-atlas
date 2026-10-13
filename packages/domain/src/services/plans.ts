import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type {
  CreatePlanRequest,
  CreatePlanResponse,
  PlanReplacementRequest,
  PlanReplacementResponse,
  PlanResponse,
  PlansListResponse,
} from '../schemas/plans';
import type { PageQuery } from '../schemas/common';

/**
 * Recommendation Composer: movie-night plans. createPlan validates collection
 * ownership/grant, expected_revision (409 on stale), membership of every
 * item, fixed film is a selected film, usable anchors (else 400 with the weak
 * item ids), then snapshots inputs into plan_versions v1 and enqueues
 * generate_plan. Requires plans:write + collections:read + access to all inputs.
 * Reads re-check the CURRENT grant: plans whose inputs left the grant are 404
 * for that agent.
 */

/** GET /v1/plans. TODO(plans owner): implement. */
export async function listPlans(ctx: ServiceContext, query: PageQuery): Promise<PlansListResponse> {
  void ctx;
  void query;
  notImplemented('plans.listPlans');
}

/** POST /v1/plans (202). TODO(plans owner): implement. */
export async function createPlan(ctx: ServiceContext, body: CreatePlanRequest): Promise<CreatePlanResponse> {
  void ctx;
  void body;
  notImplemented('plans.createPlan');
}

/** GET /v1/plans/{id}. TODO(plans owner): implement. */
export async function getPlan(ctx: ServiceContext, input: { id: string }): Promise<PlanResponse> {
  void ctx;
  void input;
  notImplemented('plans.getPlan');
}

/**
 * POST /v1/plans/{id}/replacements (202) — new version copying other sections
 * unchanged; enqueue replace_plan_section. TODO(plans owner): implement.
 */
export async function replacePlanSection(
  ctx: ServiceContext,
  input: { id: string; body: PlanReplacementRequest },
): Promise<PlanReplacementResponse> {
  void ctx;
  void input;
  notImplemented('plans.replacePlanSection');
}

/** DELETE /v1/plans/{id}. TODO(plans owner): implement. */
export async function deletePlan(ctx: ServiceContext, input: { id: string }): Promise<void> {
  void ctx;
  void input;
  notImplemented('plans.deletePlan');
}
