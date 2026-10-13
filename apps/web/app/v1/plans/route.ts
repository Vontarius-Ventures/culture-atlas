import { plans } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.listPlans, ({ ctx, query }) => plans.listPlans(ctx, query));
export const POST = apiRoute(ROUTES.createPlan, ({ ctx, body }) => plans.createPlan(ctx, body));
