import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { agentPlatform, collections, setDbForTesting, setDomainConfigForTesting, type Scope } from '@culture-atlas/domain';
import { closeTestDb, getTestDb, insertAccount, testConfig, testContext } from '@culture-atlas/domain/testing';
import { LocalMultipartStorage } from '@culture-atlas/providers';
import { connectMcp } from '../../../demo-agent/src/client';

vi.mock('server-only', () => ({}));
const { setCaptureV2Runtime, captureV2Route } = await import('./capture-v2');
const mcp = await import('../../app/mcp/route');
const agentContent = await import('../../app/v2/agent-media/[id]/content/[variant]/route');
const operations = await import('../../app/v2/operations/[id]/route');

const db = getTestDb();
const config = testConfig({ APP_BASE_URL: 'http://localhost:3303' });
const BASE = 'http://localhost:3303';
let root: string;
let storage: LocalMultipartStorage;
let ip = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ca-agent-media-'));
  storage = new LocalMultipartStorage(root, BASE, 'private-test-key');
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setCaptureV2Runtime({ storage });
});
afterAll(async () => {
  setCaptureV2Runtime({});
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
});

async function photo(accountId: string, title: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO media_assets (account_id, client_capture_id, kind, source, status, byte_size, content_type, title, width, height, original_key)
     VALUES ($1, $2, 'photo', 'upload', 'ready', 2048, 'image/jpeg', $3, 64, 64, $4) RETURNING id`,
    [accountId, randomUUID(), title, `originals/${randomUUID()}`],
  );
  const id = rows[0]!.id;
  const key = `derivatives/${randomUUID()}.jpg`;
  const bytes = randomBytes(2048);
  await storage.put(key, (async function* () { yield bytes; })(), 'image/jpeg', bytes.length);
  await db.query(
    `INSERT INTO media_derivatives (account_id, asset_id, generation, kind, processing_version, object_key, checksum, byte_size, width, height)
     VALUES ($1, $2, 1, 'normalized', 'test', $3, $4, 2048, 64, 64)`,
    [accountId, id, key, 'c'.repeat(64)],
  );
  return { id, bytes };
}

async function fixture(scopes: Scope[]) {
  const owner = await insertAccount();
  const ctx = testContext(owner);
  const granted = await collections.createCollection(ctx, { name: 'Granted' });
  const hidden = await collections.createCollection(ctx, { name: 'Private' });
  const visible = await photo(owner.accountId, 'Visible photo');
  const secret = await photo(owner.accountId, 'Private photo');
  await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [owner.accountId, granted.id, visible.id]);
  await db.query('INSERT INTO collection_media_items (account_id, collection_id, asset_id) VALUES ($1, $2, $3)', [owner.accountId, hidden.id, secret.id]);
  const created = await agentPlatform.createConnection(ctx, {
    client_name: 'Media agent', scopes, library_access: 'selected_collections', collection_ids: [granted.id],
  });
  return { owner, ctx, granted, hidden, visible, secret, connectionId: created.connection.id, credential: created.credential };
}

function bearer(path: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': `203.0.113.${++ip % 250}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe('AGT-01 agent REST media parity (G7)', () => {
  it('lists, reads and previews only media inside the live grant; originals need media:download', async () => {
    const f = await fixture(['media:read']);
    const list = await captureV2Route(bearer('/v2/library', f.credential));
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.items.map((m: { media: { id: string } }) => m.media.id)).toEqual([f.visible.id]);
    expect(JSON.stringify(body)).not.toContain(f.secret.id);
    expect((await captureV2Route(bearer(`/v2/media/${f.secret.id}`, f.credential))).status).toBe(404);
    const detail = await captureV2Route(bearer(`/v2/media/${f.visible.id}`, f.credential));
    expect(detail.status).toBe(200);
    const links = (await detail.json()).links;
    expect(links.original).toBeNull();
    expect(links.analysis).toBeNull();
    expect(links.playback).toMatch(new RegExp(`^/v2/agent-media/${f.visible.id}/content/`));
    const preview = await agentContent.GET(bearer(links.playback, f.credential));
    expect(preview.status).toBe(200);
    expect(Buffer.from(await preview.arrayBuffer()).equals(f.visible.bytes)).toBe(true);
    const original = await captureV2Route(bearer(`/v2/media/${f.visible.id}/content/original`, f.credential));
    expect(original.status).toBe(403);
    expect((await original.json()).error.code).toBe('scope_denied');
    // Owner-only capture surfaces stay closed to agents.
    expect((await captureV2Route(bearer('/v2/devices', f.credential))).status).toBe(403);
    expect((await captureV2Route(bearer('/v2/capabilities', f.credential))).status).toBe(403);
  });

  it('narrowing the collection grant applies to the very next list, detail and preview', async () => {
    const f = await fixture(['media:read']);
    const detail = await (await captureV2Route(bearer(`/v2/media/${f.visible.id}`, f.credential))).json();
    await agentPlatform.narrowConnection(f.ctx, f.connectionId, { collection_ids: [] });
    expect((await captureV2Route(bearer('/v2/library', f.credential))).status).toBe(200);
    expect((await (await captureV2Route(bearer('/v2/library', f.credential))).json()).items).toEqual([]);
    expect((await captureV2Route(bearer(`/v2/media/${f.visible.id}`, f.credential))).status).toBe(404);
    expect((await agentContent.GET(bearer(detail.links.playback, f.credential))).status).toBe(404);
  });

  it('analyze_media needs media:analyze, is explicit, and is visible through get_operation', async () => {
    const reader = await fixture(['media:read']);
    const denied = await captureV2Route(bearer(`/v2/media/${reader.visible.id}/analysis`, reader.credential, {
      method: 'POST', body: { mode: 'photo', expected_generation: 1 },
    }));
    expect(denied.status).toBe(403);
    const f = await fixture(['media:read', 'media:analyze']);
    expect((await captureV2Route(bearer(`/v2/media/${f.secret.id}/analysis`, f.credential, {
      method: 'POST', body: { mode: 'photo', expected_generation: 1 },
    }))).status).toBe(404);
    const requested = await captureV2Route(bearer(`/v2/media/${f.visible.id}/analysis`, f.credential, {
      method: 'POST', body: { mode: 'photo', expected_generation: 1 },
    }));
    expect(requested.status).toBe(202);
    const analysis = await requested.json();
    expect(analysis).toMatchObject({ state: 'queued', reused: false });
    expect(JSON.stringify(analysis)).not.toContain('result_url');
    const work = await db.query('SELECT created_by_agent_connection_id, authorization_version FROM capture_work WHERE id = $1', [analysis.job_id]);
    expect(work.rows[0]).toEqual({ created_by_agent_connection_id: f.connectionId, authorization_version: 1 });
    const op = await operations.GET(bearer(`/v2/operations/${analysis.analysis_id}`, f.credential), { params: Promise.resolve({ id: analysis.analysis_id }) });
    expect(op.status).toBe(200);
    expect(await op.json()).toMatchObject({ kind: 'analysis', state: 'queued', result_id: f.visible.id });
  });
});

