import { hasWholeLibrary } from '../authz';
import type { ServiceContext } from '../context';
import { LIMITS, type ClaimType, type ReferenceType } from '../enums';
import { AppError } from '../errors';
import { ownerOf, ownerPredicate } from '../principal';
import type { ReferenceResponse } from '../schemas/references';
import { iso } from '../util/time';
import { loadCards, type CardRecommendationContext } from './cards';
import { loadAccessibleCapture } from './captures';

/**
 * Reference Research module (public library). Pages contain public facts
 * only: never another user's private context or associations. Related cards
 * come from the caller's OWN context (a capture they can access, or their own
 * items anchored to this reference).
 */

interface ReferenceRow {
  id: string;
  canonical_name: string;
  type: ReferenceType;
  overview: string | null;
  sections: { heading: string; body: string; claim_ids: string[] }[] | null;
  research_status: ReferenceResponse['research_status'];
  revision: number;
  updated_at: Date;
}

/**
 * GET /v1/references/{id} — concise page: overview (<150 words), up to three
 * sections, claims with sources, related cards. Opening a reference is not an
 * endorsement (no taste change).
 */
export async function getReference(ctx: ServiceContext, input: { id: string; capture_id?: string }): Promise<ReferenceResponse> {
  const { rows } = await ctx.db.query<ReferenceRow>(
    `SELECT id, canonical_name, type, overview, sections, research_status, revision, updated_at
       FROM cultural_references WHERE id = $1`,
    [input.id],
  );
  const ref = rows[0];
  if (!ref) throw new AppError('not_found');

  const { rows: claimRows } = await ctx.db.query<{ id: string; text: string; claim_type: ClaimType; source_ids: string[] }>(
    'SELECT id, text, claim_type, source_ids FROM claims WHERE reference_id = $1 ORDER BY created_at, id',
    [ref.id],
  );
  const sourceIds = [...new Set(claimRows.flatMap((c) => c.source_ids))];
  const { rows: sourceRows } = sourceIds.length
    ? await ctx.db.query<{ id: string; url: string; title: string | null; publisher: string | null; retrieved_at: Date }>(
        'SELECT id, url, title, publisher, retrieved_at FROM sources WHERE id = ANY($1::uuid[]) ORDER BY url',
        [sourceIds],
      )
    : { rows: [] };
  // Only show claims whose support is intact (a factual claim needs a live source).
  const liveSources = new Set(sourceRows.map((s) => s.id));
  const claims = claimRows
    .map((c) => ({ ...c, source_ids: c.source_ids.filter((s) => liveSources.has(s)) }))
    .filter((c) => c.claim_type === 'interpretive' || c.source_ids.length > 0);
  const claimIds = new Set(claims.map((c) => c.id));
  const sections = (Array.isArray(ref.sections) ? ref.sections : [])
    .map((s) => ({ heading: s.heading, body: s.body, claim_ids: (s.claim_ids ?? []).filter((id) => claimIds.has(id)) }))
    .filter((s) => s.claim_ids.length > 0)
    .slice(0, LIMITS.referenceSectionsMax);

  return {
    id: ref.id,
    name: ref.canonical_name,
    type: ref.type,
    overview: ref.research_status === 'complete' ? ref.overview : null,
    sections,
    claims: claims.map((c) => ({ id: c.id, text: c.text, claim_type: c.claim_type, source_ids: c.source_ids })),
    sources: sourceRows.map((s) => ({ id: s.id, url: s.url, title: s.title, publisher: s.publisher, retrieved_at: iso(s.retrieved_at) })),
    related: await relatedCards(ctx, ref.id, input.capture_id),
    research_status: ref.research_status,
    revision: ref.revision,
    updated_at: iso(ref.updated_at),
  };
}

async function relatedCards(ctx: ServiceContext, referenceId: string, captureId: string | undefined) {
  const p = ctx.principal;
  if (p.kind === 'system') return [];
  const owner = ownerOf(p);
  const exclusionCol = owner.kind === 'account' ? 'owner_account_id' : 'owner_session_id';
  const ownerVal = owner.kind === 'account' ? owner.accountId : owner.sessionId;

  if (captureId) {
    // Capture context: must be the caller's own (and, for agents, granted) capture.
    const capture = await loadAccessibleCapture(ctx, captureId).catch(() => null);
    if (!capture?.active_analysis_id) return [];
    const { rows } = await ctx.db.query<{ id: string; discovery_item_id: string; origin: CardRecommendationContext['origin']; display_reason: string | null }>(
      `SELECT r.id, r.discovery_item_id, r.origin, r.display_reason
         FROM recommendations r JOIN discovery_items di ON di.id = r.discovery_item_id
        WHERE r.analysis_id = $1 AND $2 = ANY(r.contributing_reference_ids)
          AND NOT EXISTS (SELECT 1 FROM item_exclusions x WHERE x.${exclusionCol} = $3
                            AND (x.discovery_item_id = di.id OR x.canonical_key = di.canonical_key))
        ORDER BY r.rank LIMIT $4`,
      [capture.active_analysis_id, referenceId, ownerVal, LIMITS.relatedCachedMax],
    );
    const context = new Map(rows.map((r) => [r.discovery_item_id, { id: r.id, origin: r.origin, display_reason: r.display_reason }]));
    return loadCards(ctx, rows.map((r) => r.discovery_item_id), { recommendations: context });
  }

  // Without a capture context, only whole-library principals see their own anchored items.
  if (!hasWholeLibrary(p)) return [];
  const own = ownerPredicate(owner, 'di', 2);
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT di.id FROM discovery_items di
      WHERE $1 = ANY(di.resolved_anchor_ids) AND ${own.sql} AND di.kind <> 'capture'
        AND NOT EXISTS (SELECT 1 FROM item_exclusions x WHERE x.${exclusionCol} = $2
                          AND (x.discovery_item_id = di.id OR x.canonical_key = di.canonical_key))
      ORDER BY di.updated_at DESC LIMIT $3`,
    [referenceId, ...own.params, LIMITS.relatedCachedMax],
  );
  return loadCards(ctx, rows.map((r) => r.id));
}
