import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../db/pool';
import { closeTestDb, getTestDb } from '../testing';
import type { GraphNodeDomain, GraphNodeKind } from './schema';
import { attachAssertionSupport, insertEvidence, recordSourceRevision, upsertGraphAssertion, upsertGraphIdentity } from './evidence';
import {
  APPROVED_PATH_TEMPLATES,
  checkAssertionEndpoints,
  GRAPH_PATH_GRAMMAR_VERSION,
  matchApprovedPathTemplate,
  renderPathReason,
  templateForMeaning,
  type GraphPathEdgeSummary,
  type NodePolicySummary,
} from './assertion-policy';
import { validateGraphPath } from './paths';

/**
 * VAL-EVID-002: predicate and identity specificity. Admitted CREATED_BY,
 * ABOUT, USES_TECHNIQUE, HAS_ATTRIBUTE, DOCUMENTED_ASSOCIATION and
 * AUDIENCE_AFFINITY assertions obey endpoint/scope rules; documented
 * association requires its subtype and ABOUT requires subject support. The
 * approved path grammar explicitly constrains predicate sequence, direction,
 * endpoint kinds/scopes and permitted composition, so two valid edges alone
 * never establish a valid composed claim. Shared creator, subject, technique
 * or attribute never implies identity, influence or resemblance; documented
 * association and audience affinity are not arbitrarily transitive. Ambiguous
 * same-name identities, brand-to-product evidence substitution, generic
 * RELATED_TO, model confidence and unvalidated/disputed claims cannot justify
 * factual reasons.
 */

const db = getTestDb();
afterAll(closeTestDb);

// --- Fixtures -----------------------------------------------------------------

async function identity(
  dbh: Queryable,
  over: { key?: string; name?: string; kind?: GraphNodeKind; domain?: GraphNodeDomain; sense?: string } = {},
) {
  const key = over.key ?? `atlas:${randomUUID()}`;
  return upsertGraphIdentity(dbh, {
    canonicalKey: key,
    canonicalName: over.name ?? `Identity ${key.slice(-8)}`,
    nodeKind: over.kind ?? 'creator',
    domain: over.domain ?? 'art',
    senseKey: over.sense ?? 'person',
  });
}

