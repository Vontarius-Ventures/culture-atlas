import { COLOR_WORDS, echoKey, entityProfile, productKind, scoreMatch, styleTokens, subjectProfile } from './affinity';
import { activeSubject, aboutSubject, isMusicSubject, sharedCulture, topicClaim, type DiscoveryClaim } from './discovery-concepts';
import type { StoredSubject } from './types';
import { homeKindOfReading, wearIndustryAllowed } from './home-affinity';
import { homeFamilyGenreAllowed } from './home-affinity';
import { isArtworkSubject } from './adjacency';
import { fashionProductEligible } from './product-evidence';
import { normalizeStyleName } from './vocabulary';
import { documentaryEvidence, type ContentEvidence } from './content-evidence';
import { activeConnectionTopicPlan, connectionSourceClaims, planConnectionTopics, type ConnectionTopicPlan } from './connection-topics';
import { bindSourceEvidence, compileSourceFeaturePlan, safeSubjectLabel, sameSourceEvidence, type ConnectionSourceEvidence } from './source-feature-plan';
import type { ConnectionAssetEvidence } from './connection-publication';

export type DiscoveryOrigin = 'anchor' | 'bridge' | 'topic' | 'style';
export type DiscoveryRelation = 'shared_design' | 'shared_topic' | 'shared_subculture' | 'about_subject' | 'shared_named_work' | 'brand_exploration' | 'qloo_taste' | 'place_exploration' | 'catalogue_facet';

/** Only actual request seeds, linked to the reading that selected them. Never inferred from rank. */
export interface DiscoverySeed {
  id: string;
  name: string;
  subjectId: string;
  claim?: DiscoveryClaim;
}

export interface TasteProvenance {
  queryId: string;
  requestSeedIds: readonly string[];
  seeds: readonly DiscoverySeed[];
}

export interface CandidateProof {
  subjectId: string | null;
  readingRev?: number;
  relation: DiscoveryRelation;
  origin: DiscoveryOrigin;
  claim: DiscoveryClaim;
  candidateId: string;
  targetType?: string;
  sourceQueryId?: string;
  candidateTags: { id: string; label: string }[];
  contentEvidence?: ContentEvidence;
  sourceEvidence?: ConnectionSourceEvidence;
  assetEvidence?: ConnectionAssetEvidence;
  referenceId?: string;
  referenceEvidence?: { kind: 'exact_request_tag' | 'entity_seed'; references: { referenceId: string; signalId: string }[] };
  provenance?: { queryId: string; seedIds: string[]; seedNames: string[]; attribution: 'single_request_seed' | 'returned_explainability' };
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
  properties?: Record<string, unknown>;
  query?: { explainability?: readonly { entity_id: string; score: number }[] };
}

export interface AdmissionOptions {
  /** Intersects authorized subjects and exact request tags; never widens them. */
  topicPlan?: ConnectionTopicPlan;
  /** Documentary retrieval requires an explicit candidate-owned content excerpt. */
  requireContent?: boolean;
  origin?: DiscoveryOrigin;
  subjectIds?: ReadonlySet<string>;
  excludedIds?: ReadonlySet<string>;
  excludedNames?: ReadonlySet<string>;
  readingRev?: number;
  queryId?: string;
  /** Topic fill must prove the tag actually used, not another incidental candidate tag. */
  tagIds?: ReadonlySet<string>;
  taste?: TasteProvenance;
  /** User-provided city actually used as a request constraint, never the photo's location. */
  place?: { queryId: string; city: string; requestType: string; filterTagIds: readonly string[] };
}

export function planDiscovery(subjects: readonly StoredSubject[], targetType: string): DiscoveryIntent[] {
  return subjects.flatMap((s) => connectionSourceClaims(s).flatMap((claim): DiscoveryIntent[] => {
    if (targetType === 'urn:entity:artist') {
      if (claim.slot === 'materials' || claim.slot === 'construction' || (!isMusicSubject(s) && !sharedCulture(claim.name, claim.name))) return [];
      return [{ subjectId: s.id, targetType, claim, relation: isMusicSubject(s) ? 'shared_design' : 'shared_subculture' }];
    }
    if (targetType === 'urn:entity:brand') {
      if (!commercialSubject(s) || !distinctiveDesignClaim(claim)) return [];
      return [{ subjectId: s.id, targetType, claim, relation: 'shared_design' }];
    }
    if (targetType === 'urn:entity:movie' || targetType === 'urn:entity:tv_show')
      return [{ subjectId: s.id, targetType, claim, relation: 'about_subject' }];
    return [];
  }));
}

