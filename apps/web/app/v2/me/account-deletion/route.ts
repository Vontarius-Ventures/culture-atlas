import { accountDeletion } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /v2/me/account-deletion — the owner's own deletion state and disclosure. */
export const GET = apiRoute(ROUTES.getMyAccountDeletion, ({ ctx }) => accountDeletion.getAccountDeletionOverview(ctx));

/** POST /v2/me/account-deletion — accept the deletion (idempotent; revokes everything atomically). */
export const POST = apiRoute(ROUTES.requestMyAccountDeletion, ({ ctx, body }) =>
  accountDeletion.requestAccountDeletion(ctx, body),
);
