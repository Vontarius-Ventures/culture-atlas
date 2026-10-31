import { designTagMatchesProduct, distinctiveDesignEvidence, proofIsActive, type CandidateProof } from './discovery-evidence';
import { parseConnectionContentFocus } from './content-evidence';
import { bindSourceEvidence, safeSubjectLabel, sameSourceEvidence } from './source-feature-plan';
import { connectionEvidenceClass } from './discovery-selection';
import type { StoredSubject } from './types';

export interface ConnectionAssetEvidence {
  version: 'connection_asset_evidence_v1';
  candidateId: string;
  imageUrl: string;
  originalSha256: string;
  modelInputSha256: string;
  identity: 'corroborated' | 'contradicted' | 'unknown';
  image: 'available' | 'placeholder' | 'unavailable';
  checkerVersion: string;
}

export interface ConnectionPublicationInput {
  proof: CandidateProof | null | undefined;
  subject: StoredSubject | null | undefined;
  readingRev: number;
  candidateId: string;
  /** Actual provider type, not a card category or a guessed mapping from its title. */
  targetType: string | null | undefined;
  imageUrl: string | null | undefined;
  /** Persisted recommendation origin. Replay/creative/sample are not live Qloo. */
  origin: string | null | undefined;
}

/** Strict new-publication contract. It never invents an asset verdict; the caller
 * must bind the real checker result to the exact candidate, URL and byte hashes.
 * This validates that contract, not the honesty of arbitrary external callers.
 */
export function validateConnectionPublication(input: ConnectionPublicationInput): { eligible: boolean; reasons: readonly string[] } {
  const reasons: string[] = [];
  const { proof, subject, readingRev, candidateId, targetType, imageUrl, origin } = input;
  if (origin !== 'qloo') reasons.push('origin_not_live_qloo');
  if (!['urn:entity:brand', 'urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:artist', 'urn:entity:place', 'urn:entity:destination'].includes(targetType ?? ''))
    reasons.push('incompatible_actual_target_type');
  if (!proof) return { eligible: false, reasons: [...reasons, 'proof_unavailable'] };
  if (!proof.claim || typeof proof.claim.name !== 'string' || typeof proof.claim.slot !== 'string' ||
    !Array.isArray(proof.candidateTags) || !proof.candidateTags.every((t) => t && typeof t.id === 'string' && typeof t.label === 'string') ||
    (proof.contentEvidence && (typeof proof.contentEvidence.excerpt !== 'string' || !proof.contentEvidence.claim)))
    return { eligible: false, reasons: [...reasons, 'proof_schema_invalid'] };
  if (proof.relation === 'qloo_taste' && (!Array.isArray(proof.provenance?.seedIds) ||
    !Array.isArray(proof.provenance.seedNames)))
    return { eligible: false, reasons: [...reasons, 'taste_provenance_invalid'] };
  if (!candidateId || proof.candidateId !== candidateId) reasons.push('candidate_id_mismatch');
  if (!proof.targetType || proof.targetType !== targetType) reasons.push('proof_target_mismatch');
  if (!Number.isInteger(readingRev) || readingRev < 1 || proof.readingRev !== readingRev) reasons.push('reading_revision_mismatch');
  if (typeof proof.sourceQueryId !== 'string' || !proof.sourceQueryId.trim()) reasons.push('source_query_unavailable');
  if (!subject || subject.id !== proof.subjectId) reasons.push('source_subject_mismatch');
  if (subject) {
    if (!proofIsActive(proof, [subject])) reasons.push('source_claim_inactive');
    if (proof.claim.slot === 'label' && proof.claim.name !== safeSubjectLabel(subject)) reasons.push('unsafe_public_label');
    const expected = bindSourceEvidence(subject, proof.claim, readingRev);
    if (!sameSourceEvidence(proof.sourceEvidence, expected))
      reasons.push('source_feature_binding_invalid');
    if (proof.relation === 'shared_design' && !proof.candidateTags.some((t) =>
      distinctiveDesignEvidence(proof.claim, t) && designTagMatchesProduct(subject, t.label))) reasons.push('design_product_evidence_invalid');
  }
  const evidence = connectionEvidenceClass(proof);
  if (!['distinctive_design', 'substantive_content', 'taste_exploration'].includes(evidence)) reasons.push('relation_evidence_insufficient');
  if (proof.relation === 'qloo_taste' && (!proof.provenance?.seedIds.length || proof.provenance.queryId !== proof.sourceQueryId ||
    !proof.provenance.seedNames.length || !['single_request_seed', 'returned_explainability'].includes(proof.provenance.attribution)))
    reasons.push('taste_provenance_invalid');
  if (proof.relation === 'about_subject') {
    if (targetType !== 'urn:entity:movie' && targetType !== 'urn:entity:tv_show') reasons.push('content_target_incompatible');
    const content = proof.contentEvidence;
    const parsed = content?.context && content.topicPlanKey ? parseConnectionContentFocus(content.topicPlanKey, content.context) : null;
    const original = content?.context?.[content.field];
    if (!content || content.focus !== 'central' || !parsed || parsed.focus !== 'central' ||
      parsed.field !== content.field || parsed.excerpt !== content.excerpt ||
      parsed.range?.start !== content.range?.start || parsed.range?.end !== content.range?.end ||
      typeof original !== 'string' || !original || !content.range || original.slice(content.range.start, content.range.end) !== content.excerpt ||
      content.claim?.slot !== proof.claim.slot || content.claim?.name !== proof.claim.name || content.claim?.wording !== proof.claim.wording)
      reasons.push('content_focus_binding_invalid');
    if (content?.kind !== 'documentary' && content?.kind !== 'topic_film') reasons.push('content_kind_invalid');
    if (content?.kind === 'documentary' && (!content.documentaryTag || !proof.candidateTags.some((t) =>
      t.id === content.documentaryTag!.id && /^urn:tag:(?:genre|subgenre)(?::|$)/.test(t.id) && /\bdocumentary\b/i.test(t.label))))
      reasons.push('documentary_tag_unavailable');
    if (content?.kind === 'topic_film' && (!content.topicTag || !proof.candidateTags.some((t) => t.id === content.topicTag!.id)))
      reasons.push('topic_tag_unavailable');
  }
  const asset = proof.assetEvidence;
  if (!asset || asset.version !== 'connection_asset_evidence_v1') reasons.push('asset_evidence_unavailable');
  else {
    if (asset.candidateId !== candidateId) reasons.push('asset_candidate_mismatch');
    if (!imageUrl || asset.imageUrl !== imageUrl || !/^https:\/\/[^/\s@]+(?:\/|$)/i.test(imageUrl)) reasons.push('asset_image_url_mismatch');
    if (!/^[a-f0-9]{64}$/i.test(asset.originalSha256) || !/^[a-f0-9]{64}$/i.test(asset.modelInputSha256)) reasons.push('asset_hash_invalid');
    if (typeof asset.checkerVersion !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(asset.checkerVersion)) reasons.push('asset_checker_version_invalid');
    if (asset.identity !== 'corroborated') reasons.push('asset_identity_not_corroborated');
    if (asset.image !== 'available') reasons.push('asset_image_unavailable');
  }
  return { eligible: reasons.length === 0, reasons };
}
