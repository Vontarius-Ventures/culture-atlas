import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import { FakeQloo } from '@culture-atlas/providers/testing';
import type { QlooEntity, QlooInsightsResult } from '@culture-atlas/providers';
import {
  closeTestDb,
  createIsolatedDatabase,
  getTestDb,
  insertAccount,
  testConfig,
  testProviders,
} from '../testing';
import { createCaptureV2Context } from '../capture-v2/context';
import type { CaptureIdentityAdapter, CaptureV2Context } from '../capture-v2/types';
import { MediaIntake } from '../capture-v2/intake';
import { claimJobs, getJobById } from '../jobs/queue';
import { runStageOnce } from '../jobs/stages';
import type { JobRecord } from '../jobs/types';
import { MIGRATIONS_DIR, runMigrations } from '../db/migrate';
import { AudioLibrary } from './assets';
import { AudioAnalysis } from './analysis';
import { runAnalyzeAudio, setAudioOriginalStorage } from './analyze-job';
import { pcmWavBytes } from './wav';
import type { MusicRecognition, MusicRecognitionHit, MusicRecognitionResult } from './recognition';

/**
 * DISC-SCR-013/014 (VAL-EVID-005): Music Mode's two DURABLE Qloo sinks.
 *
 * `ctx.runStage` is `runStageOnce`, which serializes the callback's COMPLETE
 * return value into `job_stages.output`; a retry replays that stored output
 * instead of buying another provider call. The resolve-qloo / related-qloo
 * stage callbacks must therefore persist only the rights-safe minimal replay
 * projection of the Qloo response — never the provider's prose, image URLs or
 * raw body.
 *
 * Results stored before the rights repair (in
 * `audio_analysis_requests.result`) can still carry Qloo imagery in
 * `artist.image_url` and the match `image` objects. The analysis read must
 * serve old rows sanitized — only owned/cleared display assets may serve —
 * while recognition, names, destinations and trace are preserved.
 */
const db = getTestDb();
afterAll(closeTestDb);

const STRIP_MIGRATION = '350_audio_provider_replay_rights.sql';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ca-audio-rights-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// --- Fixtures: a rich live Qloo response the stages must not retain -------------

const WEBSITE = 'https://www.ninasimone.com';

const RICH_NINA: QlooEntity = {
  entity_id: 'qloo-artist-nina',
  name: 'Nina Simone',
  types: ['urn:entity:artist'],
  subtype: 'urn:entity:person',
  popularity: 0.99,
  disambiguation: 'American singer',
  properties: {
    short_description: 'Qloo prose about Nina Simone.',
    description: 'Longer Qloo prose about Nina Simone.',
    image: 'https://images.qloo.test/nina.jpg',
    website: WEBSITE,
    release_year: 1965,
    akas: ['Eunice Waymon'],
  },
  tags: [{ id: 'urn:tag:jazz', name: 'Jazz' }],
  query: { affinity: 0.99, explainability: [{ entity_id: 'qloo-artist-nina', score: 1 }] },
};

const RICH_INSIGHTS_NINA: QlooEntity = {
  entity_id: 'qloo-artist-nina',
  name: 'Nina Simone',
  types: ['urn:entity:artist'],
  properties: { description: 'Qloo prose about Nina Simone.' },
  tags: [],
};

const RICH_BILLIE: QlooEntity = {
  entity_id: 'qloo-artist-billie',
  name: 'Billie Holiday',
  types: ['urn:entity:artist'],
  properties: { short_description: 'Qloo prose about Billie Holiday.' },
  tags: [],
};

const RICH_ETTA: QlooEntity = {
  entity_id: 'qloo-artist-etta',
  name: 'Etta James',
  types: ['urn:entity:artist'],
  properties: { image: 'http://insecure.example/etta.jpg' },
  tags: [],
};

const RICH_MOVIE: QlooEntity = {
  entity_id: 'qloo-movie-x',
  name: 'Not an artist',
  types: ['urn:entity:movie'],
  properties: {},
  tags: [],
};

