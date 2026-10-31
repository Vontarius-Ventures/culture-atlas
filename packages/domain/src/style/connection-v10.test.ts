import { describe, expect, it } from 'vitest';
import { productKind } from './affinity';
import { bindSourceEvidence, compileSourceFeaturePlan, safeSubjectLabel } from './source-feature-plan';
import { admitDiscovery, designTagMatchesProduct, distinctiveDesignEvidence, proofIsActive, type CandidateProof } from './discovery-evidence';
import { validateConnectionPublication, type ConnectionAssetEvidence } from './connection-publication';
import { planConnectionTopics } from './connection-topics';
import { selectEvidenceFirst } from './discovery-selection';
import { storedAesthetic, storedSubject } from './test-support';
import type { StoredSubject } from './types';

// Explicit synthetic mechanism fixtures. No private images/rows, and no identity verdict is inferred.
const observation = (id: string, text: string, kind: NonNullable<StoredSubject['observations']>[number]['kind'] = 'pattern') =>
  ({ id, text, kind, certainty: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } });
const source = () => storedSubject({
  label: 'Breton striped top',
  observations: [observation('o1', 'Horizontal navy and white stripes'), observation('o2', 'Boat neckline', 'form')],
});
const brand = (descriptor = 'Striped patterns') => ({
  entity_id: 'synthetic-brand', types: ['urn:entity:brand'],
  tags: [{ id: 'urn:tag:genre:brand:fashion:casual', name: 'Casual' },
    { id: 'urn:tag:aesthetic_property:qloo:stripes', name: descriptor }],
});
const asset = (): ConnectionAssetEvidence => ({
  version: 'connection_asset_evidence_v1', candidateId: 'synthetic-brand', imageUrl: 'https://example.test/brand.jpg',
  originalSha256: 'a'.repeat(64), modelInputSha256: 'b'.repeat(64),
  identity: 'corroborated', image: 'available', checkerVersion: 'synthetic-test-v1',
});
const proof = (): CandidateProof => ({
  ...admitDiscovery([source()], brand(), 'urn:entity:brand', { readingRev: 10, queryId: 'synthetic-query' })!,
  assetEvidence: asset(),
});
const publication = () => ({
  proof: proof(), subject: source(), readingRev: 10, candidateId: 'synthetic-brand',
  targetType: 'urn:entity:brand', imageUrl: asset().imageUrl, origin: 'qloo',
});

describe('v10 source feature contract', () => {
  it('binds only retained observations and exposes no provenance or composition', () => {
    const plan = compileSourceFeaturePlan([source()], 10);
    expect(plan.features.find((f) => f.concept === 'stripes')).toMatchObject({
      subjectId: 's1', readingRev: 10, publicCue: 'Stripes', observationIds: ['o1'],
      observations: [{ id: 'o1', certainty: 0.9, region: { x: 0, y: 0, w: 1, h: 1 } }],
    });
    expect(safeSubjectLabel({ label: 'Islamic ceramic bowl collection' })).toBe('Bowls');
    expect(JSON.stringify(plan)).not.toMatch(/Breton|French|cotton|lineage/i);
    expect(compileSourceFeaturePlan([storedSubject()], 10).features).toEqual([]);
  });
  it('rejects text, invalid certainty/region, duplicated ids and negated features', () => {
    for (const observations of [
      [observation('o1', 'Stripes', 'text')],
      [{ ...observation('o1', 'Stripes'), certainty: 0.49 }],
      [{ ...observation('o1', 'Stripes'), region: { x: 0, y: 0, w: 2, h: 1 } }],
      [observation('o1', 'Stripes'), observation('o1', 'Stripes')],
      [observation('o1', 'No stripes')],
    ]) expect(compileSourceFeaturePlan([{ ...source(), observations }], 10).features).toEqual([]);
  });
  it('does not resurrect held/retracted claims or accept unrelated feature ids', () => {
    for (const flags of [{ held: true }, { retracted: true }]) {
      const subject = { ...source(), aesthetics: [storedAesthetic('Stripes', flags)] };
      expect(compileSourceFeaturePlan([subject], 10).features.some((f) => f.concept === 'stripes')).toBe(false);
      expect(admitDiscovery([subject], brand(), 'urn:entity:brand', { readingRev: 10 })?.relation).not.toBe('shared_design');
    }
    const plan = compileSourceFeaturePlan([source()], 10);
    expect(bindSourceEvidence(source(), { slot: 'construction', name: 'Floral', wording: 'resembles' }, 10, plan.features.map((f) => f.id))).toBeUndefined();
  });
  it('retains only active visible explicitly linked style families, never certainty-based identity', () => {
    const subject = { ...source(), aesthetics: [storedAesthetic('Streetwear', { evidence_ids: ['o1', 'o2'] }),
      storedAesthetic('Persian tradition', { evidence_ids: ['o1', 'o2'] })] };
    expect(compileSourceFeaturePlan([subject], 10).features.filter((f) => f.kind === 'style_family').map((f) => f.publicCue)).toEqual(['Streetwear']);
    expect(compileSourceFeaturePlan([{ ...subject, aesthetics: subject.aesthetics.map((c) => ({ ...c, basis: 'context' as const })) }], 10).features.some((f) => f.kind === 'style_family')).toBe(false);
  });
  it.each(['ribbed trim', 'tiny floral print and tie bow', 'sequined bodice', 'four-poster canopy', 'colour-block panels'])('retains closed visual cue: %s', (text) => {
    expect(compileSourceFeaturePlan([{ ...source(), observations: [observation('o1', text)] }], 10).features.length).toBeGreaterThan(0);
  });
});

