import { plans } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const POST = apiRoute(ROUTES.replacePlanSection, ({ ctx, params, body }) =>
  plans.replacePlanSection(ctx, { id: params.id, body }),
);
