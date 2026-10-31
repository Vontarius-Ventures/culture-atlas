import type { StoredClaim, StoredSubject } from './types';
import { observationDiscoveryClaims } from './source-feature-plan';

/** One guard for every consumer of a reading. Hidden evidence cannot widen retrieval. */
export function activeClaim<T extends Pick<StoredClaim, 'held' | 'retracted'>>(claim: T | null | undefined): claim is T {
  return !!claim && !claim.held && !claim.retracted;
}

export function activeSubject(subject: StoredSubject): StoredSubject {
  return {
    ...subject,
    aesthetics: subject.aesthetics.filter(activeClaim),
    lineage: subject.lineage.filter(activeClaim),
    materials: subject.materials.filter(activeClaim),
    construction: subject.construction.filter(activeClaim),
    details: subject.details.filter(activeClaim),
    mood: subject.mood.filter(activeClaim),
    era: activeClaim(subject.era) ? subject.era : null,
  };
}

export type DiscoverySlot = 'label' | 'aesthetics' | 'lineage' | 'materials' | 'construction' | 'era';
export interface DiscoveryClaim {
  slot: DiscoverySlot;
  name: string;
  wording: 'asserted' | 'resembles';
}

export function discoveryClaims(subject: StoredSubject): DiscoveryClaim[] {
  const s = activeSubject(subject);
  const out: DiscoveryClaim[] = [];
  for (const slot of ['aesthetics', 'lineage', 'materials', 'construction'] as const)
    for (const c of s[slot]) out.push({ slot, name: c.name, wording: c.wording });
  if (s.era) out.push({ slot: 'era', name: s.era.name, wording: s.era.wording });
  for (const claim of observationDiscoveryClaims(s))
    if (!out.some((c) => c.slot === claim.slot && c.name === claim.name && c.wording === claim.wording)) out.push(claim);
  out.push({ slot: 'label', name: s.label, wording: 'asserted' });
  return out;
}