describe('v10 design and retrieval mechanism', () => {
  it('admits observed stripes without fabricating a structured aesthetic', () => {
    expect(proof()).toMatchObject({ relation: 'shared_design', claim: { name: 'Stripes', wording: 'resembles' },
      sourceEvidence: { readingRev: 10, observationIds: ['o1'] } });
    expect(proofIsActive(proof(), [source()])).toBe(true);
    expect(proofIsActive(proof(), [{ ...source(), observations: [] }])).toBe(false);
  });
  it('rejects generic formal/glamorous and wrong-product descriptors while preserving real colorblock', () => {
    for (const name of ['Formal', 'Glamorous', 'Formal glamorous'])
      expect(distinctiveDesignEvidence({ slot: 'aesthetics', name, wording: 'asserted' }, { id: 'urn:tag:personal_style:qloo:formal', label: name })).toBe(false);
    expect(distinctiveDesignEvidence({ slot: 'construction', name: 'Colour-block', wording: 'resembles' },
      { id: 'urn:tag:aesthetic_property:qloo:colorblock', label: 'Colorblock panels' })).toBe(true);
    expect(designTagMatchesProduct(source(), 'Colorblock sneakers')).toBe(false);
    expect(admitDiscovery([source()], brand('Striped sneakers'), 'urn:entity:brand', { readingRev: 10 })?.relation).not.toBe('shared_design');
    expect(productKind(storedSubject({ label: 'Black hybrid dress sneakers' }))).toBe('footwear');
    expect(designTagMatchesProduct(storedSubject({ label: 'Black hybrid dress sneakers' }), 'Colorblock dress sneakers')).toBe(true);
    expect(productKind(storedSubject({ label: 'Dress shirt' }))).toBe('tailoring');
  });
  it('fixes object routing with at most two bounded queries, no tile-to-pottery route', () => {
    for (const label of ['Sweatshirt', 'Wicker armchair', 'Wooden cafe dining set']) {
      const plans = planConnectionTopics([storedSubject({ label, category: label === 'Sweatshirt' ? 'fashion' : 'interior' })]);
      expect(plans[0]?.key).toBe(label === 'Sweatshirt' ? 'fashion_design' : 'furniture');
      expect(plans.length).toBeLessThanOrEqual(2);
      expect(plans.every((p) => p.tagQueries!.length <= 2)).toBe(true);
      expect(plans.some((p) => p.key === 'coffee')).toBe(false);
    }
    const plans = planConnectionTopics([storedSubject({ label: 'Ceramic tile galley kitchen', category: 'interior' })]);
    expect(plans.map((p) => p.key)).toEqual(['architecture']);
    expect(planConnectionTopics([storedSubject({ label: 'Bed in bedroom', category: 'interior' })]).map((p) => p.key)).toEqual(['furniture', 'architecture']);
  });
  it('prefers bound specific design to broad category, preserving ties and the taste cap', () => {
    const broad: CandidateProof = { ...proof(), candidateId: 'broad', relation: 'about_subject', contentEvidence: {
      topic: 'architecture', topicPlanKey: 'architecture', claim: proof().claim,
      field: 'description', excerpt: 'The film examines architecture.', focus: 'central',
    } };
    const pool = [broad, proof(), { ...proof(), candidateId: 'tie' }];
    expect(selectEvidenceFirst(pool, (p) => p, (items, slots) => items.slice(0, slots), 3, 1).map((p) => p.candidateId)).toEqual(['synthetic-brand', 'tie', 'broad']);
  });
});

