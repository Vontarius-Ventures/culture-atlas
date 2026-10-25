import { vlmLexicons, type QlooTagRef } from '@culture-atlas/providers';
import type { StoredSubject } from './types';
import { styleVocabulary, type ExemplarBrand, type StyleVocabulary } from './vocabulary';
import { lowerFirst } from './text';

/**
 * Style affinity smatch-1: how closely a real Qloo entity's own tags match
 * the style reading of one subject. Pure and deterministic.
 *
 * The exact-tag mapper (map-tags.ts) accepts only exact names, and Qloo's
 * style tags are long-tail ("Nautical Heritage", "Preppy Stripes", "Tennis
 * Culture", signature pieces such as "Penny Loafer"), so most specific
 * readings mapped to nothing or to a broad tag ("Casual Wear", "Sportswear")
 * that half the catalogue carries. That made the rails drift to popular or
 * co-liked brands of the wrong product, price tier or region. Here the
 * reading's own words (aesthetics and their visible features, label,
 * lineage, era, materials, construction) are matched token by token against
 * the entity's tag labels, weighted by how rare each word is across the
 * harvested brand catalogue (IDF), so a shared "nautical" or "tennis" counts
 * far more than a shared "casual". Nothing here is shown as a Qloo claim
 * about the photo: it only ranks and gates real Qloo entities, and reasons
 * name the claim's own words next to the entity's own tag label.
 *
 * Gates are product-level, never per photo: a garment rail keeps clothing
 * brands (Qloo's own genre:brand family tags), a sneaker rail footwear, a
 * bag rail bags; casual readings drop couture and bridal labels; a brand
 * whose tags tie it to a region the reading does not mention is ranked down.
 */
export const STYLE_MATCH_VERSION = 'smatch-1';

// ---- tokens ------------------------------------------------------------------

const STOP = new Set(
  `a an the and or of with in on for to from by at as is are its it this that these those into over under
   look looks looking like style styles styled stylish aesthetic aesthetics design designs designed designer inspired inspiration inspirations
   influence influenced influences feel feels vibe vibes culture cultural movement movements trend trends trending fashion fashions brand brands branding
   piece pieces item items detail details detailing element elements resembles resembling suggests suggest suggesting qloo kind type
   very slightly slight subtle overall main whole visible small large big new other style-led led driven focused focus centric based oriented forward
   wear worn wearing clothes clothing apparel garment garments outfit outfits ensemble collection collections line lines range wardrobe
   sense touch accents accent signature iconic all profile shaped finish finished tone toned panel paneled panelled`.split(/\s+/).filter(Boolean),
);

/** Spelling and compound equivalences (plain fashion and design vocabulary, never per photo). */
const FOLDS: readonly [RegExp, string][] = [
  [/\bcolou?r[\s-]*block(?:ed|ing|s)?\b/g, ' colorblock '],
  [/\bcolou?rs?\b/g, ' color '],
  [/\bt[\s-]?shirts?\b|\btees?\b/g, ' tee '],
  [/\b(?:19)?50s\b|\bfifties\b/g, ' 1950s '],
  [/\b(?:19)?60s\b|\bsixties\b/g, ' 1960s '],
  [/\b(?:19)?70s\b|\bseventies\b/g, ' 1970s '],
  [/\b(?:19)?80s\b|\beighties\b/g, ' 1980s '],
  [/\b(?:19)?90s\b|\bnineties\b/g, ' 1990s '],
  [/\b(?:20)?00s\b|\bnoughties\b/g, ' 2000s '],
  [/\btrainers?\b|\bsneakers?\b|\bkicks\b/g, ' sneaker '],
  [/\bjumpers?\b|\bpullovers?\b/g, ' sweater '],
  [/\btrousers?\b/g, ' pants '],
  [/\bmid[\s-]*century\b/g, ' midcentury '],
  [/\b(?:smart|business)[\s-]+casual\b/g, ' smartcasual '],
  [/\bstreet[\s-]+wear\b/g, ' streetwear '],
  [/\bwork[\s-]+wear\b/g, ' workwear '],
  [/\bsports?[\s-]+wear\b/g, ' sportswear '],
  [/\bactive[\s-]+wear\b/g, ' activewear '],
  [/\bevening[\s-]+wear\b/g, ' eveningwear '],
  [/\bmarini[eè]res?\b/g, ' breton '],
  [/\bboat[\s-]*necks?\b|\bbateau\b/g, ' boatneck '],
  [/\bhand[\s-]*bags?\b|\bpurses?\b/g, ' bag '],
  [/\bjeweller?y\b/g, ' jewelry '],
  [/\bsun[\s-]*glasses\b|\bspectacles\b|\beyeglasses\b/g, ' eyewear '],
  [/\bhi(?:gh)?[\s-]*tops?\b/g, ' hightop '],
  [/\blow[\s-]*tops?\b/g, ' lowtop '],
  [/\bfaux[\s-]+leather\b|\bvegan[\s-]+leather\b|\bpleather\b|\bsynthetic[\s-]+leather\b|\bpu[\s-]+leather\b/g, ' fauxleather '],
  [/\bknit(?:ted|wear)?\b/g, ' knit '],
  [/\btie[\s-]+dye[ds]?\b/g, ' tiedye '],
  [/\btailor(?:ed|ing)?\b/g, ' tailoring '],
  [/\bsuits?\b|\bsuiting\b/g, ' suit '],
  [/\btuxedos?\b|\bdinner[\s-]+jackets?\b/g, ' tuxedo '],
  [/\bpreppie\b/g, ' preppy '],
  [/\bathletic(?:s)?\b|\bathletics\b/g, ' athletic '],
];