describe('AGT-01 MCP media tools in production wiring (G6)', () => {
  it('serves list_media, get_media and analyze_media through the same live grant', async () => {
    const f = await fixture(['media:read', 'media:analyze']);
    const client = await connectMcp({
      url: `${BASE}/mcp`, token: f.credential,
      fetch: (input, init) => mcp.POST(new Request(input, init)),
    });
    try {
      expect(await client.listTools()).toContain('analyze_media');
      const listed = await client.callTool<{ items: Array<{ media: { id: string } }> }>('list_media', {});
      expect(listed.ok && listed.data.items.map((m) => m.media.id)).toEqual([f.visible.id]);
      const hidden = await client.callTool('get_media', { media_id: f.secret.id });
      expect(hidden.ok).toBe(false);
      expect(!hidden.ok && hidden.error.code).toBe('not_found');
      const analyzed = await client.callTool<{ analysis_id: string; state: string }>('analyze_media', {
        media_id: f.visible.id, idempotency_key: randomUUID(), request: { mode: 'photo', expected_generation: 1 },
      });
      expect(analyzed.ok && analyzed.data.state).toBe('queued');
      const op = await client.callTool<{ kind: string }>('get_operation', { operation_id: analyzed.ok ? analyzed.data.analysis_id : randomUUID() });
      expect(op.ok && op.data.kind).toBe('analysis');
    } finally {
      await client.close();
    }
  });

  it('rejects revoked connections on the next MCP media call', async () => {
    const f = await fixture(['media:read']);
    const client = await connectMcp({ url: `${BASE}/mcp`, token: f.credential, fetch: (input, init) => mcp.POST(new Request(input, init)) });
    try {
      await db.query('UPDATE agent_connections SET revoked_at = now() WHERE id = $1', [f.connectionId]);
      await expect(client.callTool('list_media', {})).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
