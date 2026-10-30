# Running the capture v2 journey on the real stack

`apps/web/e2e/real/v2-journey.spec.ts` drives capture platform v2 end to end
against the running app, job worker and media worker. Nothing is mocked. It
runs at 1440, 390 and 360 px (`playwright.real.config.ts`).

What it covers:

1. **Sign up.** The `/identity` email-link flow. The server writes the link to
   a local file mailbox (`IDENTITY_MAIL_DRIVER=file`) and the test opens it.
2. **Upload.** A photo, plus a 4-second H.264/AAC MP4 that ffmpeg generates
   during the test. The test records the states the upload queue showed
   before "Ready".
3. **Library.** Both items appear, with their source and state, and the
   Videos filter works.
4. **Video detail.** Moments appear in timestamp order. The test fetches the
   playback stream by byte ranges (206 responses), decodes it fully with
   ffmpeg, then presses Play:
   - in a browser that can decode MP4, the video must advance;
   - in Playwright's Chromium, which is built without H.264/AAC decoders,
     the player must show its "cannot play in this browser" notice instead.
5. **Exploration.** With no qualified Concentrate profile:
   - `/v2/capabilities` reports analysis as unavailable;
   - "Explore this video" is disabled and says why;
   - `POST /v2/media/{id}/analysis` with `sampled_video` returns 503,
     "Exploration is not available on this server yet.";
   - no result link is created.
6. **Collection.** Create one, then select both media in the library and save
   them to it.
7. **Fake native client.** It runs native email sign-in with PKCE, enrolls
   with a P-256 proof signed by a fresh key, sends status heartbeats and reads
   `/v2/capabilities` with its `cna_` token.
8. **Agent.** It is connected in Settings with three grants:
   - access to that collection only;
   - "View permitted photos and videos";
   - "Request capture while I allow it", limited to the phone.

   Over REST and MCP, the agent sees exactly the two media. It cannot manage
   shares, and `analyze_media` is refused because it has no analysis grant.
9. **Command lifecycle.** The phone opens a capture session, sends a
   heartbeat and arms for that agent. The agent then requests a photo. The
   phone claims the command (bounded long poll) and acknowledges it:
   `executing`, a repeated `executing`, then `succeeded`. Finally the agent
   reads the command back as `succeeded`.
10. **Sharing.** Link access with photos and videos included goes through the
    "Confirm what becomes visible" step. A separate browser context opens the
    link and sees the media; its owner library stays closed. The owner then
    turns the link off, and the viewer gets the revoked state with no titles
    or images.

Screenshots: `apps/web/e2e/screenshots/real-v2-*.png`. Credentials and share
secrets are masked.

## Commands

The web server runs with `next dev` here. A production build
(`next start`) refuses local media storage by design (`createMultipartStorage`
requires S3 in production), and no S3-compatible service is available offline.
To run the same journey against `next start`, point `STORAGE_DRIVER=s3` at a
real or staging bucket that allows browser `PUT` and exposes `ETag` through
CORS. The file mailbox is also refused in production, so sign-in then needs
SES (`IDENTITY_MAIL_DRIVER=ses`) and a way to read the mail.

```sh
service postgresql start
createdb ca_e2e   # or: su postgres -c "psql -c 'CREATE DATABASE ca_e2e OWNER culture_atlas'"
export DATABASE_URL=postgres://culture_atlas:culture_atlas@localhost:5432/ca_e2e
export APP_BASE_URL=http://localhost:3300
export SESSION_SECRET=<32+ random chars> CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
export STORAGE_DRIVER=local STORAGE_LOCAL_DIR=$PWD/.data/e2e-objects
export IDENTITY_MAIL_DRIVER=file IDENTITY_MAIL_FILE_DIR=$PWD/.data/e2e-mail
# Run without provider keys so every state is the honest unavailable one:
export QLOO_API_KEY= CONCENTRATE_API_KEY=
# Agent remote capture is off by default (feature-flags.json); step 9 needs the operator opt-in:
export AGENT_REMOTE_CAPTURE_ENABLED=true
pnpm db:migrate
(cd apps/web && pnpm exec next dev --port 3300) &
pnpm worker &
pnpm media-worker &      # self-tests ffmpeg, then reports video as qualified
cd apps/web && E2E_BASE_URL=http://localhost:3300 V2_MAIL_DIR=$IDENTITY_MAIL_FILE_DIR \
  pnpm exec playwright test -c playwright.real.config.ts e2e/real/v2-journey.spec.ts
```

The v1 journey (`e2e/real/journey.spec.ts`) still runs against the production
build, as described in the README.

**Production build, offline.** `scripts/local-aws.ts` runs loopback stand-ins
for S3 and SESv2. With them, both journeys pass against `next start`
(`STORAGE_DRIVER=s3`, `IDENTITY_MAIL_DRIVER=ses`), and `V2_MAIL_DIR` points at
the stand-in's `mail/` directory. The environment is in
[design-fidelity-v2-capture.md](design-fidelity-v2-capture.md#commands). The
stand-ins verify no signatures, so they do not prove real S3 or SES behaviour.

## What this journey does not prove

- **Real MP4 playback in a browser.** It was not observed: Playwright's
  Chromium cannot decode H.264. The stream is proven decodable with ffmpeg
  instead. MED-05 still needs Chrome, Safari, iOS and Android.
- **S3, SES and push delivery.** None were exercised (no network).
- **Real model output.** Nothing reached a live model; analysis is only
  shown as unavailable.
- **The native apps.** The "phone" is an HTTP client that follows
  `fixtures/native-contract`. It is not the Swift or Kotlin code, which has
  never been compiled here.
