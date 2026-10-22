import type { QlooEntity } from '@culture-atlas/providers';
import type { QlooAudioSeed } from '../schemas/audio';
import type { MusicRecognitionHit } from './recognition';

const ARTIST_TYPE = 'urn:entity:artist';

/**
 * Qloo seeds are returned catalog IDs only (AUD07). Recognition confidence is
 * never copied onto affinity; albums are metadata, not Insights targets.
 */
export function artistSeedsFromQlooEntities(entities: readonly QlooEntity[]): {
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
  if (artists.length > 1) return { status: 'ambiguous', seeds: [] };
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
