# Deploying culture atlas

The demo runs as three processes from one Docker image — `web` (Next.js app, REST `/v1` and `/v2`, MCP `/mcp`), `worker` (jobs) and `media-worker` (ffmpeg verify/prepare) — plus PostgreSQL 16. The World Sensor bridge is **not** deployed with them: it runs next to the relay (see [sensor.md](sensor.md)).

**Hosting is not live.** There is no Render API key in this repository (`rc_` keys are Featherless, `FEATHERLESS_API_KEY`, not Render). Render cannot host this app for free: background workers have no free plan (paid `starter` / `0.5c-512mb`), and `render.yaml` is web + two workers + Postgres `basic-256mb`. Do not apply that blueprint and do not spend money.

**Default for this run: Compose self-host** (`docker-compose.yml`). Concentrate is the v2 model gateway (`LLM_PROVIDER=concentrate`). The Qloo hackathon key has arrived: set `QLOO_API_KEY` in a gitignored `.env`, never in the blueprint or compose file. Missing keys keep those capabilities `unavailable`; nothing is invented.

Locally verified earlier: `pnpm build`, `next start` with the worker and migrations. Treat the first Compose up as a check of these files.

AWS (one small EC2 instance, RDS or on-instance PostgreSQL, private S3, a 1 USD budget alert): see [deploy-aws.md](deploy-aws.md). Operational runbooks: [runbooks/README.md](runbooks/README.md).

## Option A: Compose self-host (`docker-compose.yml`)

Postgres 16, web bound to `0.0.0.0:$PORT`, worker, media-worker, and a named volume for local object storage (shared by all three app processes).

```sh
cp .env.example .env
# Required: SESSION_SECRET (openssl rand -hex 32)
# For live analysis/discovery: CONCENTRATE_API_KEY, QLOO_API_KEY
# Optional rollback: FEATHERLESS_API_KEY (with LLM_PROVIDER=featherless)
docker compose up --build
```

Then `http://localhost:3000/v1/health`. Cookies follow `APP_BASE_URL` (default `http://localhost:3000`). Identity email stays fail-closed until `IDENTITY_MAIL_DRIVER` is configured.

## Option B: paid Render blueprint (`render.yaml`) — do not apply for this run

Only if someone later chooses to pay. The blueprint names `LLM_PROVIDER=concentrate`, `CONCENTRATE_API_KEY` (`sync: false`), `CONCENTRATE_BASE_URL`, `QLOO_API_KEY` (`sync: false`) and `QLOO_API_URL=https://hackathon.api.qloo.com`. It still needs a real Render account key, an S3-compatible bucket, and `APP_BASE_URL` after the first deploy. Workers are not free.

## Option C: any Docker host

```sh
docker build -t culture-atlas .
# Run migrations before each release:
docker run --rm --env-file prod.env culture-atlas pnpm db:migrate
# Web (listens on $PORT, default 3000):
docker run -d --env-file prod.env -p 3000:3000 culture-atlas
# Worker:
docker run -d --env-file prod.env culture-atlas pnpm worker
```

The image includes the full workspace install, because the worker and scripts run TypeScript through `tsx`. It runs as the `node` user and has a `HEALTHCHECK` on `/v1/health`. `.dockerignore` keeps `.env` files, `.data/`, `design/`, `research/` and `specs/` out of the build context.

## Environment

Every name is listed in `.env.example`. An empty value counts as unset.

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres 16 connection string |
| `NODE_ENV` | yes | `production` |
| `APP_BASE_URL` | yes | Public https URL |
| `SESSION_SECRET` | yes | Same value on web and worker; startup fails in production without it |
| `STORAGE_DRIVER` + `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | yes | `s3` for any multi-machine deploy. Private bucket; disable versioning or expire old versions (see [privacy.md](privacy.md)). |
| `LLM_PROVIDER` + `CONCENTRATE_API_KEY` + `CONCENTRATE_BASE_URL` + `CONCENTRATE_PROFILES_JSON` (or `CONCENTRATE_PROFILE_FILE`) + `CONCENTRATE_QUALIFICATION_DIR` + `MODEL_DAILY_SPEND_LIMIT_USD`, `MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD`, `MODEL_MAX_UNKNOWN_SPEND_USD` | for analysis | Concentrate is the v2 model gateway (`LLM_PROVIDER=concentrate` in Compose and the paid blueprint). Each role needs a qualified profile ([concentrate.md](concentrate.md)); missing pieces keep that role `unavailable` while capture, library and uploads keep working. Explicit rollback only: `LLM_PROVIDER=featherless` + `FEATHERLESS_API_KEY` (`rc_` keys belong here, not as a Render API key) or `anthropic` + `ANTHROPIC_API_KEY`; v2 media analysis is unavailable under a rollback provider. |
| `QLOO_API_KEY` + `QLOO_API_URL` | for Qloo discoveries | The hackathon key has arrived: set `QLOO_API_KEY` in `.env` / a paid dashboard, never in git. Default URL `https://hackathon.api.qloo.com`. Without the key every Qloo capability is `unavailable` and discovery categories show partial states, never invented results. |
| `WIKIMEDIA_USER_AGENT` | recommended | Descriptive User-Agent with contact info (Wikimedia policy) |
| `CREDENTIAL_ENCRYPTION_KEY` | for Sensor poll mode | `openssl rand -base64 32`. Not needed for bridge mode. Changing it makes stored viewer credentials unreadable (connections report `credential_key_mismatch`). |
| `SENSOR_ALLOWED_ORIGINS` | for Sensor poll mode | Comma-separated https relay origins the server may poll. Keep it empty if you only use the bridge. Never list internal or loopback addresses on a public server. |
| `DEMO_INSPECTOR_ACCOUNT_IDS` | for the demo | Accounts allowed to open the inspector for their own jobs |
| Quotas and limits | optional | `ANON_DAILY_ANALYSES` (10), `ACCOUNT_DAILY_ANALYSES` (100), `ACCOUNT_DAILY_ONBOARDING_SEARCHES` (200), `ACCOUNT_DAILY_TASTE_SEEDS` (12), `IP_DAILY_REQUESTS` (2000), `WORKER_CONCURRENCY` (5)… |
| Client address | check | `TRUSTED_PROXY_HOPS` (1): proxies that append to `X-Forwarded-For`; the address is read that many entries from the right, so a client cannot pick its own by sending the header. `CLIENT_IP_HEADER`: a platform header that carries the verified client address, if your host sets one. Check both against your host's proxy chain before launch: too few hops lets clients choose their address, too many makes everyone share the proxy's address. In production a request with no usable address falls into one shared, strict bucket. |

## Releasing

1. CI (`.github/workflows/ci.yml`) runs typecheck, lint, the full test suite against Postgres 16, a fresh-database migration and `pnpm build` on every push and PR.
2. Migrations are forward-only and checksummed (`scripts/migrate.ts`). Run them before starting the new version (Render's pre-deploy command does this).
3. After deploy:
   - `/v1/health` is green;
   - a test upload produces a capture and a job;
   - `GET /v1/sensor-connections` works for the operator account;
   - start the bridge next to the relay and confirm one new glasses photo imports exactly once.

## Sensor bridge on the operator's machine

The bridge is a plain Node process: `pnpm install`, then set the `BRIDGE_*` variables and run `pnpm sensor-bridge`. To keep it running, use whatever the machine offers (a `launchd` agent on macOS, a `systemd` user service on Linux, or `pm2`). It only makes outbound HTTPS calls to `BRIDGE_APP_URL`, so the relay never needs to be exposed. Details in [sensor.md](sensor.md).
