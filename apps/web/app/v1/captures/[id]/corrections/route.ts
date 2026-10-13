import { analyses } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const POST = apiRoute(ROUTES.correctCapture, ({ ctx, params, body }) =>
  analyses.submitCorrection(ctx, { id: params.id, body }),
);
