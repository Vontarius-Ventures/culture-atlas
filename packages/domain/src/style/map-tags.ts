import type { QlooTag, StyleCategory } from '@culture-atlas/providers';
import type { ClaimQloo, StoredClaim, StoredSubject } from './types';
import { idLabel, normalizeStyleName, type StyleVocabulary, type VocabEntry } from './vocabulary';

/**
 * Attribute -> Qloo tag ids (style design §C.2). Exact acceptance only:
 * the normalized claim name or tag_query must equal the normalized tag name
 * or last id segment, or a reviewed alias. Namespaces are routed by subject
 * category and slot; a tag is a hard filter only when it is type-compatible
 * with the rail's output type and the claim is asserted (or a resembles
 * claim a Qloo entity corroborates). No hit, no invention (qloo: null).
 */
export const STYLE_MAP_VERSION = 'smap-1';

type MapSlot = 'aesthetics' | 'materials' | 'lineage' | 'era' | 'mood';
interface Route {
  namespaces: readonly string[];
  method: 'vocab' | 'tags' | 'both';
}

/** Media subjects about music (album, record, gig poster) route to music genres. */
export function mediaKind(subject: Pick<StoredSubject, 'category' | 'label'>): 'music' | 'film' | null {
  if (subject.category !== 'media') return null;
  return /\b(?:albums?|vinyl|records?|lp|cds?|cassettes?|bands?|concerts?|gigs?|music|songs?|tour)\b/i.test(subject.label) ? 'music' : 'film';
}

export function routeFor(subject: Pick<StoredSubject, 'category' | 'label'>, slot: MapSlot): Route | null {
  switch (subject.category) {
    case 'fashion':
      // design_inspiration is last: the closed tag_query list (R-2) offers its labels, so an aesthetic chosen
      // from it ("Vintage Americana") must be able to map (first live check: an asserted aesthetic was lost).
      if (slot === 'aesthetics') return { namespaces: ['fashion_segment', 'personal_style', 'aesthetic_property', 'design_inspiration'], method: 'vocab' };
      if (slot === 'materials') return { namespaces: ['material'], method: 'vocab' };
      if (slot === 'lineage' || slot === 'era') return { namespaces: ['design_inspiration', 'cultural_relevance'], method: 'vocab' };
      return null;
    case 'interior':
      if (slot === 'aesthetics') return { namespaces: ['decor', 'aesthetic_property', 'setting', 'ambience'], method: 'both' };
      if (slot === 'materials') return { namespaces: ['aesthetic_property', 'decor'], method: 'both' };
      return null;
    case 'food':
      if (slot === 'aesthetics' || slot === 'lineage') return { namespaces: ['genre:place', 'cuisine', 'menu_highlight', 'specialty_dish'], method: 'tags' };
      return null;
    case 'place':
      if (slot === 'aesthetics') return { namespaces: ['decor', 'setting', 'ambience'], method: 'both' };
      return null;
    case 'media':
      if (mediaKind(subject) === 'music') return slot === 'aesthetics' ? { namespaces: ['genre:music'], method: 'tags' } : null;
      if (slot === 'aesthetics' || slot === 'mood') return { namespaces: ['style', 'theme', 'subgenre', 'genre:media'], method: 'both' };
      return null;
    default:
      return null;
  }
}

/** The entity types a subject's "More like this" rail returns (C.3). */
export function outputTypesFor(subject: Pick<StoredSubject, 'category' | 'label'>): string[] {
  switch (subject.category) {
    case 'fashion':
      return ['urn:entity:brand'];
    case 'interior':
      return ['urn:entity:place', 'urn:entity:brand'];
    case 'food':
    case 'place':
      return ['urn:entity:place'];
    case 'media':
      return mediaKind(subject) === 'music' ? ['urn:entity:artist'] : ['urn:entity:movie'];
    default:
      return [];
  }
}

/** Namespace of a tag id or type ("urn:tag:decor:qloo:japandi" -> "decor", "urn:tag:genre:place:restaurant:ramen" -> "genre:place"). */
export function tagNamespace(idOrType: string): string | null {
  const m = /^urn:tag:([a-z_]+)(?::([a-z_]+))?/.exec(idOrType);
  if (!m) return null;
  if (m[1] === 'genre' && m[2]) return `genre:${m[2]}`;
  return m[1]!;
}

/** Families never used for style (C.2 rule 3), unless the route names the namespace for the category. */
const STYLE_FORBIDDEN = ['occupation', 'category', 'offerings', 'amenity', 'amenities', 'nearby_attraction', 'neighborhood_characteristics', 'keyword', 'good_for', 'noise_level', 'room_type', 'target_gender', 'target_age_group', 'target_income_level', 'market_archetype'];

