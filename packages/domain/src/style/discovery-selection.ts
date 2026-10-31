import { distinctiveDesignEvidence, type CandidateProof } from './discovery-evidence';
import { sharedCulture } from './discovery-concepts';

export type ConnectionEvidenceClass = 'distinctive_design' | 'substantive_content' | 'taste_exploration' | 'catalogue_scope' | 'unsupported';

export function connectionEvidenceClass(proof: CandidateProof): ConnectionEvidenceClass {
  if (proof.contentEvidence?.focus && proof.contentEvidence.focus !== 'central') return 'unsupported';
  if (proof.relation === 'about_subject' && proof.contentEvidence?.excerpt.trim()) return 'substantive_content';
  if (proof.relation === 'shared_named_work' && proof.referenceId) return 'substantive_content';
  if (proof.relation === 'shared_design')
    return proof.candidateTags.some((t) => distinctiveDesignEvidence(proof.claim, t)) ? 'distinctive_design' : 'catalogue_scope';
  if (proof.relation === 'shared_subculture' && proof.claim.slot !== 'materials' &&
    proof.candidateTags.some((t) => sharedCulture(proof.claim.name, t.label))) return 'distinctive_design';
  if (proof.relation === 'shared_topic' && proof.claim.slot !== 'materials' && proof.candidateTags.length) return 'substantive_content';
  if (proof.relation === 'catalogue_facet' && proof.referenceEvidence?.references.length) return 'substantive_content';
  if (proof.relation === 'qloo_taste' && proof.provenance?.queryId && proof.provenance.seedIds.length) return 'taste_exploration';
  if (proof.relation === 'brand_exploration' || proof.relation === 'catalogue_facet' || proof.relation === 'place_exploration') return 'catalogue_scope';
  return 'unsupported';
}

/** Strength is evidence-specific, not provider rank or number of matching adjectives. */
export function connectionEvidencePriority(proof: CandidateProof): number {
  const evidence = connectionEvidenceClass(proof);
  if (evidence === 'distinctive_design') return proof.sourceEvidence ? 4 : 1;
  if (evidence === 'substantive_content') {
    if (proof.contentEvidence?.focus === 'central')
      return ['architecture', 'fashion_design', 'painting', 'sculpture'].includes(proof.contentEvidence.topicPlanKey ?? '') ? 2 : 3;
    return 1; // old proofs remain readable; new publication independently requires bound evidence
  }
  return 0;
}

/** Attribution and commercial scope are truthful exploration, not shared design/topic evidence. */
export function exploratoryProof(proof: CandidateProof): boolean {
  return proof.relation === 'qloo_taste' || proof.relation === 'brand_exploration';
}

/** Keep the existing diversity policy within evidence tiers, without filling with audience neighbours. */
export function selectEvidenceFirst<T>(
  candidates: readonly T[],
  proofFor: (candidate: T) => CandidateProof | null | undefined,
  select: (pool: readonly T[], slots: number, previous: readonly T[]) => T[],
  slots: number,
  exploratorySlots: number,
): T[] {
  if (slots <= 0) return [];
  const direct: T[] = [];
  const exploratory: T[] = [];
  for (const candidate of candidates) {
    const proof = proofFor(candidate);
    if (!proof) continue;
    const evidence = connectionEvidenceClass(proof);
    if (evidence === 'taste_exploration') exploratory.push(candidate);
    else if (evidence === 'distinctive_design' || evidence === 'substantive_content') direct.push(candidate);
  }
  const picked: T[] = [];
  for (const tier of [4, 3, 2, 1]) {
    if (picked.length >= slots) break;
    const pool = direct.filter((c) => connectionEvidencePriority(proofFor(c)!) === tier);
    picked.push(...select(pool, slots - picked.length, picked));
  }
  return [...picked, ...select(exploratory, Math.max(0, Math.min(slots - picked.length, exploratorySlots, 1)), picked)];
}
