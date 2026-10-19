import type { QlooEntity, QlooEntityType, QlooTag } from '@culture-atlas/providers';
import { canonicalTokens, nameTokens, sameTokens, strictSubset } from './text';

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
export const GROUNDING_VERSION = 'ground-v1';

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

/** Medium words (§4.2 G-MEDIUM): never a reference on a real photo. Checked again here as defence in depth. */
const MEDIUM = /\b(still[- ]?life|painting|painted|illustrat\w*|drawing|sketch|render(ing)?|watercolou?r|oil on canvas|vector|cartoon|clip ?art|photograph|digital art)\b/i;

/** Generic words that never head a brand name ("Nba basketball" heads with "nba", not "basketball"). */
const HEAD_SKIP: ReadonlySet<string> = new Set(['the', 'a', 'an', 'of', 'and', 'brand', 'logo', 'official']);

/**
 * First distinctive token of a brand-like name ("Spalding NBA basketball" ->
 * "spalding", "Cannondale CAAD8" -> "cannondale"). The guardrails' lexicon
 * version (P1) supersedes this when it sets `corroborated`; this one only
 * backs the text check below.
 */
export function headToken(name: string): string | null {
  for (const t of nameTokens(name)) if (t.length >= 3 && !HEAD_SKIP.has(t) && !/^\d+$/.test(t)) return t;
  return null;
}

/**
 * G-BRAND-CORROBORATE condition (a): a transcription read in the photo
 * contains the brand's head token as a whole word (accent- and
 * case-insensitive). The guardrails also require a supported verdict; when
 * they have run, their `corroborated` flag wins over this check.
 */
export function textCorroborates(name: string, visibleText: readonly string[]): boolean {
  const head = headToken(name);
  if (!head) return false;
  return visibleText.some((v) => nameTokens(v).includes(head));
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

/** Q-TYPE, Q-TAGTYPES and Q-EVIDENCE: what (if anything) to ask Qloo for this candidate. */
export function planLookup(c: GuardedCandidate): LookupPlan {
  const user = c.userSelected === true;
  const name = c.name.trim();
  if (!name) return { kind: 'none', reason: 'empty_name' };
  const textEvidence = c.evidence === 'read_text';
  if (!user && (MEDIUM.test(name) || MEDIUM.test(tagQueryOf(c))) && !((c.type === 'work' || c.type === 'creator') && textEvidence)) {
    return { kind: 'none', reason: 'medium_word' };
  }
  const strong = user || c.relation === 'depicted' || c.certainty >= 0.5;
  switch (c.type) {
    case 'object': {
      if (user) return { kind: 'search', query: name, types: [] };
      if (c.corroborated !== true) return { kind: 'none', reason: 'object_not_searched' };
      const head = headToken(name);
      return head ? { kind: 'search', query: head, types: ['urn:entity:brand'] } : { kind: 'none', reason: 'object_not_searched' };
    }
    case 'brand':
      if (!user && c.corroborated !== true) return { kind: 'none', reason: 'brand_not_corroborated' };
      return { kind: 'search', query: name, types: ['urn:entity:brand'] };
    case 'creator':
      return { kind: 'search', query: name, types: [...CREATOR_ENTITY_TYPES] };
    case 'work':
      return { kind: 'search', query: name, types: [...WORK_ENTITY_TYPES] };
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
  const typed = results.filter((t) => !forbiddenFamily(t) && rank(t) >= 0);
  if (typed.length === 0) return { match: null, rule: 'Q-TAGTYPES', reason: 'no_allowed_tag_type' };
  const targets = [canonicalTokens(plan.query), canonicalTokens(c.name)].filter((s) => s.size > 0);
  if (targets.length === 0) return { match: null, rule: 'Q-NAME', reason: 'empty_canonical_name' };
  const exact = typed.filter((t) => targets.some((s) => sameTokens(canonicalTokens(t.name), s)));
  if (exact.length === 0) {
    const subset = typed.some((t) => targets.some((s) => strictSubset(canonicalTokens(t.name), s)));
    return { match: null, rule: subset ? 'Q-SUBSET' : 'Q-NAME', reason: subset ? 'shorter_name' : 'no_exact_name' };
  }
  // The allowed families describe one notion ("Art Deco" decor and setting);
  // the domain-preferred family wins, then Qloo's own order.
  const best = [...exact].sort((a, b) => rank(a) - rank(b))[0]!;
  return { match: best, rule: 'Q-NAME', reason: 'exact_tag' };
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
