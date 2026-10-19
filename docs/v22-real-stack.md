# Running the amendment 2.2 journeys on the real stack

`apps/web/e2e/real/v22-journey.spec.ts` drives spec amendment 2.2 (taste
onboarding, the seeded feed, fast two-stage analysis, While we look, the ready
notice and Settings → Taste) against the running app, job worker and media
worker. There are no `/v1` or `/v2` mocks. It runs at 1440, 390 and 320 px
(`apps/web/playwright.real-v22.config.ts`).

## Provider stand-ins (no live keys)

No live key is needed or read, and nothing leaves the machine:

- **Qloo:** `scripts/e2e/fake-qloo.ts`, a local HTTP server behind the real
  Qloo adapter (`QLOO_API_URL=http://127.0.0.1:4410`). Request shaping,
  parsing, the shared in-flight cap, retries, the circuit breaker and the seed
  job's request limits all run for real; only the upstream is replaced. Every
  id it returns starts with `FIXTURE-`. Insights names start with "Fixture".
  Search and tag lookups echo the queried name, so the compiler's name checks
  can accept them. `POST /__fake/mode {"mode":"down"}` turns every route into
  HTTP 503 with `Retry-After: 3`, and `GET /__fake/stats` reports counts and
  the peak number of requests in flight.
- **Vision model:** the worker starts from `apps/worker/src/e2e-fake-models.ts`
  instead of `src/main.ts`. It replaces only the Concentrate gateway's HTTP
  transport with an in-process function. This keeps the gateway, the spend
  ledger, account-only model identity, the two-call budget and the stage-2
  planning real. The stand-in returns a fixed quick read ("Sesame noodle
  supper", after 6 s) and a fixed enrichment (after 2.5 s) for the test photo.
  The entry refuses to start with `NODE_ENV=production`.

Screenshots from this journey (`apps/web/e2e/screenshots/real-v22-*.png`)
therefore show fixture names. They are test data, not Qloo or model results.

## What it covers

1. **Main journey:**
   - an anonymous visitor browses, opens a labeled example and is never sent
     to `/welcome/taste`;
   - sign-up leads to the questionnaire;
   - the visitor picks an image, a Wear chip and a live search result, and
     adds one exclusion. Build my feed stays disabled, with its reason, until
     the third pick;
   - Building your feed hands over to a personal Discover that shows seeded,
     Qloo-backed cards;
   - the visitor uploads a photo and sees While we look from their feed,
     followed by the two-stage reading and its sections;
   - a second photo is uploaded and the visitor leaves for Collections. The
     toast "Your photo is ready" opens the result;
   - in Settings → Taste the visitor removes one pick and adds another.
2. **Qloo unavailable (ONB-03):**
   - onboarding completes from the cached catalog;
   - search says "Search is taking a break. Pick from the ideas above.";
   - screen 15 says "We'll keep building in the background.";
   - the seed job reports `retrying` and nothing is invented. Once Qloo is
     back, a retry publishes the seeded categories.
3. **Existing account (ONB-06):** an account without onboarding state (as
   before 2.2) and with fewer than 3 saves is sent to the questionnaire at
   sign-in. After completing it, the next sign-in goes straight to the app.
   This variant needs `E2E_DATABASE_URL` to remove the onboarding row.

## Commands

The web app runs under `next dev`. A production build refuses local media
storage (v2 needs S3; see [v2-real-stack.md](v2-real-stack.md)). Under
`next start`, `/v2/capabilities` would answer 503 here.

```sh
service postgresql start
su postgres -c "psql -c 'CREATE DATABASE ca_e2e_v22 OWNER culture_atlas'"
export DATABASE_URL=postgres://culture_atlas:culture_atlas@localhost:5432/ca_e2e_v22
export APP_BASE_URL=http://localhost:3220 SESSION_SECRET=<32+ random chars>
export CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
export STORAGE_DRIVER=local STORAGE_LOCAL_DIR=$PWD/.data/e2e-v22-objects
export IDENTITY_MAIL_DRIVER=file IDENTITY_MAIL_FILE_DIR=$PWD/.data/e2e-v22-mail
# Stand-ins only: never point these at live keys for this journey.
export QLOO_API_KEY=e2e-fake QLOO_API_URL=http://127.0.0.1:4410
export CONCENTRATE_API_KEY= MODEL_FALLBACK= ELORIAN_API_KEY= ANTHROPIC_API_KEY=
pnpm db:migrate
pnpm exec tsx scripts/e2e/fake-qloo.ts --port 4410 &
(cd apps/web && pnpm exec next dev --port 3220) &
(cd apps/worker && pnpm exec tsx src/e2e-fake-models.ts) &
pnpm media-worker &
cd apps/web && E2E_BASE_URL=http://localhost:3220 E2E_DATABASE_URL=$DATABASE_URL \
  pnpm test:e2e:real:v22
```

The worker loads the repository `.env` (`loadRootEnv`), but variables that are
already set win. That is why the commands above set the provider variables
explicitly, some of them to empty values.

## Result (October 19, 2026)

All 9 runs pass: 3 tests at each of 1440, 390 and 320 px. The journey found
three integration bugs, now fixed (see [the gap report](v2-gap-report.md),
section 9):

- tag picks were not used as seed signals;
- an open Qloo circuit made the seed give up;
- under a qualified gateway, an anonymous example would have failed instead of
  replaying.

The second upload uses a different photo on purpose: uploading the same bytes
again reuses the finished capture, so nothing would be left to wait for.
