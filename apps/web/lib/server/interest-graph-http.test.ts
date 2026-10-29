import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  auth,
  NATIVE_OWNER_OPERATIONS,
  NATIVE_OWNER_V2_GRAPH_OPERATIONS,
  nativeSessions,
  setDbForTesting,
  setDomainConfigForTesting,
} from '@culture-atlas/domain';
import { ROUTES } from '@culture-atlas/domain/schemas';
import { TOOLS } from '@culture-atlas/agent-gateway';
import { closeTestDb, getTestDb, insertAccount, insertAgentConnection, testConfig, testProviders } from '@culture-atlas/domain/testing';
import { setProvidersForTesting } from '@culture-atlas/providers';
import { z } from 'zod';
import * as schemas from '@culture-atlas/domain/schemas';

vi.mock('server-only', () => ({}));

const summaryRoute = (await import('../../app/v2/me/interest-graph/route')).GET;
const settingsRoute = (await import('../../app/v2/me/interest-graph/settings/route')).PATCH;
const interestRoute = (await import('../../app/v2/me/interest-graph/interests/[id]/route')).PATCH;
const connectionRoute = (await import('../../app/v2/me/recommendations/[id]/connection/route')).GET;

/**
 * Route/schema/policy matrix of the typed owner/native graph operations
 * (VAL-API-001/002/003): owner browser sessions and the four explicitly
 * bridged native installation operations are the only principals; agents
 * gain no graph authority or new tools; the v1 native allowlist stays
 * byte-identical; stale revisions, unknown mutation fields and invalid
 * cursor bounds are typed rejections; and the old client decoder contracts
 * (TypeScript/Swift/Android-Kotlin) keep decoding `why_this`-era responses,
 * with additive response fields tolerated.
 */

const db = getTestDb();
const config = testConfig();
const noParams = { params: Promise.resolve({}) };
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
let ipCounter = 0;

