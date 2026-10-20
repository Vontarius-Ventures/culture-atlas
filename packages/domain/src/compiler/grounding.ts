import { brandHeadToken, brandReadIn, hasMediumWord, type QlooEntity, type QlooEntityType, type QlooTag } from '@culture-atlas/providers';
import { canonicalTokens, sameTokens, strictSubset } from './text';

export { canonicalTokens } from './text';

/**
 * Qloo grounding acceptance rules (docs/quality-plan.md §5, package P3).
 *
 * The model proposes a candidate; this pure module decides whether Qloo is
 * asked about it at all (planLookup) and whether a returned entity or tag is
 * the SAME thing (acceptMatch). It replaces fuzzy name similarity: a result is
 * accepted only on a compatible type and an exact canonical name, and any
 * doubt becomes a reference under the candidate's own name, never a
 * look-alike's name. No I/O; every decision carries a rule id and a reason.
 */
export const GROUNDING_VERSION = 'ground-v5';

export type GroundingRule = 'Q-TYPE' | 'Q-TAGTYPES' | 'Q-NAME' | 'Q-SUBSET' | 'Q-PLACE' | 'Q-EVIDENCE' | 'Q-DOUBT';

/**
 * A candidate after the guardrails (P1). Every field the guardrails add is
 * optional so legacy readings (no domain/evidence) and user-named references
 * pass through the same rules.
 */
export interface GuardedCandidate {
  name: string;
  type: string;
  relation: 'depicted' | 'resembles' | 'user_selected';
  certainty: number;
  tag_queries?: readonly string[];
  tag_query?: string | null;
  suggested_categories?: readonly string[];
  domain?: string | null;
  evidence?: string | null;
  evidence_text?: string | null;
  /** G-BRAND-CORROBORATE passed: the brand's head token was read in the photo. */
  corroborated?: boolean;
  /** Named by the user in a correction: the user is the evidence. */
  userSelected?: boolean;
  /**
   * A text-only reference (guardrails G-TEXT-ONLY, requalification decision
   * 2): a name read only in the stage-2 reply. Never searched in Qloo.
   */
  text_only?: boolean | null;
}

export type LookupPlan =
  | { kind: 'none'; reason: string }
  | { kind: 'tags'; query: string; tagTypes: string[] }
  /** `types: []` means any entity type (only for references the user named without a type). */
  | { kind: 'search'; query: string; types: QlooEntityType[] };

export interface AcceptDecision {
  match: QlooEntity | QlooTag | null;
  rule: GroundingRule;
  reason: string;
}

// ---- tag families (URNs copied from recorded live /v2/tags responses) -------

/** Visual style families: decor, style, setting (e.g. "Art Deco" exists as decor and setting). */
export const STYLE_TAG_TYPES = ['urn:tag:decor:qloo', 'urn:tag:style:qloo', 'urn:tag:setting:qloo'] as const;
export const CUISINE_TAG_TYPES = ['urn:tag:cuisine:qloo'] as const;
/** Added only when the candidate is about music. */
export const MUSIC_TAG_TYPES = ['urn:tag:genre:music'] as const;
/** Added only when the candidate is about film or TV. */
export const MEDIA_TAG_TYPES = ['urn:tag:genre:media', 'urn:tag:subgenre:qloo'] as const;
/**
 * Families never accepted as a reference, whatever the request asked for:
 * jobs ("Still Life Painter"), place categories ("Ceramics wholesaler"),
 * dishes and menu items, venue attributes and free keywords.
 */
export const FORBIDDEN_TAG_FAMILIES = [
  'urn:tag:occupation',
  'urn:tag:category:place',
  'urn:tag:genre:place',
  'urn:tag:specialty_dish',
  'urn:tag:menu_highlight',
  'urn:tag:ambience',
  'urn:tag:offerings',
  'urn:tag:amenity',
  'urn:tag:nearby_attraction',
  'urn:tag:neighborhood_characteristics',
  'urn:tag:keyword',
  'urn:tag:good_for',
] as const;

/** Qloo's fashion-brand genre: Wear insights are filtered to it (measured 10/10 fashion vs 2/10 without). */
export const FASHION_BRAND_TAG = 'urn:tag:genre:brand:fashion';

// ---- entity types (Q-TYPE) ---------------------------------------------------

