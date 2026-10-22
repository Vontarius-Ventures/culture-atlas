# Collection sharing and agent media (capture platform v2, packages 5–6)

Authority: `specs/capture-platform-v2/AGENTS-AND-SHARING.md`. This page describes what the code in this tree does. API reference: `docs/api/agent-platform.openapi.json` (OpenAPI 3.1, generated), JSON schemas in `docs/api/schemas/`, examples in `docs/api/examples/`, MCP tool catalog `docs/api/agent-tools-v2.json` (catalog version 2.1.1). Regenerate the generated files with `pnpm exec tsx scripts/generate-agent-contract.ts`; `scripts/generate-agent-contract.test.ts` fails when they drift.

## Sharing model

| Piece | Where |
| --- | --- |
| Tables `collection_shares`, `collection_share_members`, `share_invites`, `share_sessions`, `share_redeem_windows`, `audit_events` | `db/migrations/090_collection_sharing.sql` |
| Owner and viewer services | `packages/domain/src/services/collection-shares.ts` |
| ShareProjection (what a viewer may see) and the media segment rules | `packages/domain/src/sharing/projection.ts` |
| Owner routes (`apiRoute`, owner browser session only) | `apps/web/app/v2/collections/[id]/shares`, `apps/web/app/v2/shares/[id]`, `.../invitations`, `apps/web/app/v2/share-invitations/accept` |
| Viewer routes (share session adapter) | `apps/web/lib/server/share-http.ts`, `apps/web/app/v2/shared/*` |
| Screens 12 and 13 | `apps/web/components/views/ShareCollectionView.tsx`, `SharedCollectionView.tsx` |

- **Owner only.** Creating, changing, inviting and revoking require the account owner in the browser. Agents (any scope), installations, other accounts and share viewers get `403 scope_denied` or an indistinguishable `404`. No MCP tool touches sharing.
- **Restricted (default).** One live restricted audience per collection. `POST /v2/shares/{id}/invitations` stores only an HMAC of the normalized address and a hash of a 256-bit token; the response is identical for every address and never looks up accounts. The owner delivers `…/shared/invite#invite=csi_…` themselves. Acceptance requires a signed-in account whose **verified** email (`account_emails`) matches exactly; every failure is the same 404. Invitations expire after 7 days and are single use.
- **Anyone with the link.** Requires `confirm_policy: true`; expiry 1, 7 (default) or 30 days. The 256-bit secret is returned once inside the URL fragment (`/shared#share=cas_…`), so browsers never send it to the server or in a Referer. The viewer page POSTs it to `/v2/shared/redeem`, removes the fragment from history, and receives a fresh session token in an `HttpOnly; SameSite=Strict; Path=/v2/shared` cookie (`Secure` over HTTPS). Redemption is limited to 10 attempts per address per minute plus a daily address cap, and answers invalid, expired and revoked secrets identically. Link secrets are never accepted as agent credentials.
- **Policy changes.** `PATCH /v2/shares/{id}` needs `If-Match: "<policy_version>"` (428 without, 412 when stale). Narrowing applies immediately. Broadening (include media, allow originals, later expiry) returns `409` with `details.broadening` and, for media, `details.would_include` (the exact items that would become visible) until the owner resends with `confirm_broaden: true`.
- **Revocation.** `DELETE /v2/shares/{id}` revokes the share, its sessions and pending invitations in one transaction. Deleting a collection fires a trigger that revokes every share, invitation and session of that collection in the same transaction and keeps audit rows. Revoking one share leaves other shares intact.
- **Audit.** `audit_events` records share creation, narrowing/broadening, revocation (including by collection deletion), invitation creation/acceptance and original downloads. No token, email or media is stored there.

## What a viewer sees (ShareProjection)

A positive projection, re-read on every request: collection title and description, the owner's chosen display name, and for each non-capture discovery: kind, category, title, subtitle, public description, detail, a public `https://` or `/samples/` image only, an `https://` destination only, the "Example result" flag and whether it is a public catalog reference. Never included: recommendation reasons, evidence, traces, taste, private stored images, capture items, media titles, device/source provenance, coordinates, EXIF, transcripts, analysis output or anything from other collections. Payloads are capped at 100 discoveries and 100 media items (`truncated`).

Captured photos and videos appear only when the owner turned on "Include captured photos and videos", and then only media currently in this collection, `ready`, not hidden or deleted, with a **share-safe** derivative (`media_derivatives.share_safe`, written only by the qualified preparer). Originals additionally need "Allow original downloads" and are audited.

## Recipient media gateway

`GET /v2/shared/media/{id}/{poster|playback|original}` re-checks the session or membership, the share's state and policy, and the item's current collection membership on **every** request. Each response is one segment of at most about 30 seconds of the stream (bytes ∝ duration, never more than 8 MiB), so a client fetches playback range by range and a revocation denies the next range. Responses carry `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and `X-Robots-Tag: noindex`. Already delivered bytes cannot be recalled.

## Agent media and commands (package 5 wiring)

- **G5:** `packages/domain/src/authz/capture-agent-authorization.ts` is the production `CaptureAgentAuthorization`. It is the default fence for every capture-v2 agent checkpoint (HTTP, MCP and the media worker's queued work), re-reading the connection, scopes, collection grant, selected installations and authorization version each time.
- **G6:** `/mcp` passes a live capture context to media tools (`apps/web/app/mcp/route.ts`).
- **G7:** bearer `cat_` requests to `/v2/library`, `/v2/media/{id}`, `/v2/media/{id}/analysis`, `/v2/uploads/**` and the `/v2/agent-media/{id}/content/{variant}` preview links are served by `apps/web/lib/server/agent-media-http.ts` with the same services as MCP. Device, capability and owner library management stay closed to agents.
- **`analyze_media`** (MCP) / `POST /v2/media/{id}/analysis` (REST): explicit, requires `media:analyze` on media inside the live grant; queued work is fenced to the connection's authorization version; agents get no result links and poll `get_operation` (kind `analysis`).
- **Phone-side delivery:** `GET /v2/device/commands` (bounded long poll, re-authorized each claim) and `POST /v2/device/commands/{id}/ack`, for enrolled installation sessions (`cna_…`) only. Production runtime registers `resolveNativePrincipal` and the capture identity adapter (`docs/native.md`).

## Not done here

- Per-account and per-endpoint agent budgets beyond the per-connection 60 reads / 10 mutations per minute.
- Push of revocation to open viewer pages: the viewer re-checks every 60 seconds and when the tab becomes visible, and every media range is re-authorized.
- Real-device and multi-network trials (TEN-01) and native clients.
