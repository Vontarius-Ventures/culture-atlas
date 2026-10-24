# Deploying culture atlas on AWS (small, credit-funded shape)

> **Reference only.** Production is on-prem Compose on the owner's hardware
> ([deploy.md](deploy.md), [production-readiness.md](production-readiness.md)).
> The SES section below still applies: on-prem identity mail is Amazon SES.

Status: **written and statically tested, never deployed.** Nothing in this
repository has created AWS resources. The CloudFormation template, Compose
file and host scripts are checked by `scripts/aws-infra.test.ts` (parsing,
security and cost invariants, shell syntax, the SSM-to-env renderer against a
fake AWS CLI) and `docker compose config`. They have not been run through
`cfn-lint`, a real `aws cloudformation deploy`, or a Docker image build in
this environment. Treat the first deploy as a staging exercise.

## Can it run for free?

**No, not at USD 0 on any AWS account today (October 2026).** It can run on
AWS credits for a limited trial, and then it bills. The terms below were
written without access to AWS documentation (no network in this environment),
so **verify them on the AWS Free Tier page and in your Billing console before
you deploy**:

- **Legacy Free Tier (accounts created before 15 July 2025): no longer
  available to anyone.** It lasted 12 months from account creation, so every
  such account lost it by 14 July 2026 at the latest. While it existed it
  would have covered this stack (one t3.micro, one db.t4g.micro, 20 GB disks,
  5 GB of S3, public IPv4 hours); that is why the stack is sized this way.
  Older accounts now pay the "after free tier" column below.
- **Credit-based Free plan (accounts created on or after 15 July 2025):** new
  accounts receive AWS credits (we assume about USD 100 at sign-up plus up to
  USD 100 for onboarding activities) usable for a limited period (we assume
  6 months). EC2, RDS and public IPv4 hours are **paid from those credits**,
  not free. At on-demand prices this stack costs roughly USD 15 a month with
  `DatabaseMode=instance` and USD 27 with RDS (table below), so the credits
  fund a trial of a few months. When the Free plan period ends (or the
  credits run out) you must upgrade to a paid plan, and the stack then bills
  about USD 15-27 a month, or the account is closed.
