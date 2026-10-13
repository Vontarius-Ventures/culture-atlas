# culture atlas

**Capture something you like. Discover more you will like.**

culture atlas turns a photo into cultural discoveries: what to wear, play, watch and eat next. You save mixed interests (photos, brands, artists, films, dishes, references) into private collections and turn a few of them into a movie night. A personal agent can do the same through a scoped connection, and photos can arrive straight from World Sensor glasses.

It uses a vision model to read the photo, Qloo's cultural graph for related discoveries, and Wikipedia for sourced reference pages. A separate demo inspector shows judges and developers how each result was made.

## Provider status (honest)

| Piece | Status |
| --- | --- |
| Vision and text models (Featherless) | Implemented. Needs `FEATHERLESS_API_KEY` (or `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY`). Not yet run against the live API. Without it, uploaded photos are kept and show "We can’t look at this photo yet" with a retry. The three "Try an example" photos instead replay a hand-reviewed reading with reviewed sample picks, labeled "Example result" and never presented as Qloo results ([docs/pipeline.md](docs/pipeline.md#example-replays)). |
| Qloo | Adapter implemented against the documented API (`/search`, `/v2/tags`, `/v2/insights`, `/v2/trending`, `/trends/entity`). **The hackathon key has not been issued yet**, so every Qloo capability reports `unavailable` and Wear/Play/Watch show "Related discoveries are taking longer". Results are never invented. Replayed fixtures are labeled "Example result". Run `pnpm qloo:probe` when the key arrives ([docs/qloo-probes.md](docs/qloo-probes.md)). |
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
pnpm worker              # job worker (second terminal)
```

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

It browses, tries an example, uploads, creates an account, saves into a collection, makes a movie night from mixed items and connects an agent to one collection. Screenshots land in `apps/web/e2e/screenshots/real-*.png` (credentials masked). The desktop run writes the agent token to `apps/web/test-results/agent-token.txt` (git-ignored), so you can then run `DEMO_AGENT_TOKEN=$(cat apps/web/test-results/agent-token.txt) pnpm demo-agent -- --url http://localhost:3200/mcp --collection "Slow Sunday"`.

## Environment

All names are in [.env.example](.env.example) with defaults in comments. The ones you are most likely to set:

| Variable | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | everything | default `postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas` |
| `SESSION_SECRET` | production | Session and CSRF HMAC secret; required when `NODE_ENV=production` |
| `APP_BASE_URL` | production | Public URL; cookies are `Secure` when it is https |
| `FEATHERLESS_API_KEY` | photo analysis, research, plans | `LLM_PROVIDER` defaults to `featherless`. Models: `VLM_MODEL`, `RESEARCH_MODEL`, `COMPOSER_MODEL` (default `google/gemma-3-27b-it`; the VLM model must accept images). `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` is the alternative. |
| `QLOO_API_KEY`, `QLOO_API_URL` | related discoveries | Key pending; default URL `https://hackathon.api.qloo.com` |
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
| `pnpm worker` | Job worker: analyses, related discovery, plans, World Sensor polling, hourly purge |
| `pnpm db:setup` / `pnpm db:migrate` | Local PostgreSQL setup / apply migrations to `DATABASE_URL` |
| `pnpm test` / `pnpm test:e2e` | Vitest / Playwright |
| `pnpm qloo:probe` | Qloo contract probes; writes `docs/capability-matrix.md` (needs `QLOO_API_KEY`) |
| `pnpm sensor-bridge [start\|once\|list]` | World Sensor outbound bridge (runs next to the relay) |
| `pnpm mock-relay` | Local mock World Sensor relay for demos and tests |
| `pnpm demo-agent` | Independent MCP demo agent |

## Deploying

One Docker image runs the web app and the worker; `render.yaml` is a Render blueprint with Postgres. See [docs/deploy.md](docs/deploy.md). CI (`.github/workflows/ci.yml`) runs typecheck, lint, tests, a fresh migration and the build.

## Documentation

- [Build specification](specs/cultural-discovery-build-spec.md): behavior and permissions (governs)
- [Design guide](design/cultural-atlas-v1/DESIGN-GUIDE.md), [tokens](design/cultural-atlas-v1/tokens.css), [mockup gallery](design/cultural-atlas-v1/index.html): interface (governs)
- [Architecture](docs/ARCHITECTURE.md): modules, contracts, ownership and testing rules
- [Pipeline](docs/pipeline.md): how a photo becomes discoveries
- [Agents](docs/agents.md): MCP and REST connections, the demo agent and the inspector
- [World Sensor](docs/sensor.md): poll and bridge modes, setup, guarantees, verifying the relay
- [Capability matrix](docs/capability-matrix.md) and [Qloo probes](docs/qloo-probes.md)
- [Privacy and retention](docs/privacy.md): what is kept, deletion, provider retention TODOs
- [Deploy](docs/deploy.md)
- Research: [World Sensor integration review](research/world-sensor-qloo-integration.md), [Qloo feasibility](research/qloo-style-feasibility.md)

## Repository layout

```
apps/web            Next.js: consumer UI, REST /v1, MCP /mcp, demo inspector
apps/worker         DB-backed job worker
apps/demo-agent     Independent MCP client
apps/sensor-bridge  Outbound World Sensor bridge (runs next to the relay)
packages/domain     Domain services, schemas, authorization, jobs, World Sensor import
packages/providers  VLM, text, Qloo, research and storage adapters
packages/agent-gateway  MCP tools over the domain services
db/migrations       Plain SQL migrations
fixtures            Recorded-shape fixtures, the mock relay, sample inputs
docs, specs, design, research
```

World Sensor itself stays in its own repository ([WorldCompilerSensor](https://github.com/Vontarius-Ventures/WorldCompilerSensor)); culture atlas only reads its committed photo assets.

## License

No license has been chosen yet. Picking one is a release step for the repository owner, and the hackathon requires a public, licensed repository.
