import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** POST /v1/onboarding/picks — a pick is an explicit save (source onboarding) of real Qloo ids. */
export const POST = apiRoute(ROUTES.createOnboardingPick, ({ ctx, body }) => onboarding.createPick(ctx, body));
