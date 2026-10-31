import type { QlooEntity } from '@culture-atlas/providers';
import type { Category } from '../enums';
import type { StoredSubject } from './types';
import { activeClaim } from './discovery-concepts';

/**
 * Cross-domain adjacency (eval r3, relevance cause 1 and 3): a More-like-this
 * result may only bridge into another domain when the origin subject really
 * maps there, and an entertainment card may only come from a style-adjacent
 * photo when the entity itself carries the evidence (its own name, tags or
 * properties reference the subject, or it is about the subject's art).
 * When in doubt there is no bridge: a shorter rail is honest, an invented
 * adjacency is not. Pure and deterministic; every card stays a real Qloo id.
 */

export type CrossDomainCategory = Extract<Category, 'wear' | 'play' | 'watch'>;

/** An artwork in the reading's own words (painting, illustration, poster of a person, ...). */
const ARTWORK_RE =
  /(?<![\p{L}\p{N}-])(?:paintings?|portraits?|portraiture|oil on canvas|illustrations?|posters?|artworks?|sculptures?|statues?|busts?|figurines?|ceramic heads?|(?:head|face) vessels?|effig(?:y|ies)|murals?|watercolou?rs?|engravings?|etchings?|sketch(?:es)?|fresco(?:es)?|lithographs?|old masters?|tronie)(?![\p{L}\p{N}-])/iu;
/** Reproductions that are media questions, not works of visual art: their own rail is films, music or books. */
const REPRODUCTION_RE = /\b(?:posters?|albums?|book covers?|movies?|films?|cinema|screens?|soundtracks?|tv)\b/i;

function artworkText(s: Pick<StoredSubject, 'label' | 'aesthetics' | 'lineage'>): string {
  // Normalize compound separators, keeping compounds intact. A spaced "four poster"
  // is the same furniture form, not a standalone poster.
  return [s.label, ...s.aesthetics.filter(activeClaim).map((a) => a.name), ...s.lineage.filter(activeClaim).map((l) => l.name)]
    .join(' ; ').replace(/[\u2010-\u2015]/g, '-').replace(/\bfour\s+poster\b/gi, 'four-poster');
}

/** Explicit art forms, not a painted finish or a fragment inside a compound word. */
export function isArtworkSubject(s: Pick<StoredSubject, 'label' | 'aesthetics' | 'lineage'>): boolean {
  return ARTWORK_RE.test(artworkText(s));
}

/** True for a work of visual art (a painting or illustration), false for a reproduction of media (a film poster). */
export function isFineArtSubject(s: Pick<StoredSubject, 'label' | 'aesthetics' | 'lineage'>): boolean {
  const text = artworkText(s);
  return ARTWORK_RE.test(text) && !REPRODUCTION_RE.test(text);
}

const KEYWORD_STOP = new Set(
  'the a an and or of with in on for to from by at as is are its it this that these those into over under your photo style styles look looks like aesthetic aesthetics resembles suggesting suggests century centuries era period'.split(
    ' ',
  ),
);

/**
 * The subject's own keyword words (label, aesthetics, lineage, era), for entity-side adjacency
 * evidence. Mood words are left out: a media rail is often built FROM a mood tag ("Moody"), so
 * every result would share it by construction and pass as adjacency.
 */
export function subjectKeywords(s: Pick<StoredSubject, 'label' | 'aesthetics' | 'lineage' | 'era'>): string[] {
  const text = [s.label, ...s.aesthetics.filter(activeClaim).map((a) => a.name), ...s.lineage.filter(activeClaim).map((l) => l.name), activeClaim(s.era) ? s.era.name : ''].join(' ; ');
  return keywordWords(text);
}

/** Keyword words from the analysis's own reference names — the artwork's identity ("Girl with a Pearl Earring"). */
export function referenceKeywords(names: readonly string[]): string[] {
  return keywordWords(names.join(' ; '));
}

function keywordWords(text: string): string[] {
  return [...new Set(
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !KEYWORD_STOP.has(w)),
  )];
}

/** Qloo's own art topic words: a film or artist tagged with one of these is about art, not merely co-liked with it. */
export const ART_TOPIC_WORDS: readonly string[] = [
  'artist',
  'artists',
  'painter',
  'painting',
  'portrait',
  'portraiture',
  'museum',
  'gallery',
  'artwork',
  'sculptor',
  'sculpture',
  'sculptures',
  'curator',
];