const GENERIC_DESIGN = new Set('casual classic modern contemporary everyday basic smart clothing apparel fashion style bag bags jacket top shirt dress shoe footwear'.split(' '));

const ORDINARY_DESIGN = new Set(styleTokens('regular slim relaxed loose fitted oversized fit straight cropped long short simple plain standard basic casual classic modern contemporary everyday smart athletic sportswear formal formalwear glamorous glamour sophisticated feminine masculine summer footwear tailoring luxury premium quality comfort durable versatile elegant chic timeless ' +
  'cotton wool silk linen leather canvas denim polyester nylon suede velvet satin ceramic wood metal glass plastic textile fabric knit jersey ' +
  'bag tote crossbody backpack wallet jacket coat shirt top tee dress gown suit blazer pant jean shoe sneaker boot loafer sandal furniture chair table bed sofa cabinet'));

/** Both the source slot and the candidate tag's meaning must establish design,
 * not material composition, ordinary fit or product scope. */
function distinctiveDesignClaim(claim: DiscoveryClaim): boolean {
  if (!['aesthetics', 'lineage', 'construction'].includes(claim.slot)) return false;
  return styleTokens(claim.name).some((w) => !ORDINARY_DESIGN.has(w) && !GENERIC_DESIGN.has(w) && !COLOR_WORDS.has(w));
}

export function distinctiveDesignEvidence(claim: DiscoveryClaim, tag: { id: string; label: string }): boolean {
  if (!distinctiveDesignClaim(claim)) return false;
  if (!/^urn:tag:(?:aesthetic_property|design_inspiration|cultural_relevance|personal_style|fashion_segment|signature_piece|signature_product|product_service|product_line|style|decor):/.test(tag.id)) return false;
  const words = styleTokens(claim.name);
  const candidate = styleTokens(tag.label);
  // Closed feature equivalents; no lineage, brand or culture inference.
  if (/^(?:stripes|floral|sequins|bow|canopy|colour-block|ribbed trim)$/i.test(claim.name)) {
    const patterns: Record<string, RegExp> = {
      stripes: /\bstrip(?:e|es|ed|ing)\b/i, floral: /\bfloral|flower print\b/i,
      sequins: /\bsequin(?:s|ed)?\b/i, bow: /\bbows?\b/i, canopy: /\bcanopy|four[\s-]poster\b/i,
      'colour-block': /\bcolou?r[\s-]?block(?:ed|ing)?\b/i, 'ribbed trim': /\brib(?:bed)?[\s-]+trim\b/i,
    };
    return patterns[claim.name.toLowerCase()]!.test(tag.label);
  }
  return words.length > 0 && words.every((w) => candidate.includes(w));
}

/** The design descriptor itself must refer to a compatible product, not an
 * unrelated product line elsewhere in the same diversified brand.
 */
export function designTagMatchesProduct(subject: StoredSubject, label: string): boolean {
  const descriptor = label.replace(/\bdress(?=\s+(?:sneakers?|shoes?|boots?))/gi, 'formal');
  const mentions = [
    [/\b(?:sneakers?|trainers?|shoes?|footwear|boots?)\b/i, ['footwear']],
    [/\b(?:dress(?:es)?|gowns?|bodices?)\b/i, ['dress']],
    [/\b(?:tees?|t[\s-]?shirts?|tops?|shirts?|sweatshirts?|hoodies?|jackets?)\b/i, ['apparel']],
    [/\b(?:bags?|handbags?|totes?)\b/i, ['bag']],
  ] as const;
  if (subject.category !== 'fashion') return !mentions.some(([re]) => re.test(descriptor));
  const kind = productKind(subject);
  return mentions.every(([re, kinds]) => !re.test(descriptor) || (kinds as readonly string[]).includes(kind));
}

export function hasMusicEvidence(entity: Pick<EvidenceEntity, 'tags'>): boolean {
  return (entity.tags ?? []).some((t) => /^urn:tag:genre:music(?::|$)/.test(t.id));
}