/** The minimal rights-safe projection the stage cache must hold after the fix. */
const NINA_REPLAY = {
  entity_id: 'qloo-artist-nina',
  name: 'Nina Simone',
  types: ['urn:entity:artist'],
  properties: { website: WEBSITE },
  tags: [],
  popularity: 0.99,
};
const INSIGHTS_NINA_REPLAY = {
  entity_id: 'qloo-artist-nina',
  name: 'Nina Simone',
  types: ['urn:entity:artist'],
  properties: {},
  tags: [],
};
const BILLIE_REPLAY = {
  entity_id: 'qloo-artist-billie',
  name: 'Billie Holiday',
  types: ['urn:entity:artist'],
  properties: {},
  tags: [],
};
const ETTA_REPLAY = {
  entity_id: 'qloo-artist-etta',
  name: 'Etta James',
  types: ['urn:entity:artist'],
  properties: {},
  tags: [],
};
const MOVIE_REPLAY = {
  entity_id: 'qloo-movie-x',
  name: 'Not an artist',
  types: ['urn:entity:movie'],
  properties: {},
  tags: [],
};

/** The full pre-repair search stage output (Qloo response serialized whole). */
const LEGACY_SEARCH_STAGE = {
  data: [RICH_NINA],
  request: { method: 'GET', path: '/search', query: { query: 'Nina Simone', types: 'urn:entity:artist', take: '5' } },
  status: 200,
  retrieved_at: '2026-10-27T10:00:00.000Z',
  duration_ms: 220,
  raw: {
    results: [
      {
        entity_id: 'qloo-artist-nina',
        name: 'Nina Simone',
        properties: { short_description: 'Raw body prose.', image: 'https://images.qloo.test/raw-nina.jpg' },
      },
    ],
  },
  is_replay: false,
};

/** The full pre-repair insights stage output. */
const LEGACY_INSIGHTS_STAGE = {
  data: {
    entities: [RICH_INSIGHTS_NINA, RICH_BILLIE, RICH_ETTA, RICH_MOVIE],
    tags: [{ id: 'urn:tag:jazz', name: 'Jazz', type: 'urn:tag' }],
  },
  request: { method: 'GET', path: '/v2/insights', query: {} },
  status: 200,
  retrieved_at: '2026-10-27T10:00:01.000Z',
  duration_ms: 240,
  raw: { results: { entities: [{ entity_id: 'qloo-artist-billie', name: 'Billie Holiday' }] } },
  is_replay: false,
};

const NINA_HIT: MusicRecognitionHit = {
  vendor: 'test-recognizer',
  vendor_recording_id: 'rec-nina',
  title: 'Feeling Good',
  artist_name: 'Nina Simone',
  album_title: 'I Put a Spell on You',
  artist_catalog_id: 'vendor-nina',
  album_catalog_id: 'vendor-album',
  start_ms: 0,
  end_ms: 15_000,
  vendor_confidence: 0.97,
};

const NINA_RESULT: MusicRecognitionResult = {
  status: 'matched',
  reason: null,
  hits: [NINA_HIT],
};

const RECOGNIZE_STAGE_OUTPUT = {
  status: 'matched',
  reason: null,
  hits: [NINA_HIT],
};

/** A live-flags FakeQloo with the rich entities above. */
const richQloo = () =>
  new FakeQloo(
    {
      search: (query) => (query.toLowerCase().includes('nina') ? [RICH_NINA] : []),
      insights: (_req): QlooInsightsResult => ({
        entities: [RICH_INSIGHTS_NINA, RICH_BILLIE, RICH_ETTA, RICH_MOVIE],
        tags: [{ id: 'urn:tag:jazz', name: 'Jazz', type: 'urn:tag' }],
      }),
    },
    { live: true },
  );

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

