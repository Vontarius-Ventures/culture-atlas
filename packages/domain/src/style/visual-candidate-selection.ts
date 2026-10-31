import { styleTextAboutPerson } from '@culture-atlas/providers';
import { z } from 'zod';
import type { StoredClaim, StoredStyleReading, StoredSubject } from './types';
import type { LoadedVisualCatalog, VisualCatalogObject } from './visual-catalog';

/** Retrieval policy only. Neither admission nor metadata rank verifies visual similarity. */
export const VISUAL_CANDIDATE_SELECTION_POLICY_VERSION = 'atlas_visual_candidate_selection_v4';
export interface VisualCandidate {
  catalog_id: string;
  image_hash: string;
  subject_id: 's1' | 's2';
  subject_label: string;
  region: StoredSubject['region'];
}
type Family = 'vessel' | 'drinkware' | 'sculpture' | 'seat' | 'table' | 'cabinet' | 'outfit' | 'upperwear' | 'dress' | 'suit' | 'trousers' | 'bag' | 'footwear' | 'bed' | 'room';
type ReferenceKind = 'physical_object' | 'scene';
const KINDS = {
  vase: ['vase', 'vases'], vessel: ['vessel', 'vessels'], jar: ['jar', 'jars'],
  urn: ['urn', 'urns'], bowl: ['bowl', 'bowls'], ewer: ['ewer', 'ewers'],
  pot: ['pot', 'pots'], jug: ['jug', 'jugs'], pitcher: ['pitcher', 'pitchers'],
  mug: ['mug', 'mugs', 'coffee mug', 'coffee mugs'],
  cup: ['cup', 'cups', 'teacup', 'teacups', 'tea cup', 'tea cups', 'coffee cup', 'coffee cups'],
  sculpture: ['sculpture', 'sculptures'], statue: ['statue', 'statues'],
  statuette: ['statuette', 'statuettes'], figurine: ['figurine', 'figurines'], bust: ['bust', 'busts'],
  chair: ['chair', 'chairs', 'side chair', 'side chairs', 'dining chair', 'dining chairs'],
  armchair: ['armchair', 'armchairs', 'arm chair', 'arm chairs'],
  stool: ['stool', 'stools'], seat: ['seat', 'seats'],
  table: ['table', 'tables'], desk: ['desk', 'desks'],
  cabinet: ['cabinet', 'cabinets'], chest: ['chest', 'chests'], dresser: ['dresser', 'dressers'],
  outfit: ['outfit', 'outfits', 'ensemble', 'ensembles', 'clothing ensemble', 'clothing ensembles'],
  jacket: ['jacket', 'jackets', 'blazer', 'blazers'],
  coat: ['coat', 'coats', 'overcoat', 'overcoats', 'trench coat', 'trench coats'],
  shirt: ['shirt', 'shirts', 't shirt', 't shirts', 'tee', 'tees', 'cropped tee', 'cropped tees', 'tee shirt', 'tee shirts', 'blouse', 'blouses', 'button down shirt', 'button down shirts'],
  top: ['top', 'tops', 'cropped top', 'cropped tops'],
  dress: ['dress', 'dresses', 'gown', 'gowns'],
  suit: ['suit', 'suits', 'trouser suit', 'trouser suits', 'pantsuit', 'pantsuits'],
  trousers: ['trousers', 'pants', 'jeans', 'jean trousers'],
  bag: ['bag', 'bags', 'handbag', 'handbags', 'crossbody bag', 'crossbody bags', 'cross body bag', 'cross body bags'],
  sweater: ['sweater', 'sweaters', 'jumper', 'jumpers', 'pullover', 'pullovers', 'cardigan', 'cardigans', 'sweatshirt', 'sweatshirts', 'hoodie', 'hoodies'],
  shoe: ['shoe', 'shoes', 'footwear'],
  boot: ['boot', 'boots', 'ankle boot', 'ankle boots'],
  sneaker: ['sneaker', 'sneakers', 'trainer', 'trainers', 'athletic shoe', 'athletic shoes', 'sneaker shoe', 'sneaker shoes'],
  bed: ['bed', 'beds', 'bedstead', 'bedsteads', 'single bed', 'single beds', 'double bed', 'double beds', 'four poster bed', 'four poster beds', 'four poster canopy bed', 'four poster canopy beds', 'canopy bed', 'canopy beds', 'platform bed', 'platform beds', 'loft bed', 'loft beds'],
  bedroom: ['bedroom', 'bedrooms', 'bedroom interior', 'bedroom scene', 'bedroom photograph', 'bedroom photo'],
  interior: ['interior', 'interiors', 'interior scene', 'interior photograph', 'interior photo', 'room', 'rooms', 'room interior', 'room scene', 'room photograph', 'room photo', 'living room', 'living room interior', 'living room scene', 'living room photograph', 'living room photo'],
  kitchen: ['kitchen', 'kitchens', 'galley kitchen', 'kitchen interior', 'kitchen scene', 'kitchen photo', 'kitchen photograph'],
  dining_room: ['dining room', 'dining rooms', 'dining nook', 'dining room interior', 'dining room scene', 'dining room photo', 'dining room photograph'],
  sunroom: ['sunroom', 'sunrooms', 'sun room', 'sun rooms', 'sunroom dining nook', 'sunroom interior', 'sunroom scene', 'sunroom photo', 'sunroom photograph'],
} as const;
type Kind = keyof typeof KINDS;
const FAMILIES: Record<Kind, Family> = {
  vase: 'vessel', vessel: 'vessel', jar: 'vessel', urn: 'vessel', bowl: 'vessel',
  ewer: 'vessel', pot: 'vessel', jug: 'vessel', pitcher: 'vessel', mug: 'drinkware', cup: 'drinkware',
  sculpture: 'sculpture', statue: 'sculpture', statuette: 'sculpture', figurine: 'sculpture', bust: 'sculpture',
  chair: 'seat', armchair: 'seat', stool: 'seat', seat: 'seat',
  table: 'table', desk: 'table', cabinet: 'cabinet', chest: 'cabinet', dresser: 'cabinet',
  outfit: 'outfit', jacket: 'upperwear', coat: 'upperwear', shirt: 'upperwear', top: 'upperwear', sweater: 'upperwear',
  dress: 'dress', suit: 'suit', trousers: 'trousers', bag: 'bag',
  shoe: 'footwear', boot: 'footwear', sneaker: 'footwear', bed: 'bed', bedroom: 'room', interior: 'room',
  kitchen: 'room', dining_room: 'room', sunroom: 'room',
};
// Functional retrieval constraint, NOT a visual conclusion: drinkware may compare
// mug/cup, but cannot spend a slot on a vase/urn/bowl/generic vessel (or vice versa).
// The other explicit families above remain the coarse compatibility boundary.
const referenceKind = (kind: Kind): ReferenceKind => FAMILIES[kind] === 'room' ? 'scene' : 'physical_object';
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const aliases = (Object.entries(KINDS) as [Kind, readonly string[]][])
  .flatMap(([kind, names]) => names.map(name => ({ kind, name })))
  .sort((a, b) => b.name.length - a.name.length || compare(a.name, b.name));

