import type { QlooTag } from '@culture-atlas/providers';
import { isFineArtSubject } from './adjacency';
import { lowerFirst } from './text';
import type { StoredSubject } from './types';

/**
 * TOPIC-1 rail fill (eval r3, thin rails): the reading's OWN words — an
 * aesthetic, a lineage, an era ("Abandoned decay", "Roadside motel", "Classic
 * cafe", "Indo-Islamic architecture", "Baroque portrait") — resolved to real
 * Qloo genre/subgenre/theme tags, so a rail that ended empty or thin can be
 * filled with films (or artists) that CARRY one of those tags.
 *
 * Nothing is invented: a query returns nothing, there is no fill; a result
 * that does not carry the tag itself is dropped; the reason names the tag the
 * result really carries. Bounded and deterministic: at most a few query
 * words, derived the same way from the same reading every time.
 *
 * TOPIC-2 (eval r4) tightens both ends of that: a word that is a period or
 * school of ANOTHER art form is not the reading's own topic (h71 "romantic"),
 * and a resolved tag is kept only when its own name is made of words the
 * reading used, is more than a bare medium noun, and — for a rail of people —
 * names a sound (h56, h61). See the constants and `resolveTopicTags` below.
 */

/** Tag namespaces that say what a work is ABOUT (a genre or theme), as opposed to plot keywords. */
export const TOPIC_TAG_RE = /^urn:tag:(?:genre|subgenre|theme)(?::|$)/;

/**
 * TOPIC-2 (eval r4, h71): words whose Qloo genre or theme is a PERIOD or SCHOOL of another art
 * form. A "romantic" dress is a soft silhouette; Qloo's "Romantic" is the classical period, and
 * searching it filled the Play rail with Beethoven, Schubert and Brahms (iteration-4 judges:
 * relevance 5.25/10). Like any stopped word it names no topic of the reading's OWN domain —
 * unless the reading's own primary subject IS that art form: a work of fine art (the movement
 * names the work) or a media subject (music or film is what the reading is about).
 */
export const AMBIGUOUS_TOPIC_TERMS: ReadonlySet<string> = new Set(
  `romantic romanticism classical baroque renaissance medieval gothic impressionist impressionism surreal
   surrealism cubist cubism expressionist expressionism neoclassical postmodern modernist rococo byzantine`
    .split(/\s+/)
    .filter(Boolean),
);

/** Topic searches per rail fill: each is one cached /v2/tags lookup (bounded, eval r3: <= 2 per analysis). */
export const TOPIC_TAG_QUERIES_MAX = 2;
/** Resolved topic tags sent as one insights filter. */
export const TOPIC_TAGS_MAX = 3;
/**
 * For a fine-art subject, art itself is the honest topic (eval r3: artist-biopic themes for a
 * painting). TOPIC-2 keeps only a tag that names the art ("Dutch Golden Age painting"): a bare
 * "Painting" or "Art" tag is a medium noun and is dropped like any other generic tag (h61).
 */
export const ART_TOPIC_QUERIES: readonly string[] = ['painting', 'portrait'];

/** Words that name no topic: filler, generic style qualifiers, colours, garment nouns, feeling-words. */
const TOPIC_STOP = new Set(
  `the a an and or of with in on for to from by at as is are its it this that these those into over under your photo
   look looks like style styles aesthetic aesthetics design designs designed designer inspired inspiration resembles
   suggesting suggests century centuries era period feel feels vibe vibes culture cultural movement movements trend
   influenced influences traditional traditionalwear classic modern contemporary casual chic timeless
   elegant everyday basic smart unique
   black white red blue navy green yellow orange pink purple brown beige tan cream ivory gold silver olive
   khaki teal mint aqua burgundy maroon crimson charcoal camel ecru whites blues
   jacket coats coat tees tops top dress dresses skirt jeans pant pants sneakers shoes boots bag bags suit suits
   blouse shirt sweater hoodie vest belt sock outfit piece set bomber
   warm cozy comfy comfortable inviting welcoming snug homely homey intimate cheerful sunny
   fun whimsical quirky playful exuberant serene calm tranquil peaceful relaxed soothing gentle
   sweet pretty opulent luxurious luxury lavish glamorous glamour plush
   austere moody gloomy melancholy melancholic somber sombre bleak wistful forlorn
   indo mid pre post neo new old`.split(/\s+/).filter(Boolean),
);

