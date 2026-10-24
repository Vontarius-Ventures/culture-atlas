import { readFileSync } from 'node:fs';
import { personTypeAesthetic, resolveFromWorkspace, type StyleCategory, type StyleVocabularyLists } from '@culture-atlas/providers';

/**
 * Style vocabulary svocab-1 (style design §C.2, R-2). Every id comes from a
 * recorded real Qloo response (fixtures/qloo/style-vocab, built by
 * scripts/style/build-vocab.ts; vocabulary.test.ts enforces provenance).
 * Labels are the tags' own names. target_* and market_archetype tags never
 * enter (R-7d).
 */
export const VOCAB_VERSION = 'svocab-1';

export interface VocabEntry {
  id: string;
  label: string;
  namespace: string;
  entityTypes: string[];
  /** Harvested entities carrying the tag (how common it is). */
  count: number;
  seenOn: { entityId: string | null; fixture: string };
}

export interface ExemplarBrand {
  id: string;
  name: string;
  popularity: number;
  style_tag_ids: string[];
  price_level: string | null;
  /** urn:tag:genre:brand:* ids (product families), from the same recorded brand page. */
  genre_ids?: string[];
  /** signature_piece tag names, verbatim. */
  pieces?: string[];
}

export interface VocabAlias {
  /** Normalized claim name. */
  name: string;
  /** Must exist in vocab.json. */
  id: string;
  approved_by: string;
  reason: string;
}

const TRAILING_STYLE_WORD = /\s+(?:style|design|aesthetic|inspired|chic)$/;

/**
 * Acceptance normalization (C.2 rule 1): lowercase, strip diacritics, turn
 * - _ / into spaces, collapse whitespace, drop one trailing
 * style|design|aesthetic|inspired|chic.
 */
export function normalizeStyleName(value: string): string {
  const base = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[-_/]+/g, ' ')
    .replace(/[^\p{L}\p{N}$ ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const stripped = base.replace(TRAILING_STYLE_WORD, '').trim();
  return stripped || base;
}

/** The last segment of a tag id, normalized ("urn:tag:decor:qloo:japandi_style" -> "japandi"). */
export function idLabel(id: string): string {
  return normalizeStyleName(id.split(':').pop() ?? '');
}

export interface StyleVocabulary {
  version: string;
  entries: readonly VocabEntry[];
  byId: ReadonlyMap<string, VocabEntry>;
  /** Normalized label (and normalized id segment) -> entries, in file order. */
  byName: ReadonlyMap<string, readonly VocabEntry[]>;
  aliases: ReadonlyMap<string, string>;
  brands: readonly ExemplarBrand[];
}

export function buildVocabulary(entries: readonly VocabEntry[], brands: readonly ExemplarBrand[], aliases: readonly VocabAlias[]): StyleVocabulary {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byName = new Map<string, VocabEntry[]>();
  const add = (key: string, e: VocabEntry) => {
    if (!key) return;
    const list = byName.get(key) ?? [];
    if (!list.includes(e)) list.push(e);
    byName.set(key, list);
  };
  for (const e of entries) {
    add(normalizeStyleName(e.label), e);
    add(idLabel(e.id), e);
  }
  const aliasMap = new Map<string, string>();
  for (const a of aliases) if (byId.has(a.id)) aliasMap.set(normalizeStyleName(a.name), a.id);
  return { version: VOCAB_VERSION, entries, byId, byName, aliases: aliasMap, brands };
}

let loaded: StyleVocabulary | undefined;

/** The committed vocabulary (loaded once, lazily, from fixtures/qloo/style-vocab). */
export function styleVocabulary(): StyleVocabulary {
  if (loaded) return loaded;
  const read = (f: string) => JSON.parse(readFileSync(resolveFromWorkspace(`fixtures/qloo/style-vocab/${f}`), 'utf8')) as Record<string, unknown>;
  const vocab = read('vocab.json') as { entries: VocabEntry[] };
  const brands = read('brands.json') as { brands: ExemplarBrand[] };
  const aliases = read('vocab-aliases.json') as { aliases: VocabAlias[] };
  loaded = buildVocabulary(vocab.entries, brands.brands, aliases.aliases);
  return loaded;
}

export function setStyleVocabularyForTesting(v: StyleVocabulary | undefined): void {
  loaded = v;
}

/**
 * Closed tag_query vocabularies sent in the style prompt (R-2), per subject
 * category. Common labels only (seen on >= 4 harvested entities, or recorded
 * from a /v2/tags style probe), de-duplicated by normalized form, without
 * person-type names.
 */
const CLOSED_NAMESPACES: Record<StyleCategory, readonly string[]> = {
  fashion: ['fashion_segment', 'personal_style', 'material', 'design_inspiration'],
  interior: ['decor', 'setting', 'ambience'],
  place: ['decor', 'setting', 'ambience'],
  food: ['genre:place'],
  media: ['style', 'subgenre'],
  other: [],
};

export function closedVocabularyLists(v: StyleVocabulary = styleVocabulary(), minCount = 4): StyleVocabularyLists {
  const out: StyleVocabularyLists = {};
  for (const [category, namespaces] of Object.entries(CLOSED_NAMESPACES) as [StyleCategory, readonly string[]][]) {
    if (!namespaces.length) continue;
    const seen = new Set<string>();
    const labels: string[] = [];
    for (const ns of namespaces)
      for (const e of v.entries) {
        if (e.namespace !== ns) continue;
        const probe = e.seenOn.fixture.startsWith('probe-');
        if (e.count < minCount && !probe) continue;
        if (ns === 'genre:place' && !e.id.startsWith('urn:tag:genre:place:restaurant:')) continue;
        const key = normalizeStyleName(e.label);
        if (!key || seen.has(key) || personTypeAesthetic(e.label)) continue;
        seen.add(key);
        labels.push(e.label);
      }
    out[category] = labels;
  }
  return out;
}

/**
 * R-2: a tag_query must be one of the closed labels for the subject's
 * category; returns that label, or null (never fuzzy-matched).
 */
export function closedTagQuery(lists: StyleVocabularyLists, category: StyleCategory, query: string): string | null {
  const key = normalizeStyleName(query);
  if (!key) return null;
  return (lists[category] ?? []).find((l) => normalizeStyleName(l) === key) ?? null;
}
