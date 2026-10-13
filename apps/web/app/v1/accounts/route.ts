import { NextResponse } from 'next/server';
import { AppError } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { apiRoute } from '@/lib/server/http';

/**
 * POST /v1/accounts — TODO(accounts owner): call auth.createAccount(ctx, body),
 * then set the new `ca_session` cookie from its sessionToken. The response
 * cookie needs direct access to the NextResponse, so this route will likely
 * use a custom handler around apiRoute.
 */
export const POST = apiRoute(ROUTES.createAccount, async () => {
  void NextResponse;
  throw new AppError('not_implemented');
});