- Some allowances have historically been free for every account ("always
  free"): 100 GB/month of data transfer out to the internet, CloudWatch 10
  custom metrics, 10 alarms and 5 GB of log ingestion, SNS 1,000 email
  notifications, SSM Parameter Store standard parameters, and the first two
  AWS Budgets. This stack stays inside those: 9 custom metrics, 9 alarms
  watching 10 metrics, 14-day log retention. They reduce the bill; they do
  not make the stack free, because the instance, its public IPv4 address and
  the database are not in them.

So for the request "host it on AWS if it can run free": it cannot run free
indefinitely. The cheapest honest option is a new account's Free plan credits
with `DatabaseMode=instance` (about USD 15 a month of credits), deciding
before the credits end whether to pay about USD 15 a month or shut it down.
The 1 USD budget below emails you as soon as anything is billed, and when the
month is forecast to pass 1 USD.

## What you get

```
             Internet
                │ 80/443 (no SSH; admin via SSM Session Manager)
        ┌───────▼──────────────── EC2 t3.micro (Ubuntu 24.04, 2 GiB swap) ─┐
        │ Caddy (HTTPS, Let's Encrypt) ──► web (Next.js)                     │
        │ worker (analysis/plans)   media-worker (verify, ffmpeg, cleanup)   │
        │ [postgres 16 container if DatabaseMode=instance]                   │
        │ timers: ops metrics every 5 min, nightly logical backup            │
        └──────┬──────────────┬──────────────────┬──────────────────────────┘
               │ 5432 (VPC)   │ S3 gateway        │ awslogs
     RDS PostgreSQL 16   private S3 bucket   CloudWatch Logs → metric filters → alarms → SNS email
     db.t4g.micro        versioned, AES256    (/culture-atlas/<env>, 14 days)
     (DatabaseMode=rds)  lifecycle rules
                         SSM Parameter Store /culture-atlas/<env>/ (config + SecureString secrets)
                         AWS Budgets 1 USD
```

Files: `infra/aws/culture-atlas.yaml` (CloudFormation),
`infra/aws/compose.yml`, `infra/aws/Caddyfile`, `infra/aws/bin/*` (host
tools), `infra/aws/systemd/*` (timers), `infra/aws/ship.sh` (release upload).

Security choices:

- Inbound only TCP 80/443 and UDP 443. No SSH port: shells use SSM Session
  Manager. IMDSv2 required. EBS and RDS encrypted.
- The instance role can read and write only `accounts/*` and `owners/*`
  objects, read `deploy/*`, write (not read or delete) `backups/*`, read only
  its own `/culture-atlas/<env>/` parameters, decrypt only through SSM, write
  only its log group, and send email only as the SES identity you name.
- The bucket blocks all public access, enforces TLS, encrypts by default and
  keeps previous object versions for 30 days (restore window, bounded).
- Secrets live only in SSM SecureString parameters you create; CloudFormation
  never sees them. RDS reads its password through a `ssm-secure` dynamic
  reference.
- CPU credits are pinned to `standard`: bursts are throttled, never billed.

## Costs

Prices are approximate us-east-1 on-demand list prices remembered from
before this was written; **check the AWS pricing pages**.

| Item | Legacy Free Tier (ended for every account by July 2026; for reference) | Credit-based Free plan (paid from credits) / after free tier | Can bill when |
| --- | --- | --- | --- |
| EC2 t3.micro, 730 h | free (750 h) | ≈ USD 7.60/month | always on new plan; >750 h or larger type on legacy |
| EBS gp3 20 GB root | free (30 GB) | ≈ USD 1.60/month | above 30 GB in total, snapshots |
| Public IPv4 (Elastic IP) | free (750 h) | ≈ USD 3.65/month (USD 0.005/h) | always on new plan |
| RDS db.t4g.micro + 20 GB gp2 (`DatabaseMode=rds`) | free (750 h, 20 GB, 20 GB backups) | ≈ USD 12-14/month | backups over 20 GB, storage growth, the final snapshot kept after stack deletion |
| PostgreSQL on the instance (`DatabaseMode=instance`) | free | free (uses the instance) | never; but no PITR, only nightly dumps |
| S3 (media, versions, backups, release bundles) | 5 GB free | ≈ USD 0.023/GB-month | above 5 GB; previous versions count for 30 days; each release bundle (~0.5-1 GB) for 14 days |
| S3 requests | 20k GET / 2k PUT free | ≈ USD 0.005 per 1k PUT | heavy uploads (multipart parts are PUTs) |
| Data transfer in | free | free | never |
| Data transfer out (video playback, downloads) | 100 GB/month free (all accounts, assumed) | USD 0.09/GB after 100 GB | **the most likely cost**: 100 GB is about 2,000 plays of a 50 MB video |
| EC2 ↔ S3 / RDS in the same region | free (S3 gateway endpoint, same AZ for RDS assumed) | free | cross-AZ RDS traffic is about USD 0.01/GB |
| CloudWatch: 9 metrics, 9 alarms, logs | free (assumed always-free 10/10/5 GB) | free within those | log volume above 5 GB/month; extra metrics or alarms |
| SNS email, SSM standard parameters, Budgets (2) | free | free | never at this size |
| SES email | legacy: 3,000/month free for 12 months (assumed) | USD 0.10 per 1,000 | rarely matters |
| Video transcoding CPU | no extra charge | no extra charge | never billed (standard credits); it just gets slow, see below |
| Model/Qloo providers | not AWS | not AWS | billed by those providers |
| Domain name | not AWS (or Route 53 ≈ USD 0.50/zone/month + registration) | | optional; sslip.io works without one |

Rough monthly totals today: **≈ USD 15 with `DatabaseMode=instance`, ≈ USD 27
with RDS**, paid from Free plan credits while they last and billed after
that. The legacy free tier's ≈ USD 0 no longer applies to any account.

## Limits of a micro instance (read before enabling video)

A t3.micro has 2 vCPUs, 1 GiB of RAM and a 10 % per-vCPU CPU baseline. It
earns 12 CPU credits an hour (one credit = one vCPU at 100 % for one minute)
and can bank at most 288. With `standard` credits it never bills extra; when
the bank is empty it is throttled to the baseline.

Estimates, not measurements (the media worker's qualification step measures
the real numbers on your instance):

- Transcoding a 60 s 1080p phone video to H.264 at a fast preset on 2 vCPUs
  takes roughly 1-2 minutes at full speed, i.e. 2-4 credits. Sustained, the
  host can prepare only a handful of such videos per hour from earned credits,
  and the web server needs some credits too.
- With the bank empty a transcode runs about 10× slower (10-20 minutes),
  which misses the 120 s preparation target in BUILD-AND-ACCEPTANCE.md. The
  `CpuCreditsLow` alarm tells you when this happens.
- ffmpeg plus Next.js plus PostgreSQL does not fit in 1 GiB without swap. The
  stack creates a 2 GiB swap file and caps each container; preparation runs
  one job at a time (`MEDIA_WORKER_CONCURRENCY=1`).
- Photos are cheap (sharp, well under a second each).

Mitigations, in order: keep `CAPTURE_VIDEO_MAX_DURATION_SECONDS` short
(30-60 s); let the media worker remux instead of re-encode when the input is
already a qualified H.264/AAC MP4; turn video off with the kill switch while
the bank refills (`pnpm ops:kill kill camera_video` and `file_video_upload`);
or use `InstanceType=t3.small` (2 GiB, about twice the price, and not free on
every plan).

## Step by step

All commands run on your computer with AWS CLI v2 configured for the target
account (`aws sts get-caller-identity` works) and Docker with buildx. Pick a
region and keep it: `export AWS_REGION=us-east-1`.

### 1. Secrets (SecureString parameters)

Create these before the stack. Replace `prod` if you use another
`EnvironmentName`. Values never go in the template or in git.

```sh
P=/culture-atlas/prod
aws ssm put-parameter --name $P/SESSION_SECRET --type SecureString --value "$(openssl rand -base64 48 | tr -d '\n')"
aws ssm put-parameter --name $P/CREDENTIAL_ENCRYPTION_KEY --type SecureString --value "$(openssl rand -base64 32)"
# Letters and digits only: the env renderer refuses quotes and newlines.
aws ssm put-parameter --name $P/DB_PASSWORD --type SecureString --value "$(openssl rand -hex 24)"
# Optional provider keys, same pattern:
#   $P/QLOO_API_KEY, $P/CONCENTRATE_API_KEY, $P/PUSH_APNS_PRIVATE_KEY, ...
```

Any other setting from `.env.example` can be added the same way (String for
non-secrets). The instance reads everything under `/culture-atlas/prod/`.

### 2. Email sender (optional but needed for sign-in)

Verify a domain or address in Amazon SES (console → SES → Verified
identities). New SES accounts are in the sandbox and can only send to
verified addresses; request production access before inviting real users.
Without this, leave `MailFrom`/`SesIdentity` empty: email sign-in then fails
closed with 503 instead of pretending to send.

### 3. Create the stack

```sh
aws cloudformation deploy \
  --stack-name culture-atlas-prod \
  --template-file infra/aws/culture-atlas.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    EnvironmentName=prod \
    AlertEmail=you@example.com \
    DomainName=atlas.example.com \
    DatabaseMode=rds \
    MailFrom='culture atlas <no-reply@example.com>' \
    SesIdentity=example.com
```

- `DatabaseMode=instance` skips RDS (cheapest on the credit-based plan).
- Leave `DomainName` empty to start on `https://<elastic-ip>.sslip.io`.
- Confirm the SNS subscription email AWS sends to `AlertEmail`, or alarms
  will not reach you. The budget emails do not need confirmation.

Outputs: `aws cloudformation describe-stacks --stack-name culture-atlas-prod --query 'Stacks[0].Outputs'`.

### 4. DNS

Create an A record for `DomainName` pointing at the `PublicIp` output. Caddy
obtains the certificate on the first request once DNS resolves.

### 5. Ship a release

```sh
STACK=culture-atlas-prod infra/aws/ship.sh
```

It builds the `runtime` and `ops` images for linux/amd64 locally (the
1 GiB instance cannot build Next.js), uploads them with the host bundle to
`s3://<bucket>/deploy/<git sha>/`, and runs `atlas-deploy <sha>` on the
instance through SSM Run Command. The installer renders `.env` from SSM,
starts PostgreSQL in instance mode, runs migrations, starts Caddy, web,
worker and media worker, enables the metrics and backup timers, and keeps
the previous release's images for rollback.

Note: the `media-worker` service runs `pnpm media-worker`, which arrives with
the capture v2 media work (branch `v2/media`). Ship from a tree that includes
it, or uploads stay in "verifying".

### 6. Check it

```sh
curl -fsS https://atlas.example.com/v1/health
aws ssm start-session --target <InstanceId>      # shell, no SSH
sudo docker compose -f /opt/culture-atlas/compose.yml --env-file /opt/culture-atlas/compose.env ps
sudo atlas-ops pnpm ops:metrics                   # one snapshot
```

Then sign in through `/identity` with your email.

## Operating the host

- Logs: CloudWatch Logs group `/culture-atlas/prod`, one stream per container.
- Operator commands: `sudo atlas-ops <command>` (see docs/runbooks/README.md),
  e.g. `sudo atlas-ops pnpm ops:kill list`, `sudo atlas-ops psql`.
- Settings change: update the SSM parameter, then `sudo atlas-reload`
  (re-renders `.env` and recreates the services; no download).
- Rollback: `sudo atlas-deploy <previous sha>`. The previous release's images
  and bundle stay on the host, so this works after the S3 copy expired.
- Backups: RDS keeps 7 days of automated backups and point-in-time recovery
  (rds mode). Every night `atlas-backup` also writes a logical snapshot and
  object inventory to `s3://<bucket>/backups/` (30-day lifecycle). Media
  objects are protected by bucket versioning (30 days). Practise restores with
  docs/runbooks/restore-drill.md.
- OS updates: Ubuntu unattended-upgrades is installed for security updates.
- Instance failure: the `InstanceStatusCheck` alarm triggers EC2 auto-recovery
  (same disk, same IP). If the instance is replaced, user data reinstalls
  Docker and redeploys the release named in `deploy/current.txt` (release
  bundles expire after 14 days; re-run `ship.sh` if it is gone).

## Tear down

```sh
aws cloudformation delete-stack --stack-name culture-atlas-prod
```

RDS has deletion protection and a final snapshot, and the bucket is retained,
so your data survives a mistaken delete. Both keep costing money until you
remove them yourself: disable deletion protection and delete the RDS instance
and its final snapshot, empty and delete the bucket (including previous
versions), and delete the `/culture-atlas/prod/` parameters.

## Known gaps

- Not validated against AWS: no `cfn-lint`, no real deploy, no image build
  here. Expect small fixes on first use.
- The `staging-objects` lifecycle rule matches objects tagged
  `atlas-lifecycle=staging`. The S3 multipart adapter does not tag staging
  uploads yet; until it does, staging cleanup relies on the 1-day
  incomplete-multipart rule and the media worker's reconciliation.
- Concentrate analysis readiness must be injected into the web runtime
  (`CaptureV2Runtime.analysisReadiness`) for `concentrate_analysis_enabled`
  to turn on; until then analysis is reported unavailable.
- One instance means no high availability; deploys restart services (seconds
  of downtime). The 99.9 % SLO target is not achievable on this shape.
- The Render blueprint (`render.yaml`, docs/deploy.md) remains supported as an
  alternative host.
