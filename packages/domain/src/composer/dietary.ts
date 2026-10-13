/**
 * Dietary exclusions for movie-night dishes. Stated exclusions are enforced
 * against a dish's title, description, cuisine and listed ingredients; a dish
 * that mentions an excluded ingredient (or a common form of it) is dropped.
 * We never assert that a dish is allergen-free: such claims are stripped from
 * generated text, because provider/model output is a hint, not proof.
 */

/** Common forms of frequently stated exclusions (lower-case, singular stems). */
const EXPANSIONS: Record<string, string[]> = {
  peanut: ['peanut', 'groundnut', 'satay', 'arachis'],
  nut: ['nut', 'almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia', 'praline', 'marzipan', 'peanut', 'pesto'],
  'tree nut': ['almond', 'cashew', 'walnut', 'pecan', 'pistachio', 'hazelnut', 'macadamia', 'praline', 'marzipan', 'pesto'],
  dairy: ['dairy', 'milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'ghee', 'paneer', 'pecorino', 'parmesan', 'mozzarella', 'ricotta', 'custard', 'feta', 'burrata', 'mascarpone'],
  milk: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'ghee', 'custard'],
  lactose: ['milk', 'cheese', 'butter', 'cream', 'yogurt', 'yoghurt', 'custard'],
  cheese: ['cheese', 'pecorino', 'parmesan', 'mozzarella', 'ricotta', 'feta', 'paneer', 'burrata', 'mascarpone'],
  egg: ['egg', 'mayonnaise', 'aioli', 'custard', 'meringue', 'frittata', 'omelet', 'omelette', 'shakshouka', 'shakshuka', 'carbonara'],
  gluten: ['gluten', 'wheat', 'flour', 'bread', 'pasta', 'noodle', 'barley', 'rye', 'couscous', 'semolina', 'pastry', 'dumpling', 'tortilla', 'pita', 'udon', 'ramen', 'seitan', 'beer', 'soy sauce'],
  wheat: ['wheat', 'flour', 'bread', 'pasta', 'noodle', 'couscous', 'semolina', 'pastry'],
  shellfish: ['shellfish', 'shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop', 'crayfish', 'langoustine'],
  fish: ['fish', 'salmon', 'tuna', 'cod', 'anchovy', 'sardine', 'mackerel', 'trout', 'bonito', 'dashi', 'fish sauce'],
  seafood: ['seafood', 'fish', 'shrimp', 'prawn', 'crab', 'lobster', 'clam', 'mussel', 'oyster', 'scallop', 'squid', 'octopus', 'anchovy'],
  soy: ['soy', 'soya', 'tofu', 'tempeh', 'edamame', 'miso', 'soy sauce'],
  sesame: ['sesame', 'tahini', 'za atar', 'zaatar'],
  pork: ['pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'guanciale', 'lard', 'salami', 'sausage'],
  beef: ['beef', 'steak', 'brisket', 'veal'],
  meat: ['meat', 'beef', 'pork', 'lamb', 'chicken', 'turkey', 'duck', 'bacon', 'ham', 'prosciutto', 'pancetta', 'chorizo', 'guanciale', 'sausage', 'veal', 'salami', 'steak', 'brisket'],
  chicken: ['chicken', 'poultry'],
  alcohol: ['wine', 'beer', 'rum', 'vodka', 'whisky', 'whiskey', 'sake', 'mirin', 'liqueur', 'brandy', 'cognac'],
  mushroom: ['mushroom', 'porcini', 'shiitake', 'truffle'],
  onion: ['onion', 'shallot', 'leek', 'scallion'],
  garlic: ['garlic', 'aioli'],
  chili: ['chili', 'chile', 'chilli', 'jalapeno', 'harissa', 'cayenne', 'sriracha', 'gochujang'],
};

const ALIASES: Record<string, string> = {
  peanuts: 'peanut',
  nuts: 'nut',
  'tree nuts': 'tree nut',
  eggs: 'egg',
  'gluten-free': 'gluten',
  vegetarian: 'meat',
  vegan: 'meat',
  'no meat': 'meat',
  mushrooms: 'mushroom',
  onions: 'onion',
  chilies: 'chili',
  chillies: 'chili',
  shrimps: 'shellfish',
};

export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Terms to look for for one stated exclusion (always includes the stated word itself). */
export function exclusionTerms(exclusion: string): string[] {
  const norm = normalizeText(exclusion);
  if (!norm) return [];
  const key = ALIASES[norm] ?? norm;
  const singular = key.endsWith('s') && !key.endsWith('ss') ? key.slice(0, -1) : key;
  const extra = [...(EXPANSIONS[key] ?? []), ...(EXPANSIONS[singular] ?? [])];
  const terms = new Set([norm, key, singular, ...extra]);
  // Vegan also excludes animal products beyond meat.
  if (norm === 'vegan') for (const t of [...EXPANSIONS.dairy!, ...EXPANSIONS.egg!, ...EXPANSIONS.seafood!, 'honey', 'gelatin']) terms.add(t);
  if (norm === 'vegetarian') for (const t of [...EXPANSIONS.seafood!, 'gelatin']) terms.add(t);
  return [...terms].filter(Boolean);
}

function mentions(haystack: string, term: string): boolean {
  const h = ` ${haystack} `;
  const t = normalizeText(term);
  if (!t) return false;
  // Word-boundary match allowing a plural "s"/"es".
  return new RegExp(` ${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(e?s)? `).test(h);
}

export interface DishText {
  title: string;
  description?: string | null;
  cuisine?: string | null;
  ingredients?: readonly string[];
}

/** The exclusions a dish violates (empty when compatible). */
export function violatedExclusions(dish: DishText, exclusions: readonly string[]): string[] {
  const text = normalizeText([dish.title, dish.description ?? '', dish.cuisine ?? '', ...(dish.ingredients ?? [])].join(' '));
  return exclusions.filter((ex) => exclusionTerms(ex).some((t) => mentions(text, t)));
}

/** Remove sentences that assert safety ("allergen-free", "nut-free", "safe for allergies"...). */
export function stripSafetyClaims(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const unsafe = /\b(allergen|allergy)[- ]?(free|safe)\b|\b[a-z]+-free\b|\bsafe for\b|\bfree (of|from)\b|\bno (traces?|risk)\b/i;
  return sentences.filter((s) => !unsafe.test(s)).join(' ').trim();
}