function req(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    csrf?: string;
    bearer?: string;
    expectedAccount?: string;
    body?: unknown;
    query?: string;
    ip?: string;
  } = {},
) {
  const headers: Record<string, string> = { 'x-forwarded-for': init.ip ?? `198.51.100.${++ipCounter % 250}` };
  if (init.cookie) headers.cookie = `${auth.SESSION_COOKIE}=${init.cookie}`;
  if (init.csrf) headers[auth.CSRF_HEADER] = init.csrf;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.expectedAccount) headers['x-atlas-expected-account'] = init.expectedAccount;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const query = init.query ? `?${init.query}` : '';
  return new NextRequest(`http://localhost:3000${path}${query}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeAll(() => {
  setDbForTesting(db);
  setDomainConfigForTesting(config);
  setProvidersForTesting(testProviders());
});
afterAll(async () => {
  setDbForTesting(undefined);
  setDomainConfigForTesting(undefined);
  setProvidersForTesting(undefined);
  await closeTestDb();
});

/** A signed-in browser owner with a known session token and its CSRF token. */
async function browserOwner() {
  const principal = await insertAccount(db);
  const token = randomUUID();
  await db.query('UPDATE sessions SET token_hash=$2 WHERE id=$1', [principal.sessionId, auth.hashToken(token)]);
  return {
    account: principal,
    cookie: token,
    csrf: auth.csrfTokenFor(principal.sessionId!, config.SESSION_SECRET),
  };
}

/** A live native installation (cna_ access token) for the account. */
async function nativePhone(accountId: string, over: { revoked?: boolean; expired?: boolean } = {}) {
  await db.query(
    'INSERT INTO account_emails(account_id,email,verified_at) VALUES($1,$2,now()) ON CONFLICT DO NOTHING',
    [accountId, `${randomUUID()}@example.test`],
  );
  const { rows: installation } = await db.query<{ id: string }>(
    `INSERT INTO mobile_installations(account_id,installation_public_id,platform,app_version)
     VALUES($1,$2,'ios','1') RETURNING id`,
    [accountId, randomUUID()],
  );
  const installationId = installation[0]!.id;
  const now = new Date();
  const pair = await db.transaction((tx) =>
    nativeSessions.issueNativeSession(tx, { accountId, installationId, authenticatedAt: now }, now),
  );
  if (over.revoked) await db.query('UPDATE mobile_installations SET revoked_at = now() WHERE id = $1', [installationId]);
  if (over.expired) await db.query('UPDATE mobile_installations SET authority_ended_at = now() WHERE id = $1', [installationId]);
  return { token: pair.access_token, installationId };
}

const json = async (res: Response): Promise<Record<string, unknown>> => (await res.json()) as Record<string, unknown>;

describe('owner/native graph routes: principal matrix', () => {
  it('serves the owner browser session and refuses agents and anonymous visitors', async () => {
    const owner = await browserOwner();
    const ok = await summaryRoute(req('/v2/me/interest-graph', { cookie: owner.cookie, csrf: owner.csrf }), noParams);
    expect(ok.status).toBe(200);
    const body = await json(ok);
    expect(body).toMatchObject({
      owner_account_id: owner.account.accountId,
      settings: { revision: 0, discovery_paused: false, paused_at: null },
    });

    // An agent with EVERY scope gains no graph authority.
    const { credential } = await insertAgentConnection(owner.account);
    for (const call of [
      () => summaryRoute(req('/v2/me/interest-graph', { bearer: credential }), noParams),
      () =>
        settingsRoute(
          req('/v2/me/interest-graph/settings', {
            method: 'PATCH',
            bearer: credential,
            expectedAccount: owner.account.accountId,
            body: { expected_revision: 0, discovery_paused: true },
          }),
          noParams,
        ),
      () =>
        interestRoute(
          req('/v2/me/interest-graph/interests/' + randomUUID(), {
            method: 'PATCH',
            bearer: credential,
            expectedAccount: owner.account.accountId,
            body: { expected_revision: 0, state: 'suppressed' },
          }),
          idParams(randomUUID()),
        ),
      () => connectionRoute(req('/v2/me/recommendations/' + randomUUID() + '/connection', { bearer: credential }), idParams(randomUUID())),
    ]) {
      const res = await call();
      expect(res.status).toBe(403);
      expect((await json(res)).code).toBe('scope_denied');
    }

    // Anonymous visitors are told to create an account.
    const anon = await summaryRoute(req('/v2/me/interest-graph'), noParams);
    expect(anon.status).toBe(403);
    expect((await json(anon)).code).toBe('account_required');
  });

  it('bridges a live native installation for exactly the four graph operations', async () => {
    const account = await insertAccount(db);
    const phone = await nativePhone(account.accountId);
    const stranger = await insertAccount(db);

    const summary = await summaryRoute(req('/v2/me/interest-graph', { bearer: phone.token }), noParams);
    expect(summary.status).toBe(200);
    expect(((await json(summary)) as { owner_account_id: string }).owner_account_id).toBe(account.accountId);

    const connection = await connectionRoute(req('/v2/me/recommendations/' + randomUUID() + '/connection', { bearer: phone.token }), idParams(randomUUID()));
    expect(connection.status).toBe(404); // owned id check, but the bridge accepted the phone

    // Mutations must name the signed-in account (the v2 native contract).
    const noAccount = await settingsRoute(
      req('/v2/me/interest-graph/settings', { method: 'PATCH', bearer: phone.token, body: { expected_revision: 0, discovery_paused: true } }),
      noParams,
    );
    expect(noAccount.status).toBe(409);
    expect((await json(noAccount)).code).toBe('account_mismatch');

    const wrongAccount = await settingsRoute(
      req('/v2/me/interest-graph/settings', {
        method: 'PATCH',
        bearer: phone.token,
        expectedAccount: stranger.accountId,
        body: { expected_revision: 0, discovery_paused: true },
      }),
      noParams,
    );
    expect(wrongAccount.status).toBe(409);
    expect((await json(wrongAccount)).code).toBe('account_mismatch');

    const paused = await settingsRoute(
      req('/v2/me/interest-graph/settings', {
        method: 'PATCH',
        bearer: phone.token,
        expectedAccount: account.accountId,
        body: { expected_revision: 0, discovery_paused: true },
      }),
      noParams,
    );
    expect(paused.status).toBe(200);
    expect(((await json(paused)) as { settings: { revision: number; discovery_paused: boolean } }).settings).toMatchObject({
      revision: 1,
      discovery_paused: true,
    });
  });

  it('an expired or revoked installation fails closed with the native error codes', async () => {
    const account = await insertAccount(db);
    for (const over of [{ revoked: true }, { expired: true }]) {
      const phone = await nativePhone(account.accountId, over);
      const res = await summaryRoute(req('/v2/me/interest-graph', { bearer: phone.token }), noParams);
      expect(res.status).toBe(401);
      expect((await json(res)).code).toBe('token_revoked');
    }
  });

  it('browser mutations require CSRF and the expected account, and typed rejections leave no writes', async () => {
    const owner = await browserOwner();
    const body = { expected_revision: 0, discovery_paused: true };
    const noCsrf = await settingsRoute(
      req('/v2/me/interest-graph/settings', { method: 'PATCH', cookie: owner.cookie, expectedAccount: owner.account.accountId, body }),
      noParams,
    );
    expect(noCsrf.status).toBe(403);
    expect((await json(noCsrf)).code).toBe('csrf_failed');

    const noExpected = await settingsRoute(req('/v2/me/interest-graph/settings', { method: 'PATCH', cookie: owner.cookie, csrf: owner.csrf, body }), noParams);
    expect(noExpected.status).toBe(409);
    expect((await json(noExpected)).code).toBe('account_mismatch');

    // Unknown mutation fields are rejected without writes.
    const unknown = await settingsRoute(
      req('/v2/me/interest-graph/settings', {
        method: 'PATCH',
        cookie: owner.cookie,
        csrf: owner.csrf,
        expectedAccount: owner.account.accountId,
        body: { ...body, account_id: randomUUID() },
      }),
      noParams,
    );
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).code).toBe('invalid_input');

    // Stale revisions are the consistent typed rejection.
    const stale = await settingsRoute(
      req('/v2/me/interest-graph/settings', {
        method: 'PATCH',
        cookie: owner.cookie,
        csrf: owner.csrf,
        expectedAccount: owner.account.accountId,
        body: { expected_revision: 5, discovery_paused: true },
      }),
      noParams,
    );
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ code: 'revision_conflict', details: { current_revision: 0 } });

    // Nothing above wrote a pause.
    const after = await summaryRoute(req('/v2/me/interest-graph', { cookie: owner.cookie, csrf: owner.csrf }), noParams);
    expect(((await json(after)) as { settings: { discovery_paused: boolean } }).settings.discovery_paused).toBe(false);
  });

  it('rejects invalid cursor bounds on the summary route', async () => {
    const owner = await browserOwner();
    for (const query of ['limit=0', 'limit=101', 'interests_cursor=zzz']) {
      const res = await summaryRoute(req('/v2/me/interest-graph', { cookie: owner.cookie, csrf: owner.csrf, query }), noParams);
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('invalid_input');
    }
  });
});

describe('operation matrices stay bounded (VAL-API-002/003)', () => {
  it('the v1 native allowlist is unchanged and does not include the new graph routes', () => {
    // The exact pre-graph v1 matrix (regression lock): the new routes never
    // broaden it, and every entry is a real v1 operation.
    expect([...NATIVE_OWNER_OPERATIONS].sort()).toEqual(
      [
        'GET /v1/onboarding/catalog',
        'GET /v1/onboarding/search',
        'POST /v1/onboarding/picks',
        'DELETE /v1/onboarding/picks/{id}',
        'PUT /v1/onboarding/exclusions',
        'POST /v1/onboarding/complete',
        'GET /v1/onboarding/state',
        'GET /v1/onboarding/seed',
        'GET /v1/taste/picks',
        'POST /v1/taste/picks',
        'DELETE /v1/taste/picks/{id}',
        'GET /v1/discoveries',
        'GET /v1/items/{id}',
        'POST /v1/items/{id}/discoveries',
        'GET /v1/captures/{id}',
        'GET /v1/collections',
        'POST /v1/collections',
        'GET /v1/collections/{id}',
        'PUT /v1/collections/{id}/items/{item_id}',
      ].sort(),
    );
    expect([...NATIVE_OWNER_V2_GRAPH_OPERATIONS].sort()).toEqual(
      [
        'GET /v2/me/interest-graph',
        'PATCH /v2/me/interest-graph/settings',
        'PATCH /v2/me/interest-graph/interests/{id}',
        'GET /v2/me/recommendations/{id}/connection',
      ].sort(),
    );
    for (const op of NATIVE_OWNER_V2_GRAPH_OPERATIONS) expect(NATIVE_OWNER_OPERATIONS.has(op)).toBe(false);
    expect(NATIVE_OWNER_OPERATIONS.has('GET /v2/me/interest-graph')).toBe(false);
  });

  it('graph routes add no MCP tools and no agent scopes', () => {
    const graphRoutes = [ROUTES.getMyInterestGraph, ROUTES.updateMyInterestGraphSettings, ROUTES.updateMyInterestGraphInterest, ROUTES.getMyRecommendationConnection];
    for (const route of graphRoutes) {
      expect(route.auth).toBe('owner');
      expect(route.scopes).toEqual([]);
      expect((route as { mcpTool?: string }).mcpTool).toBeUndefined();
    }
    // The tool catalogue is the pre-graph one: no graph/control/proof tools.
    expect(TOOLS.some((t) => /graph|interest_graph|connection/i.test(t.name))).toBe(false);
  });
});

describe('old client decoders stay compatible (VAL-API-003)', () => {
  /**
   * The exact wire fields the old Android/Kotlin client decodes
   * (apps/android/core/.../contract/LibraryModels.kt, `ignoreUnknownKeys = true`
   * so additive server fields are safe but REMOVED fields break it). The Swift
   * decoders read the same fixtures/native-contract messages and ignore unknown
   * keys too. This locks the server response schemas to keep every declared
   * field: compatibility only, no Android build is run.
   */
  const DECODER_FIELDS = {
    DiscoveriesResponse: ['items', 'next_cursor', 'feed_id', 'feed_revision', 'is_example_feed', 'available_categories', 'expansion'],
    DiscoveryCard: ['id', 'kind', 'category', 'title', 'subtitle', 'image', 'is_example', 'saved', 'saved_item_id', 'recommendation_id', 'evidence_available'],
    FeedExpansion: ['state', 'poll_after_ms'],
    CollectionsListResponse: ['collections', 'unfiled'],
    CollectionsUnfiled: ['item_count', 'cover'],
    CollectionSummary: ['id', 'name', 'description', 'item_count', 'cover', 'revision', 'created_at', 'updated_at'],
    CollectionDetailResponse: ['collection', 'items', 'next_cursor', 'available_filters'],
    CollectionMember: ['membership_id', 'saved_item_id', 'position', 'added_at', 'item'],
    AddCollectionItemResponse: ['collection_id', 'membership_id', 'saved_item_id', 'collection_revision', 'created', 'saved'],
    ItemDetailResponse: ['item', 'description', 'detail', 'reason', 'why_this', 'destination_url', 'references', 'related', 'related_state', 'related_job_id', 'collection_ids', 'capture_id'],
    ItemWhyThis: ['text', 'sources'],
    ItemSource: ['id', 'url', 'title', 'publisher', 'retrieved_at'],
    ItemReference: ['id', 'name', 'type', 'relation', 'qualified', 'has_page', 'read_text'],
    RelatedDiscoveryResponse: ['job_id', 'discovery_job_id', 'reused'],
  } satisfies Record<string, readonly string[]>;

  type Node = { properties?: Record<string, Node>; anyOf?: Node[]; items?: Node; type?: string };
  const outputJsonSchema = (schema: z.ZodType): Node =>
    z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Node;
  /** First descendant of the node that lists properties (unwraps nullable/array wrappers). */
  const shapeOf = (node: Node | undefined): Record<string, Node> => {
    if (!node) return {};
    if (node.properties) return node.properties;
    if (node.anyOf) {
      for (const branch of node.anyOf) {
        const found = shapeOf(branch);
        if (Object.keys(found).length) return found;
      }
    }
    if (node.items) return shapeOf(node.items);
    return {};
  };
  const fieldsOf = (node: Node | undefined) => Object.keys(shapeOf(node));

  it('the server still emits every field the old decoders declare (compatibility only, no Android build)', () => {
    const serverSurface = {
      DiscoveriesResponse: outputJsonSchema(schemas.DiscoveriesResponse),
      CollectionsListResponse: outputJsonSchema(schemas.CollectionsListResponse),
      CollectionDetailResponse: outputJsonSchema(schemas.CollectionDetailResponse),
      AddCollectionItemResponse: outputJsonSchema(schemas.AddCollectionItemResponse),
      ItemDetailResponse: outputJsonSchema(schemas.ItemDetailResponse),
      RelatedDiscoveryResponse: outputJsonSchema(schemas.RelatedDiscoveryResponse),
    } satisfies Record<string, Node>;
    const decoderFields = DECODER_FIELDS as Record<string, readonly string[]>;
    // Top-level decoder fields per surface.
    for (const [name, node] of Object.entries(serverSurface) as Array<[keyof typeof serverSurface, Node]>) {
      const properties = fieldsOf(node);
      for (const field of decoderFields[name] ?? []) {
        expect(properties, `${name}.${field} must stay in the server response`).toContain(field);
      }
    }
    // Nested decoder shapes the old clients also decode.
    const item = shapeOf(serverSurface.ItemDetailResponse.properties?.item);
    for (const field of DECODER_FIELDS.DiscoveryCard) expect(Object.keys(item), `DiscoveryCard.${field}`).toContain(field);
    const why = shapeOf(serverSurface.ItemDetailResponse.properties?.why_this);
    for (const field of DECODER_FIELDS.ItemWhyThis) expect(Object.keys(why), `ItemWhyThis.${field}`).toContain(field);
    for (const field of DECODER_FIELDS.ItemSource) expect(fieldsOf(why.sources), `ItemSource.${field}`).toContain(field);
    const collection = shapeOf(serverSurface.CollectionDetailResponse.properties?.collection);
    for (const field of DECODER_FIELDS.CollectionSummary) expect(Object.keys(collection), `CollectionSummary.${field}`).toContain(field);
    const member = shapeOf(serverSurface.CollectionDetailResponse.properties?.items);
    for (const field of DECODER_FIELDS.CollectionMember) expect(Object.keys(member), `CollectionMember.${field}`).toContain(field);
    for (const field of DECODER_FIELDS.CollectionsUnfiled)
      expect(fieldsOf(serverSurface.CollectionsListResponse.properties?.unfiled), `CollectionsUnfiled.${field}`).toContain(field);
    for (const field of DECODER_FIELDS.FeedExpansion)
      expect(fieldsOf(serverSurface.DiscoveriesResponse.properties?.expansion), `FeedExpansion.${field}`).toContain(field);
    for (const field of DECODER_FIELDS.ItemReference)
      expect(fieldsOf(serverSurface.ItemDetailResponse.properties?.references), `ItemReference.${field}`).toContain(field);
    // The card image shape (LibraryImage).
    for (const field of ['url', 'width', 'height', 'alt']) expect(fieldsOf(item.image), `LibraryImage.${field}`).toContain(field);
  });

  it('the new graph response schemas tolerate additive fields the way old decoders do', () => {
    const summary = {
      owner_account_id: randomUUID(),
      settings: { revision: 0, discovery_paused: false, paused_at: null },
      projection: {
        state: 'never_projected',
        support_version: 0,
        target_taste_revision: 0,
        applied_taste_revision: 0,
        current_taste_revision: 0,
        lagging: false,
        pending_events: 0,
        last_projected_at: null,
      },
      counts: { confirmed: 0, tentative: 0, suppressed: 0 },
      interests: { items: [], next_cursor: null },
      tentative: { items: [], next_cursor: null },
    };
    // A future additive field must not break the client decoder contract.
    expect(schemas.InterestGraphSummaryResponse.safeParse({ ...summary, future_field: 'ok' }).success).toBe(true);
    const settings = { settings: { revision: 1, discovery_paused: true, paused_at: '2026-10-29T00:00:00Z' } };
    expect(schemas.UpdateInterestGraphSettingsResponse.safeParse({ ...settings, extra: 1 }).success).toBe(true);
  });
});


