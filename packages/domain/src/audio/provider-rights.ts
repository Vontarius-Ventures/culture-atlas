import type { QlooEntity } from '@culture-atlas/providers';
import { isClearedDisplayImageUrl } from '../services/display';

/**
 * Music Mode's durable Qloo sinks (DISC-SCR-013/014, VAL-EVID-005).
 *
 * The recorded Qloo rights policy (provider_rights_policies, migration 300)
 * keeps responses transient-only and display owned-or-cleared while the
 * provider's retention/display rights stay undocumented. Two Music Mode
 * stores are DURABLE, so they may only ever hold rights-safe material:
 *
 *  - `job_stages.output`: `ctx.runStage` is `runStageOnce`, which serializes
 *    the callback's COMPLETE return value. The resolve-qloo / related-qloo
 *    callbacks therefore persist the minimal replay projection below, never
 *    the provider's prose, image URLs or raw body.
 *  - `audio_analysis_requests.result`: results written before the rights
 *    repair stored Qloo-returned imagery. Reads sanitize old rows — only
 *    owned/cleared display assets may serve — while recognition, names,
 *    destinations and trace are never touched. Migration 350 removes the
 *    restricted stored copies.
 */

/** The only Qloo entity property the replay path needs: the verified destination source. */
const REPLAY_SAFE_PROPERTIES = ['website'] as const;

/** Rights-safe replay shape persisted for the 'resolve-qloo' (Qloo search) stage. */
export interface QlooSearchReplay {
  data: QlooEntity[];
}

/** Rights-safe replay shape persisted for the 'related-qloo' (Qloo insights) stage. */
export interface QlooInsightsReplay {
  /** Kept so replayed example data stays excluded from the result screen. */
  is_replay: boolean;
  data: { entities: QlooEntity[] };
}

/**
 * Minimal rights-safe projection of a Qloo entity for the durable stage
 * replay caches: the catalog identity (entity_id, name, types), the
 * same-name tiebreak (popularity) and the verified destination source
 * (properties.website). Everything else the adapter keeps — prose
 * (description/short_description), image URLs, tags, disambiguation, subtype,
 * ranking `query` material — is transient-only and never persists here.
 * Idempotent: projecting a projected entity returns it unchanged.
 */
export function qlooReplayEntity(entity: QlooEntity): QlooEntity {
  const properties: Record<string, unknown> = {};
  for (const key of REPLAY_SAFE_PROPERTIES) {
    const value = entity.properties?.[key];
    if (value !== undefined) properties[key] = value;
  }
  const replay: QlooEntity = {
    entity_id: entity.entity_id,
    name: entity.name,
    types: Array.isArray(entity.types) ? entity.types : [],
    properties,
    tags: [],
  };
  if (typeof entity.popularity === 'number') replay.popularity = entity.popularity;
  return replay;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The cleared portion of a legacy `image` value, served exactly as stored:
 * user-owned stored media (object_key) or an app-served/cleared URL
 * (services/display.ts clearedDisplayImage's rule). Anything else — an
 * uncleared external URL, e.g. a Qloo-returned picture from a pre-repair
 * result — becomes null. Non-objects are never cleared display assets.
 */
function clearedLegacyImage(raw: unknown): unknown {
  if (!isPlainObject(raw)) return null;
  if (raw.object_key) return raw;
  const url = typeof raw.url === 'string' ? raw.url.trim() : undefined;
  if (url && isClearedDisplayImageUrl(url)) return raw;
  return null;
}

/**
 * Serves an entity's `image` only when it is an owned or independently
 * cleared display asset; anything else becomes null. A missing key stays
 * missing.
 */
function withClearedImage(entity: Record<string, unknown>): Record<string, unknown> {
  if (!('image' in entity)) return entity;
  return { ...entity, image: clearedLegacyImage(entity.image) };
}

/**
 * Read boundary for stored analysis results (DISC-SCR-013): a result written
 * before the rights repair can still carry Qloo-returned imagery in
 * `artist.image_url` and the match artist/related `image` objects. Only owned
 * or independently cleared display assets may serve; recognition, names,
 * destinations and trace fields pass through untouched.
 */
export function sanitizeAudioAnalysisResult(result: unknown): unknown {
  if (!isPlainObject(result)) return result;
  const out: Record<string, unknown> = { ...result };
  if (isPlainObject(out.artist)) {
    const artist = { ...(out.artist as Record<string, unknown>) };
    if (artist.image_url !== undefined) {
      const url = artist.image_url;
      artist.image_url = typeof url === 'string' && isClearedDisplayImageUrl(url) ? url : null;
    }
    out.artist = artist;
  }
  if (isPlainObject(out.match)) {
    const match = { ...(out.match as Record<string, unknown>) };
    if (isPlainObject(match.artist)) match.artist = withClearedImage(match.artist as Record<string, unknown>);
    if (Array.isArray(match.related)) {
      match.related = match.related.map((rel) => (isPlainObject(rel) ? withClearedImage(rel) : rel));
    }
    out.match = match;
  }
  return out;
}
