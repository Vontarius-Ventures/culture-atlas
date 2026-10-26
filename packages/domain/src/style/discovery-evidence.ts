import { echoKey, entityProfile, scoreMatch, styleTokens, subjectProfile } from './affinity';
import { activeSubject, aboutSubject, discoveryClaims, isMusicSubject, sharedCulture, topicClaim, type DiscoveryClaim } from './discovery-concepts';
import type { StoredSubject } from './types';
import { homeKindOfReading, wearIndustryAllowed } from './home-affinity';

export type DiscoveryOrigin = 'anchor' | 'bridge' | 'topic' | 'style';
export type DiscoveryRelation = 'shared_design' | 'shared_topic' | 'shared_subculture' | 'about_subject' | 'shared_named_work';

export interface CandidateProof {
  subjectId: string;
  readingRev?: number;
  relation: DiscoveryRelation;
  origin: DiscoveryOrigin;
  claim: DiscoveryClaim;
  candidateId: string;
  candidateTags: { id: string; label: string }[];
  referenceId?: string;
}

export interface DiscoveryIntent {
  subjectId: string;
  targetType: string;
  claim: DiscoveryClaim;
  relation: Exclude<DiscoveryRelation, 'shared_named_work'>;
}

export interface EvidenceEntity {
  entity_id: string;
  name?: string;
  types?: readonly string[];
  tags?: { id: string; name: string }[];
}

export interface AdmissionOptions {
  origin?: DiscoveryOrigin;
  subjectIds?: ReadonlySet<string>;
  excludedIds?: ReadonlySet<string>;
  excludedNames?: ReadonlySet<string>;
  readingRev?: number;
  /** Topic fill must prove the tag actually used, not another incidental candidate tag. */
  tagIds?: ReadonlySet<string>;
}

export function planDiscovery(subjects: readonly StoredSubject[], targetType: string): DiscoveryIntent[] {
  return subjects.flatMap((s) => discoveryClaims(s).flatMap((claim): DiscoveryIntent[] => {
    if (targetType === 'urn:entity:artist') {
      if (claim.slot === 'materials' || claim.slot === 'construction' || (!isMusicSubject(s) && !sharedCulture(claim.name, claim.name))) return [];
      return [{ subjectId: s.id, targetType, claim, relation: isMusicSubject(s) ? 'shared_design' : 'shared_subculture' }];
    }
    if (targetType === 'urn:entity:brand') {
      if (claim.slot === 'label' || claim.slot === 'era') return [];
      return [{ subjectId: s.id, targetType, claim, relation: 'shared_design' }];
    }
    if (targetType === 'urn:entity:movie' || targetType === 'urn:entity:tv_show')
      return [{ subjectId: s.id, targetType, claim, relation: 'about_subject' }];
    return [];
  }));
}

const GENERIC_DESIGN = new Set('casual classic modern contemporary everyday basic smart clothing apparel fashion style bag bags jacket top shirt dress shoe footwear'.split(' '));

/**
 * Origin is audit metadata, never a waiver. Anchor, bridge and fill all prove a relation
 * against an active subject. Exact visual anchors are exclusions, not discoveries.
 */
