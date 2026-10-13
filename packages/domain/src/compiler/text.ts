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

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** "A", "A and B", "A, B and C". */
export function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