function commercialSubject(subject: StoredSubject): boolean {
  return !isArtworkSubject(subject) && (subject.category === 'fashion' ? fashionProductEligible(subject) : !!homeKindOfReading([subject]));
}

/** A geometric/first-subject anchor association cannot establish the subject's domain. */
export function seedMatchesSubject(subject: StoredSubject, types: readonly string[]): boolean {
  if (types.includes('urn:entity:brand')) return commercialSubject(subject);
  if (types.includes('urn:entity:movie') || types.includes('urn:entity:tv_show'))
    return subject.category === 'media' && /\b(?:films?|movies?|cinema|television|dvd|tv)\b/i.test(subject.label);
  if (types.includes('urn:entity:artist') || types.includes('urn:entity:album')) return isMusicSubject(subject);
  return (types.includes('urn:entity:place') || types.includes('urn:entity:destination')) && ['food', 'interior', 'place'].includes(subject.category);
}

/** Product compatibility is not a visual resemblance claim, and missing scope is unknown. */
function commercialTags(subject: StoredSubject, entity: EvidenceEntity): { id: string; name: string }[] | null {
  if (!commercialSubject(subject)) return null;
  const tags = entity.tags ?? [];
  if (subject.category !== 'fashion') {
    const kind = homeKindOfReading([subject])!;
    if (!wearIndustryAllowed({ tags }, kind) || !homeFamilyGenreAllowed(tags.map((t) => t.id))) return null;
    return tags.filter((t) => /^urn:tag:(?:industry|signature_piece|signature_product|product_line|product_service|genre:brand):/.test(t.id));
  }
  const profile = entityProfile(tags);
  if (profile.families.unknown || scoreMatch(subjectProfile(subject), profile).gate) return null;
  return tags.filter((t) => /^urn:tag:(?:genre:brand|signature_piece|signature_product|product_line|product_service):/.test(t.id));
}

function tasteProof(subject: StoredSubject, entity: EvidenceEntity, options: AdmissionOptions, targetType: string): CandidateProof | null {
  const taste = options.taste;
  if (!taste?.queryId || !taste.requestSeedIds.length) return null;
  const supplied = new Set(taste.requestSeedIds);
  const explained = new Set((entity.query?.explainability ?? []).filter((e) => Number.isFinite(e.score) && e.score > 0 && supplied.has(e.entity_id)).map((e) => e.entity_id));
  if (entity.query?.explainability?.length && !explained.size) return null;
  // With multiple seeds, the request alone cannot attribute the result to any one seed.
  const attributable = explained.size ? explained : supplied.size === 1 ? supplied : new Set<string>();
  const seeds = taste.seeds.filter((seed) => supplied.has(seed.id) && attributable.has(seed.id) && seed.subjectId === subject.id &&
    (!seed.claim || (seed.claim.slot !== 'materials' && connectionSourceClaims(subject).some((c) =>
      c.slot === seed.claim!.slot && c.name === seed.claim!.name && c.wording === seed.claim!.wording))));
  if (!seeds.length) return null;
  const claim: DiscoveryClaim = seeds[0]!.claim?.slot !== 'label' && seeds[0]!.claim
    ? seeds[0]!.claim : { slot: 'label', name: safeSubjectLabel(subject), wording: 'asserted' };
  return {
    subjectId: subject.id, candidateId: entity.entity_id, targetType, sourceQueryId: taste.queryId, relation: 'qloo_taste', origin: options.origin ?? 'style',
    claim, candidateTags: [],
    sourceEvidence: bindSourceEvidence(subject, claim, options.readingRev),
    ...(options.readingRev === undefined ? {} : { readingRev: options.readingRev }),
    provenance: { queryId: taste.queryId, seedIds: [...new Set(seeds.map((s) => s.id))], seedNames: [...new Set(seeds.map((s) => s.name))], attribution: explained.size ? 'returned_explainability' : 'single_request_seed' },
  };
}

