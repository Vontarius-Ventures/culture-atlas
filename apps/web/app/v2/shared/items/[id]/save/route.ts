import { collectionShares } from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { agentRoute } from '@/lib/server/agent-http';
import { SHARE_COOKIE } from '@/lib/server/share-http';

/** Signed-in viewers copy a public catalog reference into their own library. */
export const POST = agentRoute(ROUTES.saveSharedItem, ({ ctx, params, query, body, request }) =>
  collectionShares.saveSharedItem(
    ctx,
    { sessionToken: request.cookies.get(SHARE_COOKIE)?.value ?? null, shareId: query.share ?? null },
    params.id,
    body.collection_id,
  ));