export const CREATOR_ENTITY_TYPES: QlooEntityType[] = ['urn:entity:artist', 'urn:entity:director', 'urn:entity:person', 'urn:entity:author'];
export const WORK_ENTITY_TYPES: QlooEntityType[] = ['urn:entity:movie', 'urn:entity:album', 'urn:entity:book', 'urn:entity:tv_show'];
/** In order of preference: a city or region before a venue of the same name. */
export const PLACE_ENTITY_TYPES: QlooEntityType[] = ['urn:entity:destination', 'urn:entity:locality', 'urn:entity:place'];

/** A brand result may add only these words to the candidate's name ("Cannondale" -> "Cannondale Bicycles"). */
export const CORPORATE_SUFFIXES: ReadonlySet<string> = new Set([
  'bicycles', 'bikes', 'group', 'inc', 'co', 'company', 'corp', 'corporation', 'motors', 'motor', 'ltd', 'sa', 'ag', 'gmbh', 'international',
]);

/**
 * Medium words (§4.2 G-MEDIUM): never a reference on a real photo. Checked
 * again here as defence in depth, with the guardrails' own test (so "painted"
 * on a craft or building is decoration there and here alike).
 */
const mediumWord = (text: string, domain?: string | null) => hasMediumWord(text, domain);

/** Generic words that never head a brand name ("Nba basketball" heads with "nba", not "basketball"). */
const HEAD_SKIP: ReadonlySet<string> = new Set(['the', 'a', 'an', 'of', 'and', 'brand', 'logo', 'official']);

/**
 * The brand's own word, as G-BRAND-CORROBORATE reads it: the guardrails'
 * lexicon-based brandHeadToken ("Spalding NBA basketball" -> "spalding",
 * "Cannondale CAAD8" -> "cannondale"), so the token Qloo is searched for is
 * the token that was transcribed in the photo. ground-v3: a colour or
 * material never heads a brand ("Blue Bottle Coffee cup" is never searched
 * as "blue"), and a name with no brand word has no head (it was never
 * corroborated either), instead of falling back to its first word.
 */
export function headToken(name: string): string | null {
  const head = brandHeadToken(name);
  return head && head.length >= 3 && !HEAD_SKIP.has(head) && !/^\d+$/.test(head) ? head : null;
}

/**
 * G-BRAND-CORROBORATE condition (a), the guardrails' own test (guard-v3):
 * every brand word of the name is a whole word of a transcription read in the
 * photo (accent- and case-insensitive), so a colour on a sign or a make on a
 * badge never vouches for a different brand or a guessed model. The
 * guardrails also require a supported verdict; when they have run, their
 * `corroborated` flag wins over this check.
 */
export function textCorroborates(name: string, visibleText: readonly string[]): boolean {
  return brandReadIn(name, visibleText) !== null;
}

function tagFamilyMatches(tag: Pick<QlooTag, 'id' | 'type'>, family: string): boolean {
  return tag.type === family || tag.type.startsWith(`${family}:`) || tag.id.startsWith(`${family}:`);
}

function forbiddenFamily(tag: Pick<QlooTag, 'id' | 'type'>): boolean {
  return FORBIDDEN_TAG_FAMILIES.some((f) => tagFamilyMatches(tag, f));
}

/** "music" / "film" from the guardrails' domain, else from a single derived category (legacy readings). */
function mediaDomain(c: GuardedCandidate): 'music' | 'film' | null {
  if (c.domain === 'music' || c.domain === 'film') return c.domain;
  if (c.domain) return null;
  const cats = c.suggested_categories ?? [];
  if (cats.length === 1 && cats[0] === 'play') return 'music';
  if (cats.length === 1 && cats[0] === 'watch') return 'film';
  return null;
}

function tagQueryOf(c: GuardedCandidate): string {
  const q = c.tag_query ?? c.tag_queries?.find((t) => t.trim()) ?? c.name;
  return q.trim();
}