export function proofIsActive(proof: CandidateProof, subjects: readonly StoredSubject[]): boolean {
  const subject = subjects.find((s) => s.id === proof.subjectId);
  if (!subject) return false;
  if (proof.relation === 'shared_named_work') return true;
  const sameClaim = (claim: DiscoveryClaim) => claim.slot === proof.claim.slot &&
    ((claim.slot === 'label' ? safeSubjectLabel(subject) : claim.name) === proof.claim.name ||
      (!proof.sourceEvidence && claim.name === proof.claim.name)) && claim.wording === proof.claim.wording;
  if (!connectionSourceClaims(subject).some(sameClaim)) return false;
  if (proof.sourceEvidence) {
    const expected = bindSourceEvidence(subject, proof.claim, proof.readingRev);
    if (!sameSourceEvidence(expected, proof.sourceEvidence)) return false;
  }
  const content = proof.contentEvidence;
  return !content?.topicPlanKey || (sameClaim(content.claim) && planConnectionTopics([subject]).some((plan) =>
    plan.key === content.topicPlanKey && sameClaim(plan.claim) && plan.sourceCue === content.sourceCue));
}

/** Retrieval planning only: a tag is not a candidate entity and cannot earn a CandidateProof. */
export function topicTagRelation(subject: StoredSubject, tag: { id: string; name: string }, targetType: string): { claim: DiscoveryClaim; relation: DiscoveryRelation } | null {
  const claim = topicClaim(subject, tag, targetType);
  if (claim) return { claim, relation: sharedCulture(claim.name, tag.name) ? 'shared_subculture' : 'shared_topic' };
  if (targetType === 'urn:entity:movie' || targetType === 'urn:entity:tv_show') {
    const about = aboutSubject(subject, tag);
    if (about) return { claim: about, relation: 'about_subject' };
  }
  return null;
}

/**
 * Origin is audit metadata, never a waiver. Anchor, bridge and fill all prove a relation
 * against an active subject. Exact visual anchors are exclusions, not discoveries.
 */
