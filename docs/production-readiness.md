# Production readiness: on-prem go-live checklist

Production for culture atlas is **on-prem**: the Compose stack in
`docker-compose.yml` on the owner's own hardware. Render (`render.yaml`) stays
unapplied and AWS (`infra/aws`, [deploy-aws.md](deploy-aws.md)) is not the
production target. Production email is **Amazon SES**: the on-prem host sends
through SES with an IAM user's keys. Both are owner decisions; this checklist
does not reopen them.

Status key: **done** (in the repository and checked), **needs-owner-action**
(the exact step is below; only the owner can do it), **blocked** (waiting on
someone else).

Nothing in this checklist has been deployed. Docker was not running on the
machine where this was prepared, so the stack has been checked with
`docker compose config`, the Compose test and the preflight, not booted.

## What runs

| Service | Image | Role | Health | Restart |
| --- | --- | --- | --- | --- |
| `postgres` | `postgres:16.4-bookworm` | Database, named volume `pgdata` | `pg_isready` | `unless-stopped` |
| `garage` | `dxflrs/garage:v2.4.1` | Private S3 object store (all media), volumes `garage-meta`, `garage-data` | `garage status` | `unless-stopped` |
| `caddy` (profile `edge`) | `caddy:2.10.2` | TLS for `APP_HOST` → web and `MEDIA_HOST` → garage, automatic certificates | admin API | `unless-stopped` |
| `preflight` | culture-atlas | One-shot `pnpm ops:preflight`: refuses unsafe production settings | — | `no` |
| `storage-init` | culture-atlas | One-shot `pnpm ops:storage init`: bucket exists, CORS for the app, write/read/delete probe | — | `no` |
| `migrate` | culture-atlas | One-shot `pnpm db:migrate` (forward-only, checksummed) | — | `no` |
| `web` | culture-atlas | Next.js app, REST, MCP, `/.well-known` files | `GET /v1/health` | `unless-stopped` |
| `worker` | culture-atlas | Jobs, v2 media analysis, Qloo, push ready notices | process up + `select 1` | `unless-stopped` |
| `media-worker` | culture-atlas | ffmpeg verify/prepare/cleanup | `ffprobe` + `select 1` | `unless-stopped` |
| `ops` (profile `ops`) | culture-atlas-ops | `pg_dump` 16 + scripts, for backups and drills | — | `no` |

Start order is enforced: postgres and garage healthy → `preflight` →
`storage-init` → `migrate` → web, worker, media-worker. If the preflight fails,
nothing else starts and its log lists the setting names to fix (never values).

Each service gets only the settings it reads (no blanket `env_file`): SES keys
and the native-link settings reach `web` only; model, Qloo, ElevenLabs and push
keys reach `web` and `worker`; the media worker gets database, storage and
media settings. `scripts/compose-self-host.test.ts` checks that every setting in
the domain and provider config schemas is wired.

**Why Garage and not a local volume.** The task default was the local volume
driver unless the spec says otherwise. The spec does
(`specs/capture-platform-v2/capture-platform.env.example`: `STORAGE_DRIVER=s3`),
and the code refuses the filesystem driver for v2 media in production
(`createMultipartStorage`: "Production media requires private S3 storage").
Garage keeps the S3 API on the owner's hardware. Browsers and phones upload
parts and read media through presigned URLs on `MEDIA_HOST`, so that host needs
https too.

## Checklist

### 1. Host

| Item | Status | Action |
| --- | --- | --- |
| Hardware | needs-owner-action | One Linux host (x86_64 or arm64), 4 vCPU / 8 GB RAM as a starting point (Next.js, two workers, ffmpeg, PostgreSQL, Garage), SSD with room for media (`ACCOUNT_MEDIA_QUOTA_BYTES` is 5 GiB per account) plus at least the same again for local backups. A UPS is strongly advised: one node, no replicas. |
| Docker | needs-owner-action | Docker Engine with the Compose v2 plugin. Enable the Docker service at boot (`systemctl enable --now docker`) so `restart: unless-stopped` brings the stack back after a reboot. |
| Checkout | needs-owner-action | Clone the repository to e.g. `/opt/culture-atlas` (owned by root, mode 0750). `.env` lives next to `docker-compose.yml`, mode 0600. |
| Network | needs-owner-action | Static LAN address for the host; router forwards TCP 80, TCP 443 and UDP 443 to it. Nothing else is exposed: web (3000) and Garage (3900) bind to 127.0.0.1. |
| Clock | needs-owner-action | NTP on (`timedatectl set-ntp true`): SigV4 presigned URLs, sessions and SES requests fail with clock skew. |
| Firewall | needs-owner-action | Allow 80/tcp, 443/tcp, 443/udp and SSH from your admin network only. Docker publishes only those ports plus the two loopback ones. |
| ffmpeg in the image | done | `Dockerfile` runtime stage installs Debian bookworm `ffmpeg`; the media worker self-tests it at startup and its healthcheck runs `ffprobe -version`. |

