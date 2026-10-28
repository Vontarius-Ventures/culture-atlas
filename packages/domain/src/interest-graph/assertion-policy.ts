import type { GraphNodeDomain, GraphNodeKind, GraphPredicate } from './schema';

/**
 * Predicate and identity specificity (VAL-EVID-002): the pure, database-free
 * policy layer for the shared assertion set and the approved path grammar.
 *
 * This module is deliberately PURE: it decides over node summaries only, so
 * the typed admission writers (`upsertGraphAssertion`), the path validator
 * (`paths.ts`), the justification layer (`validity.ts`) and the research
 * proposal gate all share ONE definition of what an admitted assertion and an
 * approved composed path are. A name never establishes identity, a
 * brand-scoped property never establishes product-scoped evidence, generic
 * RELATED_TO is not an admitted predicate at all, and two valid edges alone
 * never establish a valid composed claim — only the reviewed templates below
 * do, each with its own bounded meaning that never claims identity, influence
 * or resemblance.
 */

/** Version of the approved path grammar (two-hop composition templates). */
export const GRAPH_PATH_GRAMMAR_VERSION = 'path-grammar-1';

// --- Node summaries -----------------------------------------------------------------

export type GraphNodeStatus = 'active' | 'ambiguous' | 'merged' | 'retired';

/** The identity facts every endpoint rule needs; nothing else. */
export interface NodePolicySummary {
  nodeKind: GraphNodeKind;
  domain: GraphNodeDomain;
  senseKey: string;
  status: GraphNodeStatus;
}

// --- Predicate endpoint/scope policy -------------------------------------------------

export interface PredicateEndpointPolicy {
  /** Kinds that may appear as the assertion subject. */
  subjectKinds: readonly GraphNodeKind[];
  /** Kinds that may appear as the assertion object. */
  objectKinds: readonly GraphNodeKind[];
  /** `same_domain` requires subject and object of one domain; `cross_domain` admits documented cross-domain endpoints (associates, audiences). */
  domainScope: 'same_domain' | 'cross_domain';
  /** DOCUMENTED_ASSOCIATION requires its named subtype; every other predicate forbids one. */
  requiresSubtype: boolean;
  /** ABOUT requires at least one currently valid supporting evidence row of kind `subject_matter`. */
  requiresSubjectMatterSupport: boolean;
  /** Claims an explanation built from this predicate must never make (enforced by the reviewed reason templates). */
  neverRendersAs: readonly string[];
}

/**
 * PR 8 predicate policy v1. `brand` is deliberately NOT an admitted subject
 * for any predicate: brand-scoped properties must not masquerade as
 * product/work facts, and no approved path composes through a brand midpoint.
 */
export const PREDICATE_ENDPOINT_POLICY: Record<GraphPredicate, PredicateEndpointPolicy> = {
  CREATED_BY: {
    subjectKinds: ['work', 'object'],
    objectKinds: ['creator'],
    domainScope: 'same_domain',
    requiresSubtype: false,
    requiresSubjectMatterSupport: false,
    neverRendersAs: [],
  },
  ABOUT: {
    subjectKinds: ['work', 'object'],
    objectKinds: ['creator', 'place', 'style', 'tradition', 'cuisine', 'work', 'object'],
    domainScope: 'same_domain',
    requiresSubtype: false,
    // "ABOUT requires subject support": a plain factual passage never
    // establishes what a work is about.
    requiresSubjectMatterSupport: true,
    neverRendersAs: [],
  },
  USES_TECHNIQUE: {
    subjectKinds: ['work', 'object'],
    objectKinds: ['technique'],
    domainScope: 'same_domain',
    requiresSubtype: false,
    requiresSubjectMatterSupport: false,
    neverRendersAs: [],
  },
  HAS_ATTRIBUTE: {
    subjectKinds: ['work', 'object'],
    objectKinds: ['attribute'],
    domainScope: 'same_domain',
    requiresSubtype: false,
    requiresSubjectMatterSupport: false,
    neverRendersAs: ['identity'],
  },
  DOCUMENTED_ASSOCIATION: {
    subjectKinds: ['work', 'object', 'creator', 'style', 'tradition', 'place'],
    objectKinds: ['place', 'work', 'object', 'creator', 'style', 'tradition'],
    // A documented associate (a museum, a school) legitimately spans domains;
    // the association subtype states exactly what is documented.
    domainScope: 'cross_domain',
    requiresSubtype: true,
    requiresSubjectMatterSupport: false,
    neverRendersAs: ['association_between_the_two_works'],
  },
  AUDIENCE_AFFINITY: {
    subjectKinds: ['audience'],
    objectKinds: ['work', 'object', 'creator', 'style', 'tradition', 'cuisine'],
    // An audience segment legitimately spans domains, but provider-qualified
    // affinity must never render as shared visual style or documented
    // historical influence.
    domainScope: 'cross_domain',
    requiresSubtype: false,
    requiresSubjectMatterSupport: false,
    neverRendersAs: ['visual_resemblance', 'historical_influence'],
  },
};