interface TopicQuery {
  query: string;
  /** The subject whose words the query came from: its label names the photo in the reason. */
  label: string;
  /**
   * Every word the reading itself used for that subject (label, claims, visible properties).
   * TOPIC-2: a tag resolved through this query may not add a word that is not in here.
   */
  reading: readonly string[];
}

/** The words of a text, normalized: case, accents, apostrophes and punctuation folded. */
function textWords(text: string, minLength: number): string[] {
  return [
    ...new Set(
      text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[’'`]/g, '')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= minLength),
    ),
  ];
}

/**
 * Every word the reading itself used for one subject: the label, its claims and its visible
 * properties. Never the mood: a media rail is often built FROM a mood tag, so a mood word in a
 * tag name says nothing about the photo (see style/adjacency.ts).
 */
function readingWords(s: StoredSubject): readonly string[] {
  return textWords(
    [
      s.label,
      ...s.aesthetics.map((c) => c.name),
      ...s.lineage.map((c) => c.name),
      s.era?.name ?? '',
      ...s.materials.map((c) => c.name),
      ...s.construction.map((c) => c.name),
      ...s.details.map((c) => c.name),
      ...s.palette.map((p) => p.name),
    ].join(' ; '),
    3,
  );
}

/**
 * The reading's own words to search as topics, strongest first: the head word of each aesthetic
 * and lineage claim (its last topic word — "Roadside motel" -> motel), then the claim's other
 * words ("abandoned"), then era words. A fine-art subject asks for art itself first. Never the
 * label or the mood: those name the thing and the feeling, not what to watch or hear.
 */
export function topicTagPlan(subjects: readonly StoredSubject[], max = TOPIC_TAG_QUERIES_MAX): readonly TopicQuery[] {
  const out: TopicQuery[] = [];
  const seen = new Set<string>();
  const primary = subjects[0];
  // TOPIC-2: a period or school of another art form is only the reading's own topic when the
  // reading IS that art form — a work of fine art, or a music or film subject.
  const ownArtSense = !!primary && (isFineArtSubject(primary) || primary.category === 'media');
  const add = (word: string, s: StoredSubject) => {
    if (seen.has(word)) return;
    seen.add(word);
    out.push({ query: word, label: s.label, reading: readingWords(s) });
  };
  const words = (text: string): string[] =>
    textWords(text, 4).filter((w) => !TOPIC_STOP.has(w) && (ownArtSense || !AMBIGUOUS_TOPIC_TERMS.has(w)));
  if (primary && isFineArtSubject(primary)) for (const q of ART_TOPIC_QUERIES) add(q, primary);
  const claims = (s: StoredSubject): readonly { name: string }[] => [
    ...s.aesthetics.filter((c) => !c.held && !c.retracted),
    ...s.lineage.filter((c) => !c.held && !c.retracted),
  ];
  const shown = <T extends { held: boolean; retracted?: boolean }>(x: T | null | undefined): x is T => !!x && !x.held && !x.retracted;
  for (const s of subjects) {
    // Every claim's head word first (the topics themselves: "decay", "motel"), then the modifiers
    // ("abandoned", "roadside") — so a cap never trades a topic word for a qualifier.
    const ws = claims(s).map((c) => words(c.name));
    for (const list of ws) if (list.length) add(list.at(-1)!, s);
    for (const list of ws) for (const w of list) add(w, s);
    if (shown(s.era)) for (const w of words(s.era.name)) add(w, s);
    if (out.length >= max) return out.slice(0, max);
  }
  return out.slice(0, max);
}

/** A resolved Qloo tag the reading's own words found. */
export interface StyleTopicTag {
  tagId: string;
  /** The tag's own name, as Qloo returned it (the reason names it). */
  name: string;
  /** The reading subject whose words resolved to the tag. */
  label: string;
  /** Qloo's 0..1 popularity percentile, when returned (ordering only). */
  popularity: number;
}

/**
 * TOPIC-2 (eval r4, h56): a rail whose cards are people is filled only by a tag that names a
 * SOUND. A narrative theme on an artist's profile ("Urban Decay") says what a song is about, not
 * what the artist plays, and it filled the Play rail of an abandoned motel room with artists the
 * judges called thin. Films keep Qloo's own themes and subgenres: that is where a topic like
 * "Roadside Motel" lives.
 */
const RAIL_TAG_RE: Readonly<Record<string, RegExp>> = { 'urn:entity:artist': /^urn:tag:genre:music(?::|$)/ };

/**
 * TOPIC-2 (eval r4, h61): a bare domain, medium or industry noun is not evidence about the
 * reading's subject — every work in the catalogue carries the medium it is made in — so it never
 * fills a rail ("A film tagged Art" says nothing about a portrait). A tag that names the subject's
 * own topic still fills ("Dutch Golden Age painting", "Roadside Motel").
 */
export const GENERIC_TOPIC_TAGS: ReadonlySet<string> = new Set(
  `art arts music film films movie movies cinema television tv photography photograph entertainment media
   literature books novel culture lifestyle life people person celebrity painting paintings portrait portraits
   artist artists fashion style`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Keep only real genre/subgenre/theme tags the target entity type carries
 * (the /v2/tags parents say which types a tag is known on): a decor tag or a
 * place genre never steers films. Most popular first (obscure tags name no
 * film), then by name; capped. Deterministic: same lookups, same tags, same
 * order.
 *
 * TOPIC-2 (eval r4): what Qloo returns for a word is not yet evidence about the
 * photo. A tag is kept only when its own name is made of words the reading used
 * (the same convention ground-v7 applies to a tag reached through a query: it may
 * add no word), when it is more than a bare domain or medium noun, and — for a
 * rail of people — when it names a sound. A tag that fails is dropped: an empty
 * rail is honest, "A film tagged Urban Decay, like the abandoned motel room in
 * your photo" is not.
 */
export function resolveTopicTags(
  plan: readonly TopicQuery[],
  results: ReadonlyMap<string, readonly QlooTag[]>,
  targetType: string,
  max = TOPIC_TAGS_MAX,
): readonly StyleTopicTag[] {
  const out: StyleTopicTag[] = [];
  const seen = new Set<string>();
  const railTag = RAIL_TAG_RE[targetType];
  for (const { query, label, reading } of plan) {
    const supported = new Set(reading);
    for (const tag of results.get(query) ?? []) {
      if (!TOPIC_TAG_RE.test(tag.id) || seen.has(tag.id)) continue;
      if (railTag && !railTag.test(tag.id)) continue;
      // Entity types in parents: when Qloo says which types carry the tag, the target must be one.
      const types = (tag.parents ?? []).filter((p) => p.startsWith('urn:entity:'));
      if (types.length && !types.includes(targetType)) continue;
      // The tag's own name: a bare domain or medium noun says nothing, and a word the reading
      // never used is Qloo's sense of the word, not the photo's (a stop word adds no topic).
      const name = textWords(tag.name, 1);
      if (!name.length || (name.length === 1 && GENERIC_TOPIC_TAGS.has(name[0]!))) continue;
      if (name.some((w) => !supported.has(w) && !TOPIC_STOP.has(w))) continue;
      seen.add(tag.id);
      out.push({ tagId: tag.id, name: tag.name, label, popularity: tag.popularity ?? 0 });
    }
  }
  return out
    .sort((a, b) => b.popularity - a.popularity || a.name.localeCompare(b.name) || a.tagId.localeCompare(b.tagId))
    .slice(0, max);
}

/**
 * The reason for one fill card: the tag the result itself carries, next to the reading's own
 * subject ("A film tagged Roadside motel, like the motel room in your photo"). At most 90
 * characters like every reason (REASON_MAX_CHARS); plain words, never a provider name.
 */
export function taggedTopicReason(targetType: string, tagName: string, label: string): string {
  const lead = targetType === 'urn:entity:artist' ? 'An artist tagged' : 'A film tagged';
  const text = `${lead} ${tagName}, like the ${lowerFirst(label)} in your photo`;
  return text.length <= 90 ? text : `${lead} ${tagName}, like your photo`.slice(0, 89);
}