### 2. `.env` to fill (names only)

Copy `.env.example` to `.env`, `chmod 600 .env`. Never commit it. Quote values
that contain `$` with single quotes (Compose interpolates `$`).

Required (Compose refuses to start without the first group; the preflight
refuses the second):

| Group | Names |
| --- | --- |
| Compose-required | `APP_BASE_URL`, `APP_HOST`, `MEDIA_HOST`, `ACME_EMAIL`, `POSTGRES_PASSWORD`, `SESSION_SECRET`, `STORAGE_SIGNING_SECRET`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `GARAGE_RPC_SECRET`, `GARAGE_ADMIN_TOKEN` |
| Preflight-required | `IDENTITY_MAIL_FROM`, `IDENTITY_MAIL_SES_REGION` (or `AWS_REGION`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`IDENTITY_MAIL_DRIVER` defaults to `ses` in Compose) |
| Live features (missing = that capability honestly `unavailable`) | `CONCENTRATE_API_KEY`, `QLOO_API_KEY`, `ELEVENLABS_API_KEY`, `WIKIMEDIA_USER_AGENT`, `MODEL_DAILY_SPEND_LIMIT_USD`, `MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD`, `MODEL_MAX_UNKNOWN_SPEND_USD` (Compose defaults 5 / 1 / 1) |
| Native app links | `APPLE_TEAM_ID`, `ANDROID_ASSETLINKS_SHA256` |
| Push (when `PUSH_DRIVER=live`) | `PUSH_APNS_TEAM_ID`, `PUSH_APNS_KEY_ID`, `PUSH_APNS_PRIVATE_KEY`, `PUSH_APNS_TOPIC`, `PUSH_FCM_PROJECT_ID`, `PUSH_FCM_CLIENT_EMAIL`, `PUSH_FCM_PRIVATE_KEY`, `CREDENTIAL_ENCRYPTION_KEY` |
| Optional | `COMPOSE_PROFILES` (keep `edge`), `TRUSTED_PROXY_HOPS`, `CLIENT_IP_HEADER`, `CONCENTRATE_CONFIG_DIR`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `BACKUP_OFFSITE_RSYNC`, `ATLAS_RELEASE`, quotas and feature switches from `.env.example` |

Generate secrets on the host (letters and digits for `POSTGRES_PASSWORD`, which
is embedded in a URL):

```sh
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -hex 32      # SESSION_SECRET, STORAGE_SIGNING_SECRET (different values), GARAGE_RPC_SECRET
openssl rand -base64 32   # GARAGE_ADMIN_TOKEN, CREDENTIAL_ENCRYPTION_KEY
```

| Item | Status | Action |
| --- | --- | --- |
| Compose wiring of every setting | done | `docker-compose.yml`; verified by `scripts/compose-self-host.test.ts` and `docker compose config` with a fake `.env`. |
| `.env.example` lists every name Compose reads | done | Test "documents every name Compose reads". |
| Fill `.env` | needs-owner-action | Fill the required names above on the host. `APP_BASE_URL=https://<APP_HOST>`, `S3_ENDPOINT=https://<MEDIA_HOST>`. |
| Concentrate profiles | done (factory pins) / needs-owner-action (own qualification) | Compose mounts `CONCENTRATE_CONFIG_DIR` (default `./fixtures/concentrate`) read-only at `/etc/culture-atlas/concentrate`; `CONCENTRATE_PROFILE_FILE` and `CONCENTRATE_QUALIFICATION_DIR` point inside it. Only `research_text` and `composer` are qualified; photo roles fail closed ([concentrate.md](concentrate.md)). Confirm ZDR on / content logging off for the key in the Concentrate dashboard. |

### 3. Production safety (enforced)

