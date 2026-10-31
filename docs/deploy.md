# Deploying culture atlas

**Production is on-prem: the Compose stack in `docker-compose.yml` on the
owner's own hardware.** This is THE production path. The go-live checklist,
with every owner action, is [production-readiness.md](production-readiness.md).

For a Mac without router forwarding, use the isolated
[Tailscale Funnel edge](deploy-funnel.md). It leaves existing Mac Funnels
untouched and publishes no app/database/storage host ports.

- **Not Render.** `render.yaml` stays unapplied: Render background workers have
  no free plan and there is no Render API key in this repository (`rc_` keys
  are Featherless, `FEATHERLESS_API_KEY`).
- **Not AWS EC2/RDS.** [deploy-aws.md](deploy-aws.md) and `infra/aws/` remain
  as reference only.
- **Email is Resend.** The on-prem host sends identity mail through Resend's
  HTTPS API (`IDENTITY_MAIL_DRIVER=resend`, `RESEND_API_KEY`); see
  [production-readiness.md §5](production-readiness.md#5-resend-production-email).

## The stack

One Docker image runs three processes — `web` (Next.js app, REST `/v1` and
`/v2`, MCP `/mcp`, `/.well-known` association files), `worker` (jobs, v2 media
analysis) and `media-worker` (ffmpeg verify/prepare) — next to:

- **PostgreSQL 16** on the named volume `pgdata`;
- **Garage**, an S3-compatible object store on the same host, for all media.
  Production refuses the filesystem storage driver for v2 media, and the spec
  sets `STORAGE_DRIVER=s3`, so on-prem storage is S3 served locally;
- **Caddy** (profile `edge`), which terminates TLS for `APP_HOST` (→ web) and
  `MEDIA_HOST` (→ Garage) with automatic certificates.

Start order: postgres and garage healthy → `preflight` (`pnpm ops:preflight`
refuses unsafe production settings, e.g. `IDENTITY_MAIL_DRIVER=file`, http
`APP_BASE_URL`, missing `SESSION_SECRET` / `STORAGE_SIGNING_SECRET` / Resend
key) → `storage-init` (`pnpm ops:storage init`: bucket, CORS,
write/read/delete probe) → `migrate` (`pnpm db:migrate`) → web, worker,
media-worker. Every long-running service has a healthcheck and
`restart: unless-stopped`. Web and Garage bind to 127.0.0.1; only Caddy
publishes 80/443.

```sh
cp .env.example .env && chmod 600 .env   # fill the REQUIRED names; never commit .env
docker compose build
docker compose up -d garage              # then the one-time Garage layout + key
                                         # (production-readiness.md §4)
docker compose up -d
docker compose ps                        # everything healthy
curl -fsS https://$APP_HOST/v1/health
```

The World Sensor bridge is **not** part of the stack: it runs next to the
relay (see [sensor.md](sensor.md) and the last section below).

## Environment

Every name is listed in `.env.example`; an empty value counts as unset.
Compose passes each service only the settings it reads (no blanket
`env_file`), and `scripts/compose-self-host.test.ts` checks that every setting
in the domain and provider config schemas is wired.

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_BASE_URL`, `APP_HOST` | yes | `https://<APP_HOST>`, origin only. Cookies are `Secure` because it is https; identity links and universal links use it. The native apps' release host is `app.cultureatlas.com` unless rebuilt ([production-readiness.md §12](production-readiness.md#12-native-apps-point-at-the-on-prem-host)). |
| `MEDIA_HOST`, `S3_ENDPOINT` | yes | `S3_ENDPOINT=https://<MEDIA_HOST>`: phones and browsers upload parts and read media from presigned URLs on it. |
| `ACME_EMAIL` | yes | Certificate account and expiry notices (Caddy). |
| `POSTGRES_PASSWORD` | yes | `openssl rand -hex 24`; Compose builds `DATABASE_URL` from it. |
| `SESSION_SECRET` | yes | `openssl rand -hex 32`; startup fails without it. |
| `STORAGE_SIGNING_SECRET` | yes | `openssl rand -hex 32`, different from `SESSION_SECRET`. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | The Garage app key. `STORAGE_DRIVER=s3`, `S3_FORCE_PATH_STYLE=true`, `S3_BUCKET` (default `culture-atlas-media`) and `S3_REGION` (default `us-east-1`, equal to `garage.toml`) are set by Compose. |
| `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` | yes | Garage node secrets (`openssl rand -hex 32`, `openssl rand -base64 32`). |
| `IDENTITY_MAIL_FROM`, `RESEND_API_KEY` | yes | Resend. `IDENTITY_MAIL_DRIVER` defaults to `resend` in Compose; the preflight refuses `file`, `ses` and `none`. `IDENTITY_MAIL_FROM` must be on a domain verified in Resend. Web only. |
| `LLM_PROVIDER` + `CONCENTRATE_API_KEY` + `CONCENTRATE_PROFILE_FILE` / `CONCENTRATE_PROFILES_JSON` + `CONCENTRATE_QUALIFICATION_DIR` + `MODEL_DAILY_SPEND_LIMIT_USD`, `MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD`, `MODEL_MAX_UNKNOWN_SPEND_USD` | for analysis | Concentrate is the v2 model gateway. Compose mounts `CONCENTRATE_CONFIG_DIR` (default `./fixtures/concentrate`) read-only at `/etc/culture-atlas/concentrate` and points the profile/qualification settings there. Missing pieces keep that role `unavailable` while capture, library and uploads keep working ([concentrate.md](concentrate.md)). Explicit rollback only: `LLM_PROVIDER=featherless` + `FEATHERLESS_API_KEY` or `anthropic` + `ANTHROPIC_API_KEY`. |
| `QLOO_API_KEY` + `QLOO_API_URL` | for Qloo discoveries | Hackathon key; default URL `https://hackathon.api.qloo.com`. Without the key every Qloo capability is `unavailable`, never invented. `QLOO_REPLAY_FIXTURES` is forced `false`. |
| `ELEVENLABS_API_KEY` | for Music Mode | Scribe transcription; absent key keeps it unavailable. |
| `WIKIMEDIA_USER_AGENT` | recommended | Descriptive User-Agent with contact info (Wikimedia policy). |
| `APPLE_TEAM_ID`, `ANDROID_ASSETLINKS_SHA256` | for native links | Served by web at `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`. |
| `PUSH_DRIVER=live` + `PUSH_APNS_*`, `PUSH_FCM_*`, `CREDENTIAL_ENCRYPTION_KEY` | for push | Web and worker. |
| `CREDENTIAL_ENCRYPTION_KEY` | for push / Sensor poll mode | `openssl rand -base64 32`. Changing it makes stored credentials unreadable. |
| `SENSOR_ALLOWED_ORIGINS` | for Sensor poll mode | https relay origins only; never internal or loopback addresses. |
| Client address | check | `TRUSTED_PROXY_HOPS` (1 = Caddy only). Add one per extra proxy that appends `X-Forwarded-For` (e.g. a CDN). `CLIENT_IP_HEADER` only if your edge overwrites a verified client-address header. |
| Quotas and switches | optional | `ANON_DAILY_ANALYSES` (10), `ACCOUNT_DAILY_ANALYSES` (100), `ACCOUNT_DAILY_ONBOARDING_SEARCHES` (200), `ACCOUNT_DAILY_TASTE_SEEDS` (12), `IP_DAILY_REQUESTS` (2000), `WORKER_CONCURRENCY` (5), feature switches… |
| `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_OFFSITE_RSYNC` | for backups | `infra/onprem/atlas-backup.sh`. |

## Releasing

1. CI (`.github/workflows/ci.yml`) runs typecheck, lint, the full test suite
   against Postgres 16, a fresh-database migration and `pnpm build` on every
   push and PR.
2. On the host: `git pull`, then `docker compose build` and `docker compose up -d`.
   The one-shot `preflight`, `storage-init` and `migrate` run again before the
   new web/worker/media-worker start. Migrations are forward-only and
   checksummed (`scripts/migrate.ts`). Take a backup first
   (`infra/onprem/atlas-backup.sh`).
3. After deploy:
   - `docker compose ps` shows every long-running service healthy;
   - `https://<APP_HOST>/v1/health` is green;
   - a test upload produces a capture and a job;
   - `GET /v1/sensor-connections` works for the operator account;
   - start the bridge next to the relay and confirm one new glasses photo imports exactly once.

## Backups

`infra/onprem/atlas-backup.sh` (cron, nightly) runs in the `ops` image
(PostgreSQL 16 client): `pnpm ops:backup` writes a consistent `pg_dump`
snapshot with object and tombstone inventories, and `pnpm ops:storage mirror`
copies every Garage object into the same snapshot directory. Restore drill:
[runbooks/restore-drill.md](runbooks/restore-drill.md) ("On-prem (Compose)").

## Other options (not production)

- **Paid Render blueprint (`render.yaml`)** — do not apply. Only if someone
  later chooses to pay; workers are not free.
- **AWS** — [deploy-aws.md](deploy-aws.md), reference only.
- **Local development** — `pnpm dev` with `.env` (filesystem storage and
  `IDENTITY_MAIL_DRIVER=file` are fine there; production refuses both).

## Sensor bridge on the operator's machine

The bridge is a plain Node process: `pnpm install`, then set the `BRIDGE_*`
variables and run `pnpm sensor-bridge`. To keep it running, use whatever the
machine offers (a `launchd` agent on macOS, a `systemd` user service on Linux,
or `pm2`). It only makes outbound HTTPS calls to `BRIDGE_APP_URL`, so the relay
never needs to be exposed. Details in [sensor.md](sensor.md).