async function fixture(overrides: Partial<CaptureV2Context> = {}) {
  const account = await insertAccount();
  const storage = new LocalMultipartStorage(path.join(root, randomUUID()), 'http://127.0.0.1:3301', 'local-test-signing-key');
  const ctx = createCaptureV2Context({ db, authority: account, storage, identity, ...overrides });
  setAudioOriginalStorage(storage);
  return {
    ctx,
    account,
    storage,
    audio: new AudioLibrary(ctx),
    analysis: new AudioAnalysis(ctx),
    intake: new MediaIntake(ctx),
  };
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

async function requestAnalysis(f: Awaited<ReturnType<typeof fixture>>, kept: { asset_id: string }) {
  return f.analysis.request(kept.asset_id, {
    contract_version: 2,
    expected_generation: 1,
    requested_components: ['music_match'],
    selection: { start_ms: 0, end_ms: 15_000 },
  }, randomUUID());
}

function requireAudioJob(job: JobRecord | undefined): JobRecord<'analyze_audio'> {
  if (!job || job.type !== 'analyze_audio') throw new Error('expected analyze_audio job');
  return job as JobRecord<'analyze_audio'>;
}

/**
 * A job ctx whose runStage is the REAL runStageOnce (like apps/worker), so the
 * stage outputs this file asserts are the ones actually persisted.
 */
function realStageCtx(
  job: JobRecord<'analyze_audio'>,
  extra: { qloo?: FakeQloo } = {},
) {
  const providers = testProviders({ qloo: extra.qloo ?? richQloo() });
  return {
    job,
    payload: job.payload,
    attempt: job.attempt,
    workerId: 'audio-rights-test',
    db,
    providers,
    config: testConfig(),
    signal: new AbortController().signal,
    budget: { qlooRequests: 2, researchRefs: 0, providerRetries: 1, deadlineMs: 60_000 },
    setStage: async () => undefined,
    runStage: <R,>(stage: string, fn: () => Promise<R>) =>
      runStageOnce<R>(db, { jobId: job.id, stage, attempt: job.attempt }, fn),
    ensureActive: async () => {
      const current = await getJobById(db, job.id);
      if (!current || current.cancel_requested_at || current.state === 'cancelled') {
        throw new Error('cancelled');
      }
      const asset = await db.query(`SELECT deleted_at FROM media_assets WHERE id=$1`, [job.payload.asset_id]);
      if (asset.rows[0]?.deleted_at) throw new Error('deleted');
    },
    trace: async () => undefined,
    log: () => undefined,
  };
}

const stageOutput = async (jobId: string, stage: string) =>
  (await db.query<{ output: unknown }>(`SELECT output FROM job_stages WHERE job_id=$1 AND stage=$2`, [jobId, stage]))
    .rows[0]?.output;

const storedResult = async (analysisId: string) =>
  (await db.query<{ result: Record<string, unknown> }>(`SELECT result FROM audio_analysis_requests WHERE id=$1`, [analysisId]))
    .rows[0]!.result;

const matchOf = (result: Record<string, unknown>) =>
  (result as { match?: { artist?: { image: unknown }; related?: { image: unknown }[] } | null }).match ?? null;

// --- DISC-SCR-014: the durable stage cache --------------------------------------

describe('Music Mode Qloo stage persistence (runStageOnce)', () => {
  it('persists only the rights-safe minimal replay fields for resolve/related stages', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await requestAnalysis(f, kept);
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-rights-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );

    const outcome = await runAnalyzeAudio(realStageCtx(claimed), {
      recognition: { async identify() { return NINA_RESULT; } },
    });
    expect(outcome.state).toBe('complete');

    // The resolve-qloo stage cache holds exactly the minimal replay projection.
    const resolve = await stageOutput(claimed.id, 'resolve-qloo');
    expect(resolve).toEqual({ data: [NINA_REPLAY] });
    expect(JSON.stringify(resolve)).not.toMatch(/short_description|"description"|image|raw|request|disambiguation|explainability/);

    // The related-qloo stage cache holds the minimal replay projection with
    // the is_replay flag preserved (replayed example data must stay excluded).
    const related = await stageOutput(claimed.id, 'related-qloo');
    expect(related).toEqual({
      is_replay: false,
      data: { entities: [INSIGHTS_NINA_REPLAY, BILLIE_REPLAY, ETTA_REPLAY, MOVIE_REPLAY] },
    });
    expect(JSON.stringify(related)).not.toMatch(/short_description|"description"|image|raw|request|disambiguation/);

    // The published result and the artist's library item stay clean, while the
    // verified destination (properties.website survives the projection) and
    // the recognition trace are intact.
    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as Record<string, unknown>;
    expect(matchOf(result)).toEqual({
      title: 'Feeling Good',
      album_title: 'I Put a Spell on You',
      artist: { entity_id: 'qloo-artist-nina', name: 'Nina Simone', image: null },
      related: [
        { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', image: null },
        { entity_id: 'qloo-artist-etta', name: 'Etta James', image: null },
      ],
    });
    const artist = result.artist as { name: string; image_url: string | null; item_id: string };
    expect(artist).toMatchObject({ name: 'Nina Simone', image_url: null });
    const item = await db.query<{ display_metadata: Record<string, unknown> }>(
      'SELECT display_metadata FROM discovery_items WHERE id = $1',
      [artist.item_id],
    );
    expect(item.rows[0]!.display_metadata).toEqual({
      subtitle: 'Heard in Music Mode',
      destination_url: WEBSITE,
    });
  });

  it('replays completed stages on a retry without buying another provider call', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await requestAnalysis(f, kept);
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-rights-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    let recognizerCalls = 0;
    const recognition: MusicRecognition = {
      async identify() {
        recognizerCalls++;
        return NINA_RESULT;
      },
    };
    const live = richQloo();
    const first = await runAnalyzeAudio(realStageCtx(claimed, { qloo: live }), { recognition });
    expect(first.state).toBe('complete');
    expect(live.calls).toHaveLength(2); // resolve-qloo + related-qloo once each
    const resolveAfterFirst = await stageOutput(claimed.id, 'resolve-qloo');
    const relatedAfterFirst = await stageOutput(claimed.id, 'related-qloo');

    // A retry (attempt 2) replays the completed stages from storage. Any
    // provider call now fails the test: the fake has no handlers at all.
    const strict = new FakeQloo({}, { live: true });
    const second = await runAnalyzeAudio({ ...realStageCtx(claimed, { qloo: strict }), attempt: 2 }, { recognition });
    expect(second.state).toBe('complete');
    expect(strict.calls).toHaveLength(0);
    expect(recognizerCalls).toBe(1); // the recognize stage replayed too
    expect(await stageOutput(claimed.id, 'resolve-qloo')).toEqual(resolveAfterFirst);
    expect(await stageOutput(claimed.id, 'related-qloo')).toEqual(relatedAfterFirst);

    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    expect(matchOf(got.result as Record<string, unknown>)).toEqual({
      title: 'Feeling Good',
      album_title: 'I Put a Spell on You',
      artist: { entity_id: 'qloo-artist-nina', name: 'Nina Simone', image: null },
      related: [
        { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', image: null },
        { entity_id: 'qloo-artist-etta', name: 'Etta James', image: null },
      ],
    });
  });

  it('replays pre-repair full-response stage rows without a provider call and without restricted output', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await requestAnalysis(f, kept);
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-rights-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    // Stage rows exactly as the pre-repair worker persisted them: the whole
    // Qloo response, prose, image URLs, raw body and all.
    await db.query(
      `INSERT INTO job_stages (job_id, stage, status, attempt, output)
       VALUES ($1,'resolve-qloo','complete',1,$2::jsonb),($1,'related-qloo','complete',1,$3::jsonb)`,
      [claimed.id, JSON.stringify(LEGACY_SEARCH_STAGE), JSON.stringify(LEGACY_INSIGHTS_STAGE)],
    );

    const strict = new FakeQloo({}, { live: true });
    const outcome = await runAnalyzeAudio(realStageCtx(claimed, { qloo: strict }), {
      recognition: { async identify() { return NINA_RESULT; } },
    });
    expect(outcome.state).toBe('complete');
    // No provider re-buy: the stored stages replay.
    expect(strict.calls).toHaveLength(0);

    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as Record<string, unknown>;
    expect(matchOf(result)).toEqual({
      title: 'Feeling Good',
      album_title: 'I Put a Spell on You',
      artist: { entity_id: 'qloo-artist-nina', name: 'Nina Simone', image: null },
      related: [
        { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', image: null },
        { entity_id: 'qloo-artist-etta', name: 'Etta James', image: null },
      ],
    });
    const artist = result.artist as { name: string; image_url: string | null; item_id: string };
    expect(artist.image_url).toBeNull();
    const item = await db.query<{ display_metadata: Record<string, unknown> }>(
      'SELECT display_metadata FROM discovery_items WHERE id = $1',
      [artist.item_id],
    );
    // The verified destination survived the legacy row's rich properties.
    expect(item.rows[0]!.display_metadata).toEqual({
      subtitle: 'Heard in Music Mode',
      destination_url: WEBSITE,
    });
  });
});

