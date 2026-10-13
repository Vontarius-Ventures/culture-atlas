import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentPrincipal } from '../principal';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, insertAnonymousSession, testConfig, testContext, testProviders } from '../testing';
import { getJobById } from '../jobs/queue';
import * as captures from './captures';
import * as references from './references';

const db = getTestDb();
afterAll(closeTestDb);

let n = 0;
async function jpeg(w = 40, h = 30): Promise<Uint8Array> {
  n++;
  return new Uint8Array(await sharp({ create: { width: w, height: h, channels: 3, background: { r: n % 255, g: (n * 7) % 255, b: 90 } } }).jpeg().toBuffer());
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? 'other';
  }
}

const multipart = (bytes: Uint8Array) => ({ kind: 'multipart' as const, image: { bytes }, fields: { source: 'upload' as const, focus: undefined } });

describe('uploads', () => {
  it('validates bytes, stores a private derivative and expires in 24h', async () => {
    const providers = testProviders();
    const ctx = testContext(await insertAnonymousSession(), { providers });
    const res = await captures.createUpload(ctx, { bytes: await jpeg(3000, 1000), declaredContentType: 'image/png', filename: 'x.png' });
    expect(res).toMatchObject({ content_type: 'image/jpeg', width: 2048, height: 683 });
    expect(new Date(res.expires_at).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    const { rows } = await db.query<{ object_key: string }>('SELECT object_key FROM uploads WHERE id = $1', [res.upload_id]);
    const stored = await providers.storage.get(rows[0]!.object_key);
    expect(stored?.contentType).toBe('image/jpeg');
    expect(await code(captures.createUpload(ctx, { bytes: new TextEncoder().encode('GIF89a....') }))).toBe('unsupported_image');
  });
});

describe('createCapture', () => {
  it('creates capture + capture item + job; same owner/image/focus reuses; other owners do not share', async () => {
    const providers = testProviders();
    const a = testContext(await insertAnonymousSession(), { providers });
    const b = testContext(await insertAnonymousSession(), { providers });
    const bytes = await jpeg();
    const first = await captures.createCapture(a, multipart(bytes));
    const again = await captures.createCapture(a, multipart(bytes));
    const other = await captures.createCapture(b, multipart(bytes));
    expect(again).toEqual({ ...first, reused: true });
    expect(other.capture_id).not.toBe(first.capture_id); // hashing never exposes another user's result
    const focused = await captures.createCapture(a, { kind: 'multipart', image: { bytes }, fields: { source: 'upload', focus: { kind: 'choice', choice_id: 's1', label: 'The chair' } } });
    expect(focused.capture_id).not.toBe(first.capture_id);

    const job = await getJobById(db, first.job_id);
    expect(job).toMatchObject({ type: 'analyze_capture', state: 'queued', result_type: 'capture', result_id: first.capture_id });
    expect(job!.budget).toMatchObject({ qloo_requests: 12, research_refs: 5, provider_retries: 2, deadline_ms: 60000 });
    const view = await captures.getCapture(a, { id: first.capture_id });
    expect(view).toMatchObject({ status: 'pending', source: 'upload', analysis: null, job_id: first.job_id, saved: false, is_example: false });
    expect(view.image?.url).toMatch(/\/v1\/media\?key=/);
    expect(view.discovery_item_id).not.toBeNull();
  });

  it('accepts an owned upload id and rejects others', async () => {
    const providers = testProviders();
    const owner = testContext(await insertAnonymousSession(), { providers });
    const stranger = testContext(await insertAnonymousSession(), { providers });
    const up = await captures.createUpload(owner, { bytes: await jpeg() });
    expect(await code(captures.createCapture(stranger, { kind: 'json', body: { upload_id: up.upload_id } }))).toBe('not_found');
    const res = await captures.createCapture(owner, { kind: 'json', body: { upload_id: up.upload_id, source: 'camera' } });
    expect((await captures.getCapture(owner, { id: res.capture_id })).source).toBe('camera');
  });

  it('enforces the anonymous daily analysis quota', async () => {
    const ctx = testContext(await insertAnonymousSession(), { config: testConfig({ ANON_DAILY_ANALYSES: '2' }) });
    await captures.createCapture(ctx, multipart(await jpeg()));
    await captures.createCapture(ctx, multipart(await jpeg()));
    expect(await code(captures.createCapture(ctx, multipart(await jpeg())))).toBe('quota_exceeded');
  });

  it('loads example photos from storage for "Try an example"', async () => {
    const providers = testProviders();
    await providers.storage.put('samples/outfit.jpg', await jpeg(), { contentType: 'image/jpeg' });
    const ctx = testContext(await insertAnonymousSession(), { providers });
    const res = await captures.createCapture(ctx, { kind: 'json', body: { sample_id: 'outfit' } });
    const view = await captures.getCapture(ctx, { id: res.capture_id });
    expect(view).toMatchObject({ source: 'sample', is_example: true });
    expect(await code(captures.createCapture(ctx, { kind: 'json', body: { sample_id: '../etc' } }))).toBe('not_found');
    expect(await code(captures.createCapture(ctx, { kind: 'json', body: { sample_id: 'missing' } }))).toBe('not_found');
  });

  it('sensor imports: only the bridge for that connection, deduped by asset, hash verified', async () => {
    const providers = testProviders();
    const account = await insertAccount();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sensor_connections (owner_account_id, configured_origin, mode) VALUES ($1, 'http://relay.test', 'bridge') RETURNING id`,
      [account.accountId],
    );
    const connectionId = rows[0]!.id;
    const agent = await insertAgentConnection(account, { scopes: ['captures:write', 'captures:read'] });
    const bridge: AgentPrincipal = { ...agent.principal, purpose: 'sensor_bridge', sensorConnectionId: connectionId, libraryAccess: 'none' };
    const bridgeCtx = testContext(bridge, { providers });
    const bytes = await jpeg();
    const up = await captures.createUpload(bridgeCtx, { bytes });
    const sha = (await db.query<{ sha256: string }>('SELECT sha256 FROM uploads WHERE id = $1', [up.upload_id])).rows[0]!.sha256;

    expect(await code(captures.createCapture(bridgeCtx, multipart(bytes)))).toBe('scope_denied');
    expect(
      await code(captures.createCapture(bridgeCtx, { kind: 'json', body: { upload_id: up.upload_id, sensor: { connection_id: connectionId, asset_id: 'a1', declared_sha256: 'f'.repeat(64) } } })),
    ).toBe('invalid_input');
    const first = await captures.createCapture(bridgeCtx, {
      kind: 'json',
      body: { upload_id: up.upload_id, sensor: { connection_id: connectionId, asset_id: 'a1', declared_sha256: sha, captured_at: '2026-10-01T10:00:00Z' } },
    });
    const replay = await captures.createCapture(bridgeCtx, { kind: 'json', body: { upload_id: up.upload_id, sensor: { connection_id: connectionId, asset_id: 'a1' } } });
    expect(replay).toEqual({ ...first, reused: true });
    const cap = (await db.query<{ source: string; captured_at: Date; sensor_asset_id: string }>('SELECT source, captured_at, sensor_asset_id FROM captures WHERE id = $1', [first.capture_id])).rows[0]!;
    expect(cap).toMatchObject({ source: 'sensor', sensor_asset_id: 'a1' });
    expect(cap.captured_at.toISOString()).toBe('2026-10-01T10:00:00.000Z');
    // Another connection id is refused.
    expect(await code(captures.createCapture(bridgeCtx, { kind: 'json', body: { upload_id: up.upload_id, sensor: { connection_id: randomUUID(), asset_id: 'a2' } } }))).toBe('scope_denied');
  });
});

describe('capture access', () => {
  it('isolates owners and enforces the current agent grant', async () => {
    const providers = testProviders();
    const account = await insertAccount();
    const owner = testContext(account, { providers });
    const res = await captures.createCapture(owner, multipart(await jpeg()));

    const otherAccount = testContext(await insertAccount(), { providers });
    const anon = testContext(await insertAnonymousSession(), { providers });
    expect(await code(captures.getCapture(otherAccount, { id: res.capture_id }))).toBe('not_found');
    expect(await code(captures.getCapture(anon, { id: res.capture_id }))).toBe('not_found');

    // Selected-collection agent: not granted until the capture is in a granted collection.
    const { rows: col } = await db.query<{ id: string }>(`INSERT INTO collections (owner_account_id, name) VALUES ($1, 'Grant') RETURNING id`, [account.accountId]);
    const agent = await insertAgentConnection(account, { scopes: ['captures:read', 'captures:write'], libraryAccess: 'selected_collections', collectionIds: [col[0]!.id] });
    const agentCtx = testContext(agent.principal, { providers });
    expect(await code(captures.getCapture(agentCtx, { id: res.capture_id }))).toBe('not_found');
    const item = (await db.query<{ id: string }>('SELECT id FROM discovery_items WHERE capture_id = $1', [res.capture_id])).rows[0]!.id;
    const saved = (await db.query<{ id: string }>('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id', [account.accountId, item])).rows[0]!.id;
    await db.query('INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position) VALUES ($1, $2, $3, 0)', [col[0]!.id, saved, account.accountId]);
    expect((await captures.getCapture(agentCtx, { id: res.capture_id })).id).toBe(res.capture_id);
    // ...but cannot delete it (could affect ungranted contexts), and read-only agents cannot write.
    expect(await code(captures.deleteCapture(agentCtx, { id: res.capture_id }))).toBe('scope_denied');
    const readOnly = await insertAgentConnection(account, { scopes: ['captures:read'] });
    expect(await code(captures.createCapture(testContext(readOnly.principal, { providers }), multipart(await jpeg())))).toBe('scope_denied');
  });
});

describe('deleteCapture', () => {
  it('removes media, the capture item with saves/memberships, dependent plans and preference links; cancels jobs', async () => {
    const providers = testProviders();
    const account = await insertAccount();
    const ctx = testContext(account, { providers });
    const res = await captures.createCapture(ctx, multipart(await jpeg()));
    const cap = (await db.query<{ private_object_key: string }>('SELECT private_object_key FROM captures WHERE id = $1', [res.capture_id])).rows[0]!;
    const item = (await db.query<{ id: string }>('SELECT id FROM discovery_items WHERE capture_id = $1', [res.capture_id])).rows[0]!.id;
    const other = (await db.query<{ id: string }>(`INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title) VALUES ($1, 'film', 'watch', 'qloo:X1', 'Film') RETURNING id`, [account.accountId])).rows[0]!.id;
    const savedCap = (await db.query<{ id: string }>('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id', [account.accountId, item])).rows[0]!.id;
    const savedFilm = (await db.query<{ id: string }>('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id', [account.accountId, other])).rows[0]!.id;
    const col = (await db.query<{ id: string }>(`INSERT INTO collections (owner_account_id, name) VALUES ($1, 'Mix') RETURNING id`, [account.accountId])).rows[0]!.id;
    await db.query('INSERT INTO collection_items (collection_id, saved_item_id, owner_account_id, position) VALUES ($1, $2, $3, 0), ($1, $4, $3, 1)', [col, savedCap, account.accountId, savedFilm]);
    const plan = (await db.query<{ id: string }>(`INSERT INTO plans (owner_account_id, source_collection_id, selected_item_ids) VALUES ($1, $2, $3::uuid[]) RETURNING id`, [account.accountId, col, [item, other]])).rows[0]!.id;
    await db.query(`INSERT INTO preference_events (owner_account_id, action, target_type, target_id) VALUES ($1, 'save', 'discovery_item', $2)`, [account.accountId, item]);

    await captures.deleteCapture(ctx, { id: res.capture_id });

    expect(await providers.storage.get(cap.private_object_key)).toBeNull();
    expect(await code(captures.getCapture(ctx, { id: res.capture_id }))).toBe('not_found');
    expect((await getJobById(db, res.job_id))?.state).toBe('cancelled');
    expect((await db.query('SELECT 1 FROM discovery_items WHERE id = $1', [item])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM plans WHERE id = $1', [plan])).rows).toHaveLength(0);
    expect((await db.query('SELECT 1 FROM preference_events WHERE target_id = $1', [item])).rows).toHaveLength(0);
    // The independently saved film and its membership remain; the collection revision moved.
    expect((await db.query('SELECT 1 FROM collection_items WHERE saved_item_id = $1', [savedFilm])).rows).toHaveLength(1);
    expect((await db.query<{ revision: number }>('SELECT revision FROM collections WHERE id = $1', [col])).rows[0]!.revision).toBe(2);
    // Same photo can be analyzed again later (dedupe key released).
    expect(await code(captures.deleteCapture(ctx, { id: res.capture_id }))).toBe('not_found');
  });
});

describe('references', () => {
  it('serves public facts with sources only; unknown ids are 404', async () => {
    const ctx = testContext(await insertAnonymousSession());
    const ref = (await db.query<{ id: string }>(`INSERT INTO cultural_references (canonical_name, canonical_key, type, research_status, overview, sections) VALUES ('Bauhaus', $1, 'style', 'complete', 'Bauhaus overview.', '[]') RETURNING id`, [`style:bauhaus-${randomUUID()}`])).rows[0]!.id;
    const src = (await db.query<{ id: string }>(`INSERT INTO sources (url, title, publisher) VALUES ($1, 'Bauhaus', 'Wikipedia') RETURNING id`, [`https://en.wikipedia.org/wiki/Bauhaus?${randomUUID()}`])).rows[0]!.id;
    const claim = (await db.query<{ id: string }>(`INSERT INTO claims (reference_id, text, claim_type, source_ids) VALUES ($1, 'Founded in Weimar.', 'factual', $2::uuid[]) RETURNING id`, [ref, [src]])).rows[0]!.id;
    await db.query(`UPDATE cultural_references SET sections = $2::jsonb WHERE id = $1`, [ref, JSON.stringify([{ heading: 'History', body: 'Founded in Weimar.', claim_ids: [claim] }])]);
    const page = await references.getReference(ctx, { id: ref });
    expect(page).toMatchObject({ name: 'Bauhaus', overview: 'Bauhaus overview.', research_status: 'complete', related: [] });
    expect(page.claims).toEqual([{ id: claim, text: 'Founded in Weimar.', claim_type: 'factual', source_ids: [src] }]);
    expect(page.sections[0]!.claim_ids).toEqual([claim]);
    expect(await code(references.getReference(ctx, { id: randomUUID() }))).toBe('not_found');
    // A capture context the caller cannot access yields no related cards (never another user's context).
    expect((await references.getReference(ctx, { id: ref, capture_id: randomUUID() })).related).toEqual([]);
  });
});
