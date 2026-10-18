import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** GET /v1/onboarding/catalog — screen 14 images and chips (no provider ids). Owner session only. */
export const GET = apiRoute(ROUTES.getOnboardingCatalog, ({ ctx }) => onboarding.getCatalog(ctx));
