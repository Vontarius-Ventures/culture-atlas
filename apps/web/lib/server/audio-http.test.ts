import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  auth,
  pcmWavBytes,
  setDbForTesting,
  setDomainConfigForTesting,
  type CaptureIdentityAdapter,
} from '@culture-atlas/domain';
import { getTestDb, closeTestDb, insertAccount, testConfig } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';

vi.mock('server-only', () => ({}));
const { captureV2Route, setCaptureV2Runtime } = await import('./capture-v2');

const db = getTestDb();
const config = testConfig();
let root: string;
let storage: LocalMultipartStorage;
const identity: CaptureIdentityAdapter = {
  requireRecoverableAccount: async () => {},
  peekNativeEnrollmentGrant: async () => {
    throw new Error('unused');
  },
  consumeNativeEnrollmentGrant: async () => {
    throw new Error('unused');
  },
  issueNativeSession: async () => {
    throw new Error('unused');
  },
  revokeInstallationSessions: async () => {},
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-audio-http-'));
  storage = new LocalMultipartStorage(root, 'http://localhost:3301', 'private-test-key');
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setCaptureV2Runtime({ storage, identity });
});
afterAll(async () => {
  setCaptureV2Runtime({});
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

async function browser() {
  const principal = await insertAccount();
  const token = randomUUID();
  await db.query(`UPDATE sessions SET token_hash=$2 WHERE id=$1`, [
    principal.sessionId,
    auth.hashToken(token),
  ]);
  return {
    principal,
    token,
    csrf: auth.csrfTokenFor(principal.sessionId!, config.SESSION_SECRET),
  };
}

type Browser = Awaited<ReturnType<typeof browser>>;

function json(
  path: string,
  owner: Browser,
  method = 'GET',
  body?: unknown,
) {
  return new NextRequest(`http://localhost:3301${path}`, {
    method,
    headers: {
      cookie: `ca_session=${owner.token}`,
      'x-csrf-token': owner.csrf,
      'x-atlas-expected-account': owner.principal.accountId,
      'idempotency-key': randomUUID(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function keepRequest(owner: Browser, wav: Uint8Array, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('client_capture_id', extra.client_capture_id ?? randomUUID());
  form.append('source', extra.source ?? 'browser_microphone');
  form.append('source_route', extra.source_route ?? 'browser_microphone');
  form.append('filename', extra.filename ?? 'music-mode.wav');
  form.append('content_type', extra.content_type ?? 'audio/wav');
  form.append(
    'recording',
    new File([Buffer.from(wav)], extra.filename ?? 'music-mode.wav', {
      type: extra.content_type ?? 'audio/wav',
    }),
  );
  return new NextRequest('http://localhost:3301/v2/media/audio', {
    method: 'POST',
    headers: {
      cookie: `ca_session=${owner.token}`,
      'x-csrf-token': owner.csrf,
      'x-atlas-expected-account': owner.principal.accountId,
      'idempotency-key': extra.key ?? randomUUID(),
    },
    body: form,
  });
}

describe('audio v2 routes (Music Mode domain)', () => {
  it('keeps a WAV recording without enqueueing analysis, then explores music_match only', async () => {
    const owner = await browser();
    const wav = pcmWavBytes({ durationMs: 15_000, sampleRateHz: 16_000, channels: 1 });
    const keptRes = await captureV2Route(keepRequest(owner, wav));
    expect(keptRes.status).toBe(201);
    const kept = await keptRes.json();
    expect(kept.analysis_status).toBe('not_requested');
    expect(kept.media).toMatchObject({
      kind: 'audio',
      capture_mode: 'music',
      camera_active: false,
      speech_analysis: 'off',
    });
    const jobs = await db.query(`SELECT id FROM jobs WHERE owner_account_id=$1 AND type='analyze_audio'`, [
      owner.principal.accountId,
    ]);
    expect(jobs.rows).toEqual([]);

    const detail = await captureV2Route(json(`/v2/media/${kept.asset_id}`, owner));
    expect(detail.status).toBe(200);
    expect((await detail.json()).media.kind).toBe('audio');

    const speech = await captureV2Route(
      json(`/v2/media/${kept.asset_id}/analysis`, owner, 'POST', {
        contract_version: 2,
        expected_generation: kept.generation,
        requested_components: ['speech_references'],
        selection: { start_ms: 0, end_ms: 15_000 },
      }),
    );
    expect(speech.status).toBe(400);

    const explore = await captureV2Route(
      json(`/v2/media/${kept.asset_id}/analysis`, owner, 'POST', {
        contract_version: 2,
        expected_generation: kept.generation,
        requested_components: ['music_match'],
        selection: { start_ms: 0, end_ms: 15_000 },
      }),
    );
    expect(explore.status).toBe(202);
    const requested = await explore.json();
    expect(requested.state).toBe('queued');
    expect(requested.result_url).toBe(`/v2/media/${kept.asset_id}/analysis/${requested.analysis_id}`);

    const get = await captureV2Route(
      json(`/v2/media/${kept.asset_id}/analysis/${requested.analysis_id}`, owner),
    );
    expect(get.status).toBe(200);
    expect((await get.json()).analysis_id).toBe(requested.analysis_id);
  });

  it('creates an audio upload session and refuses a non-WAV keep', async () => {
    const owner = await browser();
    const wav = pcmWavBytes({ durationMs: 8_000 });
    const created = await captureV2Route(
      json('/v2/uploads', owner, 'POST', {
        client_capture_id: randomUUID(),
        kind: 'audio',
        source: 'upload',
        filename: 'clip.wav',
        content_type: 'audio/wav',
        byte_size: wav.byteLength,
        sha256: createHash('sha256').update(wav).digest('hex'),
      }),
    );
    expect(created.status).toBe(201);
    const session = await created.json();
    expect(session.upload_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.reused).toBe(false);

    const webm = await captureV2Route(
      keepRequest(owner, wav, { filename: 'clip.webm', content_type: 'audio/webm' }),
    );
    expect(webm.status).toBe(400);
    expect((await webm.json()).error.code).toMatch(/unsupported_media|invalid_input/);
  });
});
