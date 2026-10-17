import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  JOB_HANDLERS,
  MediaAnalysis,
  agentMedia,
  authorizeMedia,
  collections,
  createCaptureV2Context,
  type PoolDb,
} from '@culture-atlas/domain';
import {
  createIsolatedDatabase,
  insertAccount,
  insertAgentConnection,
  testConfig,
  testContext,
  testProviders,
} from '@culture-atlas/domain/testing';
import {
  LocalMultipartStorage,
  ModelSpendLedger,
  PostgresSpendStore,
  createConcentrateTransport,
  createModelGateway,
  loadProviderConfig,
  type ModelGateway,
  type ModelProfile,
} from '@culture-atlas/providers';
import { MemoryObjectStorage } from '@culture-atlas/providers/testing';
import { MediaAnalysisWorker } from './media-analysis';
import { Worker } from './worker';

/**
 * AI-01 / AI-02 / MED-01 for v2 media analysis, end to end on a real database
 * (isolated: the spend ledger and its credit pause are global), real storage,
 * real sharp normalization and the REAL Concentrate Responses transport behind
 * a fake fetch. Fixture model ids are synthetic; nothing here is a provider result.
 */
let db: PoolDb;
let drop: () => Promise<void>;
let root: string;
let storage: LocalMultipartStorage;
const display = new MemoryObjectStorage();
const config = testConfig();

const base: Omit<ModelProfile, 'role'> = {
  gateway: 'concentrate',
  version: 'test-v1',
  model: 'fixture/model-1',
  provider: 'fixture',
  allowedFallbackProviders: [],
  maxOutputTokens: 2000,
  maxInputTokens: 200_000,
  maxInputBytes: 200_000,
  image: { maxBytes: 60_000, maxPixels: 160_000, maxDimension: 400, maxCount: 1 },
  timeoutMs: 30_000,
  structuredOutput: true,
  requireZdr: true,
  providerZdrEligible: true,
  contentLoggingEnabled: false,
  privacyVerifiedAt: '2026-10-15T00:00:00Z',
  promptVersion: 'vlm-p1',
  schemaVersion: 'atlas_observations_v2',
  catalogSnapshotAt: '2026-10-15T00:00:00Z',
  qualificationArtifactId: 'synthetic-offline-only',
  pricingSnapshotVersion: 'price-test',
  reservationMicros: 1000,
};
const limits = {
  dailyMicros: 10_000_000,
  accountDailyMicros: 10_000_000,
  maxUnknownMicros: 10_000_000,
  accountDailyAnalyses: 50,
};

type Color = 'red' | 'green' | 'blue' | 'white';
const COLORS: Record<Color, string> = {
  red: '#e02020',
  green: '#20c020',
  blue: '#2020e0',
  white: '#ffffff',
};

function reading(
  candidates: Array<{
    name: string;
    type?: string;
    relation?: 'depicted' | 'resembles';
    certainty?: number;
  }>,
  usable = true,
) {
  return {
    title: 'A moment',
    interpretation: 'Elements that resemble a design tradition.',
    observations: [{ id: 'o1', text: 'Round table', kind: 'object', region_ids: ['r1'] }],
    visible_text: [{ text: 'OPEN', region_id: null }],
    candidates: candidates.map((c, i) => ({
      id: `c${i + 1}`,
      name: c.name,
      type: c.type ?? 'style',
      relation: c.relation ?? 'resembles',
      rationale: 'Visual similarity',
      certainty: c.certainty ?? 0.6,
      region_ids: ['r1'],
      suggested_categories: ['wear'],
      tag_queries: [c.name.toLowerCase()],
    })),
    regions: [{ id: 'r1', label: 'subject', box: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }],
    uncertainty: { overall: 'medium', notes: [] },
    competing_subjects: [],
    quality: { usable, issue: usable ? null : 'blurred' },
  };
}