function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('es') && /(?:ss|sh|ch|x)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Normalized content tokens of a phrase (lowercase, diacritics folded, equivalences applied, stop words removed). */
export function styleTokens(text: string): string[] {
  let t = ` ${text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[_/]+/g, ' ')} `;
  for (const [re, to] of FOLDS) t = t.replace(re, to);
  const out: string[] = [];
  for (const raw of t.split(/[^\p{L}\p{N}$]+/u)) {
    if (!raw || raw.length < 2 || STOP.has(raw)) continue;
    const w = stem(raw);
    if (STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

// ---- regions -----------------------------------------------------------------

const REGION_FOLD: Record<string, string> = {
  parisian: 'french',
  france: 'french',
  breton: 'french',
  milanese: 'italian',
  neapolitan: 'italian',
  roman: 'italian',
  italy: 'italian',
  londoner: 'british',
  english: 'british',
  scottish: 'british',
  england: 'british',
  britain: 'british',
  nordic: 'scandinavian',
  danish: 'scandinavian',
  swedish: 'scandinavian',
  norwegian: 'scandinavian',
  finnish: 'scandinavian',
  brazil: 'brazilian',
  desi: 'south_asian',
  indian: 'south_asian',
  pakistani: 'south_asian',
  bollywood: 'south_asian',
  japan: 'japanese',
  korea: 'korean',
  mexico: 'mexican',
  turkey: 'turkish',
  spain: 'spanish',
  californian: 'american',
  america: 'american',
  usa: 'american',
};
const REGION_WORDS = new Set([...vlmLexicons.NATIONALITIES, ...Object.keys(REGION_FOLD), 'scandinavian', 'mediterranean']);

/** Region keys a text names ("Brazilian Fashion" -> brazilian; "Middle Eastern Luxury" -> middle_eastern). */
export function regionsOf(text: string): string[] {
  const folded = ` ${text.toLowerCase().replace(/[^a-z]+/g, ' ')} `;
  const out = new Set<string>();
  if (/ middle eastern | arab(?:ic|ian)? | gulf /.test(folded)) out.add('middle_eastern');
  if (/ south asian /.test(folded)) out.add('south_asian');
  if (/ latin american /.test(folded)) out.add('latin_american');
  if (/ united states /.test(folded)) out.add('american');
  if (/ united kingdom /.test(folded)) out.add('british');
  for (const w of folded.trim().split(' ')) {
    if (!REGION_WORDS.has(w)) continue;
    out.add(REGION_FOLD[w] ?? w);
  }
  // "american" alone is the catalogue's default market, not a regional signal.
  out.delete('american');
  return [...out];
}

// ---- product families --------------------------------------------------------

export type ProductKind = 'apparel' | 'jeans' | 'tailoring' | 'dress' | 'footwear' | 'bag' | 'jewelry' | 'eyewear' | 'watch' | 'headwear' | 'swimwear' | 'lingerie';

const KIND_WORDS: readonly [ProductKind, RegExp][] = [
  ['footwear', /\b(?:sneakers?|trainers?|shoes?|boots?|loafers?|heels?|pumps|sandals?|slippers?|mules?|clogs?|espadrilles?|brogues?|oxfords?|derbys?|slides?|flip[\s-]?flops?|footwear|stilettos?|wedges?|flats)\b/i],
  ['bag', /\b(?:bags?|handbags?|totes?|crossbody|clutch(?:es)?|backpacks?|purses?|satchels?|wallets?|duffels?|pouch(?:es)?)\b/i],
  ['jewelry', /\b(?:necklaces?|rings?|earrings?|bracelets?|pendants?|bangles?|brooch(?:es)?|jewell?e?ry|chokers?|anklets?)\b/i],
  ['eyewear', /\b(?:sunglasses|glasses|eyewear|spectacles|shades|frames)\b/i],
  ['watch', /\b(?:watch(?:es)?|wristwatch(?:es)?|timepieces?|chronographs?)\b/i],
  ['headwear', /\b(?:hats?|caps?|beanies?|berets?|fedoras?|bucket hats?|headbands?|turbans?|headscarf|bandanas?)\b/i],
  ['swimwear', /\b(?:swimsuits?|bikinis?|swim\s?trunks|boardshorts?|swimwear|one[\s-]piece)\b/i],
  ['lingerie', /\b(?:bras?|bralettes?|lingerie|corsets?|pajamas?|pyjamas?|sleepwear|loungewear|robes?)\b/i],
  ['tailoring', /\b(?:suits?|tuxedos?|blazers?|neckties?|ties|bow\s?ties?|waistcoats?|tailcoats?|morning coats?|dress shirts?)\b/i],
  ['dress', /\b(?:dress(?:es)?|gowns?|sundress(?:es)?|frocks?)\b/i],
  ['jeans', /\b(?:jeans|denims?)\b/i],
];

/** The product a subject is, from its label (the thing noun) and its construction names. */
export function productKind(subject: Pick<StoredSubject, 'label' | 'construction'>): ProductKind {
  // The label's head noun decides first ("Tan crossbody bag", "Black suit with champagne tie").
  const label = subject.label;
  let best: { kind: ProductKind; at: number } | null = null;
  for (const [kind, re] of KIND_WORDS) {
    const m = re.exec(label);
    if (!m) continue;
    // The noun that comes first in the label is the thing ("Suit with tie" -> tailoring; "Dress with bag" -> dress).
    if (!best || m.index < best.at) best = { kind, at: m.index };
  }
  return best?.kind ?? 'apparel';
}

/** Qloo genre:brand family of an entity, from its own genre tag ids. */
export interface Families {
  apparel: boolean;
  formal: boolean;
  couture: boolean;
  footwear: boolean;
  bag: boolean;
  jewelry: boolean;
  eyewear: boolean;
  watch: boolean;
  swimwear: boolean;
  lingerie: boolean;
  /** No genre information at all (gates do not apply). */
  unknown: boolean;
}

export function familiesOf(genreIds: readonly string[]): Families {
  const has = (re: RegExp) => genreIds.some((g) => re.test(g));
  const apparel = has(/^urn:tag:genre:brand:fashion:(?:casual|formalwear|jeans|athletic|haute_couture)$/) || has(/^urn:tag:genre:brand:retail:fashion$/);
  return {
    apparel,
    formal: has(/:fashion:formalwear$/),
    couture: has(/:fashion:haute_couture$/),
    footwear: has(/:fashion:footwear(?::|$)/),
    bag: has(/:accessories:bags_and_leather$/),
    jewelry: has(/:accessories:jewelry$/),
    eyewear: has(/:accessories:eyewear$/),
    watch: has(/:accessories:watch$/),
    swimwear: has(/:fashion:swimwear$/),
    lingerie: has(/:fashion:lingerie_and_sleepwear$/),
    unknown: !genreIds.some((g) => g.startsWith('urn:tag:genre:brand:fashion:')),
  };
}

/** The Qloo genre tag a rail for this product filters on (real ids from the harvested brand pages). */
export function genreFilterFor(kind: ProductKind): string | null {
  switch (kind) {
    case 'footwear':
      return 'urn:tag:genre:brand:fashion:footwear';
    case 'bag':
      return 'urn:tag:genre:brand:fashion:accessories:bags_and_leather';
    case 'jewelry':
      return 'urn:tag:genre:brand:fashion:accessories:jewelry';
    case 'eyewear':
      return 'urn:tag:genre:brand:fashion:accessories:eyewear';
    case 'watch':
      return 'urn:tag:genre:brand:fashion:accessories:watch';
    case 'swimwear':
      return 'urn:tag:genre:brand:fashion:swimwear';
    case 'lingerie':
      return 'urn:tag:genre:brand:fashion:lingerie_and_sleepwear';
    case 'tailoring':
      return 'urn:tag:genre:brand:fashion:formalwear';
    case 'jeans':
      return 'urn:tag:genre:brand:fashion:jeans';
    default:
      return null;
  }
}

/** Why a brand cannot be "more like" this subject, or null. */
/** Fabric materials: a brand whose material tags include none of them does not make clothes. */
const TEXTILE_RE = /\b(?:cotton|wool|denim|silk|linen|polyester|nylon|jersey|knit|cashmere|fleece|chiffon|satin|lace|tulle|viscose|rayon|spandex|elastane|lycra|fabric|fabrics|textile|textiles|twill|canvas|flannel|corduroy|velvet|tweed|crepe|organza|modal|tencel|lyocell|blend|blends|synthetic)\b/i;

/** Material tags that name no fabric at all (gold, titanium, acetate): another product than clothing. */
export function noTextiles(materialNames: readonly string[]): boolean {
  return materialNames.length >= 2 && !materialNames.some((m) => TEXTILE_RE.test(m));
}

export function productGate(kind: ProductKind, f: Families, materials: readonly string[] = []): string | null {
  // A label with no product family on record but only metal, stone or plastic materials is not clothing.
  if (f.unknown && !['footwear', 'bag', 'jewelry', 'eyewear', 'watch', 'swimwear', 'lingerie'].includes(kind) && noTextiles(materials)) return 'not_apparel';
  // No product family on record: a garment rail may keep it (nothing says it is another product);
  // a shoe, bag, jewellery, eyewear, watch, swim or lingerie rail needs Qloo to say it makes that.
  if (f.unknown && !['footwear', 'bag', 'jewelry', 'eyewear', 'watch', 'swimwear', 'lingerie'].includes(kind)) return null;
  switch (kind) {
    case 'footwear':
      return f.footwear ? null : 'not_footwear';
    case 'bag':
      return f.bag ? null : 'not_bags';
    case 'jewelry':
      return f.jewelry ? null : 'not_jewelry';
    case 'eyewear':
      return f.eyewear ? null : 'not_eyewear';
    case 'watch':
      return f.watch ? null : 'not_watches';
    case 'swimwear':
      return f.swimwear ? null : 'not_swimwear';
    case 'lingerie':
      return f.lingerie ? null : 'not_lingerie';
    case 'headwear':
      return f.apparel ? null : 'not_apparel';
    default:
      // Garments: a clothing label (casual, formalwear, jeans, athletic, couture). Lingerie- or
      // swim-only labels, shoe-only, jewellery, eyewear and watch houses are other products.
      return f.apparel ? null : 'not_apparel';
  }
}

// ---- tier ----------------------------------------------------------------------

const LUXE_RE = /\b(?:couture|haute|luxury|luxe|designer|eveningwear|evening|gowns?|red carpet|sequin(?:s|ned)?|beaded|embellished|opulent|glamou?r(?:ous)?|bridal|tuxedo|black tie|silk|satin|cashmere|velvet|brocade|prom|gala|formal)\b/i;
const EVERYDAY_RE = /\b(?:casual|everyday|basic|basics|day dress|cotton|jersey|denim|sporty|sportswear|athleisure|streetwear|tee|t-shirt|sneakers?|practical|comfort(?:able)?|utility|workwear|relaxed|weekend|budget|flat[\s-]?pack|mall)\b/i;

/** casual: an everyday reading (no luxury cue), so couture, bridal and $$$$ labels are other markets. */
export function readingTier(text: string): 'casual' | 'dressy' | 'open' {
  const luxe = LUXE_RE.test(text);
  const everyday = EVERYDAY_RE.test(text);
  if (everyday && !luxe) return 'casual';
  if (luxe && !everyday) return 'dressy';
  return 'open';
}

// ---- profiles ------------------------------------------------------------------

export type MatchSlot = 'aesthetics' | 'lineage' | 'era' | 'materials' | 'construction' | 'mood' | 'label' | 'details' | 'entity';

interface QueryToken {
  weight: number;
  slot: MatchSlot;
  /** The claim's own name (as shown in the reading), or the label. */
  claim: string;
  wording: 'asserted' | 'resembles';
  /** Weight of the source the word is credited to (a claim outranks the label; a stronger claim outranks a weaker one). */
  creditWeight: number;
  /** The word is in a claim's NAME ("Breton nautical"), or only in a visible feature or detail of it ("contrast ribbed trim"). */
  level: 'name' | 'feature';
}

export interface SubjectProfile {
  tokens: Map<string, QueryToken>;
  kind: ProductKind;
  tier: 'casual' | 'dressy' | 'open';
  regions: Set<string>;
  label: string;
  /** Kids' clothing words appear in the reading. */
  kids: boolean;
}

/** Colour words describe the photo's palette, which brands rarely share: they count for little. */
const COLOR_WORDS = new Set(
  'black white grey gray red blue navy green yellow orange pink purple brown beige tan cream ivory gold silver olive khaki teal mint aqua burgundy maroon crimson charcoal camel ecru'.split(' '),
);
const COLOR_CAP = 0.12;

/** Garment and product nouns: matching one is a product match, not a style match (half weight, never a claim name). */
const PRODUCT_WORDS = new Set(
  'top tee shirt blouse dress gown skirt skort short pant jean jacket coat blazer suit tuxedo sweater hoodie sweatshirt cardigan vest bag tote sneaker shoe boot loafer sandal heel hat cap scarf belt sock legging jumpsuit set outfit piece'.split(' '),
);
const PRODUCT_FACTOR = 0.5;

const SLOT_W = { aesthetics: 1, features: 0.3, label: 0.5, lineage: 0.6, era: 0.45, materials: 0.5, construction: 0.35, details: 0.15, mood: 0.2, entity: 0.35 } as const;

export function subjectProfile(subject: StoredSubject, entityTags: readonly Pick<QlooTagRef, 'id' | 'name'>[] = []): SubjectProfile {
  const tokens = new Map<string, QueryToken>();
  const kind = productKind(subject);
  const add = (text: string, weight: number, slot: MatchSlot, claim: string, wording: 'asserted' | 'resembles', claimLevel: 'name' | 'feature' = 'name') => {
    for (const t of styleTokens(text)) {
      let level = claimLevel;
      // For a generic garment, a product noun ("top", "jacket") says what the thing is, not its style
      // ("Corset Tops" is not like a striped top). For jeans, tailoring, dresses, shoes and bags the
      // product noun is the category itself ("Skinny Jeans", "Crossbody Bag") and keeps its weight.
      const productNoun = kind === 'apparel' && PRODUCT_WORDS.has(t);
      const w = COLOR_WORDS.has(t) ? Math.min(weight, COLOR_CAP) : productNoun ? weight * PRODUCT_FACTOR : weight;
      if (productNoun) level = 'feature';
      const prev = tokens.get(t);
      if (!prev) {
        tokens.set(t, { weight: w, slot, claim, wording, creditWeight: w, level });
        continue;
      }
      // The word keeps its highest weight; it is credited to a shown claim rather than to the label
      // ("canvas" in "Canvas work jacket" and in the material "Canvas": the reason names the material),
      // and to the stronger of two claims.
      const takesCredit = slot !== 'label' && (prev.slot === 'label' || w > prev.creditWeight);
      // A word that some claim NAMES counts at name level, whichever source gets the credit.
      const named = (level === 'name' && slot !== 'label') || (prev.level === 'name' && prev.slot !== 'label');
      const next = takesCredit ? { slot, claim, wording, creditWeight: w } : { slot: prev.slot, claim: prev.claim, wording: prev.wording, creditWeight: prev.creditWeight };
      tokens.set(t, { ...next, weight: Math.max(prev.weight, w), level: named || next.slot === 'label' ? 'name' : 'feature' });
    }
  };
  const shown = <T extends { held: boolean; retracted?: boolean }>(xs: readonly T[]) => xs.filter((x) => !x.held && !x.retracted);
  const w = (c: { wording: string; certainty: number }) => (c.wording === 'asserted' ? 1 : 0.8) * Math.min(1, 0.5 + c.certainty / 2);
  add(subject.label, SLOT_W.label, 'label', subject.label, 'asserted');
  for (const a of shown(subject.aesthetics)) {
    add(a.name, SLOT_W.aesthetics * w(a), 'aesthetics', a.name, a.wording);
    // A visible defining feature counts for its aesthetic (the reason names the aesthetic).
    for (const f of a.defining_features) add(f, SLOT_W.features * w(a), 'aesthetics', a.name, a.wording, 'feature');
  }
  for (const l of shown(subject.lineage)) add(l.name, SLOT_W.lineage * w(l), 'lineage', l.name, l.wording);
  if (subject.era && !subject.era.held && !subject.era.retracted) add(subject.era.name, SLOT_W.era * w(subject.era), 'era', subject.era.name, subject.era.wording);
  for (const m of shown(subject.materials)) add(m.name, SLOT_W.materials * w(m), 'materials', m.name, m.wording);
  for (const c of shown(subject.construction)) add(c.name, SLOT_W.construction * w(c), 'construction', c.name, c.wording);
  for (const d of shown(subject.details)) add(d.text, SLOT_W.details, 'details', d.text, d.wording, 'feature');
  for (const m of shown(subject.mood)) add(m.name, SLOT_W.mood, 'mood', m.name, 'resembles');
  // The identified brand's own style tags (logo in the photo) widen the reading a little.
  for (const t of entityTags) if (isStyleTag(t.id)) add(t.name, SLOT_W.entity, 'entity', t.name, 'asserted');
  const text = [
    subject.label,
    ...shown(subject.aesthetics).flatMap((a) => [a.name, ...a.defining_features]),
    ...shown(subject.lineage).map((l) => l.name),
    subject.era && !subject.era.held ? subject.era.name : '',
    ...shown(subject.materials).map((m) => m.name),
    ...shown(subject.construction).map((c) => c.name),
  ].join(' ; ');
  return {
    tokens,
    kind,
    tier: readingTier(text),
    regions: new Set(regionsOf(text)),
    label: subject.label,
    kids: /\b(?:kids?|child(?:ren)?|baby|toddler|infant)\b/i.test(text),
  };
}

/** Tag families that describe style (matched), as opposed to price, audience, related brands or wiki categories. */
function isStyleTag(id: string): boolean {
  return /^urn:tag:(?:aesthetic_property|design_inspiration|cultural_relevance|personal_style|fashion_segment|material|signature_piece|signature_product|product_service|product_line|lifestyle|emotional_tone|consumption_context|core_value|interest_adjacency|style|theme|subgenre|decor|setting|ambience|keyword|genre:media|genre:music|genre:place)\b/.test(id) || /^urn:tag:genre:(?:qloo|media)/.test(id);
}

const TAG_W: Record<string, number> = {
  signature_piece: 1,
  /** Home-brand families (home-brands-1): a named product ("Dutch Ovens") or an aesthetic word carries the match. */
  signature_product: 1,
  product_service: 0.9,
  design_inspiration: 0.9,
  cultural_relevance: 0.8,
  aesthetic_property: 0.8,
  personal_style: 0.8,
  fashion_segment: 0.7,
  product_line: 0.7,
  material: 0.6,
  genre: 0.7,
  lifestyle: 0.5,
  emotional_tone: 0.5,
  core_value: 0.5,
  consumption_context: 0.4,
  interest_adjacency: 0.4,
  keyword: 0.6,
};

/**
 * A region in a tag is a market tie ("Brazilian Fashion", "Middle Eastern Retail Scene", "South Asian
 * Cultural Events", "Desi Culture", "Indian Wedding Culture") unless the tag is a design reference
 * ("French Riviera Style", "Scandinavian Design", "Italian Heritage" of a global label).
 */
const DESIGN_REFERENCE_RE = /\b(?:style|styles|design|designs|riviera|architecture|art|arts|modernism|minimalism|tailoring|engineering|craftsmanship|heritage)\s*$/i;

export interface EntityTagLike {
  id: string;
  name: string;
}

/** One entity tag a word appears in: the tag's weight, label, id and the label's own words. */
export interface EntityWord {
  weight: number;
  label: string;
  tagId: string;
  words: readonly string[];
}

export interface EntityProfile {
  /** Word -> every tag label carrying it. */
  tokens: Map<string, EntityWord[]>;
  /** The entity's material tag names. */
  materials: string[];
  families: Families;
  price: string | null;
  regions: Set<string>;
  kids: boolean;
  bridalOrCouture: boolean;
}

export function entityProfile(tags: readonly EntityTagLike[]): EntityProfile {
  const tokens = new Map<string, EntityWord[]>();
  const genres: string[] = [];
  const regionText: string[] = [];
  const materials: string[] = [];
  let ethnic = false;
  let price: string | null = null;
  for (const t of tags) {
    if (!t?.id) continue;
    if (t.id.startsWith('urn:tag:genre:brand:')) {
      genres.push(t.id);
      // Product family names ("Sneakers", "Formalwear", "Jeans") are matchable words too.
      if (t.id.startsWith('urn:tag:genre:brand:fashion:') && !/:other$/.test(t.id)) addEntityTokens(tokens, t, TAG_W.genre!);
      continue;
    }
    if (t.id.startsWith('urn:tag:price_level:')) {
      price = t.name;
      continue;
    }
    if (/^urn:tag:wikipedia_category:/.test(t.id)) {
      // "Clothing companies of Brazil": where the label is from (a market tie).
      const name = t.name || t.id.split(':').pop()!.replace(/_/g, ' ');
      if (/\b(?:companies|brands|retailers|manufacturers)\s+(?:of|based in)\b/i.test(name)) regionText.push(name);
      continue;
    }
    if (!isStyleTag(t.id)) continue;
    const ns = /^urn:tag:([a-z_]+)/.exec(t.id)?.[1] ?? '';
    if (ns === 'material') materials.push(t.name);
    // A region counts only as a market tie ("Brazilian Fashion", "Middle Eastern Retail Scene",
    // "Desi Culture"), not as a design reference ("French Riviera Style", "Italian Heritage").
    if ((ns === 'cultural_relevance' || ns === 'design_inspiration') && !DESIGN_REFERENCE_RE.test(t.name)) regionText.push(t.name);
    // Traditional or ethnic wear is a regional market of its own.
    if (/:fashion_segment:qloo:(?:ethnic_wear|traditional_wear)$/.test(t.id)) ethnic = true;
    addEntityTokens(tokens, t, TAG_W[ns] ?? 0.6);
  }
  return {
    tokens,
    materials,
    families: familiesOf(genres),
    price,
    regions: new Set([...regionsOf(regionText.join(' ; ')), ...(ethnic ? ['traditional'] : [])]),
    // A children's label, not a family label with a kids' line: a quarter of its tags are about children.
    kids: tags.filter((t) => /\b(?:kids?wear|kids|children|childrens|baby|babies|toddlers?|infants?)\b/i.test(t.name ?? '')).length >= Math.max(2, 0.25 * tags.filter((t) => isStyleTag(t.id)).length),
    bridalOrCouture: genres.some((g) => /:haute_couture$/.test(g)) || tags.some((t) => /:(?:fashion_segment|design_inspiration|cultural_relevance):qloo:(?:bridal|haute_couture|couture)/.test(t.id)),
  };
}

function addEntityTokens(into: EntityProfile['tokens'], t: EntityTagLike, weight: number): void {
  const label = t.name || t.id.split(':').pop()!.replace(/_/g, ' ');
  const words = [...new Set(styleTokens(label))];
  for (const tok of words) {
    const list = into.get(tok) ?? [];
    list.push({ weight, label, tagId: t.id, words });
    into.set(tok, list);
  }
}

/** Entity tags of a harvested brand row (style ids with their vocabulary labels, pieces, genres). */
export function brandTags(b: ExemplarBrand, v: StyleVocabulary = styleVocabulary()): EntityTagLike[] {
  const out: EntityTagLike[] = [];
  for (const id of b.style_tag_ids) out.push({ id, name: v.byId.get(id)?.label ?? id.split(':').pop()!.replace(/_/g, ' ') });
  for (const p of b.pieces ?? []) out.push({ id: `urn:tag:signature_piece:qloo:${p.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, name: p });
  for (const g of b.genre_ids ?? []) out.push({ id: g, name: g.split(':').pop()!.replace(/_/g, ' ') });
  if (b.price_level) out.push({ id: 'urn:tag:price_level:qloo:_', name: b.price_level });
  return out;
}

// ---- IDF -----------------------------------------------------------------------

let idfCache: { v: StyleVocabulary; df: Map<string, number>; n: number } | null = null;

/** Document frequency of every token across the harvested brand catalogue (each brand counts a token once). */
function idfTable(v: StyleVocabulary = styleVocabulary()): { df: Map<string, number>; n: number } {
  if (idfCache && idfCache.v === v) return idfCache;
  const df = new Map<string, number>();
  for (const b of v.brands) {
    const seen = new Set(entityProfile(brandTags(b, v)).tokens.keys());
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  idfCache = { v, df, n: Math.max(1, v.brands.length) };
  return idfCache;
}

/** IDF of a token; a word the catalogue never uses gets a mid value (it may be a film or place tag). */
export function idf(token: string, v?: StyleVocabulary): number {
  const { df, n } = idfTable(v);
  const d = df.get(token);
  if (d === undefined) return Math.log(1 + n / 20);
  return Math.log(1 + n / (1 + d));
}

/**
 * The weight a shared word carries: rare words dominate ("tennis", "nautical",
 * "loafer"), words a third of the catalogue uses ("casual", "classic") add
 * almost nothing. (idf - 1)^1.5 / 2: idf 1.5 -> 0.18, 2.5 -> 0.9, 5 -> 4.
 */
/** A word almost no brand uses still counts at most this much (one rare shared word is not a style). */
export const WORD_WEIGHT_CAP = 3;

export function wordWeight(token: string, v?: StyleVocabulary): number {
  return Math.min(WORD_WEIGHT_CAP, Math.max(0, idf(token, v) - 1) ** 1.5 / 2);
}

// ---- scoring -------------------------------------------------------------------

export interface MatchHit {
  token: string;
  slot: MatchSlot;
  claim: string;
  wording: 'asserted' | 'resembles';
  /** The entity's own tag label and id that carried the word. */
  label: string;
  tagId: string;
  contribution: number;
  /** Share of the tag label's words the reading also uses ("Tennis Court" for a tennis-court reading: 1). */
  coverage: number;
  level: 'name' | 'feature';
}

export interface StyleMatchResult {
  score: number;
  hits: MatchHit[];
  /** A product, tier or audience gate: the entity is not a "more like this" for the subject. */
  gate: string | null;
  /** Multiplier applied for a region the reading does not mention (1 when none). */
  regionFactor: number;
  /** Shared words from the reading's style claims carry at least half the match (not only the label's product noun). */
  styleHit: boolean;
}

export const REGION_PENALTY = 0.6;
/** A suit, blazer or tie reading: a house with no tailoring words of its own (an eveningwear or gown label) ranks far down. */
const TAILORING_WORDS = ['tailoring', 'tuxedo', 'blazer', 'menswear'];
export const TAILORING_FACTOR = 0.35;
/** ... and so does a gown or bridal house that names no suit of its own. */
const GOWN_WORDS = ['gown', 'bridal', 'dress'];
const SUIT_WORDS = ['suit', 'tuxedo', 'blazer'];
/** Products whose rail is filtered to the Qloo genre: sharing the product words ("Crossbody Bag") is a real match. */
export const STRICT_KINDS: readonly ProductKind[] = ['footwear', 'bag', 'jewelry', 'eyewear', 'watch', 'swimwear', 'lingerie'];
const PRICE_ORDER = ['$', '$$', '$$$', '$$$$'];

export function scoreMatch(q: SubjectProfile, e: EntityProfile, options: { fashion?: boolean; v?: StyleVocabulary } = {}): StyleMatchResult {
  const hits: MatchHit[] = [];
  let raw = 0;
  for (const [tok, qt] of q.tokens) {
    const list = e.tokens.get(tok);
    if (!list?.length) continue;
    // The tag whose label the reading covers best carries the word: "Tennis Court" fully matches a
    // tennis reading, "Embroidered Lawn Suit" only a third of a suit reading (coverage sqrt(1/3)).
    let et = list[0]!;
    let best = -1;
    let coverage = 0;
    for (const x of list) {
      const covered = x.words.filter((w) => q.tokens.has(w)).length / Math.max(1, x.words.length);
      const v = x.weight * Math.sqrt(covered);
      if (v > best) {
        best = v;
        et = x;
        coverage = covered;
      }
    }
    const c = qt.weight * best * wordWeight(tok, options.v);
    raw += c;
    hits.push({ token: tok, slot: qt.slot, claim: qt.claim, wording: qt.wording, label: et.label, tagId: et.tagId, contribution: c, coverage, level: qt.level });
  }
  hits.sort((a, b) => b.contribution - a.contribution);
  // Mild length normalization: a brand with 60 tags should not win only by having more words.
  const score = raw / (1 + 0.04 * Math.sqrt(e.tokens.size));
  let gate: string | null = null;
  if (options.fashion !== false) {
    gate = productGate(q.kind, e.families, e.materials);
    if (!gate && e.kids && !q.kids) gate = 'kidswear';
    if (!gate && q.tier === 'casual' && (e.bridalOrCouture || e.price === '$$$$')) gate = 'tier';
  }
  const foreign = [...e.regions].filter((r) => !q.regions.has(r));
  const regionFactor = foreign.length && ![...e.regions].some((r) => q.regions.has(r)) ? REGION_PENALTY : 1;
  // Tailoring: a gown or bridal house is not "more like" a suit (and the reverse is fine: a suit
  // reading may still match a formalwear house that also makes gowns).
  let factor = regionFactor;
  if (q.kind === 'tailoring' && (!TAILORING_WORDS.some((t) => e.tokens.has(t)) || (GOWN_WORDS.some((t) => e.tokens.has(t)) && !SUIT_WORDS.some((t) => e.tokens.has(t)))))
    factor *= TAILORING_FACTOR;
  // The match is about style when the reading's claims (not the label's product noun or the logo's
  // tags) carry at least half of it: "Ribbed Tank Tops" sharing "top" with a striped top is not.
  // A visible feature word alone ("ribbed" from a trim, "shoes" next to an outfit) supports a claim but
  // is not one: named words must carry at least a third of the match.
  // (The label's own words count as named: "Breton stripe boat-neck top", "Dark slim jeans"; its generic
  // product noun on a plain garment does not.)
  const nameShare = hits.filter((h) => h.slot !== 'entity' && h.level === 'name').reduce((t, h) => t + h.contribution, 0);
  return { score: score * factor, hits, gate, regionFactor, styleHit: nameShare > 0 && nameShare >= 0.35 * raw };
}

/** Price distance in levels (null when either side is unknown). */
export function priceDistance(a: string | null, b: string | null): number | null {
  const i = a ? PRICE_ORDER.indexOf(a) : -1;
  const j = b ? PRICE_ORDER.indexOf(b) : -1;
  return i < 0 || j < 0 ? null : Math.abs(i - j);
}

// ---- exemplars -----------------------------------------------------------------

export interface AffinityExemplar {
  id: string;
  name: string;
  score: number;
  price: string | null;
}

/**
 * The catalogue brands that best match the reading (gated), most specific
 * first. Used as entity signals for Qloo and as the candidate pool Qloo is
 * asked to rank (filter.results.entities); never shown unless a Qloo
 * response returns them.
 */
export function rankCatalogue(q: SubjectProfile, options: { exclude?: ReadonlySet<string>; max?: number; v?: StyleVocabulary } = {}): AffinityExemplar[] {
  const v = options.v ?? styleVocabulary();
  const out: AffinityExemplar[] = [];
  const seenNames = new Set<string>();
  for (const b of v.brands) {
    if (options.exclude?.has(b.id)) continue;
    const r = scoreMatch(q, entityProfile(brandTags(b, v)), { v });
    // An exemplar shares a style claim, not only the product noun ("Corset Tops" for a striped top).
    if (r.gate || r.score <= 0 || !r.styleHit) continue;
    out.push({ id: b.id, name: b.name, score: r.score, price: b.price_level });
  }
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const kept: AffinityExemplar[] = [];
  for (const x of out) {
    const key = x.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    kept.push(x);
    if (kept.length >= (options.max ?? 20)) break;
  }
  return kept;
}

// ---- reasons -------------------------------------------------------------------

export const AFFINITY_REASON_MAX = 90;

const REASON_SLOTS: readonly MatchSlot[] = ['aesthetics', 'lineage', 'era', 'materials', 'construction', 'label'];

/** The hit a reason names: the strongest whose subject side is a shown claim or the label. */
export function reasonHit(hits: readonly MatchHit[]): MatchHit | null {
  // A tag the reading covers at least half of ("Tennis Court") before a one-word coincidence
  // ("Tie Me Bag" for a tie): the reason must read as the same thing, not a shared word.
  const claim = (h: MatchHit) => REASON_SLOTS.includes(h.slot) && h.slot !== 'label';
  return (
    hits.find((h) => claim(h) && h.level === 'name' && h.coverage >= 0.5) ??
    hits.find((h) => h.slot === 'label' && h.coverage >= 0.5) ??
    hits.find((h) => claim(h) && h.coverage >= 0.5) ??
    hits.find((h) => claim(h)) ??
    hits.find((h) => REASON_SLOTS.includes(h.slot)) ??
    null
  );
}

/** A Qloo tag label mid-sentence: Title Case words lowered, proper adjectives kept ("Tennis Culture" -> "tennis culture"). */
function tagPhrase(label: string): string {
  return label
    .split(' ')
    .map((w) => lowerFirst(w))
    .join(' ');
}

function claimPhrase(h: MatchHit): string {
  if (h.slot === 'label') return `the ${lowerFirst(h.claim)}`;
  const name = lowerFirst(h.claim);
  return h.slot === 'aesthetics' && !/\b(?:look|style|aesthetic|wear)$/i.test(name) ? `the ${name} look` : `the ${name}`;
}

/**
 * "Known for nautical heritage, like the nautical Breton look your photo
 * resembles": the entity's own tag label next to the reading's own claim.
 * Card-specific (each entity's tag differs) and faithful (both halves are
 * real: a Qloo tag on the entity, a claim in the published reading).
 */
export function affinityReason(hits: readonly MatchHit[], options: { entityName?: string | null } = {}): string | null {
  const h = reasonHit(hits);
  if (!h) return options.entityName ? `Connected to ${options.entityName} in your photo.` : null;
  const tag = h.label.trim();
  const tail = h.wording === 'resembles' && h.slot !== 'label' ? 'your photo resembles' : 'in your photo';
  const phrase = claimPhrase(h);
  const lead = options.entityName ? `Close to ${options.entityName} and known for` : 'Known for';
  // The tag says the same as the claim ("Workwear" / "Workwear"): say it once.
  const tagWords = styleTokens(tag);
  const claimWords = styleTokens(h.claim);
  const same = tagWords.every((t) => claimWords.includes(t)) && claimWords.every((t) => tagWords.includes(t));
  if (same) {
    const text = `${lead} ${tagPhrase(tag)}, like ${h.wording === 'resembles' && h.slot !== 'label' ? 'the look your photo resembles' : 'your photo'}`;
    if (text.length <= AFFINITY_REASON_MAX) return text;
  }
  const t = tagPhrase(tag);
  const candidates = [`${lead} ${t}, like ${phrase} ${tail}`, `Known for ${t}, like ${phrase} ${tail}`, `Known for ${t}, like ${phrase}`, `Known for ${t}`];
  for (const c of candidates) if (c.length <= AFFINITY_REASON_MAX) return c;
  return `${candidates.at(-1)!.slice(0, AFFINITY_REASON_MAX - 1).trimEnd()}…`;
}