// Closed object/scene taxonomy: material words NEVER confer a family. Catalog
// object_type must be a known noun/alias, optionally prefixed by these descriptors.
// Retrieval-query tags are hints, never type proof: they are not consulted.
// Other taxonomy (including compound/ambiguous classifications) abstains.
const CATALOG_PREFIX = /^(?:(?:ceramic|pottery|porcelain|terracotta|earthenware|stoneware|wooden|wood|bronze|marble|stone|metal|glass|cotton|denim|linen|wool|woolen|woollen|silk|leather|suede|canvas|knitted|small|large)\s+)+/;
// Spatial/lighting/size qualifiers only, never arbitrary aesthetic words. Strip
// only for a known scene noun; "loft bed" remains a physical bed, not a room.
const SCENE_PREFIX = /^(?:(?:loft|airy|bright|small|large|cozy|cosy|compact|spacious)\s+)+/;
function catalogKind(value: string): Kind | null {
  const noun = normalize(value).replace(CATALOG_PREFIX, '');
  const exact = aliases.find(a => a.name === noun)?.kind;
  if (exact) return exact;
  return aliases.find(a => referenceKind(a.kind) === 'scene' && a.name === noun.replace(SCENE_PREFIX, ''))?.kind ?? null;
}
function subjectKind(value: string): Kind | null {
  let text = ` ${normalize(value)} `;
  // An explicit room-with-contents label describes a scene, not every object in
  // that room. Do not apply this to "bed in bedroom" or arbitrary mixed nouns.
  for (const alias of aliases.filter(a => referenceKind(a.kind) === 'scene')) {
    if (new RegExp(`^${alias.name} (?:with|containing|featuring)\\b`).test(text.trim().replace(SCENE_PREFIX, ''))) return alias.kind;
  }
  const found = new Set<Kind>();
  for (const alias of aliases) {
    if (!text.includes(` ${alias.name} `)) continue;
    found.add(alias.kind);
    // Consume longer aliases first, so "arm chair" does not also mean "chair".
    text = text.split(` ${alias.name} `).join(' ');
  }
  return found.size === 1 ? [...found][0]! : null;
}

