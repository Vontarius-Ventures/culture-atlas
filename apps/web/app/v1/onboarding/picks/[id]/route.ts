import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** DELETE /v1/onboarding/picks/{id} — removes the pick and unsaves what it saved. */
export const DELETE = apiRoute(ROUTES.deleteOnboardingPick, ({ ctx, params }) => onboarding.deletePick(ctx, params.id));