describe('strict new publication contract (synthetic assets only)', () => {
  it('accepts a fully bound supported candidate, not a bare URL', () => {
    expect(validateConnectionPublication(publication())).toEqual({ eligible: true, reasons: [] });
    const input = publication();
    delete input.proof.assetEvidence;
    expect(validateConnectionPublication(input).reasons).toContain('asset_evidence_unavailable');
  });
  it.each(['unknown', 'contradicted'] as const)('rejects identity %s regardless of high source certainty', (identity) => {
    const input = publication(); input.proof.assetEvidence!.identity = identity;
    expect(validateConnectionPublication(input).eligible).toBe(false);
  });
  it.each(['placeholder', 'unavailable'] as const)('rejects image %s', (image) => {
    const input = publication(); input.proof.assetEvidence!.image = image;
    expect(validateConnectionPublication(input).eligible).toBe(false);
  });
  it('rejects every broken binding, unsupported origin and null proof without manufacturing a verdict', () => {
    const mutations: ((input: ReturnType<typeof publication>) => void)[] = [
      (i) => { i.origin = 'vlm_creative'; }, (i) => { i.readingRev++; },
      (i) => { i.candidateId = 'different'; }, (i) => { i.targetType = 'urn:entity:food'; },
      (i) => { i.imageUrl += '?changed'; }, (i) => { i.proof.assetEvidence!.candidateId = 'different'; },
      (i) => { i.proof.assetEvidence!.originalSha256 = 'not-sha'; },
      (i) => { i.proof.assetEvidence!.modelInputSha256 = 'not-sha'; },
      (i) => { i.proof.assetEvidence!.checkerVersion = ''; },
      (i) => { i.proof.sourceEvidence!.observationIds = ['invented']; },
      (i) => { i.proof.sourceEvidence!.publicCue = 'Islamic pottery'; },
      (i) => { i.proof.sourceEvidence!.featureIds = ['invented']; },
      (i) => { i.subject.observations = []; },
      (i) => { i.proof.claim.name = 'Islamic ceramic bowl'; },
      (i) => { i.proof.sourceQueryId = ''; },
    ];
    for (const mutate of mutations) {
      const input = publication(); mutate(input);
      expect(validateConnectionPublication(input).eligible).toBe(false);
    }
    expect(validateConnectionPublication({ ...publication(), proof: null }).eligible).toBe(false);
  });
  it('keeps legacy proof schema readable but requires a real new source plan', () => {
    const input = publication();
    delete input.proof.sourceEvidence;
    expect(validateConnectionPublication(input).reasons).toContain('source_feature_binding_invalid');
  });
  it('survives JSONB object-key reordering without weakening evidence bindings', () => {
    const reverse = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
    const input = publication();
    input.proof.sourceEvidence = reverse(input.proof.sourceEvidence!);
    input.subject.observations = input.subject.observations!.map((o) => reverse({ ...o, region: reverse(o.region!) }));
    expect(validateConnectionPublication(input)).toEqual({ eligible: true, reasons: [] });
  });
  it('binds exact content/context/ranges while keeping an unsafe source qualifier out of proofs', () => {
    const subject = storedSubject({ label: 'Islamic ceramic bowl collection', category: 'interior',
      observations: [observation('o1', 'Shallow bowl profile on foot', 'form')] });
    const description = 'The documentary profiles potters and explores pottery.';
    const film = { entity_id: 'synthetic-brand', types: ['urn:entity:movie'],
      tags: [{ id: 'urn:tag:genre:media:documentary', name: 'Documentary' }], properties: { description } };
    const candidateProof = admitDiscovery([subject], film, 'urn:entity:movie', { readingRev: 10, queryId: 'synthetic-query', requireContent: true })!;
    const input = { ...publication(), subject, proof: { ...candidateProof, assetEvidence: asset() }, targetType: 'urn:entity:movie' };
    expect(candidateProof.claim.name).toBe('Bowls');
    expect(JSON.stringify(candidateProof)).not.toMatch(/Islamic/);
    expect(validateConnectionPublication(input)).toEqual({ eligible: true, reasons: [] });
    input.proof.contentEvidence!.context!.short_description = 'The documentary explores philosophy through chefs, musicians and sculptors.';
    expect(validateConnectionPublication(input).reasons).toContain('content_focus_binding_invalid');
    delete input.proof.contentEvidence!.context!.short_description;
    input.proof.contentEvidence!.range!.end--;
    expect(validateConnectionPublication(input).reasons).toContain('content_focus_binding_invalid');
  });
  it('fails closed for malformed persisted proof shapes', () => {
    for (const malformed of [{}, { ...proof(), candidateTags: null }, { ...proof(), relation: 'qloo_taste', provenance: { queryId: 'q' } }]) {
      expect(validateConnectionPublication({ ...publication(), proof: malformed as CandidateProof }).eligible).toBe(false);
    }
  });
});
