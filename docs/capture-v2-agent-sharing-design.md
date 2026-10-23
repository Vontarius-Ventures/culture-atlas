# Agent and sharing design study

Screens 10–13 in `specs/capture-platform-v2/design/index.html` govern this work.
The shared visual language is ivory, olive, serif headings and simple outlined
panels. Controls remain real labels, checkboxes, selects and buttons, wrapping at
320px. Permissions use readable verbs; technical scope strings are secondary.

## Agent consent

- `/settings/agents`: named connections, readable access summary, expiry, last
  use, owner activity, deliberate rotation and named revocation confirmation.
- `/settings/agents/new`: setup/preferences only by default; no library or camera
  permission. Collection and device grants are separate explicit selections.
- A successful personal connection shows a selectable secret once, never writes
  it to local storage, copies it automatically or exposes it in a URL.
- Permission edits can narrow grants. Widening starts a new consent transaction.
  Local capture permission remains a phone action, never a preference write.
- Preferences expose user-set and effective allowlisted values. Strong If-Match
  prevents stale agents overwriting a newer user or agent change.

## Collection sharing

- Share starts Restricted. Invites use exact verified email, not an account
  lookup that reveals registration. The owner delivers invitation links.
- Link access requires explicit confirmation; media and originals default off.
  Include-media disclosure previews the actual collection policy. Live additions
  and removals follow this policy; another collection never joins the grant.
- Viewer is standalone and view-only, without private navigation. Empty,
  expired and revoked states contain no old title, image or item data.
- Fragment secrets are exchanged into a short HttpOnly share session and removed
  from history. Viewer pages have no third-party scripts, no-store, noindex and
  no-referrer protection.

## Policy boundaries

`AgentAuthorization` re-reads grants on v2 calls and async checkpoints. Existing
v1 scopes retain their meaning; no migration adds scopes to credentials.
`ShareProjection` constructs output from an allowlist, never serializes a private
card and removes fields afterward. Shared bytes use recipient checks per range,
not an owner read URL. Share tokens are not account or agent credentials.

OAuth uses pre-registered exact redirects, authorization code with PKCE S256,
client state round-trip, resource audience binding, single-use 60s codes,
10-minute access and rotating refresh families (30-day idle/90-day absolute).
Refresh reuse commits family revocation even though the exchange returns failure.
MCP protected-resource discovery and the Bearer resource_metadata challenge follow
the official 2026-07-28 authorization specification, checked October 15, 2026:
https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization

No physical-device, provider qualification or public OAuth-client interoperability
claim follows from unit tests alone.