export function admitDiscovery(
  subjects: readonly StoredSubject[], entity: EvidenceEntity, targetType: string, options: AdmissionOptions = {},
): CandidateProof | null {
  if (options.excludedIds?.has(entity.entity_id) || (entity.name && options.excludedNames?.has(echoKey(entity.name)))) return null;
  if (entity.types?.length && !entity.types.includes(targetType)) return null;
  const tags = (entity.tags ?? []).filter((t) => !options.tagIds || options.tagIds.has(t.id));
  for (const original of subjects) {
    if (options.subjectIds && !options.subjectIds.has(original.id)) continue;
    const subject = activeSubject(original);
    if (subject.entity?.id === entity.entity_id || (entity.name && [subject.brand?.name, subject.entity?.name].some((name) => name && echoKey(name) === echoKey(entity.name!)))) continue;
    const proof = (relation: DiscoveryRelation, claim: DiscoveryClaim, tag: { id: string; name: string }): CandidateProof => ({
      subjectId: subject.id, ...(options.readingRev === undefined ? {} : { readingRev: options.readingRev }),
      relation, origin: options.origin ?? 'style', claim, candidateId: entity.entity_id,
      candidateTags: [{ id: tag.id, label: tag.name }],
    });
    if (targetType === 'urn:entity:brand') {
      if (subject.category !== 'fashion') {
        const kind = homeKindOfReading([subject]);
        if (!kind || !wearIndustryAllowed({ tags }, kind)) continue;
      }
      const q = subjectProfile(subject);
      const match = scoreMatch(q, entityProfile(tags), { fashion: subject.category === 'fashion' });
      if (match.gate || !match.styleHit || match.score < 0.35) continue;
      for (const hit of match.hits) {
        if (hit.level !== 'name' || hit.slot === 'entity' || hit.slot === 'details' || hit.slot === 'mood' || hit.slot === 'era' || GENERIC_DESIGN.has(hit.token)) continue;
        // A generic thing noun is not the second rail's design evidence.
        if (hit.slot === 'label') continue;
        const claim = discoveryClaims(subject).find((c) => c.slot === hit.slot && c.name === hit.claim);
        const tag = tags.find((t) => t.id === hit.tagId);
        if (claim && tag && hit.coverage >= 0.5 && styleTokens(claim.name).every((word) => styleTokens(tag.name).includes(word)))
          return proof('shared_design', claim, tag);
      }
      continue;
    }
    for (const tag of tags) {
      const claim = topicClaim(subject, tag, targetType);
      if (claim) return proof(sharedCulture(claim.name, tag.name) ? 'shared_subculture' : 'shared_topic', claim, tag);
    }
    if (targetType === 'urn:entity:movie' || targetType === 'urn:entity:tv_show')
      for (const tag of tags) {
        const claim = aboutSubject(subject, tag);
        if (claim) return proof('about_subject', claim, tag);
      }
  }
  return null;
}

/** Exact-title discovery is intentionally separate from style and anchor-echo admission. */
export function namedWorkProof(subjectId: string, entityId: string, name: string, referenceId: string, wording: 'asserted' | 'resembles', readingRev?: number): CandidateProof {
  return {
    subjectId, candidateId: entityId, relation: 'shared_named_work', origin: 'anchor',
    claim: { slot: 'label', name, wording }, candidateTags: [], referenceId,
    ...(readingRev === undefined ? {} : { readingRev }),
  };
}

/** Only labels actually on the candidate and the active claim that proved the relation. */
export function discoveryReason(proof: CandidateProof, targetType: string): string {
  const noun = targetType === 'urn:entity:artist' ? 'An artist' : targetType === 'urn:entity:brand' ? 'A brand' : 'A film';
  const tag = proof.candidateTags[0]?.label;
  if (proof.relation === 'shared_named_work') {
    const lead = `A film sharing its title with ${proof.claim.name}`;
    const full = `${lead}, the work ${proof.claim.wording === 'resembles' ? 'your photo resembles' : 'in your photo'}`;
    return fitReason(full, lead);
  }
  const lead = `${noun} tagged ${tag ?? proof.claim.name}`;
  const tail = proof.relation === 'about_subject'
    ? `exploring a topic connected to ${proof.claim.name}`
    : `connected to ${proof.claim.name}${proof.claim.wording === 'resembles' ? ', which your photo resembles' : ' in your photo'}`;
  return fitReason(`${lead}; ${tail}`, lead);
}

function fitReason(full: string, short: string): string {
  if (full.length <= 90) return full;
  if (short.length <= 90) return short;
  return `${short.slice(0, 89).trimEnd()}…`;
}
