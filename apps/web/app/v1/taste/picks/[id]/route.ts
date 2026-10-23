import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** DELETE /v1/taste/picks/{id} — allowed below the onboarding minimum. */
export const DELETE = apiRoute(ROUTES.deleteTastePick, ({ ctx, params }) => onboarding.deletePick(ctx, params.id));