type ExclusionReason = 'part_or_tool' | 'representation';
interface Exclusion { reason: ExclusionReason; field: 'object_type' | 'title' | 'label'; term: string }
// Explicit nouns only: "cast" and "molded" describe construction, NOT a mold.
// Reject either field even if the other claims a whole object. Parts, production
// tools and representations cannot consume the two real-object comparison slots.
const EXCLUSIONS: [ExclusionReason, RegExp][] = [
  ['part_or_tool', /\b(?:fragments?|fragmentary|incomplete|parts?|components?|portions?|sections?|shards?|sherds?|molds?|moulds?|chair backs?|chair legs?|chair seats?|table legs?|vase lids?|vase handles?)\b/],
  ['part_or_tool', /\b(?:backs?|legs?|seats?|arms?|feet|foot|lids?|handles?|bases?|covers?) (?:of|for|from) (?:an? |the )?(?:chairs?|armchairs?|stools?|tables?|desks?|cabinets?|vases?|jars?|urns?|statuettes?|statues?|sculptures?)\b/],
  ['part_or_tool', /\b(?:(?:jacket|coat|shirt|tee|top|sweater|dress|gown|suit) (?:sleeves?|collars?|cuffs?|bodices?)|(?:trouser|trousers|jean|jeans) (?:legs?|waistbands?)|(?:bag|handbag) (?:straps?|handles?|linings?)|(?:shoe|boot|sneaker) (?:soles?|heels?|uppers?)|(?:sewing|knitting|dressmaking) patterns?)\b/],
  ['part_or_tool', /\b(?:sleeves?|collars?|cuffs?|bodices?|waistbands?|straps?|linings?|patterns?) (?:of|for|from) (?:an? |the )?(?:jackets?|coats?|shirts?|tees?|tops?|sweaters?|dresses|dress|gowns?|suits?|trousers|jeans|bags?|handbags?)\b/],
  ['representation', /\b(?:prints?|engravings?|etchings?|lithographs?|woodcuts?|paintings?|drawings?|depictions?|illustrations?|sketches?|posters?|reproductions?|replicas?)\b/],
  ['representation', /\b(?:models?|studies|study|designs?) (?:of|for|depicting)\b|\b(?:miniature|toy|dollhouse) (?:chairs?|armchairs?|stools?|tables?|desks?|cabinets?|chests?|dressers?)\b/],
];
function exclusion(value: string, field: Exclusion['field'], kind: Kind | null): Exclusion | null {
  // The literal furniture term is not a printed poster. Any separate "poster"
  // mention (e.g. "Poster of four-poster bed") still excludes the representation.
  const text = normalize(value).replace(/\bfour poster (?:canopy )?beds?\b/g, 'bed');
  for (const [reason, pattern] of EXCLUSIONS) {
    const match = text.match(pattern);
    if (match) return { reason, field, term: match[0] };
  }
  // Only explicit room/bedroom scene taxonomy permits photographic references.
  // "Photo" alone or a query tag cannot waive object/representation exclusions.
  const photo = text.match(/\b(?:photographs?|photos?)\b/);
  if (photo && (!kind || referenceKind(kind) !== 'scene')) return { reason: 'representation', field, term: photo[0] };
  return null;
}

const Region = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().positive().max(1), h: z.number().positive().max(1) })
  .refine(b => b.x + b.w <= 1.000001 && b.y + b.h <= 1.000001);
const activeVisible = (claim: StoredClaim) => !claim.held && !claim.retracted && claim.basis === 'visible' && claim.certainty >= 0.35;
export type VisualSubjectReason = 'eligible' | 'unsupported_subject' | 'excluded_subject' | 'invalid_region' | 'inactive_subject' | 'no_active_visible_evidence';
function subjectReason(reading: StoredStyleReading, s: StoredSubject): VisualSubjectReason {
  const kind = subjectKind(s.label);
  if (!['s1', 's2'].includes(s.id) || !['fashion', 'interior', 'other', 'media'].includes(s.category) ||
    styleTextAboutPerson(s.label) || !kind) return 'unsupported_subject';
  const clothing = ['outfit', 'upperwear', 'dress', 'suit', 'trousers', 'bag', 'footwear'].includes(FAMILIES[kind]);
  if ((s.category === 'fashion' && !clothing) || (s.category === 'interior' && clothing)) return 'unsupported_subject';
  if (exclusion(s.label, 'label', kind)) return 'excluded_subject';
  if (!Region.safeParse(s.region).success) return 'invalid_region';
  if (reading.held.some(h => h.path === `subjects.${s.id}` || h.path === s.id) ||
    reading.retracted.some(p => p === s.id || p === `subjects.${s.id}`)) return 'inactive_subject';
  return [...s.aesthetics, ...s.materials, ...s.construction, ...s.details].some(activeVisible)
    ? 'eligible' : 'no_active_visible_evidence';
}
/** Same guarded subject/category/region/evidence threshold; unknown object kinds abstain. */
export function eligibleVisualSubjects(reading: StoredStyleReading): StoredSubject[] {
  return reading.subjects.slice(0, 2).filter(s => subjectReason(reading, s) === 'eligible');
}