export function admitDiscovery(
  subjects: readonly StoredSubject[], entity: EvidenceEntity, targetType: string, options: AdmissionOptions = {},
): CandidateProof | null {
  if (options.excludedIds?.has(entity.entity_id) || (entity.name && options.excludedNames?.has(echoKey(entity.name)))) return null;
  if (!entity.types?.includes(targetType)) return null;
  if (targetType === 'urn:entity:artist' && !hasMusicEvidence(entity)) return null;
  if (!['urn:entity:brand', 'urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:artist', 'urn:entity:place', 'urn:entity:destination'].includes(targetType)) return null;
  if (options.topicPlan && targetType !== 'urn:entity:movie' && targetType !== 'urn:entity:tv_show') return null;
  const tags = (entity.tags ?? []).filter((t) => !options.tagIds || options.tagIds.has(t.id));
  if (options.tagIds && !tags.length) return null;
  let exploratory: CandidateProof | null = null;
  for (const original of subjects) {
    if (options.subjectIds && !options.subjectIds.has(original.id)) continue;
    if (options.topicPlan && !activeConnectionTopicPlan(original, options.topicPlan)) continue;
    const subject = activeSubject(original);
    if (subject.entity?.id === entity.entity_id || (entity.name && [subject.brand?.name, subject.entity?.name].some((name) => name && echoKey(name) === echoKey(entity.name!)))) continue;
    const proof = (relation: DiscoveryRelation, originalClaim: DiscoveryClaim, tag?: { id: string; name: string }): CandidateProof => {
      const claim = originalClaim.slot === 'label' ? { ...originalClaim, name: safeSubjectLabel(subject) } : originalClaim;
      return {
        subjectId: subject.id, ...(options.readingRev === undefined ? {} : { readingRev: options.readingRev }),
        relation, origin: options.origin ?? 'style', claim, candidateId: entity.entity_id, targetType,
        ...(options.queryId ? { sourceQueryId: options.queryId } : {}),
        candidateTags: tag ? [{ id: tag.id, label: tag.name }] : [],
        sourceEvidence: bindSourceEvidence(original, claim, options.readingRev),
      };
    };
    if (targetType === 'urn:entity:brand') {
      const scopeTags = commercialTags(subject, entity);
      if (!scopeTags?.length) continue;
      // Raw observations previously stranded outside the affinity profile now
      // contribute closed, bound construction/pattern evidence.
      for (const feature of compileSourceFeaturePlan([original], options.readingRev ?? 1).features) {
        if (feature.kind === 'object_form') continue;
        const tag = tags.find((t) => distinctiveDesignEvidence(feature.claim, { id: t.id, label: t.name }) && designTagMatchesProduct(subject, t.name));
        if (tag) return proof('shared_design', feature.claim, tag);
      }
      const q = subjectProfile(subject);
      const match = scoreMatch(q, entityProfile(tags), { fashion: subject.category === 'fashion',
        acceptHit: (hit) => {
          const claim = connectionSourceClaims(subject).find((c) => c.slot === hit.slot && c.name === hit.claim);
          return !!claim && distinctiveDesignEvidence(claim, { id: hit.tagId, label: hit.label }) && designTagMatchesProduct(subject, hit.label);
        },
      });
      if (match.gate) continue;
      for (const hit of match.hits) {
        if (hit.level !== 'name' || hit.slot === 'entity' || hit.slot === 'details' || hit.slot === 'mood' || hit.slot === 'era' || GENERIC_DESIGN.has(hit.token)) continue;
        // A generic thing noun is not the second rail's design evidence.
        if (hit.slot === 'label') continue;
        const claim = connectionSourceClaims(subject).find((c) => c.slot === hit.slot && c.name === hit.claim);
        const tag = tags.find((t) => t.id === hit.tagId);
        if (claim && tag && hit.coverage >= 0.5 && styleTokens(claim.name).every((word) => styleTokens(tag.name).includes(word)))
          return proof('shared_design', claim, tag);
      }
      const taste = tasteProof(subject, entity, options, targetType);
      exploratory ??= taste ?? proof('brand_exploration', { slot: 'label', name: subject.label, wording: 'asserted' }, scopeTags[0]);
      continue;
    }
    if (targetType === 'urn:entity:place' || targetType === 'urn:entity:destination') {
      // A restaurant or destination card must really be typed as such. City constrains a
      // request; it never identifies the location of the photographed subject.
      const place = options.place;
      if (!entity.types?.includes(targetType) || !place?.city.trim() || place.requestType !== targetType) continue;
      const address = entity.properties?.address;
      const cityKey = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const city = cityKey(place.city.split(',')[0]!);
      if (typeof address === 'string' && address.trim() && !` ${cityKey(address)} `.includes(` ${city} `)) continue;
      const tag = tags.find((t) => place.filterTagIds.includes(t.id));
      const taste = tasteProof(subject, entity, options, targetType);
      if (!tag && !taste) continue;
      return { ...proof('place_exploration', { slot: 'label', name: subject.label, wording: 'asserted' }, tag), ...(taste?.provenance ? { provenance: taste.provenance } : {}) };
    }
    if (targetType === 'urn:entity:movie' || targetType === 'urn:entity:tv_show') {
      const content = documentaryEvidence(subject, entity, options.topicPlan);
      if (content && (!options.tagIds || tags.length)) {
        return {
          ...proof('about_subject', content.claim),
          candidateTags: [...(options.tagIds ? tags.slice(0, 3).map((t) => ({ id: t.id, label: t.name })) : []),
            ...(content.documentaryTag ? [content.documentaryTag] : []), ...(content.topicTag ? [content.topicTag] : [])]
            .filter((t, i, all) => all.findIndex((x) => x.id === t.id) === i),
          contentEvidence: content,
        };
      }
      if (options.requireContent || options.topicPlan) continue;
    }
    for (const tag of tags) {
      const claim = topicClaim(subject, tag, targetType);
      if (claim && claim.slot !== 'materials' && connectionSourceClaims(subject).some((c) => c.slot === claim.slot && c.name === claim.name) &&
        ((targetType !== 'urn:entity:movie' && targetType !== 'urn:entity:tv_show') ||
          sharedCulture(claim.name, tag.name) || (subject.category === 'media' && /\b(?:films?|movies?|cinema|television|dvd|tv|music|albums?|records?)\b/i.test(subject.label))))
        return proof(sharedCulture(claim.name, tag.name) ? 'shared_subculture' : 'shared_topic', claim, tag);
    }
    if ((targetType === 'urn:entity:movie' || targetType === 'urn:entity:tv_show') &&
      subject.category === 'media' && /\b(?:films?|movies?|cinema|television|dvd|tv)\b/i.test(subject.label))
      for (const tag of tags) {
        const claim = aboutSubject(subject, tag);
        if (claim) return proof('about_subject', claim, tag);
      }
    const taste = tasteProof(subject, entity, options, targetType);
    exploratory ??= taste;
  }
  return exploratory;
}

