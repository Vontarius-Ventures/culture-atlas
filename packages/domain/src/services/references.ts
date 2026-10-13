import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type { ReferenceResponse } from '../schemas/references';

/**
 * Reference Research module (public library). Pages contain public facts
 * only: never another user's private context or associations.
 */

/**
 * GET /v1/references/{id} — concise page: overview (<150 words), up to three
 * sections, claims with sources, related cards. Opening a reference is not an
 * endorsement (no taste change).
 * TODO(research owner): implement.
 */
export async function getReference(
  ctx: ServiceContext,
  input: { id: string; capture_id?: string },
): Promise<ReferenceResponse> {
  void ctx;
  void input;
  notImplemented('references.getReference');
}
