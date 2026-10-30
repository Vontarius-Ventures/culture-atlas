# culture atlas

> **Capture platform v2 is built and integrated, but not yet released** ([v2.1 specification](specs/capture-platform-v2/README.md), [status and gaps](docs/v2-gap-report.md)). Its parts:
>
> - a private photo and video library;
> - browser camera and resumable uploads;
> - an ffmpeg media worker;
> - Concentrate as the model gateway;
> - agent access to selected collections, media and phones;
> - collection sharing;
> - iOS and Android capture apps.
>
> **Spec amendment 2.2 is merged** ([amendment](specs/onboarding-and-fast-analysis.md), [build plan](docs/build-plan-v2.2.md), status in [the gap report](docs/v2-gap-report.md) section 9):
>
> - new accounts answer a required taste questionnaire (at least 3 picks from images, Wear/Play/Watch/Eat chips and live Qloo search, plus optional food exclusions);
> - the picks seed a personal, Qloo-backed feed (`taste_seed` job);
> - photos get a fast two-stage reading (quick read, then background enrichment);
> - "While we look" shows feed cards while a photo is read, and "Your photo is ready" appears after you leave (a push on native).
>
> The questionnaire's image grid uses generated mock photos (`apps/web/public/samples/onboarding`), not licensed photography. Only the text roles (`research_text` and the composer, `composer-v2`) are qualified at the moment: the two photo roles (quick read and enrichment) failed the blind held-out run of their requalification three times (2026-10-19 on golden-v2: M1, M4, M11; 2026-10-20 on a fresh golden-v3 split: M1, M2, M4, M9, M11; 2026-10-20 on a fresh golden-v4 split: M1, M2, M5, M7, M11, M15), so photos fail closed; the video-frame role was never qualified ([docs/concentrate.md](docs/concentrate.md), [docs/quality-plan.md §18.15](docs/quality-plan.md#1815-freeze-and-blind-run-on-h50h79-once-fail)). Live-photo qualification and any photo-usefulness claims were deferred by the owner to their own later work and are **not** release-verified here.
>
> **Interest-graph discovery is built and real-stack-verified, but not released**: a reviewed public-source corpus (art/sculpture/ceramics/interiors, `fixtures/graph-corpus/`) backs source-cited Why-this cards, with pause/suppress controls, scoped agent discovery, cross-client isolation and honest deletion. One honest measured limitation (2026-10-30; 6 distinct frozen personal journeys, each run in all three variants = 18 variant attempts; PR #8's proposed 20-distinct-journey sample was not met, 6 of 20): a fresh account gets **no** graph-published cards from a single saved interest, because publication surfaces only the account's own library items on related candidate references — the corpus walk finds the right candidates (e.g. Rodin → Seurat via the Art Institute bridge) but publishes nothing until the account holds such items. The legacy Qloo taste seed, by contrast, serves pick-derived cards (none of which named any of the six journeys' declared interests under the completed rubric review — one disclosed AI reviewer, no independent human review yet, so the personal-preference gates are not human-passed); the curated-only variant serves only the labeled example feed. Provider accounting for that comparison, per provider: the 28 live Qloo requests it made (26 insights, 2 search, all ok) were attested at no charge with no overages by the shared hackathon key's owner after the fact — an operator attestation for those calls only, not provider billing (the calls were dispatched without a verified worst-case reservation, a gap that is preserved, not rewritten); the one live Concentrate research call holds an unsettled $0.0045 worst-case ledger reservation against the $100 new-paid allowance, actual charge unreconciled.
>
> The web and server parts pass their tests and a real-stack browser journey. The iOS app is generated, built and simulator-tested (Xcode; 121 unit tests). The Android app, Meta glasses, live model output beyond the one verified `research_text` dispatch, S3, email and push delivery, and any AWS deployment have **not** been run. See "What is not verified" below.

**Capture something you like. Discover more you will like.**

culture atlas turns a photo into cultural discoveries: what to wear, play, watch and eat next. You save mixed interests (photos, brands, artists, films, dishes, references) into private collections and turn a few of them into a movie night. A personal agent can do the same through a scoped connection, and photos can arrive straight from World Sensor glasses.

It uses a vision model to read the photo, Qloo's cultural graph for related discoveries, and Wikipedia for sourced reference pages. A separate demo inspector shows judges and developers how each result was made.

## Provider status (honest)

| Piece | Status |
| --- | --- |
| Vision and text models: **Concentrate (default)** | `LLM_PROVIDER` unset means Concentrate. Every role (`vision_photo`, `vision_video_frame`, `research_text`, `composer`, and the stage-2 `vision_photo_enrich` from amendment 2.2) stays `unavailable` until all of these exist: `CONCENTRATE_API_KEY`, qualified role profiles (`CONCENTRATE_PROFILES_JSON` or `CONCENTRATE_PROFILE_FILE`), qualification artifacts (`CONCENTRATE_QUALIFICATION_DIR`, from `pnpm qualify:concentrate`) and spend ceilings (`MODEL_DAILY_SPEND_LIMIT_USD` and the rest). **Only `research_text` and `composer` are qualified now** (both on text-v1 under thr-v2; the composer with the injection-hardened `composer-v2` prompt, 11/11). The photo roles (`anthropic/claude-haiku-5-5`) must pass a golden-set evaluation that includes a blind held-out split read once after a rule freeze; the round-1 blind run (golden-v2) failed M1, M4 and M11, the round-2 blind run (golden-v3 h30–h49) failed M1, M2, M4, M9 and M11, and the round-3 blind run (golden-v4 h50–h79) failed M1, M2, M5, M7, M11 and M15, so they were not qualified and all three sets are consumed ([docs/quality-plan.md §18.15–18.16](docs/quality-plan.md#1815-freeze-and-blind-run-on-h50h79-once-fail)). The video-frame role is not qualified. Privacy (ZDR) confirmation by the operator is still pending for the route ([docs/concentrate.md](docs/concentrate.md)). Until then, uploads are kept and show "We can’t look at this photo yet", and v2 "Explore" says exploration is unavailable. Sessions without an account get no AI under Concentrate, because spend is tied to an account. |
| Rollback models: Featherless or Anthropic | Explicit operator rollback only: `LLM_PROVIDER=featherless` with `FEATHERLESS_API_KEY`, or `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`. Nothing falls back to them automatically. v2 media analysis is unavailable under either. Neither has been run against its live API. |
| Example photos | The three "Try an example" photos replay a hand-reviewed reading with reviewed sample picks. They are labeled "Example result" and never presented as Qloo results ([docs/pipeline.md](docs/pipeline.md#example-replays)). |
| Taste onboarding (2.2) | Catalog of real Qloo tag ids (`fixtures/onboarding/catalog.json`, built from live `/v2/tags` on 2026-10-18) with generated mock photos for the image grid. Onboarding search is live Qloo; with Qloo down the catalog still completes onboarding and search says it is taking a break. The seed job makes at most 6 Qloo requests in total (across all of its retries, counted on the run), 3 at a time; while Qloo is down it retries with one probe request per attempt, and whatever the 6 requests could not fetch stays empty and is filled by labeled examples. Onboarding search and Settings → Taste reseeds have per-account daily caps on the shared Qloo key (`ACCOUNT_DAILY_ONBOARDING_SEARCHES`, `ACCOUNT_DAILY_TASTE_SEEDS`). Elorian is not used for analysis (it stays an operator-only last resort, `MODEL_FALLBACK=elorian`, off by default). |
| Qloo | Adapter implemented against the documented API (`/search`, `/v2/tags`, `/v2/insights`, `/v2/trending`, `/trends/entity`). A one-off probe with the hackathon key (2026-10-17, [docs/capability-matrix.md](docs/capability-matrix.md)) found:<br>- search, tags and insights with explainability answer;<br>- trending returns nothing;<br>- entity trends return 404.<br>Without a key, or when Qloo is unreachable, Wear/Play/Watch show "Related discoveries are taking longer". Results are never invented, and replayed fixtures are labeled "Example result" ([docs/qloo-probes.md](docs/qloo-probes.md)). |
| Reference research | Wikipedia/Wikimedia REST with real source URLs; claims extracted by the text model. |
| World Sensor import | Implemented (server polling and an outbound bridge). The relay runs only on the operator's machine and was not reachable during development, so it is tested against a mock relay modeled on the Sensor asset API. Route names still need checking against the real relay ([docs/sensor.md](docs/sensor.md)). |
| Live capability report | `GET /v1/health` and [docs/capability-matrix.md](docs/capability-matrix.md) |

## Quick start

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```sh
pnpm install
pnpm db:setup            # starts PostgreSQL 16 (needs root), creates role culture_atlas + databases
pnpm db:migrate          # applies db/migrations
cp .env.example .env     # fill in what you have; empty values count as unset
pnpm dev                 # app, REST /v1 and MCP /mcp on http://localhost:3000
pnpm worker              # job worker: v1 jobs and v2 media analysis (second terminal)
pnpm media-worker        # capture v2: verify, prepare (ffmpeg) and clean up uploads (third terminal)
```

The media worker needs `ffmpeg` and `ffprobe` on the PATH. At startup it encodes short test clips and runs them through its own verifier and preparer. It reports video as available only if that self-test passes. To use the v2 library, sign in through `/identity`. Locally, `IDENTITY_MAIL_DRIVER=file` writes the sign-in link to `IDENTITY_MAIL_FILE_DIR` instead of sending mail.

Open http://localhost:3000, choose "Try an example" or upload a photo. Without provider keys the app still runs: captures, collections and plans work, and sections that need a provider show honest partial states.

Checks:

```sh
pnpm test                # unit, integration and contract tests (each run creates and drops its own database)
pnpm typecheck && pnpm lint && pnpm build
pnpm test:e2e            # Playwright browser journeys against a contract-checked mock API
```

The main journey also runs against the real stack (no mocks) at 1440, 390 and 360 px. Start the production build and the worker first:

```sh
pnpm build && (cd apps/web && pnpm exec next start --port 3200) &  # SESSION_SECRET, DATABASE_URL set
pnpm worker &
E2E_BASE_URL=http://localhost:3200 pnpm --filter @culture-atlas/web test:e2e:real
```

It browses, tries an example, uploads, creates an account (answering the taste questionnaire), saves into a collection, makes a movie night from mixed items and connects an agent to one collection.

The amendment 2.2 journeys (`e2e/real/v22-journey.spec.ts`, 1440/390/320) run against `next dev`, the worker and the media worker, with local provider stand-ins and no live keys: a fake Qloo server (`scripts/e2e/fake-qloo.ts`, every invented name says "Fixture") and a worker entry whose Concentrate gateway uses an in-process fake transport (`apps/worker/src/e2e-fake-models.ts`). They cover:

- anonymous browsing and examples without the questionnaire;
- sign-up, then the questionnaire, Building your feed and a personal Discover;
- an upload with While we look, the two-stage result and the ready toast;
- Settings → Taste;
- a Qloo outage;
- the existing-account trigger.

Commands are in [docs/v22-real-stack.md](docs/v22-real-stack.md).

Design fidelity of the v1 screens and the agent and sharing screens is checked on the same real stack with a fixture account (`scripts/seed-fidelity.ts`, every item labeled "Example result") and `apps/web/playwright.fidelity.config.ts` at 1440, 390 and 320 px; see [docs/design-fidelity-v1-and-account.md](docs/design-fidelity-v1-and-account.md).

The capture v2 journey (`e2e/real/v2-journey.spec.ts`) runs against `next dev`, the worker and the media worker. It covers sign-up, photo and video upload, the library, video detail and the unavailable exploration state. It also covers collections, a fake native client enrolling and running a remote command, an agent over REST and MCP, and a shared link opened and then revoked. Commands are in [docs/v2-real-stack.md](docs/v2-real-stack.md). Screenshots land in `apps/web/e2e/screenshots/real-*.png` (credentials masked). The desktop run writes the agent token to `apps/web/test-results/agent-token.txt` (git-ignored), so you can then run `DEMO_AGENT_TOKEN=$(cat apps/web/test-results/agent-token.txt) pnpm demo-agent -- --url http://localhost:3200/mcp --collection "Slow Sunday"`.

## Environment

All names are in [.env.example](.env.example) with defaults in comments. The ones you are most likely to set:

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | default `postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas` |
| `SESSION_SECRET` | production | Session and CSRF HMAC secret; required when `NODE_ENV=production` |
| `APP_BASE_URL` | production | Public URL; cookies are `Secure` when it is https |
| `CONCENTRATE_API_KEY`, `CONCENTRATE_PROFILES_JSON`, `CONCENTRATE_QUALIFICATION_DIR`, `MODEL_*_SPEND_LIMIT_USD` | photo/video analysis, research, plans | Concentrate is the default gateway. All of these are required before any role is ready ([docs/concentrate.md](docs/concentrate.md)). |
| `LLM_PROVIDER`, `FEATHERLESS_API_KEY` / `ANTHROPIC_API_KEY` | explicit rollback only | `featherless` or `anthropic`. Models: `VLM_MODEL`, `RESEARCH_MODEL`, `COMPOSER_MODEL` |
| `IDENTITY_MAIL_DRIVER` (`resend` / `ses` / `file` / `none`), `IDENTITY_MAIL_FROM`, `RESEND_API_KEY` | v2 email sign-in | `file` is local only; production uses Resend |
| `FEATURE_KILL_SWITCHES`, `META_GLASSES_*` | v2 feature flags | Server-side flags; kill switches can only turn features off (`pnpm ops:kill`) |
| `QLOO_API_KEY`, `QLOO_API_URL`, `QLOO_MAX_CONCURRENCY` | related discoveries, onboarding search, taste seed | Default URL `https://hackathon.api.qloo.com`; at most `QLOO_MAX_CONCURRENCY` (default 3) requests in flight per process, shared by every Qloo caller |
| `ONBOARDING_REQUIRED`, `TASTE_SEED_ENABLED`, `WHILE_WE_LOOK_ENABLED` | amendment 2.2 | Default on; killable like other flags. `fast_analysis_two_stage` turns on only with a qualified `vision_photo_enrich` profile |
| `ANALYSIS_VERIFIER_ENABLED` | photo-role requalification | Default off. The verifier (`vision_verify`, a model of another family; round 3: binding, only its "yes" publishes a checked claim, docs/quality-plan.md §18) runs only when this is `true`, the two-stage reading runs and the role is qualified; kill switch `analysis_verifier_enabled` (docs/requalification-plan.md) |
| `WIKIMEDIA_USER_AGENT` | reference research | Descriptive User-Agent with contact info |
| `STORAGE_DRIVER` | media | `local` (default, `.data/objects`, needs `STORAGE_SIGNING_SECRET`), `s3` (deployments) or `memory` (tests) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | `s3` storage | Any S3-compatible private bucket |
| `CREDENTIAL_ENCRYPTION_KEY` | World Sensor poll mode | `openssl rand -base64 32`; encrypts viewer credentials at rest |
| `SENSOR_ALLOWED_ORIGINS` | World Sensor poll mode | Relay origins the server may poll (https in production) |
| `BRIDGE_*` | World Sensor bridge | Set on the machine next to the relay ([docs/sensor.md](docs/sensor.md)) |
| `DEMO_INSPECTOR_ACCOUNT_IDS` | demo inspector | Accounts allowed to open "Show how it works" for their own jobs |
| `DEMO_AGENT_MCP_URL`, `DEMO_AGENT_TOKEN` | demo agent | MCP endpoint and connection token |
| `TEST_DATABASE_URL` | tests | Base database; each run creates its own |

Never commit `.env`; it is gitignored.

## Demo script

The demonstration sequence from the build spec, with what to run. Start `pnpm dev` and `pnpm worker` first.

1. **Capture an outfit.** Upload a photo or "Try an example". To show the glasses path instead, run the World Sensor bridge next to the relay (`pnpm sensor-bridge`; locally, `pnpm mock-relay --emit-every 20` stands in for the relay) and take a photo: it appears as a new capture, not as a like.
2. **Browse its discoveries.** Watch "Finding your next favorites…", then a title, a one-line reading and a mixed grid with optional Wear/Play/Watch/Eat filters. Open a card for its reason and related discoveries. Without the Qloo key, categories show "Related discoveries are taking longer". That is the honest state, not a bug.
3. **Save into a collection.** Create an account when prompted (the anonymous session and the intended save carry over), then save the photo and an artist into a new named collection.
4. **Add a room.** Analyze a room photo and add it to the same collection.
5. **Make a movie night.** Open the collection, choose "Make something", select two to five mixed items, and create the plan. Replace just the film, food or music.
6. **Let an agent in.** Create an agent connection limited to that collection, then run the independent demo agent ([docs/agents.md](docs/agents.md)):
   ```sh
   DEMO_AGENT_TOKEN=cat_... pnpm demo-agent -- --url http://localhost:3000/mcp --collection "<name>"
   ```
   It reads the granted collection, is refused global taste, discovers related items, creates a plan and replaces only the film.
7. **Show how it works.** As a demo owner, open `/inspector/<job_id>`. It shows observations, resolved Qloo ids, query inputs and ranked results (replays labeled "Example result"), sourced references, and the agent's service calls.

The spec requires at least one discovery per live demo path to trace back to a successful Qloo response. That needs the hackathon key. Until then, the demo shows partial states honestly.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` / `pnpm build` | Next.js dev server / type-check every package and `next build` |
| `pnpm worker` | Job worker: analyses (v1 and v2 media), related discovery, plans, World Sensor polling, hourly purge |
| `pnpm media-worker` | Capture v2 media worker: upload verification, ffmpeg preparation, cleanup, upload expiry, storage reconciliation |
| `pnpm qualify:concentrate` | Concentrate catalog snapshot and (only with `--confirm-paid-requests`) paid role qualification |
| `pnpm ops:kill` / `ops:metrics` / `ops:backup` / `ops:restore-drill` | Feature kill switches, CloudWatch health metrics, logical backup, restore drill |
| `pnpm db:setup` / `pnpm db:migrate` | Local PostgreSQL setup / apply migrations to `DATABASE_URL` |
| `pnpm test` / `pnpm test:e2e` | Vitest / Playwright |
| `pnpm --filter @culture-atlas/web test:e2e:real:v22` | Amendment 2.2 journeys on the real stack ([docs/v22-real-stack.md](docs/v22-real-stack.md)) |
| `pnpm onboarding:catalog` | Rebuild the onboarding catalog from live Qloo `/v2/tags` (at most 40 requests, 3 at a time) |
| `pnpm qloo:probe` | Qloo contract probes; writes `docs/capability-matrix.md` (needs `QLOO_API_KEY`) |
| `pnpm sensor-bridge [start\|once\|list]` | World Sensor outbound bridge (runs next to the relay) |
| `pnpm mock-relay` | Local mock World Sensor relay for demos and tests |
| `pnpm demo-agent` | Independent MCP demo agent |

## Deploying

One Docker image runs the web app, the worker and the media worker.

- **Production (on-prem, the owner's hardware):** `docker-compose.yml` runs PostgreSQL 16, Garage (S3-compatible media storage), Caddy (TLS), a preflight that refuses unsafe settings, migrations, web, worker and media worker. Email goes through Resend. See [docs/deploy.md](docs/deploy.md) and the go-live checklist [docs/production-readiness.md](docs/production-readiness.md). It has not been booted yet.
- **Render (not used):** `render.yaml` is a paid blueprint and stays unapplied.
- **AWS (reference only, not the production target):** see [docs/deploy-aws.md](docs/deploy-aws.md) and `infra/aws/`. The CloudFormation template creates:
  - one t3.micro with Caddy for HTTPS;
  - PostgreSQL on RDS db.t4g.micro or on the instance;
  - a private S3 bucket;
  - settings in SSM;
  - CloudWatch alarms;
  - a USD 1 budget alert.

  It has **never been deployed**. It is **not free on any AWS account today**: the legacy 12-month free tier (accounts opened before 15 July 2025) has ended for every account, and newer accounts' credit-based Free plan pays for it from credits (roughly USD 15–27 a month) for a limited period, after which it bills.
  Video playback traffic beyond the free transfer allowance is the most likely real cost. A 1 GiB micro instance prepares only a few videos an hour. Check current terms in the AWS Free Tier page and Billing console before deploying.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, a fresh migration and the build.

## What is not verified

These are written and, where possible, unit- or contract-tested, but have not run for real:

- **Native apps.** The iOS capture app (`apps/ios`) is generated with xcodegen, compiles in Xcode and passes its simulator test suite on an iPhone 17 simulator (121 tests, 2026-10-30), but has never run on a physical device, and simulator journeys observed open UX debt (the capture conveyor moves under taps, the Taste pause target is partially clipped, the onboarding chip row overflows on smaller phones, the sign-in form shifts when the keyboard opens, and the Verified checkmark's accessibility is intermittent). The Android capture app (`apps/android`) has never been compiled or run: there is no Android SDK or Kotlin compiler here, and its Meta SDK binding is written from documentation and unchecked.
- **Glasses and phones.** Nothing has run on Meta glasses or on a physical phone (DEV-01..03, and the device parts of MED-04/05 and TEN-01).
- **Models.** The two-stage photo reading on `anthropic/claude-haiku-5-5` is not qualified: its requalification passed the tune split but failed three blind held-out splits, each read once: 16 photographs on M1, M4 and M11 (round 1), 20 fresh photographs on M1, M2, M4, M9 and M11 (round 2) and 30 fresh photographs on M1, M2, M5, M7, M11 and M15 (round 3; [docs/quality-plan.md §18.15–18.16](docs/quality-plan.md#1815-freeze-and-blind-run-on-h50h79-once-fail)). No real upload has reached `complete` on this branch; uploads fail closed. The operator's ZDR and no-logging confirmation in the Concentrate dashboard is still pending, so these profiles are not for production. Video frames are not qualified. `research_text` and the composer (`composer-v2`) are qualified, and `research_text` was verified live exactly once (2026-10-30: one gated `research_graph_relation` dispatch through the real worker and the real Concentrate gateway — reserved $0.0045, 1833/773 tokens, one unreviewed proposal with approved-source citations; the actual external charge is unreconciled and stays booked as unknown, never zero). The automated browser journeys use an in-process fake transport. Billing reconciliation is manual.
- **Onboarding images.** The 12 image picks are generated mock photos, not licensed photography ([fixtures/images/LICENSES.md](fixtures/images/LICENSES.md)).
- **ONB-04 on a deployed demo.** "First category within 5 s p50" was measured only locally, against live Qloo on the hackathon key: 1.4 s on October 18, and a p50 of about 6.4 s over 4 runs on October 19. It was never measured on a deployed demo.
- **Browser video playback.** MP4 playback in a real browser was not observed: Playwright's Chromium has no H.264. The stream was decoded with ffmpeg instead.
- **External services.** S3 (multipart, CORS, ListMultipartUploads), Resend/SES email, APNs/FCM push and the AWS stack were tested against local fakes only.
- **Release qualification.** There is no store or SDK eligibility evidence, no independent two-user trial and no cloud restore drill.

## Documentation

- [Build specification](specs/cultural-discovery-build-spec.md): behavior and permissions (governs)
- [Design guide](design/cultural-atlas-v1/DESIGN-GUIDE.md), [tokens](design/cultural-atlas-v1/tokens.css), [mockup gallery](design/cultural-atlas-v1/index.html): interface (governs)
- [Architecture](docs/ARCHITECTURE.md): modules, contracts, ownership and testing rules
- [Pipeline](docs/pipeline.md): how a photo becomes discoveries
- [Agents](docs/agents.md): MCP and REST connections, the demo agent and the inspector
- [World Sensor](docs/sensor.md): poll and bridge modes, setup, guarantees, verifying the relay
- [Capability matrix](docs/capability-matrix.md) and [Qloo probes](docs/qloo-probes.md)
- [Privacy and retention](docs/privacy.md): what is kept, deletion, provider retention TODOs
- [Deploy (on-prem production)](docs/deploy.md), [production readiness checklist](docs/production-readiness.md) and [Deploy on AWS](docs/deploy-aws.md) (reference only)
- Capture platform v2:
  - [gap report](docs/v2-gap-report.md);
  - [real-stack journey](docs/v2-real-stack.md) and [amendment 2.2 real-stack journeys](docs/v22-real-stack.md);
  - [contract](docs/capture-v2-contract.md);
  - [operations](docs/capture-v2-operations.md);
  - [media worker](docs/media-worker.md);
  - [Concentrate](docs/concentrate.md);
  - [sharing](docs/sharing.md);
  - [native apps](docs/native.md);
  - [runbooks](docs/runbooks/).
- Research: [World Sensor integration review](research/world-sensor-qloo-integration.md), [Qloo feasibility](research/qloo-style-feasibility.md)

## Repository layout

```
apps/web            Next.js: consumer UI, REST /v1 and /v2, MCP /mcp, demo inspector
apps/worker         DB-backed job worker (v1 jobs, v2 media analysis)
apps/media-worker   Capture v2 upload verification and ffmpeg preparation
apps/ios, apps/android  Native capture apps (source only; not compiled here)
infra/onprem        Caddyfile, Garage config and backup script for the on-prem production stack
infra/aws           CloudFormation, Compose and Caddy for the AWS shape (reference only)
apps/demo-agent     Independent MCP client
apps/sensor-bridge  Outbound World Sensor bridge (runs next to the relay)
packages/domain     Domain services, schemas, authorization, jobs, World Sensor import
packages/providers  Model gateway (Concentrate; Featherless/Anthropic rollback), Qloo, research, storage, mail and push adapters
packages/agent-gateway  MCP tools over the domain services
db/migrations       Plain SQL migrations
fixtures            Recorded-shape fixtures, the mock relay, sample inputs
docs, specs, design, research
```

World Sensor itself stays in its own repository ([WorldCompilerSensor](https://github.com/Vontarius-Ventures/WorldCompilerSensor)); culture atlas only reads its committed photo assets.

## License

No license has been chosen yet. Picking one is a release step for the repository owner, and the hackathon requires a public, licensed repository.