/** Exact-title discovery is intentionally separate from style and anchor-echo admission. */
export function sameNamedWorkTitle(candidate: string, work: string): boolean {
  const key = (name: string) => normalizeStyleName(name).replace(/^the\s+/, '');
  return !!key(work) && key(candidate) === key(work);
}

export function namedWorkProof(subjectId: string, entityId: string, name: string, referenceId: string, wording: 'asserted' | 'resembles', readingRev?: number, sourceQueryId?: string): CandidateProof {
  return {
    subjectId, candidateId: entityId, targetType: 'urn:entity:movie', ...(sourceQueryId ? { sourceQueryId } : {}), relation: 'shared_named_work', origin: 'anchor',
    claim: { slot: 'label', name, wording }, candidateTags: [], referenceId,
    ...(readingRev === undefined ? {} : { readingRev }),
  };
}

/** Only labels actually on the candidate and the active claim that proved the relation. */
export function discoveryReason(proof: CandidateProof, targetType: string): string {
  const noun = targetType === 'urn:entity:artist' ? 'An artist' : targetType === 'urn:entity:brand' ? 'A brand' : 'A film';
  const tag = proof.candidateTags[0]?.label;
  const photoLink = proof.claim.wording === 'resembles' ? ', which your photo resembles' : ' in your photo';
  const compactLink = proof.claim.wording === 'resembles' ? ' (photo resemblance)' : ' in your photo';
  const compact = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
  if (proof.contentEvidence) {
    const content = proof.contentEvidence;
    const kind = content.kind === 'topic_film' ? 'Film' : 'Documentary';
    const cue = content.sourceCue ?? 'source appearance';
    return fitReason(
      `${kind} on ${content.topic}; prompted by ${cue} your photo may suggest`,
      `${kind} on ${compact(content.topic, 20)}; ${compact(cue, 26)} (photo resemblance)`,
    );
  }
  if (proof.relation === 'catalogue_facet') return fitReason(`${noun} tagged ${tag}`, `${noun} tagged ${tag}`);
  if (proof.relation === 'qloo_taste') {
    const names = proof.provenance?.seedNames.join(' and ');
    return fitReason(`Explore a Qloo taste connection through ${names}`, `Explore Qloo taste via ${proof.provenance?.seedNames[0] ?? 'a supplied seed'}`);
  }
  if (proof.relation === 'shared_design')
    return fitReason(
      `A brand tagged ${tag ?? proof.claim.name}; connected to ${proof.claim.name}${photoLink}`,
      `Brand tag ${compact(tag ?? proof.claim.name, 20)}; ${compact(proof.claim.name, 20)}${compactLink}`,
    );
  if (proof.relation === 'brand_exploration')
    return fitReason(`A brand to explore; catalogue tag: ${tag ?? proof.claim.name}`, 'A brand to explore');
  if (proof.relation === 'place_exploration')
    return fitReason(`A place to explore${tag ? `; tagged ${tag}` : ''}`, 'A place to explore');
  if (proof.relation === 'shared_named_work') {
    const lead = `A film sharing its title with ${proof.claim.name}`;
    const full = `${lead}, the work ${proof.claim.wording === 'resembles' ? 'your photo resembles' : 'in your photo'}`;
    return fitReason(full, lead);
  }
  const lead = `${noun} tagged ${tag ?? proof.claim.name}`;
  const tail = proof.relation === 'about_subject'
    ? `exploring a topic connected to ${proof.claim.name}`
    : `connected to ${proof.claim.name}${proof.claim.wording === 'resembles' ? ', which your photo resembles' : ' in your photo'}`;
  return fitReason(`${lead}; ${tail}`, `${noun} tagged ${compact(tag ?? proof.claim.name, 20)}; linked to ${compact(proof.claim.name, 20)}${compactLink}`);
}

function fitReason(full: string, short: string): string {
  if (full.length <= 90) return full;
  if (short.length <= 90) return short;
  return `${short.slice(0, 89).trimEnd()}…`;
}
