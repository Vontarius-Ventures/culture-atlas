import { interestGraph } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v2/me/interest-graph — the owner/native typed graph summary. */
export const GET = apiRoute(ROUTES.getMyInterestGraph, ({ ctx, query }) => interestGraph.getInterestGraphSummary(ctx, query));
