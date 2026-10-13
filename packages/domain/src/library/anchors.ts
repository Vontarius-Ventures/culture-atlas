import type { Queryable } from '../db/pool';
import type { ReferenceType } from '../enums';

/**
 * Resolved cultural anchors of discovery items: the item's own reference, its
 * resolved_anchor_ids and, for captures, the anchors of the ACTIVE analysis
 * (rejected/unmatched references excluded; user-selected/confirmed flagged).
 */
export interface ItemAnchor {
  reference_id: string;
  name: string;
  type: ReferenceType;
  revision: number;
  external_ids: Record<string, unknown>;
  user_selected: boolean;
}

export async function loadItemAnchors(db: Queryable, itemIds: readonly string[]): Promise<Map<string, ItemAnchor[]>> {
  const out = new Map<string, ItemAnchor[]>();
  if (itemIds.length === 0) return out;
  const { rows } = await db.query<{ item_id: string } & ItemAnchor>(
    `SELECT x.item_id, r.id AS reference_id, r.canonical_name AS name, r.type, r.revision, r.external_ids,
            bool_or(x.user_selected) AS user_selected
       FROM (
         SELECT di.id AS item_id, di.reference_id AS rid, false AS user_selected
           FROM discovery_items di WHERE di.id = ANY($1::uuid[]) AND di.reference_id IS NOT NULL
         UNION ALL
         SELECT di.id, a.rid, false
           FROM discovery_items di, unnest(di.resolved_anchor_ids) AS a(rid)
          WHERE di.id = ANY($1::uuid[])
         UNION ALL
         SELECT di.id, cr.reference_id, (cr.relation = 'user_selected' OR cr.resolution_status = 'user_confirmed')
           FROM discovery_items di
           JOIN captures c ON c.id = di.capture_id AND c.deleted_at IS NULL
           JOIN capture_references cr ON cr.analysis_id = c.active_analysis_id
          WHERE di.id = ANY($1::uuid[])
            AND (cr.is_anchor OR cr.relation = 'user_selected' OR cr.resolution_status = 'user_confirmed')
            AND cr.resolution_status NOT IN ('rejected', 'unmatched')
       ) x
       JOIN cultural_references r ON r.id = x.rid
      GROUP BY x.item_id, r.id
      ORDER BY x.item_id, bool_or(x.user_selected) DESC, r.canonical_name`,
    [itemIds],
  );
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push({
      reference_id: r.reference_id,
      name: r.name,
      type: r.type,
      revision: r.revision,
      external_ids: r.external_ids ?? {},
      user_selected: r.user_selected,
    });
    out.set(r.item_id, list);
  }
  return out;
}
