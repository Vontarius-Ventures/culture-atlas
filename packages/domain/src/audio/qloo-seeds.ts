import type { QlooEntity } from '@culture-atlas/providers';
import type { QlooAudioSeed } from '../schemas/audio';
import type { MusicRecognitionHit } from './recognition';

const ARTIST_TYPE = 'urn:entity:artist';

/**
 * Qloo seeds are returned catalog IDs only (AUD07). Recognition confidence is
 * never copied onto affinity; albums are metadata, not Insights targets.
 */
function normalizedName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Qloo search for an artist name usually returns several artists (the artist
 * plus tribute acts, collaborations, similarly named projects). When `query`
 * (the text the recognizer or transcript actually produced) names exactly one
 * of the returned artists, that artist is resolved; two or more exact-name
 * artists stay ambiguous. Only ids Qloo returned are ever used.
 */
export function artistSeedsFromQlooEntities(entities: readonly QlooEntity[], query?: string): {
  seeds: QlooAudioSeed[];
  status: 'resolved' | 'ambiguous' | 'unresolved';
} {
  const artists = entities.filter(
    (entity) =>
      typeof entity.entity_id === 'string' &&
      entity.entity_id.length > 0 &&
      entity.types.includes(ARTIST_TYPE),
  );
  if (artists.length === 1) {
    const artist = artists[0]!;
    return {
      status: 'resolved',
      seeds: [
        {
          entity_id: artist.entity_id,
          entity_type: ARTIST_TYPE,
          name: artist.name,
          insights_eligible: true,
        },
      ],
    };
  }
  if (artists.length > 1) {
    const wanted = query ? normalizedName(query) : '';
    const exact = wanted ? artists.filter((a) => normalizedName(a.name) === wanted) : [];
    if (exact.length === 1) return artistSeedsFromQlooEntities(exact);
    return { status: 'ambiguous', seeds: [] };
  }
  return { status: 'unresolved', seeds: [] };
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

const MAX_TRANSCRIPT_QUERIES = 3;
const MAX_QUERY_CHARS = 80;

function addQuery(queries: string[], seen: Set<string>, raw: string): void {
  const query = raw.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/g, '').trim();
  if (query.length < 2 || query.length > MAX_QUERY_CHARS) return;
  const key = query.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  queries.push(query);
}

/**
 * Pull artist/title phrases from a Scribe transcript. Never invent names;
 * Qloo is searched only with text the vendor returned.
 */
export function queriesFromTranscript(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const match of cleaned.matchAll(/["“']([^"'“”]{2,80})["”']/g)) {
    addQuery(queries, seen, match[1] ?? '');
  }
  for (const match of cleaned.matchAll(/\bby\s+([A-Z][\w'.]+(?:\s+[A-Z][\w'.]+){0,4})/g)) {
    addQuery(queries, seen, match[1] ?? '');
  }
  for (const match of cleaned.matchAll(
    /([A-Z][\w'.]+(?:\s+[A-Z][\w'.]+){0,4})\s+-\s+([A-Z][\w'.]+(?:\s+[A-Z][\w'.]+){0,5})/g,
  )) {
    addQuery(queries, seen, match[1] ?? '');
    addQuery(queries, seen, `${match[1] ?? ''} ${match[2] ?? ''}`);
  }
  if (queries.length === 0) {
    const first = (cleaned.split(/[.!?]/)[0] ?? '').trim().slice(0, MAX_QUERY_CHARS);
    addQuery(queries, seen, first);
  }
  return queries.slice(0, MAX_TRANSCRIPT_QUERIES);
}
