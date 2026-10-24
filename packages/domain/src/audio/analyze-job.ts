import { randomUUID } from 'node:crypto';
import {
  createMultipartStorage,
  loadProviderConfig,
  type MultipartStorage,
  type QlooEntity,
} from '@culture-atlas/providers';
import { canonicalKeyFor, upsertDiscoveryItem } from '../composer/store';
import { AppError } from '../errors';
import { JobCancelledError, type JobHandler } from '../jobs/handler';
import { relatedDiscoveryDedupeKey } from '../jobs/dedupe';
import { enqueueJob } from '../jobs/queue';
import type { Queryable } from '../db/pool';
import { clipText, destinationFromQlooProperties, imageFromQlooProperties } from '../services/display';
import { getTasteRevision } from '../services/taste';
import { audioMatchDisplay, type AudioMatchDisplay } from './match-display';
import { artistSeedsFromQlooEntities, queriesFromTranscript, searchQueryForHit } from './qloo-seeds';
import {
  musicRecognitionFromConfig,
  publicMusicState,
  type MusicRecognition,
  type MusicRecognitionResult,
} from './recognition';
import { elevenLabsFromConfig, type AudioTranscription } from './transcription';

/** Reads capture-v2 originals (the namespace POST /v2/media/audio writes). */
export type AudioOriginalReader = Pick<MultipartStorage, 'read'>;

export interface AnalyzeAudioOptions {
  recognition?: MusicRecognition;
  transcription?: AudioTranscription;
  originals?: AudioOriginalReader;
}

let registeredOriginals: AudioOriginalReader | undefined;
/** The worker registers the same multipart storage the web API and media worker use. */
export function setAudioOriginalStorage(reader: AudioOriginalReader | undefined): void {
  registeredOriginals = reader;
}
function defaultOriginals(signingSecret: string): AudioOriginalReader {
  registeredOriginals ??= createMultipartStorage(loadProviderConfig(), {
    production: process.env.NODE_ENV === 'production',
    fallbackSigningSecret: signingSecret,
  });
  return registeredOriginals;
}

/** Whole original as bytes; null only when the object does not exist. */
async function readOriginal(
  reader: AudioOriginalReader,
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  let object;
  try {
    object = await reader.read(key);
  } catch (err) {
    const code = (err as { code?: string; name?: string } | null)?.code ?? (err as { name?: string } | null)?.name;
    if (code === 'ENOENT' || code === 'NoSuchKey' || code === 'NotFound') return null;
    throw err;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of object.body) chunks.push(chunk);
  return { bytes: Buffer.concat(chunks), contentType: object.contentType };
}

interface AudioWork {
  analysisId: string;
  assetId: string;
  accountId: string;
  generation: number;
  durationMs: number;
  originalKey: string | null;
  contentType: string | null;
  deletedAt: Date | null;
  windows: { start_ms: number; end_ms: number }[];
  trackId: string | null;
}

async function loadWork(db: Queryable, analysisId: string, accountId: string): Promise<AudioWork> {
  const { rows } = await db.query(
    `SELECT a.id, a.asset_id, a.account_id, a.generation, a.selection, a.state AS analysis_state,
            m.duration_ms, m.original_key, m.content_type, m.deleted_at
       FROM audio_analysis_requests a
       JOIN media_assets m ON m.account_id=a.account_id AND m.id=a.asset_id
      WHERE a.id=$1 AND a.account_id=$2`,
    [analysisId, accountId],
  );
  const row = rows[0];
  if (!row) throw new AppError('not_found');
  const track = await db.query(
    `SELECT id FROM media_tracks WHERE account_id=$1 AND asset_id=$2 AND generation=$3 AND role='primary'`,
    [accountId, row.asset_id, row.generation],
  );
  const selection = row.selection as { windows?: { start_ms: number; end_ms: number }[] };
  return {
    analysisId: row.id,
    assetId: row.asset_id,
    accountId: row.account_id,
    generation: row.generation,
    durationMs: row.duration_ms,
    originalKey: row.original_key,
    contentType: typeof row.content_type === 'string' ? row.content_type : null,
    deletedAt: row.deleted_at,
    windows: selection.windows ?? [],
    trackId: track.rows[0]?.id ?? null,
  };
}

function evidenceStatus(result: MusicRecognitionResult): 'matched' | 'ambiguous' | 'no_match' | 'unavailable' {
  if (result.status === 'matched') return 'matched';
  if (result.status === 'ambiguous') return 'ambiguous';
  if (result.status === 'no_match') return 'no_match';
  return 'unavailable';
}

