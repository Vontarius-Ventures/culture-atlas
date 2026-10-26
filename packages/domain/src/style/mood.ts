/**
 * Mood alignment (eval r3, relevance cause 2): the style reading names moods
 * ("cozy", "austere", "serene"), and an aesthetic can carry one too
 * ("Abandoned decay"). A card whose own style words sit in the opposite mood
 * (cheerful bedding for an abandoned motel room) is not "more like this", so
 * its match score is cut hard and it falls behind honest matches.
 *
 * Small, fixed vocabulary; deterministic; a contradiction only counts when
 * BOTH sides name a mood family — silence on the entity side is never read as
 * disagreement (nothing is invented about a card that says nothing).
 */

export type MoodFamily = 'warm' | 'playful' | 'opulent' | 'airy' | 'serene' | 'energetic' | 'austere' | 'rugged' | 'melancholy';

const family = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/).filter(Boolean));

/**
 * Mood words by family (plain lowercase words, matched as whole words).
 *
 * Only words that name a mood survive here. Words that commonly describe
 * products, materials or design styles are deliberately absent ("dark" a
 * roast or a wash, "rich" a flavour, "cold" a brew, "minimalist" a design
 * language, "industrial" a look, "bright" and "fresh" flavour notes, "raw"
 * denim): measured on the live espresso run (r3run), they made every coffee
 * brand contradict a warm "Feels warm, Feels cozy" reading, cut all 17 real
 * results to 35 % of their score and gated the whole rail empty. Product
 * words are style evidence for scoreMatch, never moods.
 */
export const MOOD_WORDS: Readonly<Record<MoodFamily, ReadonlySet<string>>> = {
  warm: family('warm cozy comfy comfortable inviting welcoming snug homely homey intimate cheerful sunny'),
  playful: family('playful fun whimsical quirky lighthearted lighthearted carefree exuberant'),
  opulent: family('opulent luxurious luxury lavish glamorous glamour grand plush decadent ornate'),
  airy: family('airy breezy sunlit'),
  serene: family('serene calm tranquil peaceful relaxed soothing gentle'),
  energetic: family('energetic dynamic lively upbeat festive spirited'),
  austere: family('austere stark severe spare spartan bare clinical'),
  rugged: family('rugged weathered worn gritty rough tough hardy distressed'),
  melancholy: family('melancholy melancholic somber sombre moody gloomy abandoned derelict decayed decaying decay desolate faded lonely eerie haunting wistful forlorn bleak'),
};

/** Families whose moods point opposite ways (undirected pairs, kept deliberately small). */
export const MOOD_OPPOSITES: ReadonlyArray<readonly [MoodFamily, MoodFamily]> = [
  ['warm', 'austere'],
  ['warm', 'melancholy'],
  ['playful', 'austere'],
  ['playful', 'melancholy'],
  ['opulent', 'austere'],
  ['opulent', 'rugged'],
  ['airy', 'melancholy'],
  ['energetic', 'serene'],
  ['energetic', 'melancholy'],
];

const OPPOSITE: Readonly<Partial<Record<MoodFamily, ReadonlySet<MoodFamily>>>> = (() => {
  const out: Partial<Record<MoodFamily, Set<MoodFamily>>> = {};
  for (const [a, b] of MOOD_OPPOSITES) {
    (out[a] ??= new Set()).add(b);
    (out[b] ??= new Set()).add(a);
  }
  return out;
})();

/** The mood families a text names (whole words, case-insensitive; hyphens split). */
export function moodFamiliesOf(text: string): Set<MoodFamily> {
  const out = new Set<MoodFamily>();
  if (!text.trim()) return out;
  const words = new Set(
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
  for (const [fam, words2] of Object.entries(MOOD_WORDS)) for (const w of words2) if (words.has(w)) out.add(fam as MoodFamily);
  return out;
}

/** Whether the two sides name opposite mood families. */
export function moodContradicts(reading: ReadonlySet<MoodFamily>, entity: ReadonlySet<MoodFamily>): boolean {
  for (const f of reading) {
    const opp = OPPOSITE[f];
    if (!opp) continue;
    for (const g of entity) if (opp.has(g)) return true;
  }
  return false;
}

/** A contradictory card keeps this share of its match score ("strongly down-ranked"). */
export const MOOD_CONTRADICTION_FACTOR = 0.35;