export function allowedNamespace(category: StyleCategory, ns: string, route: Route, id: string): boolean {
  if (STYLE_FORBIDDEN.includes(ns)) return false;
  if ((ns === 'specialty_dish' || ns === 'menu_highlight') && category !== 'food') return false;
  if (ns === 'genre:place' && !id.startsWith('urn:tag:genre:place:restaurant')) return false;
  return route.namespaces.includes(ns);
}

/** /v2/tags queries the mapper needs for one subject (C.2: non-fashion only, de-duplicated by the caller). */
export function tagLookupQueries(subject: StoredSubject): string[] {
  const out: string[] = [];
  const add = (slot: MapSlot, claims: readonly (StoredClaim & { tag_query?: string | null })[]) => {
    const route = routeFor(subject, slot);
    if (!route || route.method === 'vocab') return;
    for (const c of claims) if (!c.held && !c.retracted) out.push(c.tag_query || c.name);
  };
  add('aesthetics', subject.aesthetics);
  add('materials', subject.materials);
  add('lineage', subject.lineage);
  if (subject.category === 'media') add('mood', subject.mood);
  return [...new Set(out.map((q) => q.trim()).filter(Boolean))];
}

interface Hit {
  id: string;
  ns: string;
  entityTypes: string[];
  acceptance: ClaimQloo['acceptance'];
}

function vocabHits(v: StyleVocabulary, keys: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const key of keys) {
    for (const e of v.byName.get(key) ?? []) hits.push({ id: e.id, ns: e.namespace, entityTypes: e.entityTypes, acceptance: 'vocab_exact' });
    const alias = v.aliases.get(key);
    const e: VocabEntry | undefined = alias ? v.byId.get(alias) : undefined;
    if (e) hits.push({ id: e.id, ns: e.namespace, entityTypes: e.entityTypes, acceptance: 'alias' });
  }
  return hits;
}

function tagHits(tags: readonly QlooTag[], keys: readonly string[]): Hit[] {
  return tags
    .filter((t) => keys.includes(normalizeStyleName(t.name)) || keys.includes(idLabel(t.id)))
    .map((t) => ({ id: t.id, ns: tagNamespace(t.type || t.id) ?? '', entityTypes: [...(t.parents ?? [])].filter((p) => p.startsWith('urn:entity:')), acceptance: 'tags_exact' as const }));
}

/**
 * C.2 rules 1-8 for one claim. `kind` decides strength (rule 7); `resolved`
 * filters the claim's own words (name, tag_query) against the vocabulary and
 * the recorded /v2/tags results for its query.
 */
export function mapClaim(
  subject: Pick<StoredSubject, 'category' | 'label'>,
  slot: MapSlot,
  claim: Pick<StoredClaim, 'name' | 'wording' | 'corroborated_by' | 'held' | 'retracted'> & { tag_query?: string | null },
  v: StyleVocabulary,
  tagResults: ReadonlyMap<string, readonly QlooTag[]>,
): ClaimQloo | null {
  if (claim.held || claim.retracted) return null;
  const route = routeFor(subject, slot);
  if (!route) return null;
  const keys = [...new Set([normalizeStyleName(claim.name), claim.tag_query ? normalizeStyleName(claim.tag_query) : ''].filter(Boolean))];
  const raw: Hit[] = [];
  if (route.method !== 'tags') raw.push(...vocabHits(v, keys));
  if (route.method !== 'vocab') {
    const query = (claim.tag_query || claim.name).trim();
    raw.push(...tagHits(tagResults.get(query) ?? [], keys));
  }
  // Rule 3: namespace allowed for the category (Q-STYLE-NS); then de-duplicate ids.
  const seen = new Set<string>();
  const hits = raw.filter((h) => allowedNamespace(subject.category, h.ns, route, h.id) && !seen.has(h.id) && seen.add(h.id));
  if (!hits.length) return null;
  // Rule 5: first in namespace priority; the rest only for reason overlap.
  hits.sort((a, b) => route.namespaces.indexOf(a.ns) - route.namespaces.indexOf(b.ns));
  const outputs = outputTypesFor(subject);
  // Rule 6: doubt when equal-priority namespaces match and they serve different output types.
  const top = hits[0]!;
  const samePriority = hits.filter((h) => h.ns !== top.ns && route.namespaces.indexOf(h.ns) === route.namespaces.indexOf(top.ns));
  const compatible = (h: Hit) => h.entityTypes.some((t) => outputs.includes(t));
  let chosen = top;
  let doubt = false;
  if (samePriority.length) {
    const forCategory = [top, ...samePriority].filter(compatible);
    if (forCategory.length === 1) chosen = forCategory[0]!;
    else doubt = true;
  }
  const typeOk = compatible(chosen);
  // Rule 7: strength by wording.
  let use: ClaimQloo['use'];
  let weight: number;
  if (slot === 'aesthetics') {
    const strong = claim.wording === 'asserted' || claim.corroborated_by.includes('qloo_entity');
    use = !typeOk || doubt ? (typeOk ? 'signal' : 'reason') : strong ? 'filter' : 'signal';
    weight = strong ? 1 : 0.5;
  } else if (slot === 'materials') {
    use = typeOk && !doubt ? 'signal' : 'reason';
    weight = claim.wording === 'asserted' ? 0.6 : 0.5;
  } else {
    use = typeOk && !doubt ? 'signal' : 'reason';
    weight = 0.3;
  }
  return {
    tag_ids: [chosen.id],
    alt_ids: hits.filter((h) => h.id !== chosen.id).map((h) => h.id),
    acceptance: chosen.acceptance,
    namespace: chosen.ns,
    use,
    weight,
    entity_types: chosen.entityTypes,
    ...(doubt ? { doubt: true } : {}),
  };
}