// Closed lexical agreements, not embeddings, style/culture/maker matching or
// probabilities. Only these three visible claim slots may contribute; explanatory
// display, aesthetics, lineage, era, label and contextual metadata never do.
const FEATURES = {
  materials: [
    ['wood', 'wood|wooden'], ['oak', 'oak'], ['walnut', 'walnut'], ['mahogany', 'mahogany'],
    ['bronze', 'bronze'], ['brass', 'brass'], ['iron', 'iron'], ['steel', 'steel'],
    ['marble', 'marble'], ['stone', 'stone'], ['glass', 'glass'],
    ['ceramic', 'ceramic|ceramics|pottery'], ['porcelain', 'porcelain'],
    ['terracotta', 'terracotta|terra cotta'], ['earthenware', 'earthenware'], ['stoneware', 'stoneware'],
    ['cotton', 'cotton'], ['denim', 'denim'], ['linen', 'linen'], ['wool', 'wool|woolen|woollen'],
    ['silk', 'silk'], ['leather', 'leather'], ['suede', 'suede'], ['canvas', 'canvas'],
  ],
  construction: [
    ['carved', 'carved|carving'], ['cast', 'cast|casting'], ['turned', 'turned|turning'],
    ['molded', 'molded|moulded'], ['woven', 'woven|weaving'], ['upholstered', 'upholstered|upholstery'],
    ['knitted', 'knitted|knit'], ['sewn', 'sewn|stitched'], ['quilted', 'quilted|quilting'],
    ['pleated', 'pleated|pleating'],
  ],
  details: [
    ['fluted', 'fluted|fluting'], ['ribbed', 'ribbed|ribbing'], ['pierced', 'pierced|piercing'],
    ['incised', 'incised|incision'], ['painted', 'painted'], ['glazed', 'glazed'],
    ['gilded', 'gilded|gilt'], ['inlaid', 'inlaid|inlay'], ['floral', 'floral'], ['geometric', 'geometric'],
    ['striped', 'striped|stripes'], ['checked', 'checked|checkered|chequered'], ['plaid', 'plaid|tartan'],
    ['embroidered', 'embroidered|embroidery'], ['buttoned', 'buttoned|buttons'], ['hooded', 'hooded|hood'],
  ],
} as const;
function features(text: string, slot: keyof typeof FEATURES): string[] {
  const value = normalize(text);
  // No positive credit from negation or attribution/comparison phrases. This is
  // deliberately conservative; it is not a natural-language entailment model.
  if (/\b(?:no|not|non|without|unlike|imitation|faux|style|inspired|attributed|after)\b/.test(value)) return [];
  return FEATURES[slot].filter(([, terms]) => new RegExp(`\\b(?:${terms})\\b`).test(value)).map(([name]) => `${slot}:${name}`);
}
function sourceFeatures(s: StoredSubject): string[] {
  const out: string[] = [];
  for (const c of s.materials.filter(activeVisible)) out.push(...features(`${c.name} ${c.texture}`, 'materials'));
  for (const c of s.construction.filter(activeVisible)) out.push(...features(`${c.name} ${c.kind}`, 'construction'));
  for (const c of s.details.filter(activeVisible)) out.push(...features(`${c.name} ${c.text}`, 'details'));
  return [...new Set(out)].sort(compare);
}
function candidateFeatures(item: VisualCatalogObject): Set<string> {
  return new Set((Object.keys(FEATURES) as (keyof typeof FEATURES)[])
    .flatMap(slot => [item.title, item.medium].flatMap(text => features(text, slot))));
}
export type VisualCandidateReason = 'admitted' | 'unknown_object_type' | 'family_mismatch' | 'reference_kind_mismatch' | ExclusionReason;
export interface VisualCandidateDiagnostic {
  subject_id: string;
  catalog_id: string;
  admitted: boolean;
  reason: VisualCandidateReason;
  exclusion: Exclusion | null;
  object_kind: Kind | null;
  reference_kind: ReferenceKind | null;
  /** Lexicographic retrieval rank: exact kind first, then at most three agreements. */
  rank: { exact_kind: 0 | 1; feature_agreement: number } | null;
  matched_features: string[];
  selected: boolean;
}
export interface VisualCandidateSelection {
  policy_version: typeof VISUAL_CANDIDATE_SELECTION_POLICY_VERSION;
  retrieval_only: true;
  limit: number;
  candidates: VisualCandidate[];
  subjects: { subject_id: string; reason: VisualSubjectReason; object_kind: Kind | null; reference_kind: ReferenceKind | null; active_features: string[] }[];
  diagnostics: VisualCandidateDiagnostic[];
}

