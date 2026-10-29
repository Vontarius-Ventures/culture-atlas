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
 *  - `bilaterallyVerifiedReferenceNodes` applies the DURABLE linker's full
 *    bilateral rules to read-time resolution (DISC-SCR-017): a verified
 *    (reference → identity) pair resolves at read time ONLY when the durable
 *    linker would bind the same pair — exact confirmed provider-id equality,
 *    GLOBAL one-to-one cardinality in BOTH directions, an active identity
 *    and compatible existing bindings on both sides. An identity claimed by
 *    another reference anywhere (inverse ambiguity outside any local scope)
 *    or a competing durable binding on either side fails closed, changing
 *    no stored link and publishing no wrong-identity result.
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

/**
 * Verified (active identity → reference) matches by exact confirmed
 * provider-id equality — the INVERSE direction of
 * `verifiedReferenceNodeMatches`. Returns each scoped ACTIVE identity's
 * DISTINCT matched reference ids (empty/missing when nothing verified);
 * more than one reference is an ambiguous match the caller must treat as
 * unresolved, exactly as the durable linkage pass does.
 */
export async function verifiedNodeReferenceMatches(
  db: Queryable,
  scope: { nodeIds?: readonly string[] } = {},
): Promise<Map<string, string[]>> {
  const params: unknown[] = [];
  const scoped =
    scope.nodeIds && scope.nodeIds.length > 0
      ? (() => {
          params.push([...new Set(scope.nodeIds)]);
          return ' AND x.node_id = ANY($1::uuid[])';
        })()
      : '';
  const { rows } = await db.query<{ node_id: string; reference_id: string }>(
    `SELECT DISTINCT x.node_id, cr.id AS reference_id
       FROM graph_external_ids x
       JOIN graph_nodes n ON n.id = x.node_id AND n.status = 'active'
       ${VERIFIED_MATCH_JOIN}
      WHERE ${VERIFIED_MATCH_WHERE}${scoped}`,
    params,
  );
  const byNode = new Map<string, Set<string>>();
  for (const row of rows) {
    const refs = byNode.get(row.node_id) ?? new Set<string>();
    refs.add(row.reference_id);
    byNode.set(row.node_id, refs);
  }
  return new Map([...byNode].map(([nodeId, refs]) => [nodeId, [...refs].sort()]));
}

export interface BilateralReferenceNodeVerdict {
  /**
   * The scoped references whose verified match satisfies EVERY bilateral
   * rule, mapped to their single active identity. This is exactly the set
   * the durable linker would bind (or has already bound — an existing
   * durable pair reads back as accepted).
   */
  acceptedByReference: Map<string, string>;
  /** References whose match violates GLOBAL one-to-one cardinality (fail closed). */
  ambiguousReferenceIds: string[];
  /** References whose match contradicts an existing durable binding on either side (fail closed). */
  conflictingReferenceIds: string[];
}

/**
 * The durable linker's bilateral uniqueness/existing-binding rules, applied
 * at READ time (DISC-SCR-017). A scoped reference resolves to an identity
 * only when the durable linker would bind the same pair:
 *
 *  - exact confirmed provider-id equality with GLOBAL one-to-one
 *    cardinality in BOTH directions: the reference is matched by exactly one
 *    ACTIVE identity, and that identity is matched by exactly this one
 *    reference anywhere (inverse ambiguity outside the local scope fails
 *    closed too);
 *  - compatible existing bindings on both sides: the identity must not be
 *    durably linked to a DIFFERENT reference (the same one is the
 *    idempotent durable binding, which reads resolve), and the reference
 *    must not be durably held by a DIFFERENT identity.
 *
 * Nothing is written: ambiguous and conflicting references stay unresolved
 * and no stored link changes. Unmatched references (no verified match at
 * all) are simply absent from every verdict list, mirroring the scoped
 * reader's shape.
 */
export async function bilaterallyVerifiedReferenceNodes(
  db: Queryable,
  scope: { referenceIds: readonly string[] },
): Promise<BilateralReferenceNodeVerdict> {
  const referenceIds = [...new Set(scope.referenceIds)];
  const verdict: BilateralReferenceNodeVerdict = {
    acceptedByReference: new Map(),
    ambiguousReferenceIds: [],
    conflictingReferenceIds: [],
  };
  if (referenceIds.length === 0) return verdict;

  const nodesPerReference = await verifiedReferenceNodeMatches(db, { referenceIds });
  const nodeIds = [...new Set([...nodesPerReference.values()].flat())];
  const refsPerNode =
    nodeIds.length > 0 ? await verifiedNodeReferenceMatches(db, { nodeIds }) : new Map<string, string[]>();
  // Existing durable bindings on both sides (the linker's competing checks).
  const { rows: boundNodes } = await db.query<{ id: string; cultural_reference_id: string | null }>(
    'SELECT id, cultural_reference_id FROM graph_nodes WHERE id = ANY($1::uuid[])',
    [nodeIds],
  );
  const bindingByNode = new Map(boundNodes.map((r) => [r.id, r.cultural_reference_id]));
  const { rows: holderRows } = await db.query<{ cultural_reference_id: string; id: string }>(
    'SELECT cultural_reference_id, id FROM graph_nodes WHERE cultural_reference_id = ANY($1::uuid[])',
    [referenceIds],
  );
  const holdersByReference = new Map<string, Set<string>>();
  for (const row of holderRows) {
    const holders = holdersByReference.get(row.cultural_reference_id) ?? new Set<string>();
    holders.add(row.id);
    holdersByReference.set(row.cultural_reference_id, holders);
  }

  for (const referenceId of referenceIds) {
    const nodes = nodesPerReference.get(referenceId) ?? [];
    if (nodes.length === 0) continue; // no verified match: unresolved, never counted
    if (nodes.length > 1) {
      verdict.ambiguousReferenceIds.push(referenceId);
      continue;
    }
    const nodeId = nodes[0]!;
    const refs = refsPerNode.get(nodeId) ?? [];
    // Global one-to-one cardinality in BOTH directions: the identity must
    // be matched by exactly this reference (and no other reference anywhere).
    if (refs.length !== 1 || refs[0] !== referenceId) {
      verdict.ambiguousReferenceIds.push(referenceId);
      continue;
    }
    // Compatible existing bindings, node side: a DIFFERENT durable reference
    // competes (the same one is the idempotent binding reads may resolve).
    const binding = bindingByNode.get(nodeId) ?? null;
    if (binding != null && binding !== referenceId) {
      verdict.conflictingReferenceIds.push(referenceId);
      continue;
    }
    // Compatible existing bindings, reference side: a durable holder that is
    // a DIFFERENT identity competes.
    const holders = holdersByReference.get(referenceId);
    if (holders && [...holders].some((id) => id !== nodeId)) {
      verdict.conflictingReferenceIds.push(referenceId);
      continue;
    }
    verdict.acceptedByReference.set(referenceId, nodeId);
  }
  return verdict;
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
