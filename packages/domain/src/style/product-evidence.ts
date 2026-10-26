import type { StoredSubject } from './types';

/** Internal evidence only: provider product families deliberately remain broad. */
export type ProductForm = 'crossbody' | 'backpack' | 'wallet' | 'clutch' | 'duffel' | 'tote' | 'satchel' | 'pouch' | 'loafer' | 'sneaker' | 'boot' | 'sandal';

const FORMS: readonly [ProductForm, RegExp][] = [
  ['crossbody', /\bcross[\s-]?bod(?:y|ies)\b/i],
  ['backpack', /\b(?:backpacks?|rucksacks?|knapsacks?)\b/i],
  ['wallet', /\b(?:wallets?|card[\s-]?holders?)\b/i],
  ['clutch', /\bclutch(?:es)?\b/i],
  ['duffel', /\b(?:duff[el]{2}s?|weekenders?|holdalls?)\b/i],
  ['tote', /\btotes?\b/i],
  ['satchel', /\bsatchels?\b/i],
  ['pouch', /\bpouch(?:es)?\b/i],
  ['loafer', /\bloafers?\b/i],
  ['sneaker', /\b(?:sneakers?|trainers?)\b/i],
  ['boot', /\bboots?\b/i],
  ['sandal', /\bsandals?\b/i],
];

export function productFormsIn(text: string): ProductForm[] {
  return FORMS.flatMap(([form, re]) => {
    const match = re.exec(text);
    return match ? [{ form, at: match.index }] : [];
  }).sort((a, b) => a.at - b.at).map(({ form }) => form);
}

export function activeEvidence<T extends { held: boolean; retracted?: boolean }>(claims: readonly T[]): T[] {
  return claims.filter((c) => !c.held && !c.retracted);
}

/** The depicted noun, never an aesthetic, logo or co-liked brand's range. */
export function productFormOf(subject: Pick<StoredSubject, 'label' | 'construction'>): ProductForm | null {
  return productFormsIn(subject.label)[0] ?? productFormsIn(activeEvidence(subject.construction).map((c) => c.name).join(' ; '))[0] ?? null;
}

const CLOTHING = /\b(?:apparel|clothing|garments?|outfits?|ensembles?|sportswear|activewear|swimwear|lingerie|sleepwear|loungewear|tops?|t[\s-]?shirts?|tees?|shirts?|blouses?|dress(?:es)?|gowns?|sundress(?:es)?|frocks?|skirts?|skorts?|shorts?|pants?|trousers?|jeans|denim|jackets?|coats?|blazers?|suits?|tuxedos?|waistcoats?|sweaters?|jumpers?|pullovers?|hoodies?|sweatshirts?|cardigans?|vests?|tanks?|tank[\s-]?tops?|camisoles?|singlets?|chemises?|bustiers?|turtlenecks?|polos?|henleys?|leggings?|jumpsuits?|rompers?|overalls?|dungarees?|ponchos?|capes?|tunics?|parkas?|anoraks?|raincoats?|windbreakers?|jerseys?|bodysuits?|leotards?|saris?|sarees?|kimonos?|kaftans?|caftans?|abayas?|kurtas?|sneakers?|trainers?|shoes?|boots?|loafers?|heels?|pumps|sandals?|slippers?|mules?|clogs?|espadrilles?|brogues?|oxfords?|derbys?|slides?|flip[\s-]?flops?|footwear|stilettos?|wedges?|flats|bags?|handbags?|totes?|cross[\s-]?body|clutch(?:es)?|backpacks?|rucksacks?|knapsacks?|purses?|satchels?|wallets?|duff[el]{2}s?|weekenders?|holdalls?|pouch(?:es)?|card[\s-]?holders?|necklaces?|rings?|earrings?|bracelets?|pendants?|bangles?|brooch(?:es)?|jewell?e?ry|chokers?|anklets?|sunglasses|glasses|eyewear|spectacles|watches|watch|wristwatches|timepieces?|hats?|caps?|beanies?|berets?|fedoras?|headbands?|turbans?|headscar(?:f|ves)|bandanas?|scarves|scarfs|belts?|socks?|gloves?|mittens?|ties|neckties?|swimsuits?|bikinis?|boardshorts?|bras?|bralettes?|corsets?|pajamas?|pyjamas?|robes?)\b/i;
const EQUIPMENT = /\b(?:rac?quets?|rackets?|balls?|bats?|clubs?|skateboards?|surfboards?|bicycles?|bikes?|helmets?|dumbbells?|barbells?|weights?|paddles?|sticks?|equipment)\b/i;

/**
 * A fashion label is not itself product evidence. Unknown nouns and equipment cannot
 * silently use productKind's historical apparel default. Recognized garments remain
 * eligible; an equipment noun before an incidental garment does not.
 */
export function fashionProductEligible(subject: Pick<StoredSubject, 'label' | 'construction'>): boolean {
  const garment = CLOTHING.exec(subject.label);
  const equipment = EQUIPMENT.exec(subject.label);
  return !!garment && (!equipment || garment.index < equipment.index);
}

/** Affirmative evidence beats unrelated lines at a diversified brand. */
export function productFormGate(form: ProductForm | null | undefined, supported: readonly ProductForm[]): string | null {
  if (!form || supported.includes(form)) return null;
  return supported.length ? 'incompatible_form' : 'unsupported_form';
}