| Item | Status | Action |
| --- | --- | --- |
| `SESSION_SECRET` required | done | Compose `:?` + preflight (≥ 32 chars, not the dev placeholder) + `loadDomainConfig` in the app. |
| `IDENTITY_MAIL_DRIVER=file` refused | done | Preflight fails the whole stack with "refused in production; use ses". (Inside the app `createFileIdentityMail` also throws in production, but `runtime.ts` only logs `identity_mail_misconfigured` and answers sign-in with 503; the preflight turns that into a loud startup failure.) |
| SES required | done | Preflight requires `ses`, a sender, a region and SES credentials. |
| Storage signing secret | done | Compose `:?` + preflight (≥ 32 chars, different from `SESSION_SECRET`). |
| Private S3 storage | done | `STORAGE_DRIVER=s3` fixed in Compose, path style on, https public endpoint checked by the preflight. |
| Migrations before web | done | `migrate` one-shot; web/worker/media-worker wait for it to complete. |
| Healthchecks + restart policies | done | Every long-running service (table above). |
| No replayed Qloo results | done | `QLOO_REPLAY_FIXTURES=false` fixed in Compose; the preflight refuses `true`. Without a key every Qloo capability is `unavailable`; nothing is invented. |
| Plain http not exposed | done | web and Garage bind 127.0.0.1; only Caddy publishes 80/443. |
| Dev database password refused | done | `POSTGRES_PASSWORD` is required; the preflight refuses `culture_atlas:culture_atlas`. |

### 4. Object store (Garage) one-time setup

Status: **needs-owner-action** (Garage has no layout or keys until you create them).

```sh
cd /opt/culture-atlas
docker compose up -d garage
docker compose exec garage /garage status                 # note the node id
docker compose exec garage /garage layout assign -z dc1 -c 500G <node id>   # size of your disk share
docker compose exec garage /garage layout apply --version 1
# App key: Garage generates the id (GK...) and secret; put them in .env as
# S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY. Printed once, keep them out of shell history.
docker compose exec garage /garage key create culture-atlas-app
docker compose exec garage /garage bucket create culture-atlas-media
docker compose exec garage /garage bucket allow --read --write --owner culture-atlas-media --key culture-atlas-app
```

Then `docker compose run --rm storage-init` (also part of every `up`) checks the
bucket, sets CORS for `APP_BASE_URL` (GET/HEAD/PUT, exposes `ETag` for browser
part uploads) and proves write/read/delete. Garage CLI syntax can differ
between releases: check `garage --help` for v2.4.1 if a command is refused.
Bucket versioning is off (Garage default), which matches [privacy.md](privacy.md):
deleted media is gone, not kept as old versions.

### 5. Amazon SES (production email)

| Item | Status | Action |
| --- | --- | --- |
| SES code path | done | `createSesIdentityMail` (SES v2 `SendEmail`); on-prem credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` through the SDK default chain. |
| Verify the sending domain | needs-owner-action | AWS console → SES (region = `IDENTITY_MAIL_SES_REGION`) → Verified identities → Create identity → Domain (the domain of `IDENTITY_MAIL_FROM`). Publish the 3 Easy DKIM CNAME records at your DNS host. Add SPF (`v=spf1 include:amazonses.com ~all`, merged with any existing SPF) and a custom MAIL FROM subdomain (MX + SPF records SES shows). Add DMARC (`_dmarc` TXT, start with `p=none; rua=mailto:<you>`). Wait for "Verified". |
| IAM user for the host | needs-owner-action | Create an IAM user with only `ses:SendEmail` and `ses:SendRawEmail` on `arn:aws:ses:<region>:<account>:identity/<domain>` (add a `ses:FromAddress` condition for the exact sender). Create an access key; put it in `.env` as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Rotate it at least yearly. |
| Leave the SES sandbox | needs-owner-action | SES → Account dashboard → Request production access (transactional, sign-in links only, expected volume, bounce/complaint handling). Until approved, mail only reaches verified addresses. |
| Bounces and complaints | needs-owner-action (recommended) | Create a configuration set with an SNS destination for bounces/complaints; set `IDENTITY_MAIL_SES_CONFIGURATION_SET`. |
| Live send | blocked on the three steps above | After `up`, sign in at `https://<APP_HOST>/identity` with a verified address and confirm the link arrives and works once. |

### 6. DNS and TLS

