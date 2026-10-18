import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** GET /v1/onboarding/seed — taste seed progress for screen 15. */
export const GET = apiRoute(ROUTES.getOnboardingSeed, ({ ctx }) => onboarding.getSeedStatus(ctx));
