import { AppError } from '../errors';
import type { Queryable } from '../db/pool';
import { bindGraphIdentityReference } from './evidence';

/**
 * Verified application-reference/corpus identity linkage (DISC-SCR-004).
 *
 * Normal corpus admission creates canonical identities from the reviewed
 * manifest, but an identity only becomes reachable from the application's
 * real saved/photo subjects through the VERIFIED 1:1 cultural-reference link
 * (`graph_nodes.cultural_reference_id`). This module is the production
 * linking path that follows import:
 *
 *  - A reference links an identity ONLY through EXACT provider-id equality:
 *    the reference's `external_ids` (e.g. `{qloo: <entity id>}` written by
 *    the capture compiler) or its provider-scoped `canonical_key` (e.g.
 *    `qloo:<id>`, `wikidata:Q…`) must equal a CONFIRMED `graph_external_ids`
 *    mapping of that identity. A name — however similar — never links
 *    anything, and unconfirmed (proposed/ambiguous) mappings never verify a
 *    link.
 *  - `linkGraphReferenceIdentities` binds unlinked identities durably and
 *    idempotently: replay reports everything already linked and writes
 *    nothing. Competing links (an existing binding that contradicts the
 *    verified match) and ambiguous matches (one reference matching two
 *    identities, or one identity matched by two references) fail closed:
 *    nothing binds and no other identity row changes.
 *  - `verifiedReferenceNodeMatches` is the read-only scoped reader
 *    expansions use to resolve references that appeared after the last
 *    linkage pass — the production shape, since the reviewed corpus lands
 *    once and real references accumulate over time.
 */

/** The SQL predicate shared by every verified-match query: exact provider-id equality, both arms. */
const VERIFIED_MATCH_JOIN = `JOIN cultural_references cr
    ON (cr.external_ids ->> x.provider) = x.external_id
    OR cr.canonical_key = (x.provider || ':' || x.external_id)`;

const VERIFIED_MATCH_WHERE = `x.match_status = 'confirmed'`;

/**
 * Verified (reference → active identity) matches by exact confirmed
 * provider-id equality. Returns each scoped reference's DISTINCT matched
 * active node ids (empty/missing when nothing verified); more than one node
 * is an ambiguous match the caller must treat as unresolved.
 */
export async function verifiedReferenceNodeMatches(
  db: Queryable,
  scope: { referenceIds?: readonly string[] } = {},
): Promise<Map<string, string[]>> {
  const params: unknown[] = [];
  const scoped =
    scope.referenceIds && scope.referenceIds.length > 0
      ? (() => {
          params.push([...new Set(scope.referenceIds)]);
          return ' AND cr.id = ANY($1::uuid[])';
        })()
      : '';
  const { rows } = await db.query<{ reference_id: string; node_id: string }>(
    `SELECT DISTINCT cr.id AS reference_id, x.node_id
       FROM graph_external_ids x
       JOIN graph_nodes n ON n.id = x.node_id AND n.status = 'active'
       ${VERIFIED_MATCH_JOIN}
      WHERE ${VERIFIED_MATCH_WHERE}${scoped}`,
    params,
  );
  const byReference = new Map<string, Set<string>>();
  for (const row of rows) {
    const nodes = byReference.get(row.reference_id) ?? new Set<string>();
    nodes.add(row.node_id);
    byReference.set(row.reference_id, nodes);
  }
  return new Map([...byReference].map(([referenceId, nodes]) => [referenceId, [...nodes].sort()]));
}

export interface GraphReferenceLinkCounts {
  /** References with at least one verified identity match. */
  referencesMatched: number;
  /** References whose verified match bound a previously unlinked identity. */
  referencesLinked: number;
  /** References whose verified match was already durably linked. */
  referencesAlreadyLinked: number;
  /** References whose verified match is ambiguous (never bound here). */
  referenceLinksAmbiguous: number;
  /** References whose verified match contradicts an existing binding (never bound here). */
  referenceLinksConflicting: number;
}

/**
 * The idempotent verified-linkage pass: resolves every compiler-shaped
 * reference to its corpus identity through exact confirmed provider-id
 * equality and binds unlinked identities durably. Fail-closed semantics per
 * reference — ambiguous matches and competing bindings change nothing:
 *
 *  - one reference matching two identities, or one identity matched by two
 *    references, is AMBIGUOUS: nothing binds (a review resolves it);
 *  - an identity already linked to a different reference, or a reference
 *    already held by a different identity, is a COMPETING link: nothing
 *    binds and no other identity row changes.
 *
 * Corpus admission runs this inside its transaction, so re-running
 * `pnpm graph:corpus` durably converges bindings for references that
 * appeared since the last run; replay writes nothing.
 */
export async function linkGraphReferenceIdentities(db: Queryable): Promise<GraphReferenceLinkCounts> {
  const matches = await verifiedReferenceNodeMatches(db);
  const nodesByReference = new Map<string, string[]>();
  const referencesByNode = new Map<string, Set<string>>();
  for (const [referenceId, nodeIds] of matches) {
    nodesByReference.set(referenceId, nodeIds);
    for (const nodeId of nodeIds) {
      const refs = referencesByNode.get(nodeId) ?? new Set<string>();
      refs.add(referenceId);
      referencesByNode.set(nodeId, refs);
    }
  }

  const counts: GraphReferenceLinkCounts = {
    referencesMatched: nodesByReference.size,
    referencesLinked: 0,
    referencesAlreadyLinked: 0,
    referenceLinksAmbiguous: 0,
    referenceLinksConflicting: 0,
  };

  for (const [referenceId, nodeIds] of nodesByReference) {
    const nodeId = nodeIds[0]!;
    // Ambiguous: two identities claim the reference, or two references claim
    // the identity. Nothing binds — a review resolves the duplicate data.
    if (nodeIds.length > 1 || (referencesByNode.get(nodeId)?.size ?? 0) > 1) {
      counts.referenceLinksAmbiguous++;
      continue;
    }
    try {
      const { outcome } = await bindGraphIdentityReference(db, { nodeId, culturalReferenceId: referenceId });
      if (outcome === 'bound') counts.referencesLinked++;
      else counts.referencesAlreadyLinked++;
    } catch (err) {
      if (!(err instanceof AppError) || (err.code !== 'conflict' && err.code !== 'not_found')) throw err;
      // A competing binding (or a concurrently vanished identity) fails
      // closed: nothing changes here and the count reports it honestly.
      counts.referenceLinksConflicting++;
    }
  }
  return counts;
}
