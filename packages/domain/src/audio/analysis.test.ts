import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeQloo, MemoryObjectStorage } from '@culture-atlas/providers/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import { closeTestDb, getTestDb, insertAccount, testConfig, testProviders } from '../testing';
import { createCaptureV2Context } from '../capture-v2/context';
import type { CaptureIdentityAdapter, CaptureV2Context } from '../capture-v2/types';
import { MediaIntake } from '../capture-v2/intake';
import { cancelJob, claimJobs, completeJob, getJobById } from '../jobs/queue';
import type { JobRecord } from '../jobs/types';
import { JobCancelledError } from '../jobs/handler';
import { AudioLibrary } from './assets';
import { AudioAnalysis } from './analysis';
import { AnalyzeAudioRequest } from '../schemas/audio';
import { createAnalyzeAudioHandler, runAnalyzeAudio, setAudioOriginalStorage } from './analyze-job';
import { pcmWavBytes } from './wav';
import { UnavailableMusicRecognition, type MusicRecognition } from './recognition';
import { artistSeedsFromQlooEntities, seedIfQlooReturned } from './qloo-seeds';

const db = getTestDb();
let root: string;
const identity: CaptureIdentityAdapter = {
  requireRecoverableAccount: async () => {},
  peekNativeEnrollmentGrant: async () => {
    throw new Error('No grant fixture');
  },
  consumeNativeEnrollmentGrant: async () => {
    throw new Error('No grant fixture');
  },
  issueNativeSession: async (_tx, input) => ({
    session_id: randomUUID(),
    account_id: input.accountId,
    installation_id: input.installationId,
    access_token: 'test-access',
    refresh_token: 'test-refresh',
    access_expires_at: new Date(Date.now() + 600000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86400000).toISOString(),
  }),
  revokeInstallationSessions: async () => {},
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-audio-'));
});
afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

async function fixture(overrides: Partial<CaptureV2Context> = {}) {
  const account = await insertAccount();
  const storage = new LocalMultipartStorage(join(root, randomUUID()), 'http://127.0.0.1:3301', 'local-test-signing-key');
  const ctx = createCaptureV2Context({ db, authority: account, storage, identity, ...overrides });
  // The analysis worker reads originals from the same capture-v2 storage the recording was kept in.
  setAudioOriginalStorage(storage);
  return { ctx, account, storage, audio: new AudioLibrary(ctx), analysis: new AudioAnalysis(ctx), intake: new MediaIntake(ctx) };
}

function wav() {
  return pcmWavBytes({ durationMs: 15_000, sampleRateHz: 16_000, channels: 1 });
}

async function keep(f: Awaited<ReturnType<typeof fixture>>) {
  return f.audio.keepRecording(
    {
      client_capture_id: randomUUID(),
      source: 'browser_microphone',
      source_route: 'phone_microphone',
    },
    wav(),
    randomUUID(),
  );
}

function requireAudioJob(job: JobRecord | undefined): JobRecord<'analyze_audio'> {
  if (!job || job.type !== 'analyze_audio') throw new Error('expected analyze_audio job');
  return job as JobRecord<'analyze_audio'>;
}

function jobCtx(
  _f: Awaited<ReturnType<typeof fixture>>,
  job: JobRecord<'analyze_audio'>,
  extra: { qloo?: FakeQloo; beforePublish?: () => Promise<void>; storage?: MemoryObjectStorage } = {},
) {
  const providers = testProviders({
    qloo: extra.qloo ?? new FakeQloo({}),
    ...(extra.storage ? { storage: extra.storage } : {}),
  });
  let hook = false;
  return {
    job,
    payload: job.payload,
    attempt: 1,
    workerId: 'audio-test',
    db,
    providers,
    config: testConfig(),
    signal: new AbortController().signal,
    budget: { qlooRequests: 2, researchRefs: 0, providerRetries: 1, deadlineMs: 60_000 },
    setStage: async () => undefined,
    runStage: async <R>(_stage: string, fn: () => Promise<R>) => fn(),
    ensureActive: async () => {
      if (extra.beforePublish && !hook) {
        hook = true;
        await extra.beforePublish();
      }
      const current = await getJobById(db, job.id);
      if (!current || current.cancel_requested_at || current.state === 'cancelled') {
        throw new JobCancelledError('cancelled');
      }
      const asset = await db.query(`SELECT deleted_at FROM media_assets WHERE id=$1`, [job.payload.asset_id]);
      if (asset.rows[0]?.deleted_at) throw new JobCancelledError('deleted');
    },
    trace: async () => undefined,
    log: () => undefined,
  };
}

