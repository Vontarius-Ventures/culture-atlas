import { interestGraph } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH /v2/me/interest-graph/interests/{id} — tentative-interest suppress/restore. */
export const PATCH = apiRoute(ROUTES.updateMyInterestGraphInterest, ({ ctx, params, body }) =>
  interestGraph.updateInterestGraphInterest(ctx, params.id, body),
);
