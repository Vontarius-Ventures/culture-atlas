# Screens and interaction contract

> Audio scope is extended by [amendment2.3](AUDIO-AND-MULTIMODAL.md): standalone audio, Music Mode, soundtrack/evidence analysis, provider qualification, new permissions and safe sharing migration. This amendment takes precedence for audio; other behavior is unchanged.

The gallery contains nine visual capture references and four editable interface mockups covering agent and sharing additions. These are design references, not implemented application screens. Written contracts and exact copy take precedence over generated lettering or incidental layout differences.

## Layout and navigation

Desktop: 1440px reference, centered content max1200px, 32px gutters, 24px gaps, header72px. Mobile: 390px reference, 20px gutters, safe-area padding and 44px minimum controls. Four navigation destinations: Discover, Library, Collections, Plans. Capture is a separate primary action; Settings is secondary. Mobile capture screens suppress bottom navigation while recording. At320px all controls wrap without horizontal scrolling. Keyboard focus is visible; status changes use polite live regions; errors retain focus context. Reduced motion disables decorative transitions. Never communicate recording or upload state by color alone.

Warm ivory background, dark ink, olive actions, serif headings and sans-serif controls extend v1. Photos retain natural colors. Every screen includes loading, empty, offline, denied and retry states where applicable. Buttons name the action; disabled controls explain the unmet requirement.

## Screen inventory

| Reference | Route or native screen | Required behavior |
|---|---|---|
| 01 Library desktop | /library | Photo/video filters, source and durable upload status, selection, upload and Capture actions. Empty state invites camera or upload. Failed analysis does not hide media. |
| 02 Source mobile | /capture | This camera, Meta glasses Experimental, Upload files. Glasses entry always explains eligibility; desktop hands off through a signed short-lived account-bound phone link, never Bluetooth pairing in a browser. |
| 03 Camera mobile | Native camera / browser camera | Photo/video switch, recording elapsed/limit, visible microphone state, Stop. Permissions requested on action. On stop show local saving, then Saved on this phone, then Uploading. Browser fallback is file picker when capture APIs unavailable. |
| 04 Glasses connect | Settings → Devices | Per-user Meta AI registration/permission, test photo and disconnect. Do not ask for founder device IP or relay address. Return from Meta AI resumes the pending registration safely. |
| 05 Glasses ready | Native capture | Actual connection state, eligible photo/video controls, audio off default. Remote arming off with duration and allowed agents selection. Never label stale status Ready. |
| 06 Uploads desktop | /uploads | Per-file progress, preparing, ready, paused, rejected and retry/cancel. Upload bytes and preparation progress are separate. Resume does not create duplicates. |
| 07 Video detail | /library/:id | Accessible playback, mute default, duration, selected moments, Explore, collection action, download/delete by owner. Explain selected-frame analysis. Processing hides unsupported playback and shows status. |
| 08 Library mobile | /library | Two-column cards, video duration, visible Capture and upload recovery, four destination navigation. |
| 09 Glasses unavailable | Native/web eligibility | Explain release, device, country or permission reason separately; offer camera/uploads. No fake reconnect for distribution blockers. |
| 10 Agents | /settings/agents | Connections, permitted resources, expiry, last use, Connect, edit permissions, rotate and revoke. No secrets in list. |
| 11 Agent permission | /settings/agents/new | Named agent, setup/preferences scopes, media resource selection, separate device control, expiry and explicit Connect. Secret display is a separate one-time success state. |
| 12 Collection share | /collections/:id/share | Restricted default, recipient invitations or explicit link access, expiry, media inclusion/download choices, live-change disclosure, revoke. Copy link only after successful create. |
| 13 Shared collection | /shared | View-only public-safe collection, owner attribution by chosen display name, optional sanitized media, expired/revoked empty state with no titles or thumbnails. |

## Detailed state rules

Camera: permission denial offers system-settings instructions or upload; unavailable microphone does not block silent video. Interruptions stop safely and retain any valid local recording. Native background upload may continue within OS constraints; no guaranteed background capture. Storage full stops recording cleanly and explains recovery. A preview with Retake/Keep precedes committing a manually taken photo; video Stop saves a local draft and offers Keep/Delete before upload. Auto-upload applies only after Keep. User can dismiss analysis without deleting a saved asset.

Upload: reject unsupported extension/MIME mismatch, oversized file, excessive duration or pixel count with per-item reason. Successful siblings continue. Offline states distinguish local queued files from cloud files. Sign-out with pending local media offers Keep on this device or Delete local drafts; encrypt retained drafts and only show them after the same account signs in. Never upload one account's draft under another account.

Glasses: states unavailable, not connected, registering, awaiting permission, connecting, ready, recording, disconnected and error. A connected radio does not prove camera permission. Test photo is a real capture, clearly saved to the owner's library. Disconnection during recording preserves valid segments and marks the clip interrupted; no silent restart. Experimental label links to a plain explanation of tested devices, permitted releases and known limitations. No promise that all glasses models support all functions.

Agent consent: show readable verbs (“View my device setup”, “Read my preferences”, “Change ordinary preferences”, “View selected collections”, “Request capture while I allow it”). No preselected camera control. Advanced scope strings may appear in expandable technical details only. Revoke confirms the named connection, then immediately removes access and reports success; failure keeps the connection shown as active. Activity records name the agent, action, target and time. Preference changes are visible in history. A local remote-capture banner has a countdown and Stop access.

Sharing: the owner starts Restricted. Enabling link access requires confirming the actual policy. Changing to include private captures previews exactly which items become visible. Copy link announces Copied only after clipboard success; otherwise provides selectable text. The viewer has no private navigation or owner edit menus. Login is required for restricted invites, not bearer links. Empty, expired and revoked views do not leak prior content. Original downloads have a clear owner-controlled switch; default off. Link sharing does not authorize agents.

## Copy and assets

Exact recurring copy is in design/copy.json. Titles and photographed subjects in mockups are fixtures. All generated references are preserved unchanged in design/mockups; design/manifest.json records dimensions and hashes. Use real accessible controls and licensed production photography during implementation. Agent and share mockups use deterministic HTML so the new permissions and privacy wording remains exact. Their controls are visual examples, not connected to accounts or APIs.

## Visual review corrections

All nine generated references were inspected. In reference08, replace “All active” with “All” and include the Uploading filter via horizontal filter scrolling. In reference05, replace the browser-only remote-capture description with “Allow selected devices and agents to request capture for 10 minutes”; the local permission sheet selects individual agents. In reference03, “Saved on this phone before upload” describes the workflow, not proof that a recording still in progress is complete; show “Recording on this phone” until finalization. Its microphone-on state assumes explicit permission, never the default. The references are scaled compositions; use specified responsive dimensions rather than their raster pixel dimensions.