function envelope(text: string, status = 200, headers: Record<string, string> = {}) {
  if (status !== 200)
    return new Response(JSON.stringify({ error: { message: 'PRIVATE' } }), { status, headers });
  return new Response(
    JSON.stringify({
      id: `resp_${randomUUID()}`,
      object: 'response',
      status: 'completed',
      model: 'fixture/model-1',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 900, output_tokens: 150 },
    }),
    { status, headers: { 'x-request-id': `req_${randomUUID().slice(0, 8)}` } },
  );
}

/** Decodes the data-URI image a request carried and returns its dominant color and size. */
async function inspect(
  init: RequestInit,
): Promise<{ color: Color; width: number; height: number; bytes: number }> {
  const body = JSON.parse(init.body as string);
  const image = body.input[0].content.find((c: { type: string }) => c.type === 'input_image');
  const buf = Buffer.from(image.image_url.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
  const { data, info } = await sharp(buf).resize(1, 1).raw().toBuffer({ resolveWithObject: true });
  const [r, g, b] = [data[0]!, data[1]!, data[2]!];
  const color: Color =
    r > 200 && g > 200 && b > 200 ? 'white' : r > g && r > b ? 'red' : g > b ? 'green' : 'blue';
  const meta = await sharp(buf).metadata();
  void info;
  return { color, width: meta.width!, height: meta.height!, bytes: buf.length };
}

type Handler = (color: Color, call: number) => Response | Promise<Response>;
function gatewayWith(handler: Handler, options: { roles?: Array<ModelProfile['role']> } = {}) {
  let call = 0;
  const seen: Array<{ color: Color; width: number; height: number; bytes: number }> = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const info = await inspect(init);
    seen.push(info);
    return handler(info.color, call++);
  });
  const roles = options.roles ?? ['vision_photo', 'vision_video_frame'];
  const gateway: ModelGateway = createModelGateway(
    loadProviderConfig({ CONCENTRATE_API_KEY: 'synthetic-test-key' }),
    {
      ledger: new ModelSpendLedger(new PostgresSpendStore(db), limits),
      profiles: Object.fromEntries(roles.map((role) => [role, { ...base, role }])),
      transport: createConcentrateTransport({
        apiKey: 'synthetic-test-key',
        fetch: fetchImpl as unknown as typeof fetch,
      }),
      qualification: () => 'qualified',
    },
  );
  return { gateway, fetchImpl, seen };
}

function worker(gateway: ModelGateway | undefined, accountId: string) {
  return new MediaAnalysisWorker({
    db,
    storage,
    displayStorage: display,
    gateway,
    config,
    accountId,
    log: () => undefined,
    heartbeatMs: 1000,
  });
}

async function jpeg(color: Color, width = 1200, height = 900) {
  return sharp({ create: { width, height, channels: 3, background: COLORS[color] } })
    .jpeg({ quality: 90 })
    .toBuffer();
}
async function store(key: string, bytes: Buffer) {
  await storage.put(key, Readable.from([bytes]), 'image/jpeg', bytes.length);
}

async function photoAsset(accountId: string, color: Color = 'red') {
  const id = randomUUID();
  await db.query(
    `INSERT INTO media_assets(id,account_id,client_capture_id,kind,source,status,original_key,sha256,byte_size,content_type,width,height)
     VALUES($1,$2,$3,'photo','browser_camera','ready',$4,'x',100,'image/jpeg',1200,900)`,
    [id, accountId, randomUUID(), `accounts/${accountId}/media/${id}/1/original`],
  );
  const key = `accounts/${accountId}/media/${id}/1/normalized`;
  await store(key, await jpeg(color));
  await db.query(
    `INSERT INTO media_derivatives(account_id,asset_id,generation,kind,processing_version,object_key,checksum,byte_size,width,height)
     VALUES($1,$2,1,'normalized','normalized-jpeg-v1',$3,'c',100,1200,900)`,
    [accountId, id, key],
  );
  return id;
}

