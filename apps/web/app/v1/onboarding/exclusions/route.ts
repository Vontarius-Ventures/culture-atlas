import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** PUT /v1/onboarding/exclusions — replaces food exclusions (a preference, never a pick). */
export const PUT = apiRoute(ROUTES.putOnboardingExclusions, ({ ctx, body }) => onboarding.putExclusions(ctx, body));