/** Literal words, not the fashion stemmer: "kicks her out" is not sneaker evidence. */
export function conceptWords(text: string): string[] {
  return [...new Set(text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[’'`]/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))];
}

const QUALIFIERS = new Set('the and with for from look looks like resembles inspired suggests style design warm cozy playful sweet classic casual contemporary aesthetic'.split(' '));
export function conceptContent(text: string): string[] {
  return conceptWords(text).filter((w) => !QUALIFIERS.has(w));
}

/**
 * Positive relations, not homonym blacklists. These concepts have a documented shared
 * visual/music culture; a region, material, or generic adjective has no such relation.
 */
export const SHARED_SUBCULTURES: readonly string[] = ['punk', 'grunge', 'goth', 'gothic', 'mod', 'psychedelic', 'hip hop', 'hip-hop', 'varsity', 'campus'];
const ACTIVITY_TOPICS = ['tennis', 'athletic', 'skateboarding', 'sneakers', 'sneaker'];

export function sharedCulture(claim: string, tag: string): boolean {
  const has = (text: string, term: string) => {
    const words = conceptWords(text);
    return conceptWords(term).every((w) => words.includes(w));
  };
  return SHARED_SUBCULTURES.some((term) => has(claim, term) && has(tag, term));
}

export function isMusicSubject(subject: Pick<StoredSubject, 'category' | 'label'>): boolean {
  return subject.category === 'media' && /\b(?:music|albums?|vinyl|records?|bands?|concerts?|songs?|sleeves?|soundtracks?)\b/i.test(subject.label);
}

/** Reusable, directional about-subject relations. Generic "Design" alone is not one. */
const ABOUT_RELATIONS: readonly { source: RegExp; topic: RegExp; categories: readonly StoredSubject['category'][] }[] = [
  { source: /\b(?:architectur\w*|buildings?|palaces?|facades?|rooms?|interiors?|houses?|urbanism)\b/i,
    topic: /\b(?:architectur\w*|architects?|urbanism|interior design)\b/i, categories: ['interior', 'place'] },
  { source: /\b(?:food|ramen|noodles?|espresso|coffee|cafes?|cafe|cooking|cuisine|dishes?|meals?)\b/i,
    topic: /\b(?:food|cooking|culinary|cuisine|ramen|noodles?|espresso|coffee|cafes?)\b/i, categories: ['food'] },
  { source: /\b(?:ceramics?|pottery|porcelain|slipware|lustreware|lusterware|earthenware|stoneware|terracotta)\b/i,
    topic: /\b(?:ceramics?|pottery|porcelain|crafts?|artisans?)\b/i, categories: ['interior', 'place', 'media'] },
  { source: /\b(?:paintings?|portraits?|portraiture|illustrations?|artworks?|sculptures?|statues?|busts?|oil paint)\b/i,
    topic: /\b(?:painting|painter|portraiture|artist|artwork|sculpture|sculptor|museum|gallery)s?\b/i, categories: ['interior', 'place', 'media', 'fashion'] },
  { source: /\b(?:cafes?|coffeehouses?)\b/i,
    topic: /\b(?:cafes?|coffee|coffeehouses?)\b/i, categories: ['interior', 'place', 'media'] },
  { source: /\b(?:furniture|beds?|sofas?|chairs?|cabinets?)\b/i,
    topic: /\b(?:furniture|interior design)\b/i, categories: ['interior'] },
];

/** Search terms, never fabricated tag IDs or claims about the object's origin. */
export function subjectTopicQueries(subject: StoredSubject): string[] {
  const claims = discoveryClaims(subject);
  const supports = (name: string) => ABOUT_RELATIONS.some((relation) =>
    relation.categories.includes(subject.category) && relation.topic.test(name) &&
    claims.some((claim) => relation.source.test(claim.name)));
  if (claims.some((c) => /\b(?:sculptures?|statues?|busts?)\b/i.test(c.name)) && supports('Sculpture')) return ['sculpture', 'museum'];
  if (supports('Pottery')) return ['pottery', 'ceramics'];
  if (claims.some((c) => /\b(?:coffee|espresso|cafes?|coffeehouses?)\b/i.test(c.name)) && supports('Coffee')) return ['coffee', 'cafe'];
  if (supports('Architecture')) return ['architecture', 'interior design'];
  if (supports('Furniture')) return ['interior design', 'furniture'];
  if (supports('Painting')) return ['painting', 'artist'];
  if (supports('Cooking')) return ['cooking', 'food'];
  return [];
}

export function aboutSubject(subject: StoredSubject, tag: { id: string; name: string }): DiscoveryClaim | null {
  // A plot keyword is not evidence that the work is ABOUT this domain.
  if (!/^urn:tag:(?:genre|subgenre|theme)(?::|$)/.test(tag.id)) return null;
  for (const relation of ABOUT_RELATIONS) {
    if (!relation.categories.includes(subject.category) || !relation.topic.test(tag.name)) continue;
    const claim = discoveryClaims(subject).find((c) => relation.source.test(c.name));
    if (claim) return claim;
  }
  return null;
}

/** Same concept in its proper target sense, never merely an adjective's spelling. */
export function topicClaim(subject: StoredSubject, tag: { id: string; name: string }, target: string): DiscoveryClaim | null {
  const claims = discoveryClaims(subject);
  if (target === 'urn:entity:artist') {
    if (!/^urn:tag:genre:music(?::|$)/.test(tag.id)) return null;
    return claims.find((c) => c.slot !== 'materials' && c.slot !== 'construction' &&
      (sharedCulture(c.name, tag.name) || (isMusicSubject(subject) && coversConcept(c.name, tag.name)))) ?? null;
  }
  if (target !== 'urn:entity:movie' && target !== 'urn:entity:tv_show') return null;
  if (/^urn:tag:genre:music(?::|$)/.test(tag.id)) return null;
  const filmSubject = subject.category === 'media' && /\b(?:films?|movies?|cinema|television|dvd|tv)\b/i.test(subject.label);
  // Qloo's visual style is not a narrative topic for a sculpture, illustration or room.
  if (/^urn:tag:style(?::|$)/.test(tag.id) && !filmSubject) return null;
  if (!/^urn:tag:(?:genre|subgenre|theme|keyword|style)(?::|$)/.test(tag.id)) return null;
  return claims.find((c) => {
    if (c.slot === 'era' && subject.category !== 'media') return false;
    if (sharedCulture(c.name, tag.name)) return true;
    const words = conceptContent(c.name);
    const tagWords = conceptContent(tag.name);
    if (!words.length || !tagWords.length) return false;
    if (subject.category === 'fashion' && ACTIVITY_TOPICS.some((w) => words.includes(w) && tagWords.includes(w))) return true;
    // A concrete narrative topic can be named by its head; abstract visual qualifiers cannot.
    if (['motel', 'decay', 'pottery', 'ceramics', 'ramen', 'espresso', 'coffee'].some((w) => words.includes(w) && tagWords.includes(w))) return true;
    if (subject.category === 'media' && isMusicSubject(subject)) return false;
    const ownFilmSense = subject.category === 'media' && /\b(?:films?|movies?|cinema|television|dvd|tv)\b/i.test(subject.label);
    return coversConcept(c.name, tag.name) && (words.length >= 2 || ownFilmSense);
  }) ?? null;
}

function coversConcept(claim: string, tag: string): boolean {
  const words = conceptContent(claim);
  const target = conceptContent(tag);
  return words.length > 0 && words.every((w) => target.includes(w));
}
