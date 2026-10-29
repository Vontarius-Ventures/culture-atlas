import { interestGraph } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH /v2/me/interest-graph/settings — optimistic discovery pause control. */
export const PATCH = apiRoute(ROUTES.updateMyInterestGraphSettings, ({ ctx, body }) =>
  interestGraph.updateInterestGraphSettings(ctx, body),
);