const legacyResult = (djId: string | null) => ({
    music: 'identified',
    components: {
      music_match: { state: 'succeeded', reason: null, fingerprint_reason: null, transcript_reason: null },
      speech_references: { state: 'not_requested', reason: 'music_mode_default_off' },
    },
    artist: {
      name: 'Nina Simone',
      entity_id: 'qloo-artist-nina',
      item_id: '11111111-1111-4111-8111-111111111111',
      // Cleared app-served asset: may serve (owned_or_cleared_only).
      image_url: '/samples/artist/nina.jpg',
      discovery_job_id: djId,
      related_job_id: '22222222-2222-4222-8222-222222222222',
    },
    match: {
      title: 'Feeling Good',
      album_title: null,
      artist: {
        entity_id: 'qloo-artist-nina',
        name: 'Nina Simone',
        image: { url: 'https://images.qloo.test/nina.jpg', alt: 'Nina Simone', license: 'provider', attribution: 'Qloo' },
      },
      related: [
        { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', image: { url: 'https://images.qloo.test/billie.jpg' } },
        { entity_id: 'qloo-artist-etta', name: 'Etta James', image: { url: '/samples/artist/etta.jpg' } },
        { entity_id: 'qloo-artist-nina2', name: 'Nina Simone', image: null },
      ],
    },
    evidence_id: '33333333-3333-4333-8333-333333333333',
    recognition_id: '44444444-4444-4444-8444-444444444444',
    qloo_seeds: [
      { entity_id: 'qloo-artist-nina', entity_type: 'urn:entity:artist', name: 'Nina Simone', insights_eligible: true },
    ],
  });

// --- DISC-SCR-013: the stored-result read boundary ------------------------------

describe('Music Mode stored-result read boundary (old rows)', () => {
  it('serves an old result sanitized while keeping recognition, names, destinations and trace', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await requestAnalysis(f, kept);
    await db.query(
      `UPDATE audio_analysis_requests SET state='complete', result=$2::jsonb WHERE account_id=$1 AND id=$3`,
      [f.account.accountId, JSON.stringify(legacyResult(null)), requested.analysis_id],
    );

    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as Record<string, unknown>;
    const artist = result.artist as { name: string; image_url: string | null; entity_id: string };
    const match = matchOf(result) as {
      artist: { image: { url: string } | null };
      related: { image: { url: string } | null }[];
    };
    // Uncleared Qloo imagery never serves; the cleared app-served asset does.
    expect(artist.image_url).toBe('/samples/artist/nina.jpg');
    expect(match.artist.image).toBeNull();
    expect(match.related.map((r) => r.image)).toEqual([null, { url: '/samples/artist/etta.jpg' }, null]);
    // Recognition, names, destinations and trace are preserved.
    expect(artist.name).toBe('Nina Simone');
    expect(artist.entity_id).toBe('qloo-artist-nina');
    expect((result as { qloo_seeds: { entity_id: string }[] }).qloo_seeds[0]!.entity_id).toBe('qloo-artist-nina');
    expect((result as { recognition_id: string }).recognition_id).toBe('44444444-4444-4444-8444-444444444444');
    expect((result as { evidence_id: string }).evidence_id).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('sanitizes an old result on the discovery-job branch too, keeping live suggestions pending', async () => {
    const f = await fixture();
    const kept = await keep(f);
    const requested = await requestAnalysis(f, kept);
    const claimed = requireAudioJob(
      (
        await claimJobs(db, {
          workerId: 'audio-rights-test',
          limit: 1,
          leaseMs: 30_000,
          ids: [requested.job_id],
        })
      )[0],
    );
    // A real run produces the artist item and its discovery job.
    await runAnalyzeAudio(realStageCtx(claimed), {
      recognition: { async identify() { return NINA_RESULT; } },
    });
    const current = await storedResult(requested.analysis_id);
    const artist = current.artist as { name: string; item_id: string; discovery_job_id: string };
    expect(artist.discovery_job_id).toBeTruthy();

    // Overwrite with the pre-repair shape: restricted imagery back in, same trace ids.
    const legacy = {
      ...current,
      artist: {
        ...artist,
        image_url: 'https://images.qloo.test/nina.jpg',
      },
      match: {
        title: 'Feeling Good',
        album_title: null,
        artist: {
          entity_id: 'qloo-artist-nina',
          name: 'Nina Simone',
          image: { url: 'https://images.qloo.test/nina.jpg', alt: 'Nina Simone' },
        },
        related: [
          { entity_id: 'qloo-artist-billie', name: 'Billie Holiday', image: { url: 'https://images.qloo.test/billie.jpg' } },
        ],
      },
    };
    await db.query(`UPDATE audio_analysis_requests SET result=$2::jsonb WHERE id=$1`, [
      requested.analysis_id,
      JSON.stringify(legacy),
    ]);

    const got = await f.analysis.get(kept.asset_id, requested.analysis_id);
    const result = got.result as Record<string, unknown>;
    const sanitizedArtist = result.artist as { image_url: string | null; discovery_job_id: string };
    const match = matchOf(result) as { artist: { image: unknown }; related: { image: unknown }[] };
    expect(sanitizedArtist.image_url).toBeNull();
    expect(match.artist.image).toBeNull();
    expect(match.related.every((r) => r.image === null)).toBe(true);
    // The read still resolves the related-discovery state from the stored trace.
    expect((result as { related_state: string }).related_state).toBe('pending');
    expect(sanitizedArtist.discovery_job_id).toBe(artist.discovery_job_id);
    // The stored row keeps its legacy copy until migration 350; the read boundary is what serves clean.
    expect(((await storedResult(requested.analysis_id)).artist as { image_url: string }).image_url).toBe(
      'https://images.qloo.test/nina.jpg',
    );
  });
});

// --- Migration 350: previously persisted copies ----------------------------------

describe(`migration ${STRIP_MIGRATION} (previously persisted result/stage copies)`, () => {
  it('strips legacy result imagery and reduces legacy stage caches to the minimal replay projection', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ca-migrations-'));
    try {
      for (const file of await readdir(MIGRATIONS_DIR)) {
        if (file.endsWith('.sql') && file !== STRIP_MIGRATION) {
          await copyFile(path.join(MIGRATIONS_DIR, file), path.join(dir, file));
        }
      }
      const iso = await createIsolatedDatabase({ migrate: false, prefix: 'ca_audiorights' });
      try {
        // The database is at the pre-350 migration head, as a deployment that
        // ran the pre-repair worker is when this repair lands.
        await runMigrations(iso.url, { dir });
        const account = await insertAccount(iso.db);
        const assetId = randomUUID();
        await iso.db.query(
          `INSERT INTO media_assets (id, account_id, client_capture_id, kind, source, status, byte_size, content_type, duration_ms, schema_version, capture_mode, camera_active, original_key)
           VALUES ($1,$2,$3,'audio','browser_microphone','ready',2646000,'audio/wav',15000,2,'music',false,'capture-v2/mig/original.wav')`,
          [assetId, account.accountId, randomUUID()],
        );
        const seedResult = async (requestHash: string, result: unknown) => {
          await iso.db.query(
            `INSERT INTO audio_analysis_requests (id, account_id, asset_id, generation, requested_components, selection, request_hash, state, result)
             VALUES ($1,$2,$3,1,'["music_match"]','{"start_ms":0,"end_ms":15000,"windows":[{"start_ms":0,"end_ms":15000}]}',$4,'complete',$5::jsonb)`,
            [randomUUID(), account.accountId, assetId, requestHash, JSON.stringify(result)],
          );
        };
        const uncleared = legacyResult(null);
        await seedResult('mig-uncleared', {
          ...uncleared,
          artist: { ...uncleared.artist, image_url: 'https://images.qloo.test/nina.jpg' },
        });
        await seedResult('mig-cleared', legacyResult(null));

        const jobId = randomUUID();
        await iso.db.query(
          `INSERT INTO jobs (id, owner_account_id, type, state, payload, attempt, max_attempts)
           VALUES ($1,$2,'analyze_audio','complete',$3::jsonb,1,3)`,
          [jobId, account.accountId, JSON.stringify({ analysis_id: randomUUID(), asset_id: assetId, expected_generation: 1 })],
        );
        await iso.db.query(
          `INSERT INTO job_stages (job_id, stage, status, attempt, output)
           VALUES ($1,'resolve-qloo','complete',1,$2::jsonb),
                  ($1,'related-qloo','complete',1,$3::jsonb),
                  ($1,'recognize','complete',1,$4::jsonb)`,
          [jobId, JSON.stringify(LEGACY_SEARCH_STAGE), JSON.stringify(LEGACY_INSIGHTS_STAGE), JSON.stringify(RECOGNIZE_STAGE_OUTPUT)],
        );

        const applied = await runMigrations(iso.url);
        expect(applied.applied).toEqual([STRIP_MIGRATION]);

        const row = async (requestHash: string) =>
          (
            await iso.db.query<{ result: Record<string, unknown> }>(
              `SELECT result FROM audio_analysis_requests WHERE request_hash=$1`,
              [requestHash],
            )
          ).rows[0]!.result;

        // Uncleared imagery is stripped from the legacy result; the cleared
        // app-served asset, names, destinations and trace survive.
        const stripped = await row('mig-uncleared');
        const strippedArtist = stripped.artist as { image_url: string | null; name: string; entity_id: string };
        const strippedMatch = matchOf(stripped) as {
          artist: { image: unknown; name: string };
          related: { image: unknown; name: string }[];
        };
        expect(strippedArtist.image_url).toBeNull();
        expect(strippedMatch.artist.image).toBeNull();
        expect(strippedMatch.related.map((r) => r.image)).toEqual([null, { url: '/samples/artist/etta.jpg' }, null]);
        expect(strippedArtist.name).toBe('Nina Simone');
        expect(strippedArtist.entity_id).toBe('qloo-artist-nina');
        expect((stripped as { recognition_id: string }).recognition_id).toBe('44444444-4444-4444-8444-444444444444');
        expect((stripped as { qloo_seeds: unknown[] }).qloo_seeds).toHaveLength(1);
        const cleared = await row('mig-cleared');
        expect((cleared.artist as { image_url: string }).image_url).toBe('/samples/artist/nina.jpg');

        // Legacy stage caches are reduced to the minimal replay projection.
        const stage = async (name: string) =>
          (
            await iso.db.query<{ output: unknown }>(`SELECT output FROM job_stages WHERE job_id=$1 AND stage=$2`, [
              jobId,
              name,
            ])
          ).rows[0]!.output;
        expect(await stage('resolve-qloo')).toEqual({ data: [NINA_REPLAY] });
        expect(await stage('related-qloo')).toEqual({
          is_replay: false,
          data: { entities: [INSIGHTS_NINA_REPLAY, BILLIE_REPLAY, ETTA_REPLAY, MOVIE_REPLAY] },
        });
        // Recognition material the policy does not restrict is untouched.
        expect(await stage('recognize')).toEqual(RECOGNIZE_STAGE_OUTPUT);

        // Reapplying is idempotent.
        const again = await runMigrations(iso.url);
        expect(again.applied).toEqual([]);
        expect(await row('mig-uncleared')).toEqual(stripped);
        expect(await stage('resolve-qloo')).toEqual({ data: [NINA_REPLAY] });
      } finally {
        await iso.drop();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