async function reviewedSource(dbh: Queryable, over: { family?: string; url?: string } = {}) {
  const family = over.family ?? `artic:${randomUUID()}`;
  return recordSourceRevision(dbh, {
    provider: 'artic_open_access',
    url: over.url ?? `https://www.artic.edu/artworks/${randomUUID().slice(0, 8)}`,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { provider: 'artic_open_access', title: 'A reviewed collection record', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
    documentHash: randomUUID(),
  }).then((recorded) => ({ ...recorded, familyKey: family }));
}

/** A validated, currently justified assertion with one reviewed supporting family. */
async function validatedAssertion(
  dbh: Queryable,
  input: {
    subject: Awaited<ReturnType<typeof identity>>;
    predicate: 'CREATED_BY' | 'ABOUT' | 'USES_TECHNIQUE' | 'HAS_ATTRIBUTE' | 'DOCUMENTED_ASSOCIATION' | 'AUDIENCE_AFFINITY';
    object: Awaited<ReturnType<typeof identity>>;
    associationSubtype?: string | null;
    evidenceKind?: 'fact' | 'subject_matter' | 'audience' | 'visual';
  },
) {
  const upserted = await upsertGraphAssertion(dbh, {
    subjectNodeId: input.subject.id,
    predicate: input.predicate,
    objectNodeId: input.object.id,
    associationSubtype: input.associationSubtype ?? null,
    status: 'validated',
  });
  const source = await reviewedSource(dbh);
  const evidence = await insertEvidence(dbh, {
    sourceRevisionId: source.sourceRevisionId,
    permittedExcerpt: `Reviewed support for ${input.predicate}.`,
    validationMethod: 'provider_metadata',
    validationVersion: 'test-1',
    evidenceKind: input.evidenceKind ?? 'fact',
    reviewedBy: 'corpus review',
    reviewedAt: new Date('2026-10-28T00:00:00Z'),
  });
  await attachAssertionSupport(dbh, {
    assertionId: upserted.row.id,
    evidenceId: evidence.row.id,
    derivation: 'primary',
    sourceFamilyKey: source.familyKey,
  });
  return upserted.row;
}

function summary(node: Awaited<ReturnType<typeof identity>>): NodePolicySummary {
  return { nodeKind: node.node_kind, domain: node.domain, senseKey: node.sense_key, status: node.status };
}

// --- Predicate endpoint and scope rules ----------------------------------------------

describe('predicate endpoint and scope rules (VAL-EVID-002)', () => {
  it('admits the reviewed pilot shapes: work→creator, work→technique, work→attribute, work⇄place association, audience→work', async () => {
    const work = await identity(db, { kind: 'work', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', sense: 'painter' });
    const technique = await identity(db, { kind: 'technique', sense: 'painting medium' });
    const attribute = await identity(db, { kind: 'attribute', sense: 'art movement' });
    const place = await identity(db, { kind: 'place', sense: 'museum' });
    const audience = await identity(db, { kind: 'audience', sense: 'audience segment' });

    expect(checkAssertionEndpoints(summary(work), 'CREATED_BY', summary(creator), null).valid).toBe(true);
    expect(checkAssertionEndpoints(summary(work), 'USES_TECHNIQUE', summary(technique), null).valid).toBe(true);
    expect(checkAssertionEndpoints(summary(work), 'HAS_ATTRIBUTE', summary(attribute), null).valid).toBe(true);
    expect(checkAssertionEndpoints(summary(work), 'DOCUMENTED_ASSOCIATION', summary(place), 'on_display_at').valid).toBe(true);
    expect(checkAssertionEndpoints(summary(audience), 'AUDIENCE_AFFINITY', summary(work), null).valid).toBe(true);
    expect(checkAssertionEndpoints(summary(work), 'ABOUT', summary(creator), null).valid).toBe(true);
  });

  it('rejects wrong endpoint kinds and wrong domain scope with typed rules', async () => {
    const work = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });
    const sculptureCreator = await identity(db, { kind: 'creator', domain: 'sculpture', sense: 'sculptor' });
    const technique = await identity(db, { kind: 'technique', domain: 'art', sense: 'painting medium' });
    const attribute = await identity(db, { kind: 'attribute', domain: 'art', sense: 'art movement' });
    const audience = await identity(db, { kind: 'audience', domain: 'art', sense: 'audience segment' });

    // Reversed endpoints: a creator does not create a work as its object.
    expect(checkAssertionEndpoints(summary(creator), 'CREATED_BY', summary(work), null)).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_kind' },
    });
    // A technique is not a valid HAS_ATTRIBUTE object; an attribute never creates.
    expect(checkAssertionEndpoints(summary(work), 'HAS_ATTRIBUTE', summary(technique), null)).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_kind' },
    });
    expect(checkAssertionEndpoints(summary(attribute), 'CREATED_BY', summary(work), null)).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_kind' },
    });
    // Audience affinity is asserted about the audience, not by a work.
    expect(checkAssertionEndpoints(summary(work), 'AUDIENCE_AFFINITY', summary(audience), null)).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_kind' },
    });
    // Domain scope: a sculpture-domain creator cannot justify an art-domain work.
    expect(checkAssertionEndpoints(summary(work), 'CREATED_BY', summary(sculptureCreator), null)).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_domain' },
    });
  });

  it('enforces the endpoint rules at assertion admission, including the DOCUMENTED_ASSOCIATION subtype', async () => {
    const work = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'sculpture', sense: 'sculptor' });
    const place = await identity(db, { kind: 'place', domain: 'art', sense: 'museum' });

    // The typed admission writer refuses a wrong-scope CREATED_BY assertion.
    await expect(
      upsertGraphAssertion(db, {
        subjectNodeId: work.id,
        predicate: 'CREATED_BY',
        objectNodeId: creator.id,
        status: 'validated',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { rule: 'endpoint_domain' } });

    // DOCUMENTED_ASSOCIATION without its named subtype cannot be admitted.
    await expect(
      upsertGraphAssertion(db, {
        subjectNodeId: work.id,
        predicate: 'DOCUMENTED_ASSOCIATION',
        objectNodeId: place.id,
        status: 'validated',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { rule: 'predicate_subtype' } });
  });

  it('rejects ambiguous and non-active identities as assertion endpoints: a name never justifies a fact', async () => {
    const name = `Same Name ${randomUUID().slice(0, 8)}`;
    const work = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    // A second same-name creator in the SAME identity slot is impossible (the
    // identity guard rejects it); simulate the ambiguous-review state directly,
    // which is exactly the state an unresolved same-name match leaves behind.
    const ambiguous = await identity(db, { name, kind: 'creator', domain: 'art', sense: 'painter' });
    await db.query(`UPDATE graph_nodes SET status = 'ambiguous' WHERE id = $1`, [ambiguous.id]);

    expect(checkAssertionEndpoints(summary(work), 'CREATED_BY', summary({ ...ambiguous, status: 'ambiguous' }), null)).toMatchObject(
      { valid: false, rejection: { code: 'ambiguous_identity' } },
    );
    await expect(
      upsertGraphAssertion(db, {
        subjectNodeId: work.id,
        predicate: 'CREATED_BY',
        objectNodeId: ambiguous.id,
        status: 'validated',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { rule: 'ambiguous_identity' } });
  });

  it('rejects brand-to-product evidence substitution: brand nodes are not work endpoints', async () => {
    const brand = await identity(db, { kind: 'brand', domain: 'fashion', sense: 'fashion house' });
    const product = await identity(db, { kind: 'work', domain: 'fashion', sense: 'dress' });
    const attribute = await identity(db, { kind: 'attribute', domain: 'fashion', sense: 'design movement' });
    const place = await identity(db, { kind: 'place', domain: 'fashion', sense: 'flagship store' });

    // Brand-scoped properties can never be asserted as product/work facts.
    expect(checkAssertionEndpoints(summary(brand), 'HAS_ATTRIBUTE', summary(attribute), null)).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_kind' },
    });
    expect(checkAssertionEndpoints(summary(brand), 'DOCUMENTED_ASSOCIATION', summary(place), 'headquartered_at')).toMatchObject({
      valid: false,
      rejection: { code: 'endpoint_kind' },
    });
    // And a product cannot inherit the brand's evidence: its own assertion has
    // no support unless independently evidenced.
    await expect(
      upsertGraphAssertion(db, {
        subjectNodeId: brand.id,
        predicate: 'HAS_ATTRIBUTE',
        objectNodeId: attribute.id,
        status: 'validated',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { rule: 'endpoint_kind' } });
    expect(checkAssertionEndpoints(summary(product), 'HAS_ATTRIBUTE', summary(attribute), null).valid).toBe(true);
  });

  it('never admits a generic RELATED_TO predicate', async () => {
    const work = await identity(db, { kind: 'work', sense: 'painting' });
    const other = await identity(db, { kind: 'work', sense: 'painting' });
    // RELATED_TO is not an admitted predicate: the typed enum, the admission
    // writer and the database CHECK all refuse it, so it can never justify a
    // factual explanation.
    expect(checkAssertionEndpoints(summary(work), 'RELATED_TO' as never, summary(other), null)).toMatchObject({
      valid: false,
      rejection: { code: 'unadmitted_predicate' },
    });
    await expect(
      upsertGraphAssertion(db, {
        subjectNodeId: work.id,
        predicate: 'RELATED_TO' as never,
        objectNodeId: other.id,
        status: 'validated',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { rule: 'unadmitted_predicate' } });
  });
});

