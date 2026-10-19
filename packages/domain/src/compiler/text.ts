/** Text helpers for identity keys and fuzzy name matching (no I/O). */

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function slugify(value: string, max = 80): string {
  return normalizeName(value).replace(/\s+/g, '-').slice(0, max).replace(/-+$/, '') || 'item';
}

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'co', 'inc', 'ltd', 'style', 'culture']);

function tokens(value: string): Set<string> {
  return new Set(normalizeName(value).split(' ').filter((t) => t && !STOP.has(t)));
}

/**
 * Similarity 0..1 between a VLM candidate name and a provider result name:
 * 1 for equal normalized names, high when one contains the other, otherwise
 * token Jaccard. Used to require a close name match before treating a
 * provider result as the same entity (resemblance is not identity).
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  const contained = inter === Math.min(ta.size, tb.size) ? 0.85 : 0;
  return Math.max(jaccard, contained);
}

/**
 * Words that never decide whether two names denote the same thing
 * (docs/quality-plan.md §5 Q-NAME): "Mughal architecture" and "Mughal
 * Architecture" are one tag, "Art Deco" and "Deco" are one style, "Spanish
 * cuisine" and "Spanish" are one cuisine.
 */
export const CANONICAL_STOP: ReadonlySet<string> = new Set([
  'style', 'styles', 'architecture', 'cuisine', 'food', 'design', 'inspired', 'art', 'arts', 'culture',
  'the', 'a', 'an', 'of', 'and', 'le', 'la', 'les', 'de', 'du', 'des',
]);

/**
 * Raw name tokens with normalizeName's folding (case, accents, apostrophes,
 * "&" -> "and"), but letters of every script are kept: CJK, Arabic or
 * Cyrillic names are compared verbatim instead of vanishing.
 */
export function nameTokens(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Content tokens of a name for exact-identity checks (no fuzzy similarity). */
export function canonicalTokens(name: string): Set<string> {
  return new Set(nameTokens(name).filter((t) => !CANONICAL_STOP.has(t)));
}

export function sameTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size || a.size === 0) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** True when `a` is a proper, non-empty subset of `b` ("Honda" of "Honda Civic"). */
export function strictSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || a.size >= b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** Plural-insensitive token: strips a final "s" (not "ss"), then a final "e" ("noodles"/"noodle", "dishes"/"dish"). */
export function stemToken(token: string): string {
  let t = token;
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
  return t;
}

/**
 * Spelling-insensitive identity key: stemmed canonical tokens joined without
 * spaces, so "Dim Sum", "Dim Sums" and "Dimsum" share one key.
 */
export function stemmedKey(name: string): string {
  return nameTokens(name)
    .filter((t) => !CANONICAL_STOP.has(t))
    .map(stemToken)
    .join('');
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** "A", "A and B", "A, B and C". */
export function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