/** Fails the analysis honestly when the recording cannot be read (never a provider outage). */
async function failUnreadable(
  ctx: Parameters<JobHandler<'analyze_audio'>>[0],
  work: AudioWork,
  accountId: string,
): Promise<never> {
  await ctx.db.query(
    `UPDATE audio_analysis_components SET state='failed', reason='storage_unavailable', updated_at=now()
      WHERE account_id=$1 AND analysis_id=$2 AND component='music_match'`,
    [accountId, work.analysisId],
  );
  await ctx.db.query(
    `UPDATE audio_analysis_requests SET state='failed', error_code='storage_unavailable', completed_at=now()
      WHERE account_id=$1 AND id=$2`,
    [accountId, work.analysisId],
  );
  await ctx.db.query(`UPDATE media_assets SET analysis_status='failed' WHERE account_id=$1 AND id=$2`, [
    accountId,
    work.assetId,
  ]);
  throw new AppError('service_unavailable', {
    message: 'We couldn’t read this recording. It is still in your library.',
    retryable: false,
    details: { reason: 'storage_unavailable' },
  });
}

/**
 * A resolved Music Mode artist becomes a library item and starts one related
 * discovery (Qloo insights from the artist across Watch, Play, Wear and Eat).
 * Its results join the interest feed as "Because you heard <artist>."
 */