// --- Approved path grammar ------------------------------------------------------------

describe('approved path grammar (VAL-EVID-002)', () => {
  it('approves the reviewed two-hop templates and renders their own meaning, never identity', async () => {
    const root = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const candidate = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });

    const rootEdge = await validatedAssertion(db, { subject: root, predicate: 'CREATED_BY', object: creator });
    const candidateEdge = await validatedAssertion(db, { subject: candidate, predicate: 'CREATED_BY', object: creator });

    const result = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: candidate.id,
      assertionIds: [rootEdge.id, candidateEdge.id],
    });
    expect(result.rejection).toBeUndefined();
    expect(result.path).toMatchObject({
      templateKey: 'same_creator',
      grammarVersion: GRAPH_PATH_GRAMMAR_VERSION,
      midNodeId: creator.id,
    });
    expect(result.path!.reason).toContain('creator');
    expect(result.path!.reason).toContain(creator.canonical_name);
    // Shared creator does not imply identity, influence or resemblance.
    expect(result.path!.meaning).toBe('shared_creator');
  });

  it('approves a shared-subject path only when the ABOUT edges carry subject-matter support', async () => {
    const root = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const candidate = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const subject = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });

    // Both ABOUT assertions carry only plain factual evidence: no subject-matter
    // support, so the edges are unjustified and the path cannot compose.
    const factRootEdge = await validatedAssertion(db, { subject: root, predicate: 'ABOUT', object: subject, evidenceKind: 'fact' });
    const factCandidateEdge = await validatedAssertion(db, {
      subject: candidate,
      predicate: 'ABOUT',
      object: subject,
      evidenceKind: 'fact',
    });
    const rejected = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: candidate.id,
      assertionIds: [factRootEdge.id, factCandidateEdge.id],
    });
    expect(rejected.path).toBeUndefined();
    expect(rejected.rejection).toMatchObject({ code: 'edge_unjustified' });

    // With reviewed subject-matter evidence the same composition is approved.
    const subjectRootEdge = await validatedAssertion(db, {
      subject: root,
      predicate: 'ABOUT',
      object: subject,
      evidenceKind: 'subject_matter',
    });
    const subjectCandidateEdge = await validatedAssertion(db, {
      subject: candidate,
      predicate: 'ABOUT',
      object: subject,
      evidenceKind: 'subject_matter',
    });
    const approved = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: candidate.id,
      assertionIds: [subjectRootEdge.id, subjectCandidateEdge.id],
    });
    expect(approved.path).toMatchObject({ templateKey: 'shared_subject', midNodeId: subject.id });
    expect(approved.path!.reason).toContain(subject.canonical_name);
  });

  it('rejects reversed-edge composition: a stored edge cannot be walked backwards', async () => {
    const workA = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const workB = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });
    const edgeA = await validatedAssertion(db, { subject: workA, predicate: 'CREATED_BY', object: creator });
    const edgeB = await validatedAssertion(db, { subject: workB, predicate: 'CREATED_BY', object: creator });

    // The stored CREATED_BY edges converge on the creator: starting the walk
    // AT the creator cannot reach the candidate, and the pure grammar rejects
    // a both-backwards walk of a converging predicate.
    const result = await validateGraphPath(db, {
      rootNodeId: creator.id,
      candidateNodeId: workB.id,
      assertionIds: [edgeA.id, edgeB.id],
    });
    expect(result.path).toBeUndefined();
    expect(result.rejection).toMatchObject({ code: 'disconnected' });

    // Directly: the grammar refuses walking either converging predicate
    // forwards-forwards (a stored edge used backwards), and the two
    // non-transitive predicates reject a directional chain by name.
    const work = { nodeKind: 'work', domain: 'art', senseKey: 'painting', status: 'active' } as const;
    const creatorSum = { nodeKind: 'creator', domain: 'art', senseKey: 'painter', status: 'active' } as const;
    const placeSum = { nodeKind: 'place', domain: 'art', senseKey: 'museum', status: 'active' } as const;
    const audienceSum = { nodeKind: 'audience', domain: 'art', senseKey: 'segment', status: 'active' } as const;
    const createdByFwdFwd: [GraphPathEdgeSummary, GraphPathEdgeSummary] = [
      { predicate: 'CREATED_BY', direction: 'forward', associationSubtype: null, subject: work, object: creatorSum },
      { predicate: 'CREATED_BY', direction: 'forward', associationSubtype: null, subject: creatorSum, object: work },
    ];
    expect(matchApprovedPathTemplate(work, createdByFwdFwd, work, creatorSum)).toMatchObject({
      rejection: { code: 'wrong_direction' },
    });
    const associationFwdFwd: [GraphPathEdgeSummary, GraphPathEdgeSummary] = [
      {
        predicate: 'DOCUMENTED_ASSOCIATION',
        direction: 'forward',
        associationSubtype: 'on_display_at',
        subject: work,
        object: placeSum,
      },
      {
        predicate: 'DOCUMENTED_ASSOCIATION',
        direction: 'forward',
        associationSubtype: 'on_display_at',
        subject: placeSum,
        object: work,
      },
    ];
    expect(matchApprovedPathTemplate(work, associationFwdFwd, work, placeSum)).toMatchObject({
      rejection: { code: 'nontransitive' },
    });
    const affinityFwdFwd: [GraphPathEdgeSummary, GraphPathEdgeSummary] = [
      {
        predicate: 'AUDIENCE_AFFINITY',
        direction: 'forward',
        associationSubtype: null,
        subject: audienceSum,
        object: work,
      },
      {
        predicate: 'AUDIENCE_AFFINITY',
        direction: 'forward',
        associationSubtype: null,
        subject: work,
        object: audienceSum,
      },
    ];
    expect(matchApprovedPathTemplate(work, affinityFwdFwd, work, audienceSum)).toMatchObject({
      rejection: { code: 'nontransitive' },
    });
  });

  it('rejects cross-predicate composition: two valid edges alone do not establish a composed claim', async () => {
    const root = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });
    const place = await identity(db, { kind: 'place', domain: 'art', sense: 'school' });

    // Both edges are individually admitted and justified, and the walk IS
    // connected (root —CREATED_BY→ creator —DOCUMENTED_ASSOCIATION→ place):
    // still no approved template composes that predicate sequence.
    const createdBy = await validatedAssertion(db, { subject: root, predicate: 'CREATED_BY', object: creator });
    const studiedAt = await validatedAssertion(db, {
      subject: creator,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: place,
      associationSubtype: 'studied_at',
    });

    const result = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: place.id,
      assertionIds: [createdBy.id, studiedAt.id],
    });
    expect(result.path).toBeUndefined();
    expect(result.rejection).toMatchObject({ code: 'unsupported_composition' });
  });

  it('rejects disconnected walks and wrong path lengths', async () => {
    const root = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const candidate = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });
    const otherCreator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });
    const edgeRoot = await validatedAssertion(db, { subject: root, predicate: 'CREATED_BY', object: creator });
    const edgeCandidate = await validatedAssertion(db, { subject: candidate, predicate: 'CREATED_BY', object: otherCreator });

    const disconnected = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: candidate.id,
      assertionIds: [edgeRoot.id, edgeCandidate.id],
    });
    expect(disconnected.rejection).toMatchObject({ code: 'disconnected' });

    const wrongLength = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: candidate.id,
      assertionIds: [edgeRoot.id],
    });
    expect(wrongLength.rejection).toMatchObject({ code: 'wrong_length' });
  });

  it('treats documented association as non-transitive and renders co-association, never an association between works', async () => {
    const workA = await identity(db, { kind: 'work', domain: 'sculpture', sense: 'bust' });
    const workB = await identity(db, { kind: 'work', domain: 'ceramics', sense: 'vessel' });
    const museum = await identity(db, { kind: 'place', domain: 'art', sense: 'museum' });

    const onDisplayA = await validatedAssertion(db, {
      subject: workA,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: museum,
      associationSubtype: 'on_display_at',
    });
    const onDisplayB = await validatedAssertion(db, {
      subject: workB,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: museum,
      associationSubtype: 'on_display_at',
    });

    // Co-association through the shared place is an approved documented
    // connection, across domains, and renders as "also on display at ...".
    const coAssociated = await validateGraphPath(db, {
      rootNodeId: workA.id,
      candidateNodeId: workB.id,
      assertionIds: [onDisplayA.id, onDisplayB.id],
    });
    expect(coAssociated.path).toMatchObject({ templateKey: 'co_documented_association', midNodeId: museum.id });
    expect(coAssociated.path!.reason).toContain(museum.canonical_name);
    expect(coAssociated.path!.reason.toLowerCase()).toContain('on display at');

    // A chain work → place → place-associate is NOT transitive: documented
    // association never composes into an association between the two works.
    const chainEnd = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const chainEdge = await validatedAssertion(db, {
      subject: museum,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: chainEnd,
      associationSubtype: 'on_display_at',
    });
    const chained = await validateGraphPath(db, {
      rootNodeId: workA.id,
      candidateNodeId: chainEnd.id,
      assertionIds: [onDisplayA.id, chainEdge.id],
    });
    expect(chained.rejection).toMatchObject({ code: 'nontransitive' });
  });

  it('rejects mixed-subtype documented-association composition', async () => {
    const workA = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const workB = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const place = await identity(db, { kind: 'place', domain: 'art', sense: 'museum' });

    const displayedA = await validatedAssertion(db, {
      subject: workA,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: place,
      associationSubtype: 'on_display_at',
    });
    const studiedB = await validatedAssertion(db, {
      subject: workB,
      predicate: 'DOCUMENTED_ASSOCIATION',
      object: place,
      associationSubtype: 'studied_at',
    });

    const result = await validateGraphPath(db, {
      rootNodeId: workA.id,
      candidateNodeId: workB.id,
      assertionIds: [displayedA.id, studiedB.id],
    });
    expect(result.rejection).toMatchObject({ code: 'subtype_mismatch' });
  });

  it('keeps audience affinity bounded: same-audience composition is approved, but it is never resemblance or influence', async () => {
    const workA = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const workB = await identity(db, { kind: 'work', domain: 'film', sense: 'film' });
    const audience = await identity(db, { kind: 'audience', domain: 'art', sense: 'audience segment' });

    const affinityA = await validatedAssertion(db, {
      subject: audience,
      predicate: 'AUDIENCE_AFFINITY',
      object: workA,
      evidenceKind: 'audience',
    });
    const affinityB = await validatedAssertion(db, {
      subject: audience,
      predicate: 'AUDIENCE_AFFINITY',
      object: workB,
      evidenceKind: 'audience',
    });

    const approved = await validateGraphPath(db, {
      rootNodeId: workA.id,
      candidateNodeId: workB.id,
      assertionIds: [affinityA.id, affinityB.id],
    });
    expect(approved.path).toMatchObject({ templateKey: 'shared_audience', midNodeId: audience.id });
    const reason = approved.path!.reason.toLowerCase();
    expect(reason).toContain('audience');
    expect(reason).not.toContain('resembl');
    expect(reason).not.toContain('influenc');
    expect(reason).not.toContain('visual');

    // Audience affinity never composes beyond the shared-audience template: a
    // walk that starts at the audience cannot chain affinity through works.
    const chained = await validateGraphPath(db, {
      rootNodeId: audience.id,
      candidateNodeId: workB.id,
      assertionIds: [affinityA.id, affinityB.id],
    });
    expect(chained.rejection).toBeDefined();
    expect(chained.rejection!.code).toMatch(/disconnected|nontransitive/);
  });

  it('rejects paths through ambiguous midpoints and unjustified edges', async () => {
    const root = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const candidate = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const creator = await identity(db, { kind: 'creator', domain: 'art', sense: 'painter' });
    const edgeRoot = await validatedAssertion(db, { subject: root, predicate: 'CREATED_BY', object: creator });
    const edgeCandidate = await validatedAssertion(db, { subject: candidate, predicate: 'CREATED_BY', object: creator });

    // An ambiguous midpoint cannot justify the composed claim.
    await db.query(`UPDATE graph_nodes SET status = 'ambiguous' WHERE id = $1`, [creator.id]);
    const ambiguous = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: candidate.id,
      assertionIds: [edgeRoot.id, edgeCandidate.id],
    });
    expect(ambiguous.rejection).toMatchObject({ code: 'ambiguous_identity' });
    await db.query(`UPDATE graph_nodes SET status = 'active' WHERE id = $1`, [creator.id]);

    // A proposed (unreviewed, unsupported) edge inside an otherwise approved
    // template shape is never a justified edge.
    const secondCandidate = await identity(db, { kind: 'work', domain: 'art', sense: 'painting' });
    const proposedEdge = await upsertGraphAssertion(db, {
      subjectNodeId: secondCandidate.id,
      predicate: 'CREATED_BY',
      objectNodeId: creator.id,
      status: 'proposed',
    });
    const unjustifiedSameShape = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: secondCandidate.id,
      assertionIds: [edgeRoot.id, proposedEdge.row.id],
    });
    expect(unjustifiedSameShape.path).toBeUndefined();
    expect(unjustifiedSameShape.rejection).toMatchObject({ code: 'edge_unjustified' });
    expect(proposedEdge.row.status).toBe('proposed');

    // And a proposed edge of a foreign predicate is no composition at all,
    // even when the walk itself is connected.
    const place = await identity(db, { kind: 'place', domain: 'art', sense: 'school' });
    const proposed = await upsertGraphAssertion(db, {
      subjectNodeId: creator.id,
      predicate: 'DOCUMENTED_ASSOCIATION',
      objectNodeId: place.id,
      associationSubtype: 'studied_at',
      status: 'proposed',
    });
    const unjustified = await validateGraphPath(db, {
      rootNodeId: root.id,
      candidateNodeId: place.id,
      assertionIds: [edgeRoot.id, proposed.row.id],
    });
    expect(unjustified.rejection).toMatchObject({ code: 'unsupported_composition' });
    expect(proposed.row.status).toBe('proposed');
  });

  it('defines templates whose reasons never claim identity, influence or resemblance', () => {
    const forbidden = ['resembl', 'influenc', 'identical', 'looks like', 'same work as'];
    for (const template of APPROVED_PATH_TEMPLATES) {
      const rendered = renderPathReason(template, { root: 'Root', candidate: 'Candidate', mid: 'Mid' });
      for (const word of forbidden) expect(rendered.toLowerCase()).not.toContain(word);
      expect(rendered.length).toBeGreaterThan(0);
    }
    // No approved meaning is identity, influence or resemblance.
    expect(templateForMeaning('identity')).toBeNull();
    expect(templateForMeaning('influences')).toBeNull();
    expect(templateForMeaning('resembles')).toBeNull();
    expect(templateForMeaning('shared_creator')).not.toBeNull();
  });
});
