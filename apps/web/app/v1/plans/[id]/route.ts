import { plans } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getPlan, ({ ctx, params }) => plans.getPlan(ctx, params));
export const DELETE = apiRoute(ROUTES.deletePlan, ({ ctx, params }) => plans.deletePlan(ctx, params));
