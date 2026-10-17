/**
 * Contract-validated in-memory mock of the /v2 agent and sharing routes for
 * screens 10–13. Every JSON response is parsed with the shared ROUTES response
 * schema, so the UI is exercised against the real contract. Data mirrors the
 * illustrative values of the HTML mockups (design/index.html sections 10–13).
 * Not provider data; no credential here is real.
 */
import type { Page, Route } from '@playwright/test';
import { ROUTES, type RouteName } from '@culture-atlas/domain/schemas';
import type { AgentConnectionDto, ShareDto, SharedCollectionResponse } from '@culture-atlas/domain/schemas';

const now = () => new Date().toISOString();
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
let counter = 0x900;
const uid = () => `00000000-0000-4000-9000-${(++counter).toString(16).padStart(12, '0')}`;
const meta = () => ({ schema_version: '2.1' as const, request_id: uid() });

export interface AgentsSharingOptions {
  /** Seed the mockup's "My research assistant" connection and its activity. */
  seedAgent?: boolean;
  /** Collection id/name used by the share sheet and the agent card. */
  collection?: { id: string; name: string };
  /** Shared-view state for /shared. */
  shared?: 'none' | 'link' | 'revoked' | 'media';
}

export class AgentsSharingMock {
  connections: AgentConnectionDto[] = [];
  activity: Array<{ id: string; connection_id: string; client_name: string; action: string; target_id: string | null; target_label: string | null; created_at: string }> = [];
  shares: ShareDto[] = [];
  redeemed = false;
  revokedViews = 0;
  requests: string[] = [];

  constructor(readonly opts: AgentsSharingOptions) {
    if (opts.seedAgent) {
      const id = uid();
      const today = (h: number, m: number) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
      this.connections.push({
        id, client_name: 'My research assistant', scopes: ['setup:read', 'preferences:read'], library_access: 'selected_collections',
        collection_ids: opts.collection ? [opts.collection.id] : [], installation_ids: [], authorization_version: 1,
        credential_prefix: 'cat_1a2b3c4d_…', created_at: days(-6), expires_at: new Date(Date.now() + 23.6 * 86_400_000).toISOString(),
        revoked_at: null, last_used_at: today(10, 43), status: 'active',
        access_summary: { reads: ['Your safe device setup and observed capabilities'], writes: [], limits: [] },
      });
      this.activity.push(
        { id: uid(), connection_id: id, client_name: 'My research assistant', action: 'collection.read', target_id: opts.collection?.id ?? null, target_label: opts.collection?.name ?? null, created_at: today(10, 43) },
        { id: uid(), connection_id: id, client_name: 'My research assistant', action: 'preferences.read', target_id: null, target_label: null, created_at: today(10, 42) },
      );
    }
  }

  private json(route: Route, name: RouteName, body: unknown, status?: number) {
    const contract = ROUTES[name];
    const parsed = contract.response ? (contract.response as { parse(v: unknown): unknown }).parse(body) : undefined;
    return route.fulfill({
      status: status ?? contract.status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
      body: parsed === undefined ? '' : JSON.stringify(parsed),
    });
  }

