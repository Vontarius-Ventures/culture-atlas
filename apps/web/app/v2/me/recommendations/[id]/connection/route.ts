import { interestGraph } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v2/me/recommendations/{id}/connection — the owner's pinned Why this. */
export const GET = apiRoute(ROUTES.getMyRecommendationConnection, ({ ctx, params }) =>
  interestGraph.getRecommendationConnection(ctx, params.id),
);