async function videoAsset(accountId: string, colors: Color[]) {
  const id = randomUUID();
  const duration = 1000 * (colors.length + 1);
  await db.query(
    `INSERT INTO media_assets(id,account_id,client_capture_id,kind,source,status,original_key,sha256,byte_size,content_type,width,height,duration_ms,audio_present)
     VALUES($1,$2,$3,'video','upload','ready',$4,'x',100,'video/mp4',640,360,$5,false)`,
    [id, accountId, randomUUID(), `accounts/${accountId}/media/${id}/1/original`, duration],
  );
  const frames: Array<{ id: string; timestampMs: number }> = [];
  for (const [i, color] of colors.entries()) {
    const key = `accounts/${accountId}/media/${id}/1/frame-${i}`;
    await store(key, await jpeg(color, 640, 360));
    const d = await db.query<{ id: string }>(
      `INSERT INTO media_derivatives(account_id,asset_id,generation,kind,processing_version,object_key,checksum,byte_size,width,height)
       VALUES($1,$2,1,'frame',$3,$4,'c',100,640,360) RETURNING id`,
      [accountId, id, `frames-v1:${(i + 1) * 1000}`, key],
    );
    await db.query(
      `INSERT INTO media_segments(account_id,asset_id,frame_derivative_id,timestamp_ms,extraction_version) VALUES($1,$2,$3,$4,'frames-v1')`,
      [accountId, id, d.rows[0]!.id, (i + 1) * 1000],
    );
    frames.push({ id: d.rows[0]!.id, timestampMs: (i + 1) * 1000 });
  }
  return { id, frames };
}

function analysisFor(
  accountId: string,
  extra: Parameters<typeof createCaptureV2Context>[0] extends infer T ? Partial<T> : never = {},
) {
  return new MediaAnalysis(
    createCaptureV2Context({
      db,
      storage,
      authority: { kind: 'account', accountId, sessionId: null },
      ...extra,
    }),
  );
}
async function request(accountId: string, assetId: string, body: Record<string, unknown>) {
  return analysisFor(accountId).request(
    assetId,
    { expected_generation: 1, ...body },
    randomUUID(),
  ) as Promise<{
    analysis_id: string;
    job_id: string;
    state: string;
  }>;
}
async function analysisRow(id: string) {
  return (await db.query('SELECT * FROM media_analysis_requests WHERE id=$1', [id])).rows[0]!;
}

// Creating and migrating a dedicated database can be slow on a loaded shared server.
beforeAll(async () => {
  ({ db, drop } = await createIsolatedDatabase('concan'));
  root = await mkdtemp(path.join(os.tmpdir(), 'ca-analysis-'));
  storage = new LocalMultipartStorage(root, 'http://localhost:3999', 'test-signing-secret');
}, 120_000);
afterAll(async () => {
  await drop();
  await rm(root, { recursive: true, force: true });
}, 60_000);

