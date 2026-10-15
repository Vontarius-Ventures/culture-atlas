# Agent access and collection sharing

Version 2.1 · October 15, 2026 · Required build scope.

Every account can authorize its own agents to inspect permitted setup and preferences and act through the same domain services as the first-party apps. A connection is always bound to one account. An agent cannot enumerate users, inherit the operator's account, or grant itself permissions. Collection sharing is a separate, read-only audience grant; it never conveys device or agent control.

## Extend the existing foundation

Reuse `packages/domain/src/services/agent-connections.ts`, its hashed credentials, selected-collection grants, live revocation checks, and `agent-privacy.test.ts`. Preserve existing v1 scopes and behavior. Add explicit v2 scopes; existing credentials receive none automatically. Avoid a second authorization system. REST is the authoritative API; a thin remote MCP adapter exposes the same operations and authorization checks. Publish an OpenAPI 3.1 document, JSON schemas, examples, and a versioned tool catalog as implementation deliverables.

## Permissions and resource boundaries

| Scope | Permitted action | Additional restriction |
|---|---|---|
| setup:read | App capabilities, registered device aliases, connectivity, eligible sources, permission summaries | No hardware serials, push tokens, Meta credentials, network addresses, or precise location |
| preferences:read | Explicit account preferences, capture defaults and analysis consent choices | Taste profile remains separately protected by taste:read |
| preferences:write | Change allowlisted ordinary preferences | Cannot enable microphone, remote arming, sharing, automatic analysis, or expand grants |
| media:read | List metadata and preview/play authorized media | Same selected collection boundary; no originals |
| media:download | Download authorized originals | Explicit additional grant and audited access |
| media:write | Create uploads and manage agent-created drafts | No arbitrary remote URL fetching; upload bytes through signed intake |
| media:analyze | Request analysis of authorized media | Consent, daily quota and spend limits enforced |
| devices:command | Request capture on selected installations | Fresh local arming plus all device eligibility checks |
| collections:read | Read granted collection items | No unrelated capture reasons or private annotations |
| collections:write | Add/remove authorized items from granted collections | Cannot create public access or move inaccessible media into a grant |
| plans:read / plans:write | Existing plan operations | Existing account/resource filtering retained |

Default new connection: setup:read and preferences:read only, no media access. Library choices: None, Selected collections, Entire library. Scopes, collection IDs and selected installation IDs are intersected on every call. For selected collections, newly created collections are never included automatically; newly added items in an explicitly granted collection become visible, disclosed during consent. Removing an item removes access unless another permitted collection grants it. Uploads by selected-collection agents must name an allowed destination; absent destination is rejected. Scope upgrades require the account owner in the first-party app. Account defaults exposed in responses are marked effective versus user-set; permission summaries are observations, never a way to grant OS access.

## Connection lifecycle

Ship owner-created personal agent credentials first: Settings → Agents → Connect agent → name, permissions, resources, expiry → Connect. Show the secret once; persist only its hash and non-secret prefix. Default expiry 30 days, maximum 90; rotate atomically with no implicit overlapping credential. Never put tokens in URLs, analytics, clipboard automatically, or example files. An account-scoped setup endpoint replaces requests for an arbitrary user ID.

For third-party agent apps, implement OAuth authorization code with PKCE S256, exact pre-registered redirects, state checking, short single-use authorization codes, 10-minute access tokens and rotating refresh tokens (30-day idle/90-day absolute expiry). Refresh reuse revokes the token family. The owner reviews the same scopes and resource restrictions. Do not offer public client-credentials access to user accounts. MCP authentication must use the supported protocol authorization contract at implementation time, verified against its official specification; it must not accept a share link as a credential. The API-token path works independently of MCP/OAuth rollout.

Revocation immediately blocks subsequent API/tool calls, refresh and event subscriptions; queued jobs recheck before external dispatch and result publication. Already dispatched inference may finish and incur cost, but cannot restore access. Previously downloaded bytes cannot be recalled. Device commands from a revoked connection that have not executed must be rejected on the next claim; the phone checks the command authorization version before acting.

## API contract

All routes below are proposed additions under `/v2`. Bearer auth is required except explicit share redemption. Owner identity comes exclusively from the verified principal. Responses include request_id and schema_version. Setup carries observed_at, last_seen_at, capability reasons and stale status; disconnected devices never appear ready. Never return secrets or complete internal configuration.

| Method and route | Contract |
|---|---|
| GET /v2/me/setup | Current account's permitted source capabilities, installation aliases, app versions, experimental eligibility and available actions |
| GET /v2/me/preferences | Allowlisted preferences plus version and effective values |
| PATCH /v2/me/preferences | Require If-Match version; atomic allowlisted patch; 412 on conflict |
| GET /v2/agent-connections | Owner-only connection list, access summary, expiry, last use |
| POST /v2/agent-connections | Owner-only credential creation with explicit scopes and resource IDs |
| PATCH /v2/agent-connections/{id} | Owner-only narrowing/expiry update; widening requires a new consent transaction |
| POST /v2/agent-connections/{id}/rotate | Owner-only rotate, secret shown once |
| DELETE /v2/agent-connections/{id} | Owner-only revoke |
| POST /v2/devices/{id}/commands | Scoped command, Idempotency-Key, explicit action/duration, active arming session |
| GET /v2/operations/{id} | Authorized asynchronous upload/analysis/command outcome |
| GET /v2/events | Scoped resumable events with opaque cursor; recheck grant every batch |