function stripCuisineWords(q: string): string {
  return q.replace(/\b(cuisine|food|foods)\b/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * ground-v5: domains whose subject is seen, not played, watched or read: art, architecture, interior,
 * design, craft, signage, place, vehicle, fashion, food, sport. A work or creator in one of them has no
 * Qloo media entity of its kind (a painting is not the novel or film of the same title).
 */
const VISUAL_DOMAINS: ReadonlySet<string> = new Set(['art', 'architecture', 'interior', 'design', 'craft', 'signage', 'place', 'vehicle', 'fashion', 'food', 'sport']);

/** ground-v5: the work entity types a candidate's domain allows (any media type when the domain is unknown or "other"). */
export function workTypesFor(domain: string | null | undefined): QlooEntityType[] {
  if (domain === 'film') return ['urn:entity:movie', 'urn:entity:tv_show'];
  if (domain === 'music') return ['urn:entity:album'];
  if (domain && VISUAL_DOMAINS.has(domain)) return [];
  return [...WORK_ENTITY_TYPES];
}

/** ground-v5: the creator entity types a candidate's domain allows (a painter or architect is a person, never a music artist). */
export function creatorTypesFor(domain: string | null | undefined): QlooEntityType[] {
  if (domain === 'music') return ['urn:entity:artist'];
  if (domain === 'film') return ['urn:entity:director', 'urn:entity:person'];
  if (domain && VISUAL_DOMAINS.has(domain)) return ['urn:entity:person'];
  return [...CREATOR_ENTITY_TYPES];
}

/**
 * ground-v5: the decor and setting tag families describe rooms, buildings and venues. They are accepted
 * only for a candidate in a spatial or visual-art domain (or an unknown one); a vehicle, garment, dish,
 * sport, music, film or people claim never grounds to a decor tag ("futuristic hybrid sports car" ->
 * "Futuristic Design", iteration 3 h43). The aesthetic style family ("Rustic", "Minimalist") is not
 * restricted.
 */
const SPATIAL_TAG_FAMILIES = ['urn:tag:decor:qloo', 'urn:tag:setting:qloo'] as const;
const NON_SPATIAL_DOMAINS: ReadonlySet<string> = new Set(['vehicle', 'fashion', 'food', 'sport', 'music', 'film', 'people']);

/**
 * ground-v5: one token form for the inflections and the -ism/-ist/-al forms of a style word
 * ("paneling"/"paneled", "Neoclassicism"/"Neoclassical", "Minimalism"/"Minimalist"): strip one of -ism,
 * -ist, -ing, -ed, -al, -s, then a final "e", keeping at least four letters.
 */
function lightStem(t: string): string {
  let w = t;
  for (const suffix of ['isms', 'ists', 'ism', 'ist', 'ing', 'ed', 'al', 's']) {
    if (w.endsWith(suffix) && w.length - suffix.length >= 4) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

/**
 * ground-v5, the defining-style rule for style tags matched through the tag query, one rule for all:
 * the tag must name the candidate's own defining style, so
 *  (a) every content word of the tag is a word of the candidate's name (a tag adds nothing: "Rustic
 *      wooden table" -> "Rustic", "Minimalist tableware" -> "Minimalist", "Neoclassical chair" ->
 *      "Neoclassical", "Dutch Golden Age portraiture" -> "Dutch Golden Age Style" are accepted; "Rustic
 *      painted wooden bar stools" -> "Rustic Farmhouse", "Mid-century automotive design" -> "Mid Century
 *      Modern" and "striped sofa" -> "Striped Upholstery" are not), and
 *  (b) the words it leaves out are not a proper name: a capitalized word after the first ("Hong Kong neon
 *      signage" -> "Neon Signage" drops the place and is not accepted).
 * The family must also fit the candidate's domain (SPATIAL_TAG_FAMILIES). Doubt leaves the candidate
 * unresolved under its own name.
 */
export function definingStyleTag(candidateName: string, tagName: string): boolean {
  const name = new Set([...canonicalTokens(candidateName)].map(lightStem));
  const tag = [...canonicalTokens(tagName)].map(lightStem);
  if (!tag.length || !tag.every((t) => name.has(t))) return false;
  const kept = new Set(tag);
  const words = candidateName.split(/[\s\-–—/]+/).filter(Boolean);
  return !words.slice(1).some((w) => /^\p{Lu}/u.test(w) && [...canonicalTokens(w)].map(lightStem).some((t) => !kept.has(t)));
}

/** Q-TYPE, Q-TAGTYPES and Q-EVIDENCE: what (if anything) to ask Qloo for this candidate. */
export function planLookup(c: GuardedCandidate): LookupPlan {
  const user = c.userSelected === true;
  const name = c.name.trim();
  if (!name) return { kind: 'none', reason: 'empty_name' };
  // ground-v4: a text-only reference is shown with the text it was read from and nothing else.
  if (c.text_only === true && !user) return { kind: 'none', reason: 'text_only_reference' };
  const textEvidence = c.evidence === 'read_text';
  if (!user && (mediumWord(name, c.domain) || mediumWord(tagQueryOf(c), c.domain)) && !((c.type === 'work' || c.type === 'creator') && textEvidence)) {
    return { kind: 'none', reason: 'medium_word' };
  }
  const strong = user || c.relation === 'depicted' || c.certainty >= 0.5;
  switch (c.type) {
    case 'object': {
      if (user) return { kind: 'search', query: name, types: [] };
      if (c.corroborated !== true) return { kind: 'none', reason: 'object_not_searched' };
      // The maker is searched by its own word (ground-v3: never a colour or material, see headToken).
      const head = headToken(name);
      return head ? { kind: 'search', query: head, types: ['urn:entity:brand'] } : { kind: 'none', reason: 'object_not_searched' };
    }
    case 'brand':
      if (!user && c.corroborated !== true) return { kind: 'none', reason: 'brand_not_corroborated' };
      return { kind: 'search', query: name, types: ['urn:entity:brand'] };
    case 'creator': {
      const types = user ? [...CREATOR_ENTITY_TYPES] : creatorTypesFor(c.domain);
      return { kind: 'search', query: name, types };
    }
    case 'work': {
      // ground-v5: a work grounds only to an entity of its own kind. Qloo's work entities are films, TV
      // shows, albums and books; an artwork, building, sign or object filed as a work has none, so it stays
      // under its own name (iteration-3 h57 "Stained glass windows" resolved to a movie of that title).
      const types = user ? [...WORK_ENTITY_TYPES] : workTypesFor(c.domain);
      if (!types.length) return { kind: 'none', reason: 'work_without_entity_type' };
      return { kind: 'search', query: name, types };
    }
    case 'place':
      if (!(strong || textEvidence)) return { kind: 'none', reason: 'place_without_evidence' };
      return { kind: 'search', query: name, types: [...PLACE_ENTITY_TYPES] };
    case 'cuisine': {
      if (!strong) return { kind: 'none', reason: 'cuisine_without_evidence' };
      const query = stripCuisineWords(tagQueryOf(c)) || stripCuisineWords(name);
      if (!query) return { kind: 'none', reason: 'empty_name' };
      return { kind: 'tags', query, tagTypes: [...CUISINE_TAG_TYPES] };
    }
    case 'style':
    case 'tradition': {
      const media = mediaDomain(c);
      const lead = media === 'music' ? MUSIC_TAG_TYPES : media === 'film' ? MEDIA_TAG_TYPES : [];
      return { kind: 'tags', query: tagQueryOf(c), tagTypes: [...lead, ...STYLE_TAG_TYPES] };
    }
    default:
      return { kind: 'none', reason: 'unsupported_type' };
  }
}

function isTag(x: QlooEntity | QlooTag): x is QlooTag {
  return !('entity_id' in x);
}

function withoutSuffixes(tokens: ReadonlySet<string>): Set<string> {
  return new Set([...tokens].filter((t) => !CORPORATE_SUFFIXES.has(t)));
}

function akaNames(e: QlooEntity): string[] {
  const raw = e.properties['akas'];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => (typeof a === 'string' ? a : a && typeof a === 'object' && typeof (a as { value?: unknown }).value === 'string' ? (a as { value: string }).value : null))
    .filter((v): v is string => !!v);
}

/** Where a same-named place is: its geocode, else its disambiguation, else its own id (unknown = different). */
function localityKey(e: QlooEntity): string {
  const g = e.properties['geocode'];
  if (g && typeof g === 'object') {
    const rec = g as Record<string, unknown>;
    const parts = ['city', 'admin1_region', 'country_code'].map((k) => (typeof rec[k] === 'string' ? (rec[k] as string).toLowerCase() : ''));
    if (parts.some(Boolean)) return parts.join('|');
  }
  if (e.disambiguation) return e.disambiguation.toLowerCase();
  return `id:${e.entity_id}`;
}

function placeTier(e: QlooEntity): number {
  const tiers = e.types.map((t) => PLACE_ENTITY_TYPES.indexOf(t as QlooEntityType)).filter((i) => i >= 0);
  return tiers.length ? Math.min(...tiers) : PLACE_ENTITY_TYPES.length;
}

function acceptTag(c: GuardedCandidate, plan: Extract<LookupPlan, { kind: 'tags' }>, results: readonly QlooTag[]): AcceptDecision {
  if (results.length === 0) return { match: null, rule: 'Q-NAME', reason: 'no_results' };
  const rank = (t: QlooTag) => plan.tagTypes.findIndex((f) => tagFamilyMatches(t, f));
  const spatialOk = !(c.domain && NON_SPATIAL_DOMAINS.has(c.domain) && !c.userSelected);
  const spatial = (t: QlooTag) => SPATIAL_TAG_FAMILIES.some((f) => tagFamilyMatches(t, f));
  const typed = results.filter((t) => !forbiddenFamily(t) && rank(t) >= 0 && (spatialOk || !spatial(t)));
  if (typed.length === 0) return { match: null, rule: 'Q-TAGTYPES', reason: spatialOk ? 'no_allowed_tag_type' : 'decor_tag_outside_domain' };
  const nameTokens = canonicalTokens(c.name);
  const queryTokens = canonicalTokens(plan.query);
  const targets = [queryTokens, nameTokens].filter((s) => s.size > 0);
  if (targets.length === 0) return { match: null, rule: 'Q-NAME', reason: 'empty_canonical_name' };
  const style = (t: QlooTag) => STYLE_TAG_TYPES.some((f) => tagFamilyMatches(t, f));
  const exact = typed.filter((t) => {
    const tokens = canonicalTokens(t.name);
    if (nameTokens.size && sameTokens(tokens, nameTokens)) return true;
    if (!queryTokens.size || !sameTokens(tokens, queryTokens)) return false;
    // ground-v5: matched only through the tag query: a style tag must be the candidate's defining style.
    return !style(t) || c.userSelected === true || definingStyleTag(c.name, t.name);
  });
  if (exact.length === 0) {
    const subset = typed.some((t) => targets.some((s) => strictSubset(canonicalTokens(t.name), s)));
    return { match: null, rule: subset ? 'Q-SUBSET' : 'Q-NAME', reason: subset ? 'shorter_name' : 'no_exact_name' };
  }
  // The allowed families describe one notion ("Art Deco" decor and setting);
  // the domain-preferred family wins, then Qloo's own order.
  const best = [...exact].sort((a, b) => rank(a) - rank(b))[0]!;
  return { match: best, rule: 'Q-NAME', reason: 'exact_tag' };
}

/** The entity type a film or music work/creator should be, when the plan allows it. */
function domainEntityType(c: GuardedCandidate, plan: Extract<LookupPlan, { kind: 'search' }>): QlooEntityType | null {
  const media = mediaDomain(c);
  if (!media) return null;
  const wanted: QlooEntityType | null =
    c.type === 'work'
      ? media === 'film' ? 'urn:entity:movie' : 'urn:entity:album'
      : c.type === 'creator'
        ? media === 'film' ? 'urn:entity:director' : 'urn:entity:artist'
        : null;
  return wanted && plan.types.includes(wanted) ? wanted : null;
}

/** Small words an acronym skips ("Museum of Modern Art" -> MOMA would need "of"; we never count it). */
const ACRONYM_SKIP: ReadonlySet<string> = new Set(['of', 'the', 'and', 'for', 'de', 'du', 'des', 'la', 'le', 'les', 'el', 'a', 'an']);

/**
 * The searched brand word as an acronym, when the candidate's own name writes
 * it in capitals (2 to 5 letters: "NBA", "EMT"), else null. Lower-case or
 * mixed-case words never are ("Fila" is a name, not F.I.L.A.).
 */
function brandAcronym(c: GuardedCandidate, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!/^[a-z]{2,5}$/.test(q)) return null;
  const written = c.name.split(/[^\p{L}\p{N}]+/u).find((w) => w.toLowerCase() === q);
  return written && /^\p{Lu}{2,5}$/u.test(written) ? q : null;
}

/** First letters of a multi-word name's words, small words skipped ("National Basketball Association" -> "nba"); null for one word. */
function initialsOf(name: string): string | null {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !ACRONYM_SKIP.has(w));
  return words.length >= 2 && words.every((w) => /^[a-z]/.test(w)) ? words.map((w) => w[0]).join('') : null;
}

function acceptEntity(c: GuardedCandidate, plan: Extract<LookupPlan, { kind: 'search' }>, results: readonly QlooEntity[]): AcceptDecision {
  if (results.length === 0) return { match: null, rule: 'Q-NAME', reason: 'no_results' };
  const anyType = plan.types.length === 0;
  const typed = results.filter((e) => anyType || e.types.some((t) => (plan.types as string[]).includes(t)));
  if (typed.length === 0) return { match: null, rule: 'Q-TYPE', reason: 'no_allowed_entity_type' };
  const isBrand = !anyType && plan.types.length === 1 && plan.types[0] === 'urn:entity:brand';
  const isPlace = !anyType && plan.types.every((t) => PLACE_ENTITY_TYPES.includes(t));
  const want = isBrand ? withoutSuffixes(canonicalTokens(plan.query)) : canonicalTokens(plan.query);
  if (want.size === 0) return { match: null, rule: 'Q-NAME', reason: 'empty_canonical_name' };
  const tokensOf = (n: string) => (isBrand ? withoutSuffixes(canonicalTokens(n)) : canonicalTokens(n));
  const names = (e: QlooEntity) => (isPlace ? [e.name, ...akaNames(e)] : [e.name]);
  const exact = typed.filter((e) => names(e).some((n) => sameTokens(tokensOf(n), want)));
  if (exact.length === 0) {
    // ground-v4, Q-ACRONYM: a brand written as an acronym in the photo ("NBA") is the one brand whose
    // full name has exactly those initials ("National Basketball Association"); two such brands are a doubt.
    const acronym = isBrand ? brandAcronym(c, plan.query) : null;
    if (acronym) {
      const spelled = typed.filter((e, i) => typed.findIndex((x) => x.entity_id === e.entity_id) === i && initialsOf(e.name) === acronym);
      if (spelled.length === 1) return { match: spelled[0]!, rule: 'Q-NAME', reason: 'exact_brand_acronym' };
      if (spelled.length > 1) return { match: null, rule: 'Q-DOUBT', reason: 'several_acronym_expansions' };
    }
    const subset = typed.some((e) => strictSubset(tokensOf(e.name), want));
    return { match: null, rule: subset ? 'Q-SUBSET' : 'Q-NAME', reason: subset ? 'shorter_name' : 'no_exact_name' };
  }
  const distinct = exact.filter((e, i) => exact.findIndex((x) => x.entity_id === e.entity_id) === i);
  if (isPlace) {
    const top = Math.min(...distinct.map(placeTier));
    const tier = distinct.filter((e) => placeTier(e) === top);
    if (new Set(tier.map(localityKey)).size > 1) return { match: null, rule: 'Q-PLACE', reason: 'same_name_in_several_places' };
    const chosen = tier[0]!;
    if (typeof chosen.popularity !== 'number') return { match: null, rule: 'Q-PLACE', reason: 'no_popularity' };
    return { match: chosen, rule: 'Q-NAME', reason: 'exact_place' };
  }
  if (distinct.length > 1) {
    // ground-v2: a work or creator whose domain names the medium (film, music)
    // is that medium's entity when exactly one exact match has that type
    // ("Rebecca" on a film poster is the movie, not the novel).
    const preferred = domainEntityType(c, plan);
    const ofType = preferred ? distinct.filter((e) => e.types.includes(preferred)) : [];
    if (ofType.length === 1) return { match: ofType[0]!, rule: 'Q-NAME', reason: 'exact_name_domain_type' };
    const types = new Set(distinct.map((e) => [...e.types].sort().join(',')));
    return { match: null, rule: 'Q-DOUBT', reason: types.size > 1 ? 'exact_matches_of_different_types' : 'several_exact_matches' };
  }
  return { match: distinct[0]!, rule: 'Q-NAME', reason: isBrand ? 'exact_brand' : 'exact_name' };
}

/**
 * Q-NAME, Q-SUBSET, Q-PLACE, Q-DOUBT: the single result that is the
 * candidate, or null with the rule that rejected every result.
 */
export function acceptMatch(c: GuardedCandidate, plan: LookupPlan, results: readonly (QlooEntity | QlooTag)[]): AcceptDecision {
  if (plan.kind === 'none') return { match: null, rule: 'Q-EVIDENCE', reason: plan.reason };
  if (plan.kind === 'tags') return acceptTag(c, plan, results.filter(isTag));
  return acceptEntity(c, plan, results.filter((x): x is QlooEntity => !isTag(x)));
}
