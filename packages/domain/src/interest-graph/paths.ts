import type { Queryable } from '../db/pool';
import {
  GRAPH_PATH_GRAMMAR_VERSION,
  matchApprovedPathTemplate,
  renderPathReason,
  type GraphPathEdgeSummary,
  type NodePolicySummary,
  type PathRejection,
} from './assertion-policy';
import { loadNodePolicySummaries } from './evidence';
import { currentAssertionJustification } from './validity';
import type { GraphAssertionRow } from './schema';

/**
 * The approved path grammar's database validator (VAL-EVID-002): given a
 * root, a candidate and the assertion edges of a walked two-hop path, only an
 * APPROVED template composition validates — two valid edges alone never
 * establish a composed claim. Every edge must also be currently justified
 * (validated status with currently-valid family-deduped evidence), every
 * endpoint identity must be active, and the rendered reason comes from the
 * template's own bounded meaning, never from the walk.
 *
 * Expansion/discovery (later PR 8 slices) use this as the single admission
 * rule for composed connections; single-edge connections use
 * `currentAssertionJustification` directly.
 */

export interface ValidatedGraphPath {
  templateKey: string;
  meaning: string;
  grammarVersion: string;
  /** Rendered reason from the template (never claims identity/influence/resemblance). */
  reason: string;
  rootNodeId: string;
  candidateNodeId: string;
  midNodeId: string;
  /** The walked edges in root→candidate order. */
  assertionIds: string[];
  associationSubtype: string | null;
}

export interface GraphPathValidation {
  path?: ValidatedGraphPath;
  rejection?: PathRejection;
}

interface Walk {
  ordered: [GraphAssertionRow, GraphAssertionRow];
  directions: ['forward' | 'reverse', 'forward' | 'reverse'];
  midNodeId: string;
}

/**
 * Orders the two edges into a root→candidate walk. Both orderings are tried
 * deterministically; an edge is walked from its near endpoint (root) to its
 * far endpoint, and the second edge must continue from that far endpoint to
 * the candidate. `direction` is how the stored subject→object assertion is
 * being walked: forward (near = subject) or reverse (near = object).
 */
function orderWalk(rootNodeId: string, candidateNodeId: string, edges: [GraphAssertionRow, GraphAssertionRow]): Walk | null {
  for (const pair of [
    [edges[0], edges[1]],
    [edges[1], edges[0]],
  ] as const) {
    const [first, second] = pair;
    let direction0: 'forward' | 'reverse';
    let far0: string;
    if (first.subject_node_id === rootNodeId) {
      direction0 = 'forward';
      far0 = first.object_node_id;
    } else if (first.object_node_id === rootNodeId) {
      direction0 = 'reverse';
      far0 = first.subject_node_id;
    } else {
      continue;
    }
    let direction1: 'forward' | 'reverse';
    let far1: string;
    if (second.subject_node_id === far0) {
      direction1 = 'forward';
      far1 = second.object_node_id;
    } else if (second.object_node_id === far0) {
      direction1 = 'reverse';
      far1 = second.subject_node_id;
    } else {
      continue;
    }
    if (far1 !== candidateNodeId) continue;
    return { ordered: [first, second], directions: [direction0, direction1], midNodeId: far0 };
  }
  return null;
}

/**
 * Validates a walked two-hop path against the approved path grammar. The
 * checks run in a fixed order so rejection codes are deterministic:
 * wrong_length → missing_edge → disconnected → ambiguous_identity →
 * template rules (unsupported composition / direction / nontransitivity /
 * subtype / kinds / domain scope) → per-edge current justification.
 */