/** Maps every claim of a subject in place (C.2). Construction, details and palette never map (display and reasons only). */
export function mapSubjectTags(subject: StoredSubject, v: StyleVocabulary, tagResults: ReadonlyMap<string, readonly QlooTag[]>): void {
  for (const a of subject.aesthetics) a.qloo = mapClaim(subject, 'aesthetics', a, v, tagResults);
  for (const m of subject.materials) m.qloo = mapClaim(subject, 'materials', m, v, tagResults);
  for (const l of subject.lineage) l.qloo = mapClaim(subject, 'lineage', l, v, tagResults);
  if (subject.era) subject.era.qloo = mapClaim(subject, 'era', subject.era, v, tagResults);
  if (subject.category === 'media') for (const m of subject.mood) m.qloo = mapClaim(subject, 'mood', m, v, tagResults);
}

/** Slot weights for the overlap re-rank and reasons (C.3 list C). */
export const SLOT_WEIGHT = { aesthetics: 1, materials: 0.6, lineage: 0.4, era: 0.4, mood: 0.3 } as const;

export interface AcceptedTag {
  id: string;
  slot: keyof typeof SLOT_WEIGHT;
  claimName: string;
  wording: StoredClaim['wording'];
  weight: number;
  /** Primary id (not an alt id). */
  primary: boolean;
  use: ClaimQloo['use'];
}

/** Every accepted tag id of a subject (primary and alternate), for overlap and reasons. */
export function acceptedTags(subject: StoredSubject): AcceptedTag[] {
  const out: AcceptedTag[] = [];
  const push = (slot: AcceptedTag['slot'], c: StoredClaim) => {
    if (!c.qloo || c.held || c.retracted) return;
    for (const id of c.qloo.tag_ids) out.push({ id, slot, claimName: c.name, wording: c.wording, weight: SLOT_WEIGHT[slot], primary: true, use: c.qloo.use });
    for (const id of c.qloo.alt_ids) out.push({ id, slot, claimName: c.name, wording: c.wording, weight: SLOT_WEIGHT[slot], primary: false, use: 'reason' });
  };
  subject.aesthetics.forEach((c) => push('aesthetics', c));
  subject.materials.forEach((c) => push('materials', c));
  subject.lineage.forEach((c) => push('lineage', c));
  if (subject.era) push('era', subject.era);
  subject.mood.forEach((c) => push('mood', c));
  return out;
}

/** The subject's best filter tag F (C.2 rule 7): the highest-certainty filterable aesthetic. */
export function bestFilterTag(subject: StoredSubject): { id: string; claimName: string } | null {
  const a = [...subject.aesthetics].filter((c) => c.qloo?.use === 'filter' && !c.held && !c.retracted).sort((x, y) => y.certainty - x.certainty)[0];
  return a?.qloo ? { id: a.qloo.tag_ids[0]!, claimName: a.name } : null;
}

/**
 * The subject's primary style tag: F when there is one, else the
 * highest-certainty aesthetic that mapped to a type-compatible tag (a
 * "resembles" one). Exemplars must carry it, so they share the subject's
 * style family, not only a material (first live check: "faux leather" plus a
 * loose "casual" signal picked fast-fashion brands for a varsity bomber).
 */
export function primaryStyleTag(subject: StoredSubject): { id: string; claimName: string } | null {
  const f = bestFilterTag(subject);
  if (f) return f;
  const a = [...subject.aesthetics].filter((c) => c.qloo && c.qloo.use !== 'reason' && !c.held && !c.retracted).sort((x, y) => y.certainty - x.certainty)[0];
  return a?.qloo ? { id: a.qloo.tag_ids[0]!, claimName: a.name } : null;
}