describe('Keep does not analyze', () => {
  it('saves a private Music Mode recording without enqueueing analysis or taste', async () => {
    const f = await fixture();
    const kept = await keep(f);
    expect(kept.analysis_status).toBe('not_requested');
    expect(kept.media.camera_active).toBe(false);
    expect(kept.media.kind).toBe('audio');
    expect(kept.media.capture_mode).toBe('music');
    expect(kept.media.speech_analysis).toBe('off');
    const jobs = await db.query(`SELECT id FROM jobs WHERE owner_account_id=$1 AND type='analyze_audio'`, [
      f.account.accountId,
    ]);
    expect(jobs.rows).toEqual([]);
    const prefs = await db.query(`SELECT id FROM preference_events WHERE owner_account_id=$1`, [
      f.account.accountId,
    ]);
    expect(prefs.rows).toEqual([]);
    const library = await f.intake.library({});
    expect(library.items).toEqual([]);
    const detail = await f.audio.detail(kept.asset_id);
    expect(detail.media.analysis_status).toBe('not_requested');
  });
});

describe('Explore authorizes analysis', () => {
  it('queues music_match only and leaves speech off', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    expect(requested.reused).toBe(false);
    expect(requested.state).toBe('queued');
    const components = await db.query(
      `SELECT component, state FROM audio_analysis_components WHERE analysis_id=$1 ORDER BY component`,
      [requested.analysis_id],
    );
    expect(components.rows).toEqual([
      { component: 'music_match', state: 'queued' },
      { component: 'speech_references', state: 'not_requested' },
    ]);
    await expect(
      f.analysis.request(
        kept.asset_id,
        {
          contract_version: 2,
          expected_generation: 1,
          requested_components: ['speech_references'],
          selection: { start_ms: 0, end_ms: 15_000 },
        },
        randomUUID(),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('returns honest partial when the recognizer is missing', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    const outcome = await runAnalyzeAudio(jobCtx(f, claimed), {
      recognition: new UnavailableMusicRecognition('not_configured'),
    });
    expect(outcome.state).toBe('partial');
    await completeJob(db, claimed!.id, 'audio-test', outcome);
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    expect(got.state).toBe('partial');
    const result = got.result as { music: string; qloo_seeds: unknown[]; components: { music_match: { state: string } } };
    expect(result.music).toBe('provider_unavailable');
    expect(result.qloo_seeds).toEqual([]);
    expect((got.result as { match: unknown }).match).toBeNull();
    expect(result.components.music_match.state).toBe('unavailable');
    const recordings = await db.query(`SELECT id FROM recognized_recordings WHERE analysis_id=$1`, [
      requested.analysis_id,
    ]);
    expect(recordings.rows).toEqual([]);
  });

  it('uses an ElevenLabs transcript to search Qloo and stores only returned artist ids', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    const qloo = new FakeQloo(
      {
        search: (query) =>
          query.toLowerCase().includes('nina')
            ? [
                {
                  entity_id: 'qloo-artist-nina',
                  name: 'Nina Simone',
                  types: ['urn:entity:artist'],
                  properties: {},
                  tags: [],
                },
              ]
            : [],
        insights: (req) => ({
          entities: [
            { entity_id: 'qloo-artist-nina', name: 'Nina Simone', types: ['urn:entity:artist'], properties: {}, tags: [] },
            { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', types: ['urn:entity:artist'], properties: {}, tags: [] },
            { entity_id: 'qloo-movie-x', name: 'Not an artist', types: ['urn:entity:movie'], properties: {}, tags: [] },
            {
              entity_id: 'qloo-artist-etta',
              name: 'Etta James',
              types: ['urn:entity:artist'],
              properties: { image: 'http://insecure.example/etta.jpg' },
              tags: [],
            },
          ].filter(() => req.signalEntities?.[0] === 'qloo-artist-nina'),
          tags: [],
        }),
      },
      { live: true },
    );
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    const original = await db.query<{ original_key: string | null }>(
      `SELECT original_key FROM media_assets WHERE id=$1`,
      [kept.asset_id],
    );
    const storage = new MemoryObjectStorage();
    if (original.rows[0]?.original_key) {
      await storage.put(original.rows[0].original_key, wav(), { contentType: 'audio/wav' });
    }
    const outcome = await runAnalyzeAudio(jobCtx(f, claimed, { qloo, storage }), {
      recognition: new UnavailableMusicRecognition('not_configured'),
      transcription: {
        enabled: true,
        reason: 'configured',
        async transcribe() {
          return { text: 'That was Feeling Good by Nina Simone.', words: [] };
        },
      },
    });
    expect(outcome.state).toBe('complete');
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as {
      music: string;
      qloo_seeds: { entity_id: string; name: string }[];
      components: { speech_references: { state: string } };
    };
    expect(result.music).toBe('identified');
    expect(result.qloo_seeds).toEqual([
      {
        entity_id: 'qloo-artist-nina',
        entity_type: 'urn:entity:artist',
        name: 'Nina Simone',
        insights_eligible: true,
      },
    ]);
    expect(result.components.speech_references.state).toBe('not_requested');
    // The result screen gets the Qloo artist and related Qloo artists, nothing invented:
    // the seed itself and non-artists are dropped; a non-https image is never kept.
    const match = (got.result as { match: unknown }).match;
    expect(match).toEqual({
      title: null,
      album_title: null,
      artist: { entity_id: 'qloo-artist-nina', name: 'Nina Simone', image: null },
      related: [
        { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', image: null },
        { entity_id: 'qloo-artist-etta', name: 'Etta James', image: null },
      ],
    });
    const evidence = await db.query<{ method: string; qloo_entity_id: string }>(
      `SELECT method, qloo_entity_id FROM media_evidence WHERE analysis_id=$1`,
      [requested.analysis_id],
    );
    expect(evidence.rows).toEqual([{ method: 'transcript', qloo_entity_id: 'qloo-artist-nina' }]);
    // The heard artist is stored and starts related discovery that feeds suggestions.
    const artist = (got.result as { artist: { name: string; item_id: string; discovery_job_id: string; related_job_id: string } }).artist;
    expect(artist).toMatchObject({ name: 'Nina Simone' });
    const item = await db.query<{ title: string; kind: string; owner_account_id: string }>(
      'SELECT title, kind, owner_account_id FROM discovery_items WHERE id = $1',
      [artist.item_id],
    );
    expect(item.rows[0]).toEqual({ title: 'Nina Simone', kind: 'artist', owner_account_id: f.account.accountId });
    const dj = await db.query<{ source: string; source_label: string }>(
      'SELECT source, source_label FROM discovery_jobs WHERE id = $1',
      [artist.discovery_job_id],
    );
    expect(dj.rows[0]).toEqual({ source: 'music_mode', source_label: 'Nina Simone' });
    const related = await db.query<{ type: string }>('SELECT type FROM jobs WHERE id = $1', [artist.related_job_id]);
    expect(related.rows[0]?.type).toBe('discover_related');
    expect((got.result as { related_state: string }).related_state).toBe('pending');
  });

  it('reads the recording from capture-v2 storage and fails honestly when it is missing', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    const claimed = requireAudioJob(
      (await claimJobs(db, { workerId: 'audio-test', limit: 1, leaseMs: 30_000, ids: [requested.job_id] }))[0],
    );
    const original = await db.query<{ original_key: string }>('SELECT original_key FROM media_assets WHERE id=$1', [kept.asset_id]);
    await f.storage.delete(original.rows[0]!.original_key);
    let transcribed = false;
    await expect(
      runAnalyzeAudio(jobCtx(f, claimed), {
        recognition: new UnavailableMusicRecognition('not_configured'),
        transcription: {
          enabled: true,
          reason: 'configured',
          async transcribe() {
            transcribed = true;
            return { text: '', words: [] };
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'service_unavailable', retryable: false, details: { reason: 'storage_unavailable' } });
    expect(transcribed).toBe(false);
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    expect(got.state).toBe('failed');
    expect(got.error_code).toBe('storage_unavailable');
  });

  it('reads the kept recording from the capture-v2 media namespace (local storage driver)', async () => {
    const dir = join(root, randomUUID());
    const storage = new LocalMultipartStorage(join(dir, 'capture-v2'), 'http://127.0.0.1:3301', 'local-test-signing-key');
    const f = await fixture({ storage });
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    const claimed = requireAudioJob(
      (await claimJobs(db, { workerId: 'audio-test', limit: 1, leaseMs: 30_000, ids: [requested.job_id] }))[0],
    );
    const ctx = jobCtx(f, claimed);
    const providers = { ...ctx.providers, config: { ...ctx.providers.config, STORAGE_DRIVER: 'local' as const, STORAGE_LOCAL_DIR: dir } };
    let heardBytes = 0;
    await runAnalyzeAudio({ ...ctx, providers } as typeof ctx, {
      originals: storage,
      recognition: new UnavailableMusicRecognition('not_configured'),
      transcription: {
        enabled: true,
        reason: 'configured',
        async transcribe(input) {
          heardBytes = input.bytes.byteLength;
          return { text: '', words: [] };
        },
      },
    });
    // The 15 s WAV the web API kept, not an empty buffer.
    expect(heardBytes).toBe(wav().byteLength);
  });

  it('stores a Qloo artist seed only from a real returned catalog id', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    const recognizer: MusicRecognition = {
      async identify() {
        return {
          status: 'matched',
          reason: null,
          hits: [
            {
              vendor: 'test-recognizer',
              vendor_recording_id: 'rec-1',
              title: 'Test Take',
              artist_name: 'Nina Simone',
              album_title: 'An Album',
              artist_catalog_id: 'vendor-artist-1',
              album_catalog_id: 'vendor-album-1',
              start_ms: 0,
              end_ms: 15_000,
              vendor_confidence: 0.99,
            },
          ],
        };
      },
    };
    const qloo = new FakeQloo(
      {
        search: () => [
          {
            entity_id: 'qloo-artist-nina',
            name: 'Nina Simone',
            types: ['urn:entity:artist'],
            properties: {},
            tags: [],
          },
        ],
      },
      { live: true },
    );
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    const handler = createAnalyzeAudioHandler(recognizer);
    const outcome = await handler(jobCtx(f, claimed, { qloo }));
    expect(outcome.state).toBe('complete');
    const seeds = await db.query<{ qloo_entity_id: string; insights_eligible: boolean }>(
      `SELECT qloo_entity_id, insights_eligible FROM audio_entity_resolutions WHERE analysis_id=$1`,
      [requested.analysis_id],
    );
    expect(seeds.rows).toEqual([{ qloo_entity_id: 'qloo-artist-nina', insights_eligible: true }]);
    const evidence = await db.query<{ qloo_entity_id: string; vendor_evidence: { vendor_confidence: number } }>(
      `SELECT qloo_entity_id, vendor_evidence FROM media_evidence WHERE analysis_id=$1`,
      [requested.analysis_id],
    );
    expect(evidence.rows[0]!.qloo_entity_id).toBe('qloo-artist-nina');
    expect(evidence.rows[0]!.vendor_evidence.vendor_confidence).toBe(0.99);
  });

  it('ignores a fabricated Qloo id that the catalog did not return', async () => {
    expect(
      seedIfQlooReturned('urn:entity:artist:invented', [
        { entity_id: 'real-id', name: 'Someone', types: ['urn:entity:artist'], properties: {}, tags: [] },
      ]),
    ).toBeNull();
    expect(
      artistSeedsFromQlooEntities([
        { entity_id: 'album-1', name: 'An Album', types: ['urn:entity:album'], properties: {}, tags: [] },
      ]).seeds,
    ).toEqual([]);
    const several = [
      { entity_id: 'qloo-nina', name: 'Nina Simone', types: ['urn:entity:artist'], properties: {}, tags: [] },
      { entity_id: 'qloo-tribute', name: 'Nina Simone Tribute Band', types: ['urn:entity:artist'], properties: {}, tags: [] },
    ];
    // Several returned artists, one named exactly what was heard: resolved to that Qloo id.
    expect(artistSeedsFromQlooEntities(several, 'nina simone')).toMatchObject({
      status: 'resolved',
      seeds: [{ entity_id: 'qloo-nina', name: 'Nina Simone' }],
    });
    // Without the heard text it stays ambiguous.
    expect(artistSeedsFromQlooEntities(several).status).toBe('ambiguous');
    // Same-named artists resolve to the most popular Qloo id (never an invented one).
    expect(
      artistSeedsFromQlooEntities(
        [{ ...several[0]!, popularity: 0.2 }, { ...several[0]!, entity_id: 'qloo-nina-2', popularity: 0.9 }],
        'Nina Simone',
      ),
    ).toMatchObject({ status: 'resolved', seeds: [{ entity_id: 'qloo-nina-2' }] });
  });

  it('does not publish after cancellation or deletion', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      {
        contract_version: 2,
        expected_generation: 1,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      },
      randomUUID(),
    );
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    await cancelJob(db, requested.job_id);
    await expect(
      runAnalyzeAudio(jobCtx(f, claimed), { recognition: new UnavailableMusicRecognition() }),
    ).rejects.toBeInstanceOf(JobCancelledError);
    const evidence = await db.query(`SELECT id FROM media_evidence WHERE analysis_id=$1`, [requested.analysis_id]);
    expect(evidence.rows).toEqual([]);
  });
});

describe('Client recognition (ShazamKit hint)', () => {
  function requestWith(recognition?: Record<string, unknown>) {
    return {
      contract_version: 2,
      expected_generation: 1,
      requested_components: ['music_match'],
      selection: { start_ms: 0, end_ms: 15_000 },
      ...(recognition ? { client_recognition: recognition } : {}),
    };
  }

  const shazamHint = {
    vendor: 'shazamkit',
    artist_name: 'Fleetwood Mac',
    title: 'Dreams',
    matched_at_ms: 4200,
    vendor_recording_id: 'shazam-40339261',
  };

  /** Original bytes in memory, exactly as the worker reads them. */
  async function originalStorage(assetId: string) {
    const original = await db.query<{ original_key: string | null }>(
      `SELECT original_key FROM media_assets WHERE id=$1`,
      [assetId],
    );
    const storage = new MemoryObjectStorage();
    if (original.rows[0]?.original_key) {
      await storage.put(original.rows[0].original_key, wav(), { contentType: 'audio/wav' });
    }
    return storage;
  }

  async function claim(requested: { job_id: string }) {
    return requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
  }

  const fleetwoodQloo = new FakeQloo(
    {
      search: (query: string) =>
        query.toLowerCase().includes('fleetwood')
          ? [
              {
                entity_id: 'qloo-artist-fleetwood',
                name: 'Fleetwood Mac',
                types: ['urn:entity:artist'],
                properties: {},
                tags: [],
              },
            ]
          : [],
    },
    { live: true },
  );

  it('resolves a client-recognized song through Qloo without any provider keys', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(kept.asset_id, requestWith(shazamHint), randomUUID());
    const claimed = await claim(requested);
    const storage = await originalStorage(kept.asset_id);
    const outcome = await runAnalyzeAudio(jobCtx(f, claimed, { qloo: fleetwoodQloo, storage }), {
      recognition: new UnavailableMusicRecognition('not_configured'),
    });
    expect(outcome.state).toBe('complete');
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as {
      music: string;
      qloo_seeds: { entity_id: string; name: string }[];
      match: { title: string | null; artist: { entity_id: string; name: string } };
      artist: { name: string } | null;
    };
    expect(result.music).toBe('identified');
    expect(result.qloo_seeds).toEqual([
      { entity_id: 'qloo-artist-fleetwood', entity_type: 'urn:entity:artist', name: 'Fleetwood Mac', insights_eligible: true },
    ]);
    // The title shown is the one the phone recognized; the artist is Qloo's.
    expect(result.match).toMatchObject({
      title: 'Dreams',
      artist: { entity_id: 'qloo-artist-fleetwood', name: 'Fleetwood Mac' },
    });
    expect(result.artist).toMatchObject({ name: 'Fleetwood Mac' });
    const evidence = await db.query<{ method: string; qloo_entity_id: string; vendor_evidence: { vendor: string; client_recognition_reason: null } }>(
      `SELECT method, qloo_entity_id, vendor_evidence FROM media_evidence WHERE analysis_id=$1`,
      [requested.analysis_id],
    );
    expect(evidence.rows).toEqual([
      {
        method: 'client_recognition',
        qloo_entity_id: 'qloo-artist-fleetwood',
        vendor_evidence: {
          vendor: 'shazamkit',
          vendor_recording_id: 'shazam-40339261',
          vendor_confidence: null,
          transcript: null,
          transcript_reason: null,
          client_recognition_reason: null,
        },
      },
    ]);
    // The recognized recording row keeps the client's own metadata.
    const recordings = await db.query<{
      vendor: string;
      vendor_recording_id: string | null;
      title: string | null;
      artist_name: string;
      artist_catalog_id: string | null;
      match_status: string;
    }>(`SELECT vendor, vendor_recording_id, title, artist_name, artist_catalog_id, match_status
          FROM recognized_recordings WHERE analysis_id=$1`, [requested.analysis_id]);
    expect(recordings.rows).toEqual([
      {
        vendor: 'shazamkit',
        vendor_recording_id: 'shazam-40339261',
        title: 'Dreams',
        artist_name: 'Fleetwood Mac',
        artist_catalog_id: 'qloo-artist-fleetwood',
        match_status: 'identified',
      },
    ]);
  });

  it('never resolves from the hint alone: no Qloo match is an honest no_result', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      requestWith({ vendor: 'shazamkit', artist_name: 'TobyMac' }),
      randomUUID(),
    );
    const claimed = await claim(requested);
    const storage = await originalStorage(kept.asset_id);
    // Qloo answers with a different artist only: the recognized name does not resolve.
    const qloo = new FakeQloo(
      {
        search: () => [
          { entity_id: 'qloo-artist-other', name: 'Someone Else', types: ['urn:entity:artist'], properties: {}, tags: [] },
        ],
      },
      { live: true },
    );
    const outcome = await runAnalyzeAudio(jobCtx(f, claimed, { qloo, storage }), {
      recognition: new UnavailableMusicRecognition('not_configured'),
    });
    expect(outcome.state).toBe('complete');
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as {
      music: string;
      qloo_seeds: unknown[];
      components: { music_match: { state: string; reason: string | null; client_recognition_reason: string | null } };
    };
    expect(result.music).toBe('no_reliable_match');
    expect(result.qloo_seeds).toEqual([]);
    expect(result.components.music_match.state).toBe('no_result');
    expect(result.components.music_match.client_recognition_reason).toBe('no_matching_artist');
    expect(result.components.music_match.reason).toBe('no_matching_artist');
    const evidence = await db.query<{ method: string; status: string }>(
      `SELECT method, status FROM media_evidence WHERE analysis_id=$1`,
      [requested.analysis_id],
    );
    expect(evidence.rows).toEqual([{ method: 'client_recognition', status: 'no_match' }]);
    const recordings = await db.query(`SELECT id FROM recognized_recordings WHERE analysis_id=$1`, [
      requested.analysis_id,
    ]);
    expect(recordings.rows).toEqual([]);
  });

  it('a server fingerprint match outranks the client hint', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(
      kept.asset_id,
      requestWith({ vendor: 'shazamkit', artist_name: 'TobyMac' }),
      randomUUID(),
    );
    const claimed = await claim(requested);
    const storage = await originalStorage(kept.asset_id);
    const recognizer: MusicRecognition = {
      async identify() {
        return {
          status: 'matched',
          reason: null,
          hits: [
            {
              vendor: 'test-recognizer',
              vendor_recording_id: 'rec-1',
              title: 'Test Take',
              artist_name: 'Nina Simone',
              album_title: 'An Album',
              artist_catalog_id: 'vendor-artist-1',
              album_catalog_id: 'vendor-album-1',
              start_ms: 0,
              end_ms: 15_000,
              vendor_confidence: 0.99,
            },
          ],
        };
      },
    };
    const qloo = new FakeQloo(
      {
        search: (query: string) =>
          query.toLowerCase().includes('nina')
            ? [{ entity_id: 'qloo-artist-nina', name: 'Nina Simone', types: ['urn:entity:artist'], properties: {}, tags: [] }]
            : [{ entity_id: 'qloo-artist-toby', name: 'TobyMac', types: ['urn:entity:artist'], properties: {}, tags: [] }],
      },
      { live: true },
    );
    const outcome = await runAnalyzeAudio(jobCtx(f, claimed, { qloo, storage }), { recognition: recognizer });
    expect(outcome.state).toBe('complete');
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as { music: string; qloo_seeds: { entity_id: string }[] };
    expect(result.music).toBe('identified');
    expect(result.qloo_seeds).toEqual([{ entity_id: 'qloo-artist-nina', entity_type: 'urn:entity:artist', name: 'Nina Simone', insights_eligible: true }]);
    const evidence = await db.query<{ method: string }>(`SELECT method FROM media_evidence WHERE analysis_id=$1`, [
      requested.analysis_id,
    ]);
    expect(evidence.rows).toEqual([{ method: 'fingerprint' }]);
  });

  it('a resolved client hint skips the paid transcript tier', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await f.analysis.request(kept.asset_id, requestWith(shazamHint), randomUUID());
    const claimed = await claim(requested);
    const storage = await originalStorage(kept.asset_id);
    let transcribed = 0;
    const outcome = await runAnalyzeAudio(jobCtx(f, claimed, { qloo: fleetwoodQloo, storage }), {
      recognition: new UnavailableMusicRecognition('not_configured'),
      transcription: {
        enabled: true,
        reason: 'configured',
        async transcribe() {
          transcribed += 1;
          return { text: 'That was Fleetwood Mac.', words: [] };
        },
      },
    });
    expect(outcome.state).toBe('complete');
    expect(transcribed).toBe(0);
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    expect((got.result as { music: string }).music).toBe('identified');
  });

  it('requests with and without a hint are different analyses', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const plain = await f.analysis.request(kept.asset_id, requestWith(), randomUUID());
    const hinted = await f.analysis.request(kept.asset_id, requestWith(shazamHint), randomUUID());
    expect(hinted.reused).toBe(false);
    expect(hinted.analysis_id).not.toBe(plain.analysis_id);
    const hintedAgain = await f.analysis.request(kept.asset_id, requestWith(shazamHint), randomUUID());
    expect(hintedAgain.reused).toBe(true);
    expect(hintedAgain.analysis_id).toBe(hinted.analysis_id);
  });

  it('validates the hint shape before anything is queued', () => {
    // The service surfaces schema failures; the HTTP boundary maps them to
    // invalid_input. The shape is closed: unknown vendors, blank names,
    // oversized titles and extra fields never reach the queue.
    expect(() => AnalyzeAudioRequest.parse(requestWith({ ...shazamHint, vendor: 'acrcloud' }))).toThrow();
    expect(() => AnalyzeAudioRequest.parse(requestWith({ vendor: 'shazamkit', artist_name: '   ' }))).toThrow();
    expect(() =>
      AnalyzeAudioRequest.parse(requestWith({ vendor: 'shazamkit', artist_name: 'An Artist', title: 'x'.repeat(201) })),
    ).toThrow();
    expect(() => AnalyzeAudioRequest.parse(requestWith({ ...shazamHint, extra: true }))).toThrow();
    expect(() => AnalyzeAudioRequest.parse(requestWith(shazamHint))).not.toThrow();
    expect(() => AnalyzeAudioRequest.parse(requestWith())).not.toThrow();
  });
});