  private error(route: Route, status: number, code: string, message: string, details?: unknown) {
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, message, retryable: false, request_id: uid(), details } }) });
  }

  private sharedView(): SharedCollectionResponse {
    const share = this.shares.find((s) => s.audience === 'link' && s.status === 'active');
    const includeMedia = this.opts.shared === 'media';
    return {
      ...meta(),
      share: { id: share?.id ?? uid(), audience: 'link', view_only: true, include_media: includeMedia, allow_originals: false, expires_at: days(7), policy_version: 1 },
      collection: { title: 'Quiet weekends', description: 'A few things for slower days.', owner_display_name: 'Alex' },
      discoveries: [
        { id: uid(), kind: 'reference', category: null, title: 'A neighborhood gallery', subtitle: null, description: 'Art, small exhibitions and an afternoon nearby.', detail: null, image: null, destination_url: null, is_example: false, saveable: true },
        { id: uid(), kind: 'track', category: 'play', title: 'Sunday listening', subtitle: null, description: 'Records to spend a little time with.', detail: null, image: null, destination_url: null, is_example: false, saveable: true },
      ],
      media: includeMedia ? [{ id: uid(), kind: 'photo', width: 1200, height: 900, duration_ms: null, poster_url: null, playback_url: '/samples/cafe.jpg', original_url: null }] : [],
      truncated: false,
    };
  }

  async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    this.requests.push(`${method} ${path}`);
    const body = () => (request.postData() ? JSON.parse(request.postData()!) : {});
    let m: RegExpExecArray | null;

    if (path === '/v2/agent-connections' && method === 'GET') return this.json(route, 'listConnectionsV2', { ...meta(), connections: this.connections });
    if (path === '/v2/agent-connections' && method === 'POST') {
      const b = ROUTES.createConnectionV2.body.parse(body());
      const connection: AgentConnectionDto = {
        id: uid(), client_name: b.client_name, scopes: b.scopes, library_access: b.library_access, collection_ids: b.collection_ids,
        installation_ids: b.installation_ids, authorization_version: 1, credential_prefix: 'cat_5e6f7a8b_…', created_at: now(),
        expires_at: days(b.expires_in_days), revoked_at: null, last_used_at: null, status: 'active',
        access_summary: { reads: [], writes: [], limits: [] },
      };
      this.connections.unshift(connection);
      return this.json(route, 'createConnectionV2', {
        ...meta(), connection, credential: 'cat_5e6f7a8b_EXAMPLE-ONLY-NOT-A-REAL-CREDENTIAL-0000000000', mcp_url: 'https://your-atlas.example/mcp',
      });
    }
    if ((m = /^\/v2\/agent-connections\/([^/]+)\/rotate$/.exec(path)) && method === 'POST') {
      return this.json(route, 'rotateConnectionV2', { ...meta(), credential: 'cat_9c8d7e6f_EXAMPLE-ONLY-ROTATED-NOT-REAL-000000000000' });
    }
    if ((m = /^\/v2\/agent-connections\/([^/]+)$/.exec(path))) {
      const c = this.connections.find((x) => x.id === m![1]);
      if (!c) return this.error(route, 404, 'not_found', 'Not found.');
      if (method === 'DELETE') {
        c.status = 'revoked';
        c.revoked_at = now();
        return route.fulfill({ status: 204, body: '' });
      }
      if (method === 'PATCH') {
        const b = ROUTES.narrowConnectionV2.body.parse(body());
        if (b.scopes) c.scopes = b.scopes;
        if (b.collection_ids) c.collection_ids = b.collection_ids;
        c.authorization_version = (c.authorization_version ?? 1) + 1;
        return this.json(route, 'narrowConnectionV2', { ...meta(), connection: c });
      }
    }
    if (path === '/v2/agent-activity' && method === 'GET') return this.json(route, 'agentActivity', { ...meta(), items: this.activity, next_cursor: null });
    if (path === '/v2/devices' && method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], next_cursor: null }) });

    if ((m = /^\/v2\/collections\/([^/]+)\/shares$/.exec(path))) {
      const collectionId = m[1]!;
      if (method === 'GET') return this.json(route, 'listShares', { ...meta(), shares: this.shares.filter((s) => s.collection_id === collectionId) });
      const b = ROUTES.createShare.body.parse(body());
      if (b.audience === 'link' && !b.confirm_policy) return this.error(route, 409, 'conflict', 'Confirm link access.', { confirmation_required: true });
      const share: ShareDto = {
        id: uid(), collection_id: collectionId, audience: b.audience, status: 'active', include_media: b.include_media,
        allow_originals: b.allow_originals, expires_at: b.audience === 'link' ? days(b.expires_in_days ?? 7) : null, revoked_at: null,
        policy_version: 1, created_at: now(), members: [], invitations: [],
      };
      this.shares.unshift(share);
      return this.json(route, 'createShare', {
        ...meta(), share, link: b.audience === 'link' ? 'https://your-atlas.example/shared#share=cas_EXAMPLEONLY_EXAMPLEONLY_EXAMPLEONLY_EXAMPLE' : null,
      });
    }
    if ((m = /^\/v2\/shares\/([^/]+)\/invitations$/.exec(path)) && method === 'POST') {
      const share = this.shares.find((s) => s.id === m![1]);
      if (!share) return this.error(route, 404, 'not_found', 'Not found.');
      const invitation = { id: uid(), status: 'pending' as const, expires_at: days(7), created_at: now() };
      share.invitations.unshift(invitation);
      return this.json(route, 'createShareInvitation', { ...meta(), invitation, link: 'https://your-atlas.example/shared/invite#invite=csi_EXAMPLEONLY_EXAMPLEONLY_EXAMPLEONLY_EXAMPLE' });
    }
    if ((m = /^\/v2\/shares\/([^/]+)$/.exec(path))) {
      const share = this.shares.find((s) => s.id === m![1]);
      if (!share) return this.error(route, 404, 'not_found', 'Not found.');
      if (method === 'DELETE') {
        share.status = 'revoked';
        share.revoked_at = now();
        return route.fulfill({ status: 204, body: '' });
      }
      const b = ROUTES.updateShare.body.parse(body());
      if (request.headers()['if-match'] !== `"${share.policy_version}"`) return this.error(route, 412, 'precondition_failed', 'Sharing settings changed. Reload before saving.');
      const broadening = [b.include_media && !share.include_media ? 'include_media' : null, b.allow_originals && !share.allow_originals ? 'allow_originals' : null].filter(Boolean);
      if (broadening.length && !b.confirm_broaden) {
        return this.error(route, 409, 'conflict', 'Confirm the broader sharing settings.', {
          confirmation_required: true, broadening,
          would_include: broadening.includes('include_media') ? [{ id: uid(), kind: 'video', title: 'Morning walk' }, { id: uid(), kind: 'photo', title: null }] : undefined,
        });
      }
      share.include_media = b.include_media ?? share.include_media;
      share.allow_originals = share.include_media ? (b.allow_originals ?? share.allow_originals) : false;
      share.policy_version += 1;
      return this.json(route, 'updateShare', { ...meta(), share });
    }
    if (path === '/v2/shared/redeem' && method === 'POST') {
      if (this.opts.shared === 'revoked') return this.error(route, 404, 'not_found', 'This collection is no longer shared.');
      this.redeemed = true;
      return this.json(route, 'redeemShare', { ...meta(), share_id: uid(), expires_at: days(1) });
    }
    if (path === '/v2/shared/collection' && method === 'GET') {
      if (this.opts.shared === 'revoked' || this.opts.shared === 'none') return this.error(route, 404, 'not_found', 'This collection is no longer shared.');
      return this.json(route, 'getSharedCollection', this.sharedView());
    }
    return this.error(route, 404, 'not_found', `Unmocked ${method} ${path}`);
  }
}

export async function installAgentsSharingMock(page: Page, opts: AgentsSharingOptions = {}): Promise<AgentsSharingMock> {
  const mock = new AgentsSharingMock(opts);
  await page.route(/\/v2\/(agent-connections|agent-activity|devices|collections\/[^/]+\/shares|shares|shared|share-invitations)/, (route) => mock.handle(route));
  return mock;
}