/** Adjacency evidence one entity must carry: the subject's keywords, or the origin domain's own topic words. */
export interface AdjacencyEvidence {
  keywords: readonly string[];
  topics: readonly string[];
}

/** Tag namespaces that say what a work is ABOUT (a genre or theme), as opposed to plot keywords. */
const TOPIC_TAG_RE = /^urn:tag:(?:genre|subgenre|theme)(?::|$)/;

/**
 * The words an entity itself carries: its name and its tag names. Free-text descriptions are left
 * out, and `topicOnly` keeps only genre and theme tags: a popular film carries hundreds of plot
 * keyword tags, so one art word among them ("art therapist") is a coincidence, not a topic.
 */
function entityWords(entity: Pick<QlooEntity, 'name' | 'tags'>, topicOnly = false): Set<string> {
  const words = new Set<string>();
  const add = (text: string) => {
    for (const w of text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[’'`]/g, '')
      .split(/[^\p{L}\p{N}]+/u))
      if (w.length >= 3) words.add(w);
  };
  if (!topicOnly) add(entity.name ?? '');
  for (const t of entity.tags ?? []) if (t.name && (!topicOnly || TOPIC_TAG_RE.test(t.id))) add(t.name);
  return words;
}

/** Art-medium words carried by anything about art ("painting", "portrait", "oil"): never distinctive evidence. */
const GENERIC_ART_WORDS: ReadonlySet<string> = new Set(
  `art arts artist artists painter painters painting paintings portrait portraits portraiture
   artwork artworks museum museums gallery galleries sculptor sculptors sculpture sculptures curator curators oil`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Whether a real Qloo entity carries the evidence that it is about this subject (never invented,
 * only read). Keywords count from two shared words up — one common word ("pearl" in "Pearl
 * Harbor" for a pearl-earring painting) is a coincidence, not adjacency — and at least one shared
 * word must be distinctive (eval r5, h61): generic art-medium words ("painting", "portrait", "oil")
 * are carried by anything about art, so two of them alone say "about art" at best, never "about
 * this subject". The topic path below carries the about-art case.
 */
export function entityAdjacency(entity: Pick<QlooEntity, 'name' | 'tags'>, evidence: AdjacencyEvidence): boolean {
  const words = entityWords(entity);
  const shared = evidence.keywords.filter((k) => words.has(k));
  if (shared.length >= 2 && shared.some((k) => !GENERIC_ART_WORDS.has(k))) return true;
  const topics = entityWords(entity, true);
  return evidence.topics.some((k) => topics.has(k));
}

/**
 * Which cross-domain categories a bridge from a given origin subject may
 * signal. Fashion rails bridge anywhere their audience really overlaps
 * (streetwear -> music and film scored 6/6 with both judges); interior,
 * craft, food and place subjects do not bridge at all — their honest
 * entertainment surface is the topic path (architecture films for
 * architecture, food films for a dish), not a home brand's co-likers.
 */
export const BRIDGE_TARGETS: Partial<Record<StoredSubject['category'], readonly CrossDomainCategory[]>> = {
  fashion: ['wear', 'play', 'watch'],
  media: ['watch'],
};

export function bridgeTargets(category: StoredSubject['category']): readonly CrossDomainCategory[] {
  return BRIDGE_TARGETS[category] ?? [];
}

/** Wear is not a question an artwork asks (eval r3, cause 3): no brand cards for a painting or poster of a person. */
export function suppressWearForArtwork(subjects: readonly StoredSubject[]): boolean {
  return subjects.length > 0 && isArtworkSubject(subjects[0]!);
}

/** A fine-art primary subject: its entertainment cards must reference it or be about art itself. */
export function artworkEvidence(subjects: readonly StoredSubject[]): AdjacencyEvidence | null {
  const s = subjects[0];
  if (!s || !isFineArtSubject(s)) return null;
  return { keywords: subjectKeywords(s), topics: ART_TOPIC_WORDS };
}

/** The same gate for a media subject's own "More like this" rail (a painting's films must be about it, or about art). */
export function mediaArtworkGate(s: StoredSubject): AdjacencyEvidence | null {
  return s.category === 'media' && isFineArtSubject(s) ? { keywords: subjectKeywords(s), topics: ART_TOPIC_WORDS } : null;
}
