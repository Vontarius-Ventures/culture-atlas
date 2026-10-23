import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** GET /v1/onboarding/state */
export const GET = apiRoute(ROUTES.getOnboardingState, ({ ctx }) => onboarding.getState(ctx));