| Item | Status | Action |
| --- | --- | --- |
| Caddy service and Caddyfile | done | `infra/onprem/Caddyfile`: HSTS, request size limits, SSE-friendly proxying, logs with headers and signed query values removed. Caddy has network aliases for both hosts so containers reach `https://MEDIA_HOST` without hairpin NAT. |
| DNS records | needs-owner-action | A (and AAAA if you have IPv6) for `APP_HOST` and `MEDIA_HOST` → the public address of your site. With a dynamic home IP use your DNS host's dynamic DNS client. |
| Port forwarding | needs-owner-action | Router: 80/tcp, 443/tcp, 443/udp → the host. Caddy needs 80 or 443 reachable for the ACME challenge. |
| Certificates | needs-owner-action (automatic once DNS resolves) | `docker compose logs caddy` shows "certificate obtained" for both hosts. |
| Existing proxy instead of Caddy | needs-owner-action (only if chosen) | Clear `COMPOSE_PROFILES`, terminate TLS for both hosts, forward `APP_HOST` → `127.0.0.1:3000` (keep `X-Forwarded-For`, no response buffering for `/v2/events`) and `MEDIA_HOST` → `127.0.0.1:3900` (preserve `Host`, allow 32 MB bodies). If that proxy runs on another machine set `WEB_BIND_ADDRESS` / `GARAGE_BIND_ADDRESS` to the LAN address and firewall them. Set `TRUSTED_PROXY_HOPS` to the number of proxies that append `X-Forwarded-For`. |
| Secure cookies | done once `APP_BASE_URL` is https | The app sets `Secure` from the `APP_BASE_URL` scheme; the preflight refuses http. |
| `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json` | done (served by web) / needs-owner-action (values) | Route handlers in `apps/web/app/.well-known/`. Set `APPLE_TEAM_ID` (the team that owns the App Store App ID) and `ANDROID_ASSETLINKS_SHA256` (Play App Signing certificate SHA-256, Play Console → App integrity). Check: `curl -s https://<APP_HOST>/.well-known/apple-app-site-association` and `.../assetlinks.json` return JSON over https without a redirect. |

### 7. First start

```sh
docker compose build
docker compose up -d
docker compose ps                        # all long-running services "healthy"
docker compose logs preflight storage-init migrate
curl -fsS https://<APP_HOST>/v1/health
```