export type AssertionEndpointRejectionCode =
  | 'unadmitted_predicate'
  | 'endpoint_kind'
  | 'endpoint_domain'
  | 'ambiguous_identity'
  | 'predicate_subtype';

export interface AssertionEndpointRejection {
  code: AssertionEndpointRejectionCode;
  message: string;
}

export interface AssertionEndpointCheck {
  valid: boolean;
  rejection: AssertionEndpointRejection | null;
}

/**
 * The predicate-specific endpoint/scope rules for one candidate assertion.
 * A wrong subject/object kind, a wrong domain scope, a missing/forbidden
 * DOCUMENTED_ASSOCIATION subtype and any non-active (ambiguous, merged,
 * retired) endpoint each reject with their own typed rule — ambiguous
 * same-name identities never justify facts.
 */
export function checkAssertionEndpoints(
  subject: NodePolicySummary,
  predicate: GraphPredicate,
  object: NodePolicySummary,
  associationSubtype: string | null | undefined,
): AssertionEndpointCheck {
  const policy = PREDICATE_ENDPOINT_POLICY[predicate];
  const reject = (code: AssertionEndpointRejectionCode, message: string): AssertionEndpointCheck => ({
    valid: false,
    rejection: { code, message },
  });
  if (!policy) {
    // Defense in depth: the typed predicate set already excludes this, and
    // the database CHECK refuses it too. A generic RELATED_TO can never
    // justify a factual explanation.
    return reject(
      'unadmitted_predicate',
      `${String(predicate)} is not an admitted predicate; only the PR 8 predicate policy set may justify a factual explanation.`,
    );
  }
  if (subject.status !== 'active' || object.status !== 'active') {
    return reject(
      'ambiguous_identity',
      'Ambiguous, merged or retired identities cannot be assertion endpoints; a name never justifies a fact.',
    );
  }
  if (policy.requiresSubtype !== (associationSubtype != null)) {
    return reject(
      'predicate_subtype',
      policy.requiresSubtype
        ? 'DOCUMENTED_ASSOCIATION requires its named subtype.'
        : 'Only DOCUMENTED_ASSOCIATION carries an association subtype.',
    );
  }
  if (!policy.subjectKinds.includes(subject.nodeKind)) {
    return reject(
      'endpoint_kind',
      `A ${subject.nodeKind} node cannot be the subject of ${predicate} (permitted: ${policy.subjectKinds.join(', ')}).`,
    );
  }
  if (!policy.objectKinds.includes(object.nodeKind)) {
    return reject(
      'endpoint_kind',
      `A ${object.nodeKind} node cannot be the object of ${predicate} (permitted: ${policy.objectKinds.join(', ')}).`,
    );
  }
  if (policy.domainScope === 'same_domain' && subject.domain !== object.domain) {
    return reject(
      'endpoint_domain',
      `${predicate} is domain-scoped: ${subject.domain} evidence cannot justify a ${object.domain} endpoint.`,
    );
  }
  return { valid: true, rejection: null };
}

// --- Approved path grammar -----------------------------------------------------------

export type PathDirection = 'forward' | 'reverse';

/** One edge of a candidate walk, summarized for the pure matcher. */
export interface GraphPathEdgeSummary {
  predicate: GraphPredicate;
  /** Direction of this edge along the root→candidate walk. */
  direction: PathDirection;
  associationSubtype: string | null;
  subject: NodePolicySummary;
  object: NodePolicySummary;
}

export interface ApprovedPathTemplate {
  /** Stable template key (e.g. `same_creator`). */
  key: string;
  /** The bounded meaning the composition asserts; never identity, influence or resemblance. */
  meaning: string;
  edges: readonly [{ predicate: GraphPredicate; direction: PathDirection }, { predicate: GraphPredicate; direction: PathDirection }];
  midKinds: readonly GraphNodeKind[];
  rootKinds: readonly GraphNodeKind[];
  candidateKinds: readonly GraphNodeKind[];
  domainScope: 'same_domain' | 'cross_domain';
  /** Both DOCUMENTED_ASSOCIATION edges must carry the same subtype. */
  requireSameSubtype: boolean;
  /** Reason template with {root}/{mid}/{candidate}/{subtype} placeholders. */
  reasonTemplate: string;
}

