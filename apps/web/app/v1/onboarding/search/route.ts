import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** GET /v1/onboarding/search?q= — live Qloo entity search; status "unavailable" when Qloo is down. */
export const GET = apiRoute(ROUTES.searchOnboarding, ({ ctx, query }) => onboarding.search(ctx, query));
