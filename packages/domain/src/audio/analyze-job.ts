import { randomUUID } from 'node:crypto';
import type { QlooEntity } from '@culture-atlas/providers';
import { AppError } from '../errors';
import { JobCancelledError, type JobHandler } from '../jobs/handler';
import type { Queryable } from '../db/pool';
import { artistSeedsFromQlooEntities, queriesFromTranscript, searchQueryForHit } from './qloo-seeds';
import {
  musicRecognitionFromConfig,
  publicMusicState,
  type MusicRecognition,
  type MusicRecognitionResult,
} from './recognition';
import { elevenLabsFromConfig, type AudioTranscription } from './transcription';

export interface AnalyzeAudioOptions {
  recognition?: MusicRecognition;
  transcription?: AudioTranscription;
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
  if (work.originalKey) {
    const stored = await ctx.providers.storage.get(work.originalKey).catch(() => null);
    if (stored) {
      bytes = Uint8Array.from(stored.body);
      mediaType = stored.contentType || mediaType;
    }
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
  if (identified.status === 'matched' && hit) {
    const query = searchQueryForHit(hit);
    if (query) {
      const mapped = artistSeedsFromQlooEntities(await searchArtists(ctx, query));
      seeds = mapped.seeds;
      resolution = mapped.status;
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
      for (const query of queries) {
        if (resolution === 'resolved') break;
        const mapped = artistSeedsFromQlooEntities(await searchArtists(ctx, query));
        if (mapped.status === 'resolved' && mapped.seeds.length) {
          seeds = mapped.seeds;
          resolution = mapped.status;
          method = 'transcript';
        } else if (resolution !== 'resolved') {
          resolution = mapped.status;
          method = 'transcript';
        }
      }
    } catch {
      transcriptReason = 'transcript_unavailable';
    }
  }

  await ctx.ensureActive();
  const resolved = seeds.length > 0 && resolution === 'resolved';
  const qlooId = seeds[0]?.entity_id ?? null;
  const evidenceState = resolved
    ? 'matched'
    : method === 'transcript' && resolution === 'unresolved'
      ? 'no_match'
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
  const result = {
    music,
    components: {
      music_match: {
        state: componentState,
        reason: identified.reason ?? transcriptReason,
      },
      speech_references: { state: 'not_requested', reason: 'music_mode_default_off' },
    },
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
    [accountId, work.analysisId, 'music_match', componentState, identified.reason ?? transcriptReason],
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