/** Pure, deterministic admission + metadata retrieval ranking; performs no IO. */
export function selectVisualCandidates(reading: StoredStyleReading, catalog: LoadedVisualCatalog, limit: number): VisualCandidateSelection {
  const boundedLimit = Number.isNaN(limit) ? 0 : Math.min(2, Math.max(0, Math.floor(limit)));
  const subjects = eligibleVisualSubjects(reading);
  const diagnostics: VisualCandidateDiagnostic[] = [];
  const shortlists = subjects.map(s => {
    const kind = subjectKind(s.label)!;
    const visibleFeatures = sourceFeatures(s);
    const rows = catalog.catalog.objects.map(item => {
      const candidateKind = catalogKind(item.object_type);
      const excluded = exclusion(item.object_type, 'object_type', candidateKind) ?? exclusion(item.title, 'title', candidateKind);
      const reason: VisualCandidateReason = excluded?.reason ?? (!candidateKind ? 'unknown_object_type' :
        referenceKind(candidateKind) !== referenceKind(kind) ? 'reference_kind_mismatch' :
        FAMILIES[candidateKind] !== FAMILIES[kind] ? 'family_mismatch' : 'admitted');
      const admitted = reason === 'admitted';
      const candidateTerms = admitted ? candidateFeatures(item) : new Set<string>();
      const matched = visibleFeatures.filter(f => candidateTerms.has(f));
      const diagnostic: VisualCandidateDiagnostic = {
        subject_id: s.id, catalog_id: item.id, admitted, reason, exclusion: excluded, object_kind: candidateKind,
        reference_kind: candidateKind ? referenceKind(candidateKind) : null,
        rank: admitted ? { exact_kind: candidateKind === kind ? 1 : 0, feature_agreement: Math.min(3, matched.length) } : null,
        matched_features: matched, selected: false,
      };
      diagnostics.push(diagnostic);
      return { item, diagnostic };
    });
    return rows.filter(row => row.diagnostic.admitted).sort((a, b) =>
      b.diagnostic.rank!.exact_kind - a.diagnostic.rank!.exact_kind ||
      b.diagnostic.rank!.feature_agreement - a.diagnostic.rank!.feature_agreement ||
      compare(a.item.id, b.item.id));
  });
  const candidates: VisualCandidate[] = [];
  // Preserve reading subject order, subject relation identity, and max-two
  // round-robin. Neither a strong metadata match nor a missing subject refills
  // the durable lifetime allowance; that remains enforced by the caller/DB.
  for (let index = 0; index < 2; index++) {
    for (const [subjectIndex, s] of subjects.entries()) {
      if (candidates.length >= boundedLimit) break;
      const row = shortlists[subjectIndex]?.[index];
      if (!row) continue;
      row.diagnostic.selected = true;
      candidates.push({ catalog_id: row.item.id, image_hash: row.item.image_sha256, subject_id: s.id as 's1' | 's2', subject_label: s.label, region: s.region });
    }
  }
  return {
    policy_version: VISUAL_CANDIDATE_SELECTION_POLICY_VERSION, retrieval_only: true, limit: boundedLimit, candidates,
    subjects: reading.subjects.slice(0, 2).map(s => ({
      subject_id: s.id, reason: subjectReason(reading, s), object_kind: subjectKind(s.label),
      reference_kind: subjectKind(s.label) ? referenceKind(subjectKind(s.label)!) : null,
      active_features: subjects.includes(s) ? sourceFeatures(s) : [],
    })),
    diagnostics: diagnostics.sort((a, b) => compare(a.subject_id, b.subject_id) || compare(a.catalog_id, b.catalog_id)),
  };
}