const WORK_ROOTS: readonly GraphNodeKind[] = ['work', 'object'];

/**
 * The approved two-hop composition templates (PR 8 §9 reviewed path
 * templates). A graph path is NOT automatically transitive: these are the
 * ONLY admitted compositions, each converging on a shared midpoint, and each
 * rendering its own bounded meaning. Chained use of DOCUMENTED_ASSOCIATION or
 * AUDIENCE_AFFINITY (edge0 forward AND edge1 forward) is rejected as
 * non-transitive; shared creator/subject/technique/attribute never implies
 * identity, influence or resemblance.
 */
export const APPROVED_PATH_TEMPLATES: readonly ApprovedPathTemplate[] = [
  {
    key: 'same_creator',
    meaning: 'shared_creator',
    edges: [{ predicate: 'CREATED_BY', direction: 'forward' }, { predicate: 'CREATED_BY', direction: 'reverse' }],
    midKinds: ['creator'],
    rootKinds: WORK_ROOTS,
    candidateKinds: WORK_ROOTS,
    domainScope: 'same_domain',
    requireSameSubtype: false,
    reasonTemplate: 'By the same creator ({mid})',
  },
  {
    key: 'shared_subject',
    meaning: 'shared_subject',
    edges: [{ predicate: 'ABOUT', direction: 'forward' }, { predicate: 'ABOUT', direction: 'reverse' }],
    midKinds: ['creator', 'place', 'style', 'tradition', 'cuisine', 'work', 'object'],
    rootKinds: WORK_ROOTS,
    candidateKinds: WORK_ROOTS,
    domainScope: 'same_domain',
    requireSameSubtype: false,
    reasonTemplate: 'About the same subject ({mid})',
  },
  {
    key: 'shared_technique',
    meaning: 'shared_technique',
    edges: [{ predicate: 'USES_TECHNIQUE', direction: 'forward' }, { predicate: 'USES_TECHNIQUE', direction: 'reverse' }],
    midKinds: ['technique'],
    rootKinds: WORK_ROOTS,
    candidateKinds: WORK_ROOTS,
    domainScope: 'same_domain',
    requireSameSubtype: false,
    reasonTemplate: 'Made using the same technique ({mid})',
  },
  {
    key: 'shared_attribute',
    meaning: 'shared_attribute',
    edges: [{ predicate: 'HAS_ATTRIBUTE', direction: 'forward' }, { predicate: 'HAS_ATTRIBUTE', direction: 'reverse' }],
    midKinds: ['attribute'],
    rootKinds: WORK_ROOTS,
    candidateKinds: WORK_ROOTS,
    domainScope: 'same_domain',
    requireSameSubtype: false,
    reasonTemplate: 'Shares the attribute {mid}',
  },
  {
    key: 'co_documented_association',
    meaning: 'co_documented_association',
    edges: [
      { predicate: 'DOCUMENTED_ASSOCIATION', direction: 'forward' },
      { predicate: 'DOCUMENTED_ASSOCIATION', direction: 'reverse' },
    ],
    midKinds: ['place', 'work', 'object', 'creator', 'style', 'tradition'],
    rootKinds: ['work', 'object', 'creator', 'style', 'tradition', 'place'],
    candidateKinds: ['work', 'object', 'creator', 'style', 'tradition', 'place'],
    // Co-association through a shared associate is documented and cross-domain
    // (works of different domains share museums); it states "both {subtype}
    // {associate}", NEVER an association between the root and the candidate.
    domainScope: 'cross_domain',
    requireSameSubtype: true,
    reasonTemplate: 'Also {subtype} {mid}',
  },
  {
    key: 'shared_audience',
    meaning: 'shared_audience',
    edges: [
      { predicate: 'AUDIENCE_AFFINITY', direction: 'reverse' },
      { predicate: 'AUDIENCE_AFFINITY', direction: 'forward' },
    ],
    midKinds: ['audience'],
    rootKinds: ['work', 'object', 'creator', 'style', 'tradition', 'cuisine'],
    candidateKinds: ['work', 'object', 'creator', 'style', 'tradition', 'cuisine'],
    // Provider-qualified audience affinity spans domains; it renders as appeal
    // to the same audience, never as visual style or historical influence.
    domainScope: 'cross_domain',
    requireSameSubtype: false,
    reasonTemplate: 'Appeals to the same audience ({mid})',
  },
];

