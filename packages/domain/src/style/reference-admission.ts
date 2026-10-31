import { echoKey } from './affinity';
import { hasMusicEvidence, type CandidateProof, type EvidenceEntity } from './discovery-evidence';

/** Published, guarded references only. Held claims have no place in this input. */
export interface DiscoveryReference {
  referenceId: string;
  name: string;
  resolution: string;
  textOnly?: boolean;
  commercialEvidence?: 'fashion';
  qloo: { entityId?: string; tagId?: string; types?: readonly string[] } | null;
  tags?: { id: string; name: string }[];
}

const fashionTags = (entity: Pick<EvidenceEntity, 'tags'>) =>
  (entity.tags ?? []).some((tag) => /^urn:tag:genre:brand:fashion(?::|$)/.test(tag.id));
const active = (ref: DiscoveryReference) => !ref.textOnly && ['resolved', 'user_confirmed'].includes(ref.resolution) && !!ref.qloo;
const commercial = (ref: DiscoveryReference) => ref.commercialEvidence === 'fashion' || fashionTags(ref);
const legitimateSeed = (ref: DiscoveryReference) =>
  !!ref.qloo?.entityId && (ref.qloo.types ?? []).some((type) =>
    ['urn:entity:movie', 'urn:entity:tv_show'].includes(type) ||
    (type === 'urn:entity:artist' && hasMusicEvidence(ref)) ||
    (type === 'urn:entity:brand' && fashionTags(ref)));

export function referenceSupportsTarget(ref: DiscoveryReference, targetType: string): boolean {
  return active(ref) && (targetType !== 'urn:entity:brand' || commercial(ref));
}

/** Missing/failed/off readers may use references. A reader still running may not race publication. */
export function referenceFallbackAllowed(hasReading: boolean, enabled: boolean, status: string): boolean {
  return !hasReading && (!enabled || ['failed', 'unavailable', 'skipped', 'empty'].includes(status));
}

export function admitReferenceDiscovery(
  refs: readonly DiscoveryReference[], entity: EvidenceEntity, targetType: string,
  request: { queryId: string; seedIds: readonly string[]; tagIds: readonly string[] },
): CandidateProof | null {
  if (!entity.types?.includes(targetType) || !['urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:artist', 'urn:entity:brand'].includes(targetType)) return null;
  if (targetType === 'urn:entity:artist' && !hasMusicEvidence(entity)) return null;
  const usable = refs.filter(active);
  if (usable.some((ref) => ref.qloo?.entityId === entity.entity_id || (entity.name && echoKey(ref.name) === echoKey(entity.name)))) return null;
  const supplied = new Set(request.seedIds);
  const explained = new Set((entity.query?.explainability ?? [])
    .filter((item) => supplied.has(item.entity_id) && Number.isFinite(item.score) && item.score > 0).map((item) => item.entity_id));
  const attributable = explained.size ? explained : !entity.query?.explainability?.length && supplied.size === 1 ? supplied : new Set<string>();
  const seeds = usable.filter((ref) => legitimateSeed(ref) && attributable.has(ref.qloo!.entityId!));
  const brand = targetType === 'urn:entity:brand';
  const commercialTags = brand ? (entity.tags ?? []).filter((tag) => /^urn:tag:genre:brand:fashion(?::|$)/.test(tag.id)).map((tag) => ({ id: tag.id, label: tag.name })) : [];
  // Catalogue type alone is not a commercial domain; nor can an unknown object shop by a style tag.
  const brandSeed = seeds.some((ref) => ref.qloo?.types?.includes('urn:entity:brand') && commercial(ref));
  if (seeds.length && (!brand || brandSeed || (fashionTags(entity) && seeds.some(commercial)))) {
    return {
      subjectId: null, referenceId: seeds[0]!.referenceId, candidateId: entity.entity_id, targetType,
      sourceQueryId: request.queryId, relation: 'qloo_taste', origin: 'anchor',
      claim: { slot: 'label', name: seeds[0]!.name, wording: 'asserted' }, candidateTags: commercialTags,
      referenceEvidence: { kind: 'entity_seed', references: seeds.map((ref) => ({ referenceId: ref.referenceId, signalId: ref.qloo!.entityId! })) },
      provenance: { queryId: request.queryId, seedIds: seeds.map((ref) => ref.qloo!.entityId!), seedNames: seeds.map((ref) => ref.name), attribution: explained.size ? 'returned_explainability' : 'single_request_seed' },
    };
  }
  const requestTags = new Set(request.tagIds);
  for (const ref of usable) {
    const id = ref.qloo?.tagId;
    if (!id || !requestTags.has(id) || (ref.qloo?.types?.length && !ref.qloo.types.includes(targetType))) continue;
    if (brand && (!commercial(ref) || !fashionTags(entity))) continue;
    const tag = entity.tags?.find((item) => item.id === id);
    if (!tag) continue;
    return {
      subjectId: null, candidateId: entity.entity_id, targetType, sourceQueryId: request.queryId,
      relation: 'catalogue_facet', origin: 'anchor', claim: { slot: 'label', name: ref.name, wording: 'asserted' },
      candidateTags: [{ id, label: tag.name }, ...commercialTags.filter((item) => item.id !== id)],
      referenceEvidence: { kind: 'exact_request_tag', references: [{ referenceId: ref.referenceId, signalId: id }] },
    };
  }
  return null;
}

/** Compose must still possess the exact live reference-to-signal mapping that earned admission. */
export function referenceProofIsActive(proof: CandidateProof, refs: readonly DiscoveryReference[]): boolean {
  const evidence = proof.referenceEvidence;
  if (proof.subjectId !== null || !proof.sourceQueryId || !evidence?.references.length) return false;
  if (proof.targetType === 'urn:entity:brand') {
    const commercialSeed = evidence.kind === 'entity_seed' && evidence.references.some((link) =>
      refs.some((ref) => ref.referenceId === link.referenceId && ref.qloo?.types?.includes('urn:entity:brand') && fashionTags(ref)));
    if (!commercialSeed && !fashionTags({ tags: proof.candidateTags.map((tag) => ({ id: tag.id, name: tag.label })) })) return false;
  }
  return evidence.references.every((link) => {
    const ref = refs.find((item) => item.referenceId === link.referenceId);
    if (!ref || !active(ref)) return false;
    if (evidence.kind === 'entity_seed')
      return proof.relation === 'qloo_taste' && legitimateSeed(ref) && ref.qloo?.entityId === link.signalId && !!proof.provenance?.seedIds.includes(link.signalId);
    return proof.relation === 'catalogue_facet' && ref.qloo?.tagId === link.signalId && (!ref.qloo.types?.length || (!!proof.targetType && ref.qloo.types.includes(proof.targetType))) && proof.candidateTags.some((tag) => tag.id === link.signalId) &&
      (proof.targetType !== 'urn:entity:brand' || commercial(ref));
  });
}