async function startArtistDiscovery(
  ctx: Parameters<JobHandler<'analyze_audio'>>[0],
  accountId: string,
  seed: { entity_id: string; name: string },
  entity: QlooEntity | undefined,
): Promise<{ itemId: string; discoveryJobId: string; jobId: string; imageUrl: string | null }> {
  const owner = { kind: 'account' as const, accountId };
  const image = imageFromQlooProperties(entity?.properties, seed.name);
  const description = entity?.properties?.['short_description'] ?? entity?.properties?.['description'];
  const itemId = await upsertDiscoveryItem(ctx.db, owner, {
    kind: 'artist',
    category: 'play',
    canonical_key: canonicalKeyFor({ kind: 'artist', title: seed.name, qlooId: seed.entity_id }),
    title: seed.name,
    display_metadata: {
      subtitle: 'Heard in Music Mode',
      description: typeof description === 'string' ? clipText(description) : null,
      image,
      destination_url: destinationFromQlooProperties(entity?.properties),
    },
    external_ids: { qloo: seed.entity_id },
  });
  const tasteRevision = await getTasteRevision(ctx.db, owner);
  return ctx.db.transaction(async (tx) => {
    const dedupeKey = relatedDiscoveryDedupeKey({
      owner,
      originItemId: itemId,
      category: null,
      tasteRevision,
      grantContext: 'music_mode',
    });
    const existing = await tx.query<{ id: string; payload: { discovery_job_id: string } }>(
      `SELECT id, payload FROM jobs WHERE dedupe_key = $1 AND state NOT IN ('failed', 'cancelled')`,
      [dedupeKey],
    );
    if (existing.rows[0])
      return {
        itemId,
        discoveryJobId: existing.rows[0].payload.discovery_job_id,
        jobId: existing.rows[0].id,
        imageUrl: image?.url ?? null,
      };
    const dj = await tx.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id, category, taste_revision, source, source_label)
       VALUES ($1, $2, NULL, $3, 'music_mode', $4) RETURNING id`,
      [accountId, itemId, tasteRevision, seed.name.slice(0, 200)],
    );
    const discoveryJobId = dj.rows[0]!.id;
    const { job } = await enqueueJob(tx, {
      type: 'discover_related',
      owner,
      payload: { discovery_job_id: discoveryJobId, origin_item_id: itemId, taste_revision: tasteRevision },
      dedupeKey,
      maxAttempts: ctx.config.JOB_MAX_ATTEMPTS,
      budget: { qloo_requests: ctx.config.JOB_MAX_QLOO_REQUESTS, provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES },
      traceId: ctx.job.trace_id ?? undefined,
      resultType: 'discovery_job',
      resultId: discoveryJobId,
    });
    await tx.query('UPDATE discovery_jobs SET job_id = $2 WHERE id = $1', [discoveryJobId, job.id]);
    return { itemId, discoveryJobId, jobId: job.id, imageUrl: image?.url ?? null };
  });
}

async function searchArtists(
  ctx: Parameters<JobHandler<'analyze_audio'>>[0],
  query: string,
): Promise<QlooEntity[]> {
  if (!query || ctx.budget.qlooRequests <= 0) return [];
  const found = await ctx.runStage('resolve-qloo', async () => {
    try {
      return await ctx.providers.qloo.searchEntities({
        query,
        types: ['urn:entity:artist'],
        take: 5,
      });
    } catch {
      return null;
    }
  });
  return found?.data ?? [];
}

export async function runAnalyzeAudio(
  ctx: Parameters<JobHandler<'analyze_audio'>>[0],
  options: AnalyzeAudioOptions = {},
) {
  const recognition = options.recognition ?? musicRecognitionFromConfig();
  const transcription = options.transcription ?? elevenLabsFromConfig(ctx.config);
  const accountId = ctx.job.owner_account_id;
  if (!accountId) throw new AppError('invalid_input', { retryable: false });
  const work = await loadWork(ctx.db, ctx.payload.analysis_id, accountId);
  if (work.deletedAt) throw new JobCancelledError('deleted');
  await ctx.ensureActive();
  await ctx.setStage('matching');
  await ctx.db.query(
    `UPDATE audio_analysis_requests SET state='running' WHERE account_id=$1 AND id=$2 AND state IN ('queued','running')`,
    [accountId, work.analysisId],
  );
  await ctx.db.query(
    `UPDATE media_assets SET analysis_status='running' WHERE account_id=$1 AND id=$2`,
    [accountId, work.assetId],
  );
  await ctx.db.query(
    `UPDATE audio_analysis_components SET state='running', updated_at=now()
      WHERE account_id=$1 AND analysis_id=$2 AND component='music_match'`,
    [accountId, work.analysisId],
  );

  const window = work.windows[0] ?? { start_ms: 0, end_ms: Math.min(work.durationMs, 15_000) };
  let bytes = new Uint8Array();
  let mediaType = work.contentType ?? undefined;
  if (!work.originalKey) return failUnreadable(ctx, work, accountId);
  {
    // Audio originals live in the capture-v2 namespace (POST /v2/media/audio),
    // not in the legacy object store. A miss fails the analysis honestly.
    const reader = options.originals ?? registeredOriginals ?? defaultOriginals(ctx.config.SESSION_SECRET);
    let stored: Awaited<ReturnType<typeof readOriginal>>;
    try {
      stored = await readOriginal(reader, work.originalKey);
    } catch {
      stored = null;
    }
    if (!stored || stored.bytes.length === 0) return failUnreadable(ctx, work, accountId);
    bytes = Uint8Array.from(stored.bytes);
    mediaType = stored.contentType || mediaType;
  }
  const identified = await ctx.runStage('recognize', () =>
    recognition.identify({
      bytes,
      startMs: window.start_ms,
      endMs: window.end_ms,
      signal: ctx.signal,
    }),
  );

  await ctx.ensureActive();
  const live = await loadWork(ctx.db, work.analysisId, accountId);
  if (live.deletedAt) throw new JobCancelledError('deleted');

  const hit = identified.hits[0] ?? null;
  let seeds: { entity_id: string; entity_type: 'urn:entity:artist'; name: string; insights_eligible: true }[] = [];
  let resolution: 'resolved' | 'ambiguous' | 'unresolved' | null = null;
  let method: 'fingerprint' | 'transcript' = 'fingerprint';
  let transcriptText: string | null = null;
  let transcriptReason: string | null = null;
  let seedEntity: QlooEntity | undefined;
  if (identified.status === 'matched' && hit) {
    const query = searchQueryForHit(hit);
    if (query) {
      const found = await searchArtists(ctx, query);
      const mapped = artistSeedsFromQlooEntities(found, query);
      seeds = mapped.seeds;
      resolution = mapped.status;
      seedEntity = found.find((e) => e.entity_id === seeds[0]?.entity_id);
    } else {
      resolution = 'unresolved';
    }
  }

  if ((!seeds.length || resolution !== 'resolved') && transcription.enabled && bytes.length > 0) {
    try {
      const spoken = await ctx.runStage('transcribe', () =>
        transcription.transcribe({ bytes, signal: ctx.signal, mediaType }),
      );
      transcriptText = spoken.text;
      const queries = queriesFromTranscript(spoken.text);
      if (!queries.length) transcriptReason = 'no_extractable_query';
      let sawAmbiguous = false;
      for (const query of queries) {
        if (resolution === 'resolved') break;
        const found = await searchArtists(ctx, query);
        // Resolved only when the artist's full name was actually spoken.
        const mapped = artistSeedsFromQlooEntities(found, spoken.text);
        method = 'transcript';
        if (mapped.status === 'resolved' && mapped.seeds.length) {
          seeds = mapped.seeds;
          resolution = 'resolved';
          seedEntity = found.find((e) => e.entity_id === seeds[0]?.entity_id);
        } else {
          sawAmbiguous ||= mapped.status === 'ambiguous';
          resolution = sawAmbiguous ? 'ambiguous' : 'unresolved';
        }
      }
      if (queries.length && resolution !== 'resolved')
        transcriptReason = resolution === 'ambiguous' ? 'ambiguous_artist' : 'no_matching_artist';
    } catch {
      transcriptReason = 'transcript_unavailable';
    }
  }

  await ctx.ensureActive();
  const resolved = seeds.length > 0 && resolution === 'resolved';
  const qlooId = seeds[0]?.entity_id ?? null;
  const evidenceState = resolved
    ? 'matched'
    : method === 'transcript'
      ? resolution === 'ambiguous'
        ? 'ambiguous'
        : 'no_match'
      : resolution === 'ambiguous'
        ? 'ambiguous'
        : evidenceStatus(identified);
  const evidenceId = randomUUID();
  await ctx.db.query(
    `INSERT INTO media_evidence(id,account_id,asset_id,generation,analysis_id,track_id,modality,relationship,start_ms,end_ms,method,status,qloo_entity_id,vendor_evidence)
     VALUES($1,$2,$3,$4,$5,$6,'audio','heard',$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      evidenceId,
      accountId,
      work.assetId,
      work.generation,
      work.analysisId,
      work.trackId,
      window.start_ms,
      window.end_ms,
      method,
      evidenceState,
      qlooId,
      JSON.stringify({
        vendor: hit?.vendor ?? (method === 'transcript' ? 'elevenlabs' : 'unavailable'),
        vendor_recording_id: hit?.vendor_recording_id ?? null,
        vendor_confidence: hit?.vendor_confidence ?? null,
        transcript: transcriptText,
        transcript_reason: transcriptReason,
      }),
    ],
  );

  let recognitionId: string | null = null;
  if (hit && identified.status !== 'unavailable') {
    recognitionId = randomUUID();
    await ctx.db.query(
      `INSERT INTO recognized_recordings(id,account_id,asset_id,generation,analysis_id,evidence_id,vendor,vendor_recording_id,title,artist_name,album_title,artist_catalog_id,album_catalog_id,match_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        recognitionId,
        accountId,
        work.assetId,
        work.generation,
        work.analysisId,
        evidenceId,
        hit.vendor,
        hit.vendor_recording_id,
        hit.title,
        hit.artist_name,
        hit.album_title,
        hit.artist_catalog_id,
        hit.album_catalog_id,
        publicMusicState(identified.status),
      ],
    );
  } else if (resolved && method === 'transcript' && seeds[0]) {
    recognitionId = randomUUID();
    await ctx.db.query(
      `INSERT INTO recognized_recordings(id,account_id,asset_id,generation,analysis_id,evidence_id,vendor,vendor_recording_id,title,artist_name,album_title,artist_catalog_id,album_catalog_id,match_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        recognitionId,
        accountId,
        work.assetId,
        work.generation,
        work.analysisId,
        evidenceId,
        'elevenlabs',
        null,
        null,
        seeds[0].name,
        null,
        seeds[0].entity_id,
        null,
        'identified',
      ],
    );
  }

  if (seeds.length && resolution === 'resolved') {
    await ctx.db.query(
      `INSERT INTO audio_entity_resolutions(id,account_id,asset_id,generation,analysis_id,evidence_id,qloo_entity_id,qloo_entity_type,name,status,insights_eligible)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'resolved',true)`,
      [
        randomUUID(),
        accountId,
        work.assetId,
        work.generation,
        work.analysisId,
        evidenceId,
        seeds[0]!.entity_id,
        seeds[0]!.entity_type,
        seeds[0]!.name,
      ],
    );
  } else if (resolution === 'ambiguous' || resolution === 'unresolved') {
    await ctx.db.query(
      `INSERT INTO audio_entity_resolutions(id,account_id,asset_id,generation,analysis_id,evidence_id,qloo_entity_id,qloo_entity_type,name,status,insights_eligible)
       VALUES($1,$2,$3,$4,$5,$6,'','urn:entity:artist',$7,$8,false)`,
      [
        randomUUID(),
        accountId,
        work.assetId,
        work.generation,
        work.analysisId,
        evidenceId,
        hit?.artist_name ?? seeds[0]?.name ?? 'unresolved',
        resolution,
      ],
    );
  }

  const componentState = resolved
    ? 'succeeded'
    : identified.status === 'unavailable' && (!transcription.enabled || transcriptReason === 'transcript_unavailable')
      ? 'unavailable'
      : identified.status === 'no_match' || (method === 'transcript' && !resolved)
        ? 'no_result'
        : identified.status === 'matched'
          ? 'succeeded'
          : 'succeeded';
  const jobState = resolved
    ? 'complete'
    : identified.status === 'unavailable' &&
        (!transcription.enabled || transcriptReason === 'transcript_unavailable')
      ? 'partial'
      : identified.status === 'matched' && !qlooId
        ? 'partial'
        : identified.status === 'no_match' ||
            identified.status === 'matched' ||
            identified.status === 'ambiguous' ||
            method === 'transcript'
          ? 'complete'
          : 'partial';
  const music = resolved
    ? 'identified'
    : publicMusicState(
        method === 'transcript' && identified.status === 'unavailable' ? 'no_match' : identified.status,
      );
  // Fingerprinting and the transcript are separate signals: report each one's
  // own reason (a missing recognizer is not why the transcript found nothing).
  const componentReason = resolved ? null : method === 'transcript' ? transcriptReason : (identified.reason ?? transcriptReason);
  let artist: {
    name: string;
    entity_id: string;
    item_id: string;
    image_url: string | null;
    discovery_job_id: string;
    related_job_id: string;
  } | null = null;
  if (resolved && seeds[0]) {
    try {
      const started = await startArtistDiscovery(ctx, accountId, seeds[0], seedEntity);
      artist = {
        name: seeds[0].name,
        entity_id: seeds[0].entity_id,
        item_id: started.itemId,
        image_url: started.imageUrl,
        discovery_job_id: started.discoveryJobId,
        related_job_id: started.jobId,
      };
    } catch (err) {
      // The identification stands even if suggestions cannot start now.
      ctx.log('music mode related discovery not started', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // What the result screen shows for a match: Qloo artist (name + Qloo image)
  // and related artists from Qloo Insights. Absent unless resolved.
  let match: AudioMatchDisplay | null = null;
  if (resolved && seedEntity) {
    match = await audioMatchDisplay(ctx, seedEntity, method === 'fingerprint' ? hit : null).catch(() => null);
    await ctx.ensureActive();
  }
  const result = {
    music,
    components: {
      music_match: {
        state: componentState,
        reason: componentReason,
        fingerprint_reason: identified.reason ?? null,
        transcript_reason: transcriptReason,
      },
      speech_references: { state: 'not_requested', reason: 'music_mode_default_off' },
    },
    /** The artist that was heard, as a library item; related suggestions arrive from related_job_id. */
    artist,
    match,
    evidence_id: evidenceId,
    recognition_id: recognitionId,
    qloo_seeds: seeds,
    /** Affinity is not recognition confidence and is not returned from this job. */
    affinity: undefined,
  };
  await ctx.ensureActive();
  await ctx.db.query(
    `UPDATE audio_analysis_components SET state=$4, reason=$5, updated_at=now()
      WHERE account_id=$1 AND analysis_id=$2 AND component=$3`,
    [accountId, work.analysisId, 'music_match', componentState, componentReason],
  );
  await ctx.db.query(
    `UPDATE audio_analysis_requests SET state=$3, result=$4::jsonb, completed_at=now() WHERE account_id=$1 AND id=$2`,
    [accountId, work.analysisId, jobState, JSON.stringify(result)],
  );
  await ctx.db.query(
    `UPDATE media_assets SET analysis_status=$3 WHERE account_id=$1 AND id=$2`,
    [accountId, work.assetId, jobState === 'partial' ? 'complete' : jobState === 'complete' ? 'complete' : 'failed'],
  );
  await ctx.db.query(
    `UPDATE media_evidence SET recognition_id=$3 WHERE account_id=$1 AND id=$2`,
    [accountId, evidenceId, recognitionId],
  );
  return { state: jobState as 'complete' | 'partial', resultType: 'audio_analysis', resultId: work.analysisId };
}

export const analyzeAudio: JobHandler<'analyze_audio'> = (ctx) => runAnalyzeAudio(ctx);
export function createAnalyzeAudioHandler(
  recognition: MusicRecognition,
  transcription?: AudioTranscription,
): JobHandler<'analyze_audio'> {
  return (ctx) => runAnalyzeAudio(ctx, { recognition, transcription });
}
