import { onboarding } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/** Settings -> Taste: GET needs taste:read (exclusions only with preferences:read); POST is owner-only. */
export const GET = apiRoute(ROUTES.listTastePicks, ({ ctx }) => onboarding.listTastePicks(ctx));
export const POST = apiRoute(ROUTES.createTastePick, ({ ctx, body }) => onboarding.createPick(ctx, body));