Then the release checks from [deploy.md](deploy.md#releasing): a test upload
produces a capture and a job; a photo kept from the iPhone reaches `ready`.

### 8. Backups and restore drill

| Item | Status | Action |
| --- | --- | --- |
| Backup script | done | `infra/onprem/atlas-backup.sh`: `pnpm ops:backup` (consistent `pg_dump` 16 snapshot + object/tombstone inventory) then `pnpm ops:storage mirror` (every Garage object into `<snapshot>/objects` with `objects.sha256`), local retention, optional `rsync` off-host. Runs in the `ops` image (PostgreSQL 16 client). |
| Schedule it | needs-owner-action | root crontab: `15 3 * * * cd /opt/culture-atlas && infra/onprem/atlas-backup.sh >> /var/log/atlas-backup.log 2>&1`. Set `BACKUP_DIR` to a disk other than the one holding the Docker volumes if you can. |
| Off-host copy | needs-owner-action | Set `BACKUP_OFFSITE_RSYNC` (another machine or NAS reachable by SSH key), or copy `BACKUP_DIR` off-site by other means. One node with no replicas: without an off-host copy a disk failure loses everything. Backups contain private media and email addresses: encrypt the off-site copy. |
| Restore drill | needs-owner-action (before go-live, then quarterly) | [runbooks/restore-drill.md](runbooks/restore-drill.md) "On-prem (Compose)": restore the latest snapshot into a new empty database and verify every object by size and SHA-256. `scripts/restore-drill.test.ts` already runs the full path with real `pg_dump`/`pg_restore` in CI. |
| Garage metadata snapshots | done | `metadata_auto_snapshot_interval = "6h"` in `infra/onprem/garage.toml`. |

### 9. Monitoring and logs

| Item | Status | Action |
| --- | --- | --- |
| Container logs | done | json-file driver, 20 MB × 5 files per service. `docker compose logs -f web worker media-worker`. Application logs redact tokens, cookies and signed URLs (`logEvent`). |
| Health | done | `docker compose ps` shows health; restarts are automatic. |
| External uptime check | needs-owner-action | Point an external monitor (any uptime service) at `https://<APP_HOST>/v1/health` and alert by email/phone. |
| Disk space | needs-owner-action | Alert at 80 % on the Docker volume disk and `BACKUP_DIR` (e.g. a cron `df` check that mails you). |
| Queue, cleanup and spend metrics | needs-owner-action (optional) | `docker compose --profile ops run --rm ops pnpm ops:metrics` prints one JSON line (CloudWatch Embedded Metric Format, counts only). On AWS the log driver ships it to CloudWatch; on-prem run it from cron and alert on it with your own tooling, or rely on the health endpoint, logs and the runbooks. |
| Model spend | done (ceilings) / needs-owner-action (review) | Ledger ceilings `MODEL_*_SPEND_LIMIT_USD` stop dispatch; review the Concentrate dashboard weekly. |
| Runbooks | done | [runbooks/README.md](runbooks/README.md): replace `atlas-ops <command>` with `docker compose --profile ops run --rm ops <command>`. |

### 10. Content and rights

| Item | Status | Action |
| --- | --- | --- |
| Qloo image and metadata display rights | blocked (Qloo) | [capability-matrix.md](capability-matrix.md): "May provider images/metadata be displayed publicly?" is **pending**. Until Qloo confirms in writing, a public launch shows only https image URLs Qloo returned under the hackathon terms or project-original sample files; artists and films get the typographic poster, never a fake portrait. Ask Qloo for public-display and response-storage permission and record the answer in the capability matrix. |
| Qloo key | needs-owner-action | `QLOO_API_KEY` is the hackathon key; confirm it may serve a public production app and its rate limits (`QLOO_MAX_CONCURRENCY` default 3). |
| No invented results | done | Missing keys keep capabilities `unavailable`; `QLOO_REPLAY_FIXTURES` is forced off. |

### 11. App Store and Google Play

| Item | Status | Action |
| --- | --- | --- |
| iOS privacy answers | done (draft) | `apps/ios/store/privacy-nutrition.json` (public build, no Meta SDK). |
| iOS App Store App ID `com.cultureatlas.app` | blocked | [native.md](native.md): Xcode reports the identifier is not available to team `U9XG3X374H`. Register it under the owning team (or choose a new bundle id and update `STORE_BUNDLES` in the AASA route), enable Associated Domains and Push. |
| iOS listing assets | needs-owner-action | Not in the repository: screenshots (6.9" and 6.5" iPhone), app description, keywords, support and privacy-policy URLs (the privacy URL must be https on `APP_HOST` or another site). |
| Android data safety | done (draft) | `apps/android/play/data-safety.json`. |
| Android icon | done | `apps/android/play/icon-512.png`. |
| Android listing assets | needs-owner-action | Not in the repository: feature graphic 1024×500, phone screenshots, short/full description. |
| Android upload key / Play App Signing | needs-owner-action | Upload keystore is not in the repo ([native.md](native.md)). Create it, enroll in Play App Signing, put the app signing SHA-256 in `ANDROID_ASSETLINKS_SHA256`. The current `.aab` is a debug build with a tunnel API host: rebuild for release. |

### 12. Native apps point at the on-prem host

| Item | Status | Action |
| --- | --- | --- |
| iOS host | needs-owner-action | Release builds use `ATLAS_API_HOST = app.cultureatlas.com` (`apps/ios/Config/Base.xcconfig`, `Release.xcconfig`) and `applinks:app.cultureatlas.com` (`CultureAtlas.entitlements`). Either make `APP_HOST=app.cultureatlas.com` (DNS for that name → your site) or change both to your `APP_HOST` and rebuild. |
| Android host | needs-owner-action | `atlasApiHost=app.cultureatlas.com` in `apps/android/gradle.properties` (manifest App Links host and `BuildConfig.ATLAS_API_HOST`). Same choice: point that name at the site, or build with `-PatlasApiHost=<APP_HOST>`. |
| Universal links / App Links verify | blocked on DNS + TLS + the values in section 6 | Apple and Google fetch the association files only from the real https host. |

## Not verified here

- The stack was not booted: Docker was not running on the machine where this
  was prepared. Checked instead: `docker compose config` with a fake `.env`,
  `scripts/compose-self-host.test.ts`, `scripts/production-env.test.ts`,
  `scripts/object-store.test.ts`, `pnpm build`, typecheck and lint.
- Garage `v2.4.1` was not run; its CLI commands above follow Garage's
  documented syntax. Caddy, SES, DNS, certificates and a real backup/restore
  on the host are untested until the owner performs the steps above.
