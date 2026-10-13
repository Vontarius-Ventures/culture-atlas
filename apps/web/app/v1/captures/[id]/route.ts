import { captures } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.getCapture, ({ ctx, params }) => captures.getCapture(ctx, params));
export const DELETE = apiRoute(ROUTES.deleteCapture, ({ ctx, params }) => captures.deleteCapture(ctx, params));
