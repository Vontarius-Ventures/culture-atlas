import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** POST /v1/onboarding/complete — 409 below 3 picks; queues the taste seed. */
export const POST = apiRoute(ROUTES.completeOnboarding, ({ ctx }) => onboarding.complete(ctx));
