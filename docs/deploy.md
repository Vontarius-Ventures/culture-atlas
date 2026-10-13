# Deploying culture atlas

The demo runs as two processes from one Docker image, `web` (Next.js app, REST `/v1`, MCP `/mcp`) and `worker` (job worker), plus PostgreSQL 16 and S3-compatible object storage. The World Sensor bridge is **not** deployed with them: it runs next to the relay (see [sensor.md](sensor.md)).

> Neither the Docker build nor the Render blueprint has been run from this repository yet: the build environment had no Docker or Render access. Locally verified: `pnpm build`, `next start` with the worker and migrations, and the full sensor flow against that server. Treat the first deploy as a check of these files.

## Option A: Render blueprint (`render.yaml`)

1. Push the repository to GitHub, then in Render choose **New > Blueprint** and select the repo. The blueprint creates:
   - `culture-atlas-db` (Postgres 16);
   - `culture-atlas-web` (Docker web service, health check `/v1/health`, migrations as the pre-deploy command);
   - `culture-atlas-worker` (Docker background worker, `pnpm worker`);
   - the shared env group `culture-atlas-shared`.
2. Fill in the `sync: false` variables when prompted (see the table below). `SESSION_SECRET` is generated once and shared by both services.
3. Create a bucket (Cloudflare R2, S3, MinIO…) and set the `S3_*` variables. Local disk storage cannot work here because web and worker run on different machines.
4. After the first deploy, set `APP_BASE_URL` on both services to the web service's public `https://` URL and redeploy. Cookies are `Secure` when it is https.
5. Check `https://<app>/v1/health`: `ok: true`, and capability statuses that match the keys you set.

Plan names in `render.yaml` (`starter`, `basic-256mb`) are examples; check Render's current plans.

## Option B: any Docker host

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
| `FEATHERLESS_API_KEY` | for analysis | Without it, captures are kept but analysis reports unavailable. `VLM_MODEL` / `RESEARCH_MODEL` / `COMPOSER_MODEL` default to `google/gemma-3-27b-it`. Set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` to use Anthropic instead. |
| `QLOO_API_KEY` | for Qloo discoveries | Pending. Without it every Qloo capability is `unavailable` and discovery categories show partial states, never invented results. Run `pnpm qloo:probe` once it arrives ([qloo-probes.md](qloo-probes.md)). |
| `WIKIMEDIA_USER_AGENT` | recommended | Descriptive User-Agent with contact info (Wikimedia policy) |
| `CREDENTIAL_ENCRYPTION_KEY` | for Sensor poll mode | `openssl rand -base64 32`. Not needed for bridge mode. Changing it makes stored viewer credentials unreadable (connections report `credential_key_mismatch`). |
| `SENSOR_ALLOWED_ORIGINS` | for Sensor poll mode | Comma-separated https relay origins the server may poll. Keep it empty if you only use the bridge. Never list internal or loopback addresses on a public server. |
| `DEMO_INSPECTOR_ACCOUNT_IDS` | for the demo | Accounts allowed to open the inspector for their own jobs |
| Quotas and limits | optional | `ANON_DAILY_ANALYSES` (10), `ACCOUNT_DAILY_ANALYSES` (100), `IP_DAILY_REQUESTS` (2000), `WORKER_CONCURRENCY` (5)… |
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
