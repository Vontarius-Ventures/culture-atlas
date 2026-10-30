import { AppError, accountDeletion } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /v2/account-deletion/status — the one-time capability token answers the
 * honest cleanup lifecycle after every authority is gone. A wrong or missing
 * token is a plain not_found: nothing about any deletion is disclosed.
 */
export const GET = apiRoute(ROUTES.getAccountDeletionStatus, async ({ ctx, request }) => {
  const token = request.headers.get('x-atlas-deletion-token') ?? '';
  const status = await accountDeletion.getAccountDeletionStatusByToken(ctx.db, token);
  if (!status) throw new AppError('not_found', { message: 'Unknown status token.' });
  return status;
});