export const PATH_REJECTION_CODES = [
  'wrong_length',
  'missing_edge',
  'disconnected',
  'ambiguous_identity',
  'unsupported_composition',
  'wrong_direction',
  'nontransitive',
  'subtype_mismatch',
  'endpoint_kind',
  'scope_mismatch',
  'edge_unjustified',
] as const;
export type PathRejectionCode = (typeof PATH_REJECTION_CODES)[number];

export interface PathRejection {
  code: PathRejectionCode;
  message: string;
}

export interface ApprovedPathMatch {
  template: ApprovedPathTemplate;
}

/**
 * Matches one walked root→candidate edge pair against the approved templates.
 * The check order is structural first (predicate sequence, direction, subtype,
 * endpoint kinds, domain scope), so two valid edges of an unapproved sequence
 * reject as an unsupported composition before anything else is consulted.
 */
export function matchApprovedPathTemplate(
  root: NodePolicySummary,
  edges: readonly [GraphPathEdgeSummary, GraphPathEdgeSummary],
  candidate: NodePolicySummary,
  mid: NodePolicySummary,
): ApprovedPathMatch | { rejection: PathRejection } {
  const reject = (code: PathRejectionCode, message: string): { rejection: PathRejection } => ({
    rejection: { code, message },
  });
  if (root.status !== 'active' || candidate.status !== 'active' || mid.status !== 'active') {
    return reject('ambiguous_identity', 'A path through an ambiguous, merged or retired identity never justifies a claim.');
  }
  const samePredicates = APPROVED_PATH_TEMPLATES.filter(
    (t) => t.edges[0].predicate === edges[0].predicate && t.edges[1].predicate === edges[1].predicate,
  );
  if (samePredicates.length === 0) {
    return reject(
      'unsupported_composition',
      'No approved path template composes this predicate sequence: two valid edges alone do not establish a composed claim.',
    );
  }
  const directional = samePredicates.filter(
    (t) => t.edges[0].direction === edges[0].direction && t.edges[1].direction === edges[1].direction,
  );
  if (directional.length === 0) {
    // The predicate pair is composable but not this way. Documented
    // association and audience affinity are NOT transitive; every other
    // reversal is a wrong-direction use of a stored edge.
    if (edges[0].predicate === 'DOCUMENTED_ASSOCIATION' || edges[0].predicate === 'AUDIENCE_AFFINITY') {
      return reject(
        'nontransitive',
        `${edges[0].predicate} is not transitive: it composes only as the reviewed shared-midpoint template.`,
      );
    }
    return reject('wrong_direction', 'A stored edge cannot be walked backwards against its admitted direction.');
  }
  for (const template of directional) {
    if (
      template.requireSameSubtype &&
      (edges[0].associationSubtype === null ||
        edges[1].associationSubtype === null ||
        edges[0].associationSubtype !== edges[1].associationSubtype)
    ) {
      return reject('subtype_mismatch', 'A documented-association composition requires the same named subtype on both edges.');
    }
    if (
      !template.midKinds.includes(mid.nodeKind) ||
      !template.rootKinds.includes(root.nodeKind) ||
      !template.candidateKinds.includes(candidate.nodeKind)
    ) {
      return reject('endpoint_kind', `The ${template.key} composition does not admit these endpoint kinds.`);
    }
    if (template.domainScope === 'same_domain' && (root.domain !== mid.domain || candidate.domain !== mid.domain)) {
      return reject('scope_mismatch', `The ${template.key} composition is domain-scoped.`);
    }
    return { template };
  }
  return reject('unsupported_composition', 'No approved path template matches this walk.');
}

/** The approved template carrying a given meaning, or null when none does. */
export function templateForMeaning(meaning: string): ApprovedPathTemplate | null {
  return APPROVED_PATH_TEMPLATES.find((t) => t.meaning === meaning) ?? null;
}

/**
 * Renders a template's bounded reason. The template text is the ONLY source
 * of claim wording — callers substitute names, never predicates — so no
 * approved reason can claim identity, influence or resemblance.
 */
export function renderPathReason(
  template: ApprovedPathTemplate,
  names: { root?: string; mid?: string; candidate?: string; subtype?: string },
): string {
  return template.reasonTemplate
    .replace('{subtype}', names.subtype ? names.subtype.replace(/_/g, ' ') : '')
    .replace('{root}', names.root ?? '')
    .replace('{mid}', names.mid ?? '')
    .replace('{candidate}', names.candidate ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
