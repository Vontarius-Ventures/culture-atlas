import { vlmLexicons } from '@culture-atlas/providers';

/** Proper adjectives beyond the guardrail lexicon's nationalities (kept capitalized mid-sentence). */
const PROPER_ADJECTIVES = new Set(
  'american californian parisian european asian african latin mediterranean victorian edwardian georgian tudor byzantine roman greek'.split(' '),
);

/**
 * Lower-cases the first letter for mid-sentence use ("Resembles mid-century
 * modern"), except acronyms ("UK") and proper adjectives ("Resembles
 * Japanese ramen-ya", "American heritage workwear").
 */
export function lowerFirst(s: string): string {
  if (s.length > 1 && s.charAt(1) === s.charAt(1).toUpperCase() && /\p{L}/u.test(s.charAt(1))) return s;
  const first = s.split(/[\s-]/)[0]?.toLowerCase() ?? '';
  if (vlmLexicons.NATIONALITIES.has(first) || PROPER_ADJECTIVES.has(first)) return s.charAt(0).toUpperCase() + s.slice(1);
  // A hyphenated proper compound keeps its capital ("Indo-Islamic", "Anglo-Indian", "Afro-Cuban").
  if (/^\p{Lu}\p{Ll}*-\p{Lu}/u.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export const upperFirst = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
