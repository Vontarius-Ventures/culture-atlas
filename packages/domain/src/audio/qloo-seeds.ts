import type { QlooEntity } from '@culture-atlas/providers';
import type { QlooAudioSeed } from '../schemas/audio';
import type { MusicRecognitionHit } from './recognition';

const ARTIST_TYPE = 'urn:entity:artist';

/** Case, accents, punctuation and a leading "The" ignored: "The Beatles" == "beatles". */
export function normalizeArtistName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^the\s+/, '');
}

function mentions(haystack: string, name: string): boolean {
  if (!name) return false;
  return ` ${haystack} `.includes(` ${name} `);
}

/**
 * Qloo seeds are returned catalog IDs only (AUD07). Recognition confidence is
 * never copied onto affinity; albums are metadata, not Insights targets.
 *
 * `heard` is the text the artist must appear in verbatim (normalized): the
 * transcript, or the recognizer's artist name. Qloo search is fuzzy (a
 * "Fleetwood Mac" search also returns TobyMac and G Tom Mac), so an artist is
 * resolved only when its name was actually heard. Same-named artists resolve
 * to the most popular; two different heard names stay ambiguous. A name that
 * is part of a longer heard name ("Mac" inside "Fleetwood Mac") does not count.
 */
export function artistSeedsFromQlooEntities(
  entities: readonly QlooEntity[],
  heard?: string,
): {
  seeds: QlooAudioSeed[];
  status: 'resolved' | 'ambiguous' | 'unresolved';
} {
  const artists = entities.filter(
    (entity) =>
      typeof entity.entity_id === 'string' &&
      entity.entity_id.length > 0 &&
      entity.types.includes(ARTIST_TYPE),
  );
  const seed = (artist: QlooEntity): QlooAudioSeed => ({
    entity_id: artist.entity_id,
    entity_type: ARTIST_TYPE,
    name: artist.name,
    insights_eligible: true,
  });
  if (heard === undefined) {
    if (artists.length === 1) return { status: 'resolved', seeds: [seed(artists[0]!)] };
    if (artists.length > 1) return { status: 'ambiguous', seeds: [] };
    return { status: 'unresolved', seeds: [] };
  }
  const haystack = normalizeArtistName(heard);
  const matched = artists.filter((a) => mentions(haystack, normalizeArtistName(a.name)));
  if (!matched.length) return { status: 'unresolved', seeds: [] };
  const names = [...new Set(matched.map((a) => normalizeArtistName(a.name)))];
  const maximal = names.filter((n) => !names.some((other) => other !== n && mentions(other, n)));
  if (maximal.length > 1) return { status: 'ambiguous', seeds: [] };
  const best = matched
    .filter((a) => normalizeArtistName(a.name) === maximal[0])
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0]!;
  return { status: 'resolved', seeds: [seed(best)] };
}

export function claimedQlooId(hit: MusicRecognitionHit, claimed: unknown): string | null {
  if (typeof claimed !== 'string' || claimed.length === 0) return null;
  return claimed;
}

/** A recognizer-claimed Qloo id is used only when Qloo itself returned it. */
export function seedIfQlooReturned(
  claimedId: string | null,
  entities: readonly QlooEntity[],
): QlooAudioSeed | null {
  if (!claimedId) return null;
  const hit = entities.find((entity) => entity.entity_id === claimedId && entity.types.includes(ARTIST_TYPE));
  if (!hit) return null;
  return {
    entity_id: hit.entity_id,
    entity_type: ARTIST_TYPE,
    name: hit.name,
    insights_eligible: true,
  };
}

export function searchQueryForHit(hit: MusicRecognitionHit): string | null {
  const name = hit.artist_name?.trim();
  return name ? name : null;
}

const MAX_TRANSCRIPT_QUERIES = 4;
const MAX_QUERY_CHARS = 60;
/** One capitalized word: letters/digits, inner apostrophes, hyphens and dots ("B.B."), never a trailing period. */
const WORD = "[A-Z](?:[\\w'’&-]|\\.(?=\\w))*";
const CONNECTOR = '(?:of|the|and|&|de|del|la|los|las|y|van|von|da|du|le)';
const NAME = `${WORD}(?:\\s+(?:${CONNECTOR}\\s+)?${WORD}){0,4}`;
/** Capitalized words that open sentences or frame the show, never artists on their own. */
const STOP_WORDS = new Set([
  'i', "i'm", 'you', "you're", 'we', "we're", 'it', "it's", 'this', 'that', "that's", 'the', 'a', 'and', 'so',
  'okay', 'ok', 'yeah', 'oh', 'up', 'next', 'now', 'here', "here's", 'there', 'thanks', 'thank', 'hello', 'hi',
  'welcome', 'radio', 'fm', 'music', 'song', 'album', 'track', 'today', 'tonight', 'later', 'coming', 'more',
  'right', 'well', 'just', 'what', 'who', 'one', 'my', 'our', 'your', 'he', 'she', 'they', 'if', 'but', 'then',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);
const isStop = (word: string) => STOP_WORDS.has(word.toLowerCase().replace(/’/g, "'"));

function addQuery(queries: string[], seen: Set<string>, raw: string): void {
  let words = raw.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  while (words.length && isStop(words[0]!)) words = words.slice(1);
  const query = words.join(' ').replace(/[\s.,;:!?]+$/g, '').trim();
  if (query.length < 2 || query.length > MAX_QUERY_CHARS) return;
  const key = query.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  queries.push(query);
}

/**
 * Pull artist-name candidates from a Scribe transcript. Never invents names:
 * Qloo is searched only with words the vendor returned, and only with
 * name-shaped phrases (DJ patterns first, then capitalized runs), never with
 * an arbitrary sentence. Apostrophes are not quotes ("You're" stays a word).
 * The job resolves an artist only when its full name appears in the
 * transcript (artistSeedsFromQlooEntities), so a stray title is harmless.
 */
export function queriesFromTranscript(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const queries: string[] = [];
  const seen = new Set<string>();
  // "by X" names the artist most reliably; then DJ cues ("listening to X").
  const cues = ["(?:[Bb]y|[Ff]rom)", "(?:[Ll]istening to|[Tt]his is|[Tt]hat was|[Hh]ere's|[Hh]ere is|[Yy]ou're hearing|[Pp]layed|[Pp]laying|[Mm]ore)"];
  for (const cue of cues)
    for (const match of cleaned.matchAll(new RegExp(`\\b${cue}\\s+(${NAME})`, 'g'))) addQuery(queries, seen, match[1] ?? '');
  for (const match of cleaned.matchAll(new RegExp(`(${NAME})\\s+[-–—]\\s+${NAME}`, 'g'))) addQuery(queries, seen, match[1] ?? '');
  for (const match of cleaned.matchAll(/["“]([^"“”]{2,60})["”]/g)) addQuery(queries, seen, match[1] ?? '');
  // Remaining capitalized runs. A lone capitalized word that opens a sentence
  // is just grammar ("Dreams." / "Okay,"), so it needs a second word.
  for (const match of cleaned.matchAll(new RegExp(NAME, 'g'))) {
    const at = match.index ?? 0;
    const sentenceStart = at === 0 || /[.!?]\s*$/.test(cleaned.slice(Math.max(0, at - 3), at));
    const run = match[0];
    if (sentenceStart && !run.includes(' ')) continue;
    addQuery(queries, seen, run);
  }
  return queries.slice(0, MAX_TRANSCRIPT_QUERIES);
}
