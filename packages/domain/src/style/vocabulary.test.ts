import { readFileSync, readdirSync } from 'node:fs';
import { resolveFromWorkspace } from '@culture-atlas/providers';
import { describe, expect, it } from 'vitest';
import { closedTagQuery, closedVocabularyLists, idLabel, normalizeStyleName, styleVocabulary } from './vocabulary';

const fixtureText = new Map<string, string>();
const fixture = (rel: string) => {
  let t = fixtureText.get(rel);
  if (t === undefined) {
    t = readFileSync(resolveFromWorkspace(`fixtures/qloo/${rel}`), 'utf8');
    fixtureText.set(rel, t);
  }
  return t;
};

describe('style vocabulary svocab-1 (style design §C.2, R-1, R-2, R-7d)', () => {
  const v = styleVocabulary();

  it('every id comes from a recorded real Qloo response, on the fixture it names', () => {
    expect(v.entries.length).toBeGreaterThan(1000);
    const missing = v.entries.filter((e) => !fixture(e.seenOn.fixture).includes(`"${e.id}"`));
    expect(missing.map((e) => e.id)).toEqual([]);
  });

  it('has no duplicate ids and every label is the tag\'s own name', () => {
    expect(new Set(v.entries.map((e) => e.id)).size).toBe(v.entries.length);
    for (const e of v.entries.slice(0, 500)) expect(fixture(e.seenOn.fixture), e.id).toContain(`"name":"${e.label}"`);
  });

  it('never contains target_* or market_archetype tags (R-7d)', () => {
    expect(v.entries.filter((e) => /target_(gender|age_group|income_level)|market_archetype/.test(e.id))).toEqual([]);
    for (const b of v.brands) expect(b.style_tag_ids.some((id) => /target_|market_archetype/.test(id)), b.name).toBe(false);
  });

  it('every alias points at an existing id (reviewed list, empty until the owner approves entries)', () => {
    for (const [, id] of v.aliases) expect(v.byId.has(id)).toBe(true);
    const raw = JSON.parse(fixture('style-vocab/vocab-aliases.json')) as { aliases: { id: string; approved_by: string; reason: string }[] };
    for (const a of raw.aliases) {
      expect(v.byId.has(a.id), a.id).toBe(true);
      expect(a.approved_by).toBeTruthy();
      expect(a.reason).toBeTruthy();
    }
  });

  it('the exemplar matrix (brands.json) holds only recorded brands and recorded tag ids', () => {
    const pages = readdirSync(resolveFromWorkspace('fixtures/qloo/style-vocab/raw')).filter((f) => f.startsWith('fashion-brands-')).map((f) => fixture(`style-vocab/raw/${f}`)).join('\n');
    expect(v.brands.length).toBeGreaterThan(500);
    for (const b of v.brands.slice(0, 200)) {
      expect(pages, b.name).toContain(`"entity_id":"${b.id}"`);
      for (const id of b.style_tag_ids) expect(v.byId.has(id), `${b.name} ${id}`).toBe(true);
    }
  });

  it('normalizes names for exact acceptance (C.2 rule 1)', () => {
    expect(normalizeStyleName('Mid-Century_Modern Style')).toBe('mid century modern');
    expect(normalizeStyleName('Wabi-sabi')).toBe('wabi sabi');
    expect(normalizeStyleName('Café Chic')).toBe('cafe');
    expect(idLabel('urn:tag:decor:qloo:japandi_style')).toBe('japandi');
  });

  it('closed tag_query lists per category (R-2): common labels, no person types, exact lookup only', () => {
    const lists = closedVocabularyLists(v);
    expect(lists.fashion!.length).toBeGreaterThan(100);
    expect(lists.interior).toEqual(lists.place);
    expect(lists.other).toBeUndefined();
    expect(closedTagQuery(lists, 'fashion', 'workwear')).toBe('Workwear');
    expect(closedTagQuery(lists, 'fashion', 'Rugged Americana')).toBeNull();
  });
});
