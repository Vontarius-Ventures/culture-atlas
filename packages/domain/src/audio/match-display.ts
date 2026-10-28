import type { QlooEntity } from '@culture-atlas/providers';
import type { JobHandler } from '../jobs/handler';
import type { MusicRecognitionHit } from './recognition';

const ARTIST_TYPE = 'urn:entity:artist';
/** Related artists shown under a Music Mode match. */
export const AUDIO_RELATED_MAX = 6;

export interface AudioMatchArtist {
  entity_id: string;
  name: string;
  /**
   * Always null today (VAL-EVID-005): the only artist pictures available are
   * Qloo-returned image URLs, and the recorded Qloo rights policy keeps them
   * transient-only / owned-or-cleared-only for display. Nothing is fabricated
   * to fill the slot; it stays null until a cleared source exists.
   */
  image: null;
}

/**
 * What the Music Mode result screen shows for a match: the recording metadata
 * the recognizer returned, the Qloo artist name and related artist names from
 * Qloo Insights. Nothing here is invented: every field is null or empty when
 * the vendor did not return it, and no Qloo picture is retained or displayed.
 */
export interface AudioMatchDisplay {
  title: string | null;
  album_title: string | null;
  artist: AudioMatchArtist;
  related: AudioMatchArtist[];
}

type Ctx = Parameters<JobHandler<'analyze_audio'>>[0];

function artistFromEntity(entity: QlooEntity): AudioMatchArtist {
  return {
    entity_id: entity.entity_id,
    name: entity.name,
    image: null,
  };
}

async function relatedArtists(ctx: Ctx, seedId: string): Promise<AudioMatchArtist[]> {
  if (ctx.budget.qlooRequests <= 1) return [];
  const res = await ctx.runStage('related-qloo', async () => {
    try {
      return await ctx.providers.qloo.insights({
        filterType: ARTIST_TYPE,
        signalEntities: [seedId],
        take: AUDIO_RELATED_MAX + 2,
      });
    } catch {
      return null;
    }
  });
  if (!res || res.is_replay) return [];
  const seen = new Set([seedId]);
  const picked: QlooEntity[] = [];
  for (const e of res.data.entities) {
    if (!e.entity_id || !e.name?.trim() || seen.has(e.entity_id)) continue;
    if (!e.types.includes(ARTIST_TYPE)) continue;
    seen.add(e.entity_id);
    picked.push(e);
    if (picked.length >= AUDIO_RELATED_MAX) break;
  }
  return picked.map(artistFromEntity);
}

/**
 * Build the match display for a resolved Qloo artist seed: names only — Qloo
 * prose and image URLs stay transient and are never retained or displayed.
 */
export async function audioMatchDisplay(
  ctx: Ctx,
  entity: QlooEntity,
  hit: MusicRecognitionHit | null,
): Promise<AudioMatchDisplay> {
  const [artist, related] = await Promise.all([artistFromEntity(entity), relatedArtists(ctx, entity.entity_id)]);
  return {
    title: hit?.title ?? null,
    album_title: hit?.album_title ?? null,
    artist,
    related,
  };
}