export async function validateGraphPath(
  db: Queryable,
  input: { rootNodeId: string; candidateNodeId: string; assertionIds: readonly string[]; at?: Date },
): Promise<GraphPathValidation> {
  const rejection = (code: PathRejection['code'], message: string): GraphPathValidation => ({
    rejection: { code, message },
  });
  if (input.assertionIds.length !== 2) {
    return rejection('wrong_length', 'An approved composed path is exactly two edges.');
  }
  if (input.rootNodeId === input.candidateNodeId) {
    return rejection('disconnected', 'A composed path connects two distinct nodes.');
  }
  const assertionRows = await db.query<GraphAssertionRow>(
    `SELECT id, subject_node_id, predicate, object_node_id, association_subtype, status, revision,
            valid_from, invalidated_at, recorded_at, superseded_at, created_at, updated_at
       FROM graph_assertions WHERE id = ANY($1::uuid[])`,
    [input.assertionIds],
  );
  const byId = new Map(assertionRows.rows.map((r) => [r.id, r]));
  const firstId = input.assertionIds[0];
  const secondId = input.assertionIds[1];
  const orderedInput: [GraphAssertionRow, GraphAssertionRow] | null =
    firstId != null && secondId != null && byId.has(firstId) && byId.has(secondId)
      ? [byId.get(firstId)!, byId.get(secondId)!]
      : null;
  if (!orderedInput) {
    return rejection('missing_edge', 'A walked edge assertion does not exist.');
  }
  const walk = orderWalk(input.rootNodeId, input.candidateNodeId, orderedInput);
  if (!walk) {
    return rejection('disconnected', 'The given edges do not form a walk from the root to the candidate.');
  }

  const nodeIds = [
    input.rootNodeId,
    input.candidateNodeId,
    walk.midNodeId,
    ...walk.ordered.flatMap((edge) => [edge.subject_node_id, edge.object_node_id]),
  ];
  // Sequential awaits: `Queryable` may be a single transaction client, and
  // parallel queries on one client strand its queue on failure.
  const summaries = await loadNodePolicySummaries(db, nodeIds);
  const nodes = await db.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name FROM graph_nodes WHERE id = ANY($1::uuid[])`,
    [nodeIds],
  );
  const nodeNames = new Map(nodes.rows.map((r) => [r.id, r.canonical_name]));
  const summaryOf = (id: string): NodePolicySummary | undefined => summaries.get(id);

  const root = summaryOf(input.rootNodeId);
  const candidate = summaryOf(input.candidateNodeId);
  const mid = summaryOf(walk.midNodeId);
  if (!root || !candidate || !mid) {
    return rejection('missing_edge', 'A walked node does not exist.');
  }

  const edgeSummaries: [GraphPathEdgeSummary, GraphPathEdgeSummary] = [
    {
      predicate: walk.ordered[0].predicate,
      direction: walk.directions[0],
      associationSubtype: walk.ordered[0].association_subtype,
      subject: summaryOf(walk.ordered[0].subject_node_id)!,
      object: summaryOf(walk.ordered[0].object_node_id)!,
    },
    {
      predicate: walk.ordered[1].predicate,
      direction: walk.directions[1],
      associationSubtype: walk.ordered[1].association_subtype,
      subject: summaryOf(walk.ordered[1].subject_node_id)!,
      object: summaryOf(walk.ordered[1].object_node_id)!,
    },
  ];

  const match = matchApprovedPathTemplate(root, edgeSummaries, candidate, mid);
  if ('rejection' in match) return { rejection: match.rejection };

  // Only a structurally approved composition earns the justification check:
  // an unjustified edge inside an approved shape is the one case where the
  // edges' current validity decides the verdict.
  for (const edge of walk.ordered) {
    const justification = await currentAssertionJustification(db, { assertionId: edge.id, at: input.at });
    if (!justification.justified) {
      return rejection(
        'edge_unjustified',
        `A path edge is not currently justified (${justification.rejection ?? 'no_valid_support'}); unvalidated or disputed claims never justify a factual reason.`,
      );
    }
  }

  return {
    path: {
      templateKey: match.template.key,
      meaning: match.template.meaning,
      grammarVersion: GRAPH_PATH_GRAMMAR_VERSION,
      reason: renderPathReason(match.template, {
        root: nodeNames.get(input.rootNodeId) ?? '',
        candidate: nodeNames.get(input.candidateNodeId) ?? '',
        mid: nodeNames.get(walk.midNodeId) ?? '',
        subtype: edgeSummaries[0].associationSubtype ?? undefined,
      }),
      rootNodeId: input.rootNodeId,
      candidateNodeId: input.candidateNodeId,
      midNodeId: walk.midNodeId,
      assertionIds: walk.ordered.map((edge) => edge.id),
      associationSubtype: edgeSummaries[0].associationSubtype,
    },
  };
}
