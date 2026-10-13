import { collections } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const GET = apiRoute(ROUTES.listCollections, ({ ctx }) => collections.listCollections(ctx));
export const POST = apiRoute(ROUTES.createCollection, ({ ctx, body }) => collections.createCollection(ctx, body));