describe('v2 media analysis worker (Concentrate, offline fixtures)', { timeout: 60_000 }, () => {
  it('photo: bounded normalized JPEG in, validated reading checkpointed, capture + compiler hand-off without a second model call', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'red');
    const { gateway, fetchImpl, seen } = gatewayWith(() =>
      envelope(JSON.stringify(reading([{ name: 'Mid-century modern' }]))),
    );
    const req = await request(accountId, assetId, { mode: 'photo', focus: 'the table' });
    await worker(gateway, accountId).drain();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Never the original: the profile-bounded derivative (<=400px, <=160k px, <=60kB).
    expect(seen[0]).toMatchObject({ color: 'red' });
    expect(Math.max(seen[0]!.width, seen[0]!.height)).toBeLessThanOrEqual(400);
    expect(seen[0]!.width * seen[0]!.height).toBeLessThanOrEqual(160_000);
    expect(seen[0]!.bytes).toBeLessThanOrEqual(60_000);
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.input[0].content[0].text).toContain('the table');
    const row = await analysisRow(req.analysis_id);
    expect(row).toMatchObject({
      state: 'complete',
      error_code: null,
      waiting_reason: null,
      observation_model: 'fixture/model-1',
    });
    expect(row.result).toMatchObject({
      mode: 'photo',
      note: null,
      candidates: [{ name: 'Mid-century modern', relation: 'resembles' }],
    });
    expect(JSON.stringify(row.result)).not.toContain('certainty');
    const capture = (await db.query('SELECT * FROM captures WHERE id=$1', [row.capture_id]))
      .rows[0]!;
    expect(capture).toMatchObject({
      owner_account_id: accountId,
      media_asset_id: assetId,
      source: 'camera',
      status: 'pending',
    });
    expect(display.objects.has(capture.private_object_key)).toBe(true);
    const media = (
      await db.query(
        'SELECT analysis_status, legacy_capture_id, status FROM media_assets WHERE id=$1',
        [assetId],
      )
    ).rows[0]!;
    expect(media).toMatchObject({
      analysis_status: 'complete',
      legacy_capture_id: row.capture_id,
      status: 'ready',
    });
    const attempts = (
      await db.query('SELECT * FROM inference_attempts WHERE job_id=$1', [req.job_id])
    ).rows;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      role: 'vision_photo',
      account_id: accountId,
      asset_id: assetId,
      state: 'unknown',
      cost_micros: null,
      input_tokens: 900,
    });
    expect(attempts[0]!.request_id).toMatch(/^req_/);
    // The cultural compiler runs from the stored reading: the test registry has NO vision model.
    const job = (
      await db.query(`SELECT id, payload FROM jobs WHERE result_id=$1`, [row.capture_id])
    ).rows[0]!;
    expect(job.payload).toMatchObject({
      media_analysis_id: req.analysis_id,
      capture_id: row.capture_id,
    });
    const providers = testProviders();
    expect(providers.vlm.capability().status).toBe('unavailable');
    await new Worker({
      db,
      providers,
      config,
      handlers: JOB_HANDLERS,
      jobIds: [job.id],
      log: () => undefined,
    }).drain();
    const compiled = (
      await db.query('SELECT status, active_analysis_id FROM captures WHERE id=$1', [
        row.capture_id,
      ])
    ).rows[0]!;
    expect(['ready', 'partial']).toContain(compiled.status);
    const observed = (
      await db.query(`SELECT observations, candidates FROM analyses WHERE id=$1`, [
        compiled.active_analysis_id,
      ])
    ).rows[0]!;
    expect(JSON.stringify(observed)).toContain('Round table');
    const q = (
      await db.query(
        `SELECT sanitized_request, status, is_replay FROM provider_queries WHERE analysis_id=$1 AND provider='vlm'`,
        [compiled.active_analysis_id],
      )
    ).rows;
    expect(q).toEqual([
      {
        status: 'ok',
        is_replay: false,
        sanitized_request: expect.objectContaining({ source: 'media_analysis' }),
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an agent that only requested the analysis is not the capture creator, so removal from its grant sticks', async () => {
    const owner = await insertAccount(db);
    const { accountId } = owner;
    const assetId = await photoAsset(accountId, 'red');
    const ownerCtx = testContext(owner, { db, config });
    const granted = await collections.createCollection(ownerCtx, { name: 'Granted' });
    await db.query(
      'INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)',
      [accountId, granted.id, assetId],
    );
    const { principal } = await insertAgentConnection(
      owner,
      {
        scopes: ['media:read', 'media:analyze', 'collections:read', 'collections:write', 'taste:write'],
        libraryAccess: 'selected_collections',
        collectionIds: [granted.id],
      },
      db,
    );
    const version = (
      await db.query<{ authorization_version: number }>(
        'SELECT authorization_version FROM agent_connections WHERE id=$1',
        [principal.connectionId],
      )
    ).rows[0]!.authorization_version;
    const agent = {
      ...testContext({ ...principal, authorizationVersion: version }, { db, config }),
      captureV2: createCaptureV2Context({
        db,
        storage,
        authority: { kind: 'account', accountId, sessionId: null },
      }),
    };
    const { gateway } = gatewayWith(() =>
      envelope(JSON.stringify(reading([{ name: 'Mid-century modern' }]))),
    );
    const req = await agentMedia.analyzeMedia(
      agent,
      assetId,
      { mode: 'photo', expected_generation: 1 },
      randomUUID(),
    );
    await worker(gateway, accountId).drain();
    const row = await analysisRow(req.analysis_id as string);
    expect(row.state).toBe('complete');
    const capture = (
      await db.query('SELECT created_by_agent_connection_id FROM captures WHERE id=$1', [
        row.capture_id,
      ])
    ).rows[0]!;
    expect(capture.created_by_agent_connection_id).toBeNull();
    const captureItem = (
      await db.query<{ id: string }>('SELECT id FROM discovery_items WHERE capture_id=$1', [
        row.capture_id,
      ])
    ).rows[0]!.id;

    // The owner removes the media from the agent's only granted collection.
    await db.query('DELETE FROM collection_media_items WHERE collection_id=$1 AND asset_id=$2', [
      granted.id,
      assetId,
    ]);
    await expect(authorizeMedia(agent, 'media:read', assetId)).rejects.toMatchObject({
      code: 'not_found',
    });
    // collections:write cannot move the now-inaccessible capture back into the grant.
    await expect(
      collections.addCollectionItem(agent, { id: granted.id, item_id: captureItem, body: {} }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(authorizeMedia(agent, 'media:read', assetId)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('sampled video: <=8 timestamped frames, one bounded call each, aggregated candidates cite their frames, partial on a refusal', async () => {
    const { accountId } = await insertAccount(db);
    const video = await videoAsset(accountId, ['red', 'green', 'blue']);
    const { gateway, fetchImpl } = gatewayWith((color) => {
      if (color === 'green')
        return new Response(
          JSON.stringify({
            id: 'r',
            model: 'fixture/model-1',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'PRIVATE' }] }],
            usage: null,
          }),
        );
      if (color === 'red')
        return envelope(
          JSON.stringify(
            reading([
              { name: 'Mid-century modern', certainty: 0.5 },
              { name: 'Bauhaus', certainty: 0.4 },
            ]),
          ),
        );
      return envelope(
        JSON.stringify(
          reading([{ name: 'Mid-Century Modern', certainty: 0.8, relation: 'depicted' }]),
        ),
      );
    });
    const req = await request(accountId, video.id, { mode: 'sampled_video', focus: '' });
    await worker(gateway, accountId).drain();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const row = await analysisRow(req.analysis_id);
    expect(row.state).toBe('partial');
    expect(row.result.note).toBe('We explore selected moments, not every frame.');
    expect(row.result.frames).toEqual([
      { frame_id: video.frames[0]!.id, timestamp_ms: 1000, state: 'complete', error_code: null },
      {
        frame_id: video.frames[1]!.id,
        timestamp_ms: 2000,
        state: 'failed',
        error_code: 'model_declined',
      },
      { frame_id: video.frames[2]!.id, timestamp_ms: 3000, state: 'complete', error_code: null },
    ]);
    expect(row.result.candidates).toEqual([
      {
        name: 'Mid-Century Modern',
        type: 'style',
        relation: 'depicted',
        cited_frames: [
          { frame_id: video.frames[0]!.id, timestamp_ms: 1000 },
          { frame_id: video.frames[2]!.id, timestamp_ms: 3000 },
        ],
      },
      {
        name: 'Bauhaus',
        type: 'style',
        relation: 'resembles',
        cited_frames: [{ frame_id: video.frames[0]!.id, timestamp_ms: 1000 }],
      },
    ]);
    // Frame-local boxes are not drawn on another image.
    expect(row.observation.regions).toEqual([]);
    expect(row.observation.candidates.map((c: { region_ids: string[] }) => c.region_ids)).toEqual([
      [],
      [],
    ]);
    expect(JSON.stringify(row)).not.toContain('PRIVATE');
    const attempts = (
      await db.query(
        'SELECT role, attempt_key FROM inference_attempts WHERE job_id=$1 ORDER BY attempt_key',
        [req.job_id],
      )
    ).rows;
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.role === 'vision_video_frame')).toBe(true);
  });

  it('402 pauses AI only: the request waits (no attempt consumed), media stays ready, nothing is claimed until an operator resumes', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'blue');
    let credits = false;
    const { gateway, fetchImpl } = gatewayWith(() =>
      credits ? envelope(JSON.stringify(reading([{ name: 'Bauhaus' }]))) : envelope('', 402),
    );
    const req = await request(accountId, assetId, { mode: 'photo' });
    const w = worker(gateway, accountId);
    await w.drain();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    let row = await analysisRow(req.analysis_id);
    expect(row).toMatchObject({ state: 'queued', waiting_reason: 'ai_paused', capture_id: null });
    const work = (
      await db.query('SELECT state, attempts FROM capture_work WHERE id=$1', [req.job_id])
    ).rows[0]!;
    expect(work).toMatchObject({ state: 'queued', attempts: 0 });
    expect(
      (await db.query('SELECT status, deleted_at FROM media_assets WHERE id=$1', [assetId]))
        .rows[0],
    ).toMatchObject({ status: 'ready', deleted_at: null });
    await expect(analysisFor(accountId).get(assetId, req.analysis_id)).resolves.toMatchObject({
      state: 'queued',
      waiting_reason: 'ai_paused',
    });
    // Paused: a fresh worker claims nothing and sends nothing (no paid probe).
    await db.query('UPDATE capture_work SET available_at=now() WHERE id=$1', [req.job_id]);
    await worker(gateway, accountId).drain();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    credits = true;
    await gateway.ledger!.resume();
    await db.query('UPDATE capture_work SET available_at=now() WHERE id=$1', [req.job_id]);
    await worker(gateway, accountId).drain();
    row = await analysisRow(req.analysis_id);
    expect(row).toMatchObject({ state: 'complete', waiting_reason: null });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('429 honors Retry-After: the request waits as rate_limited until the pause ends', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'red');
    const { gateway, fetchImpl } = gatewayWith(() => envelope('', 429, { 'retry-after': '7' }));
    const req = await request(accountId, assetId, { mode: 'photo' });
    const before = Date.now();
    await worker(gateway, accountId).drain();
    const row = await analysisRow(req.analysis_id);
    expect(row).toMatchObject({ state: 'queued', waiting_reason: 'rate_limited' });
    const work = (
      await db.query('SELECT available_at, attempts FROM capture_work WHERE id=$1', [req.job_id])
    ).rows[0]!;
    expect(work.attempts).toBe(0);
    expect((work.available_at as Date).getTime() - before).toBeGreaterThanOrEqual(6000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await gateway.ledger!.resume();
  });

  it('MED-01: a dispatch whose outcome was lost is never re-sent; the frame is recorded as unknown, the charge stays counted', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'red');
    const { gateway, fetchImpl } = gatewayWith(() =>
      envelope(JSON.stringify(reading([{ name: 'Bauhaus' }]))),
    );
    const req = await request(accountId, assetId, { mode: 'photo' });
    // A previous worker reserved this exact logical attempt, then crashed before checkpointing.
    await gateway.ledger!.reserve(
      { accountId, jobId: req.job_id, attemptKey: `media:${req.analysis_id}:photo:r0:0` },
      { ...base, role: 'vision_photo' },
    );
    await worker(gateway, accountId).drain();
    expect(fetchImpl).not.toHaveBeenCalled();
    const row = await analysisRow(req.analysis_id);
    expect(row).toMatchObject({ state: 'failed', error_code: 'outcome_unknown', capture_id: null });
    const frames = (
      await db.query('SELECT state, error_code FROM media_analysis_frames WHERE analysis_id=$1', [
        req.analysis_id,
      ])
    ).rows;
    expect(frames).toEqual([{ state: 'unknown', error_code: 'outcome_unknown' }]);
    const charged = (
      await db.query(`SELECT state FROM inference_attempts WHERE job_id=$1`, [req.job_id])
    ).rows;
    expect(charged).toEqual([{ state: 'reserved' }]);
  });

  it('transient 5xx: bounded retries across rounds (<=3 HTTP attempts per frame), then an honest failure', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'green');
    const { gateway, fetchImpl } = gatewayWith(() => envelope('', 503));
    const req = await request(accountId, assetId, { mode: 'photo' });
    const w = worker(gateway, accountId);
    await w.drain();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await analysisRow(req.analysis_id)).state).toBe('queued');
    await db.query('UPDATE capture_work SET available_at=now() WHERE id=$1', [req.job_id]);
    await w.drain();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const row = await analysisRow(req.analysis_id);
    expect(row).toMatchObject({ state: 'failed', error_code: 'model_unavailable' });
    expect(
      (await db.query('SELECT status FROM media_assets WHERE id=$1', [assetId])).rows[0]!.status,
    ).toBe('ready');
  });

  it('delete during inference fences publication: no capture, no display image, readings forgotten', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'red');
    const { gateway } = gatewayWith(async () => {
      await db.query(
        `UPDATE media_assets SET deleted_at=now(), status='deleted', generation=generation+1 WHERE id=$1`,
        [assetId],
      );
      return envelope(JSON.stringify(reading([{ name: 'Bauhaus' }])));
    });
    const req = await request(accountId, assetId, { mode: 'photo' });
    const keysBefore = display.objects.size;
    await worker(gateway, accountId).drain();
    const row = await analysisRow(req.analysis_id);
    expect(row.capture_id).toBeNull();
    expect(row.observation).toBeNull();
    expect(
      (await db.query('SELECT count(*)::int AS n FROM captures WHERE media_asset_id=$1', [assetId]))
        .rows[0]!.n,
    ).toBe(0);
    expect(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM media_analysis_frames WHERE analysis_id=$1',
          [req.analysis_id],
        )
      ).rows[0]!.n,
    ).toBe(0);
    expect(display.objects.size).toBe(keysBefore);
  });

  it('missing or unqualified role: fails as unavailable without any HTTP call; the request gate refuses before using allowance', async () => {
    const { accountId } = await insertAccount(db);
    const assetId = await photoAsset(accountId, 'red');
    const { gateway, fetchImpl } = gatewayWith(() => envelope('{}'), {
      roles: ['vision_video_frame'],
    });
    const req = await request(accountId, assetId, { mode: 'photo' });
    await worker(gateway, accountId).drain();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await analysisRow(req.analysis_id)).toMatchObject({
      state: 'failed',
      error_code: 'analysis_unavailable',
    });
    const gated = analysisFor(accountId, { analysisAvailability: async () => 'unavailable' });
    const other = await photoAsset(accountId, 'blue');
    const error = await gated
      .request(other, { mode: 'photo', expected_generation: 1 }, randomUUID())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'service_unavailable',
      message: 'Exploration is temporarily unavailable.',
    });
    expect(
      (
        await db.query('SELECT count(*)::int AS n FROM media_analysis_requests WHERE asset_id=$1', [
          other,
        ])
      ).rows[0]!.n,
    ).toBe(0);
    const waiting = analysisFor(accountId, { analysisAvailability: async () => 'waiting' });
    await expect(
      waiting.request(other, { mode: 'photo', expected_generation: 1 }, randomUUID()),
    ).resolves.toMatchObject({ state: 'queued' });
  });
});