Media/upload/collection routes reuse BACKEND-CONTRACTS and existing collection services. Scope failures return 403 with missing_permission but no inaccessible resource details; cross-account IDs return indistinguishable 404. Bad/expired credentials return 401. Rate limit 60 reads/minute and 10 mutations/minute per connection, additionally account and endpoint budgets; respond 429 with Retry-After. Pagination defaults 50, max100. SSE retention 24h; expired cursor returns 410 with resync instruction. Event payloads include only IDs/status permitted by the current grant, never signed media URLs. Connections cannot manage other connections. No arbitrary SQL, shell, URL fetch, or hidden UI automation tools.

MCP tools map one-to-one to domain operations: get_setup, get_preferences, update_preferences, list_media, get_media, begin_upload, complete_upload, analyze_media, list_collections, get_collection, add_collection_item, remove_collection_item, request_capture, get_operation. `request_capture` requires an explicit selected device and fresh arming ID; a model cannot arm a phone remotely. Tool text and captured content are untrusted data and cannot change scopes. No tool creates or broadens a share grant in v2.

## Capture controls for agents

A user enables “Allow remote capture for 10 minutes” on the actual phone, chooses permitted agents and photo/video (video capped at 60 seconds), and sees a persistent indicator with Stop access. Default off. Arming is device/session/agent scoped, expires on logout, account switch, disconnect, revocation or time limit. Microphone remains off unless the local user separately consents to a qualified audio source. Device commands are requests, not guarantees of background camera access. Expired or uncertain requests are not automatically reissued. Stop capture is allowed for the initiating authorized agent while its active capture exists; the local user always has stop priority. Consent and outcomes appear in device and account activity histories without storing image content in logs.

## Collection sharing product contract

Collections remain private by default. Owner taps Share → Restricted (default) or Anyone with the link. Restricted sharing invites existing accounts by verified email, read-only; owner copies an invitation link to deliver themselves. No automatic email service is required for v2. Unknown recipients can register and verify that exact email before acceptance. Invitation expires in 7 days and reveals no collection content before acceptance. The API must give uniform invitation responses to avoid email-account enumeration.

Anyone-with-link is an explicit bearer audience, view-only, default expiry7days, selectable1/7/30days; never publicly indexed. Show “Anyone with this link can view the items you include.” Download originals defaults off. Owner chooses “Include captured photos and videos” (off by default). When off, show only selected discovery cards, public descriptions and the owner's collection title/description. Private media-derived recommendations must use a public-safe summary, never private reasoning, location, transcripts, EXIF, or device provenance. When on, only sanitized preview/playback derivatives for captured items currently in this collection are visible. Original download requires an additional explicit option; neither option changes other collections or user preferences. No editing, contribution, re-sharing authority, account setup or taste export in v2.

Shares are live views: additions become visible under the selected policy, removals disappear. Clearly disclose this in the share sheet. Same asset in another private collection does not reveal that collection. Revoking one share leaves other intentional grants intact. Deleting a collection revokes all its shares and invitations transactionally. Owner may rename a collection; public-safe name changes appear live. Shared cards have Open details and optional Save to my collection, which copies public catalog references only; private media cannot be silently copied. Shared videos use a recipient-authorized range-streaming endpoint.

## Sharing storage and transport

Add collection_shares(id, owner_account_id, collection_id, audience, token_hash, expires_at, revoked_at, include_media, allow_originals, policy_version), collection_share_members(share_id, verified_account_id, role=viewer), share_invites(id, share_id, normalized_email_hash, token_hash, expires_at, accepted_at), and audit_events. Tenant composite constraints match other tables. Bearer secrets use at least 256 bits of cryptographic randomness, store only hashes, redact logs. Use a URL fragment token exchanged via POST into a Secure HttpOnly SameSite session; remove fragment from browser history after exchange. Set Referrer-Policy:no-referrer, Cache-Control:no-store, noindex headers and no third-party scripts on redemption/viewer pages. This limits accidental leakage but does not prevent a recipient forwarding a bearer link.

| Method and route | Authorization and result |
|---|---|
| GET/POST /v2/collections/{id}/shares | Owner-only list/create with policy and expiration |
| PATCH /v2/shares/{id} | Owner-only narrow/change policy with If-Match; broadening requires explicit confirmation |
| DELETE /v2/shares/{id} | Owner-only revoke, invalidate sessions immediately |
| POST /v2/shares/{id}/invitations | Owner creates recipient invitation |
| POST /v2/share-invitations/accept | Logged-in verified recipient plus one-use token |
| POST /v2/shared/redeem | Rate-limited bearer exchange, generic invalid/expired response |
| GET /v2/shared/collection | Share session plus current grant/policy check |
| GET /v2/shared/media/{id} | Check collection membership and current policy on every request/range |

Do not give shared viewers ordinary owner-signed S3 URLs lasting5minutes. Proxy private derivatives with a grant check per request and at most30-second authorized playback segments; close active streams on revocation where feasible. Already delivered bytes cannot be revoked; no promise to erase screenshots/downloads. Remove shared content from client memory on an observed revocation event. Limit redemption attempts and collection payload sizes; audit create/change/revoke and original downloads. Public-link tokens never authorize agent endpoints.

## Acceptance additions

Agent A cannot read user B's setup, change security consent, view an ungranted capture, query other connections or execute against an unselected device. Narrowing applies to pagination, detail, search, events, queued jobs and media reads. A failed If-Match cannot overwrite newer preferences. Capture without local arming returns a typed action_required response, not a simulated success. Share revoked during playback denies the next range/segment. Removed items and private reasoning vanish from all shared projections. Restricted invitation acceptance requires the exact verified recipient. Token rotation invalidates the former secret. Existing agent permissions remain unchanged after migration. Two independent users can connect different agents and share selected collections without founder infrastructure.
