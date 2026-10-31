# Fidelity / real-stack fixture repair

## Follow-up: live production fidelity validated (2026-10-27)

This section supersedes the earlier unvalidated runtime instructions/status
below. **All 30 fidelity cases now pass** against the coordinator's already
running production build over loopback HTTPS (desktop, mobile, narrow;
one worker; 28.6 seconds). No production source/build/service was changed.

### Actual live mismatch

The first failed production trace returned an example feed at taste revision
17 with 12 standard example cards on page 1, beginning with Sesame noodles.
The database contained the correctly seeded eight-card snapshot at revision
16. Subsequent fixture logins produced revisions 18 and 19; there were **zero
jobs** for this account. `COMPILER_VERSION` was the expected
`compiler-2026-10-27-qloo-native-v6`; this was not compiler invalidation,
worker seeding, an auth failure, or a wrongly named selector.

`accounts.claimSession` unconditionally advances the account taste revision,
including when claiming an empty anonymous session. Fidelity's `GET /session`
followed by sign-in omitted `claim_session`, whose real API default is true.
Each fresh Playwright context therefore invalidated the curated snapshot.
The old unit tests read the feed directly as an account and never exercised
this actual anonymous-to-account setup flow.

### Truthful test-only correction

- The seed now exports and writes `sign_in: { claim_session: false }`.
- Fidelity sign-in uses that existing API option: there is no anonymous
  history to import into a curated rendering fixture.
- No production cache invalidation was changed, no taste counter was reset,
  and no future-revision snapshots or provider origins were fabricated.
- Success sign-in response bodies are no longer used as assertion messages,
  avoiding accidental exposure of CSRF/session metadata in diagnostics.
- Seed regression tests now own a separately created isolated database and
  construct contexts with the **real production configuration loader**,
  production mode, HTTPS application origin, normal compiler default, and
  `surface='web'`. Only provider transports are fake.
- The new regression signs in three fresh anonymous contexts with the seeded
  no-claim option and proves all select the same eight-card snapshot at the
  unchanged revision. It then explicitly exercises `claim_session:true` and
  proves the original invalidation/fallback still occurs correctly.

Reseeded **only** `ca_team_fidelity_1793108356230`, using the supplied
`team-runtime/fidelity.env`. After the complete browser matrix, sanitized
database evidence is: current revision **16**, seeded snapshot revision **16**,
**8** cards, `is_example_feed=true`, **0** owner jobs. The preserved sample
origins and evidence/provenance gates remain untouched.

### Exact validation and artifacts

From `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration`:

```sh
pnpm exec vitest run scripts/seed-fidelity.test.ts --project node
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec tsc -p apps/web/tsconfig.json --noEmit --incremental false
pnpm exec eslint scripts/seed-fidelity.ts scripts/seed-fidelity.test.ts apps/web/e2e/fidelity/v1-and-account.spec.ts
```

Results: **6/6 production-shaped seed tests pass**, both typechecks pass,
scoped lint and `git diff --check` pass. The test creates/drops only its own
new `ca_fidelity_*` database; no default/evaluation database was mutated.
Coordinator changes to `real-stack-fixtures.test.ts` were preserved.

Runtime command used (the services were already running and remain so):

```sh
REPO=/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
R=/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/run
ENV_FILES="$R/team-runtime/fidelity.env" \
NODE_EXTRA_CA_CERTS="$R/team-runtime/tls/localhost.crt" \
E2E_BASE_URL=https://127.0.0.1:4473 \
FIDELITY_SEED="$R/team-runtime/fidelity-seed.json" \
node "$R/launch.mjs" "$REPO/apps/web" pnpm exec playwright test \
  -c "$R/team-runtime/playwright.fidelity.config.ts" \
  --output "$R/team-runtime/fidelity-results-v2" \
  > /tmp/culture-atlas-team-fidelity-v2.log 2>&1
```

Result: **30 passed (28.6s), exit 0**, no skips. Original failed traces in
`$R/team-runtime/fidelity-results` and the earlier failure log were preserved.
New results are in `$R/team-runtime/fidelity-results-v2`; the reseed log is
`/tmp/culture-atlas-team-fidelity-reseed-v2.log`. The private
`$R/team-runtime/fidelity-seed.json` was regenerated, not printed.

Follow-up source/report paths changed:

- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/scripts/seed-fidelity.ts`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/scripts/seed-fidelity.test.ts`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/fidelity/v1-and-account.spec.ts`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/prp/2026-10-23-style-analysis/team-fidelity.md`

The normal screenshot outputs were regenerated under
`/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/screenshots/fidelity/v1-and-account/`:
`01-discover`, `02-collection`, `03-plan`, `05-save`, `06-item`,
`07-collections`, `10-agents`, `11-agent-permission`,
`12-collection-share`, and `13-shared-collection`, each with
`-desktop.png`, `-mobile.png`, and `-narrow.png` (30 PNGs).

**Remaining fidelity blockers: none.** Fidelity does not rely on Qloo or
queued seed work. Main retains ownership of the real v22 suite and services;
its results/other production-copy decisions are not claimed by this follow-up.
No paid calls, service restarts, shared `.next` writes, commits, or deployment.

## Historical first-pass handoff

## Root causes and truthful fixes

1. **Fidelity Discover / Save:** `seed-fidelity.ts` stored illustrative
   `origin='sample'` related-discovery rows. `buildSavedPool` correctly excludes
   those ordinary related jobs; the resulting empty personal pool fell back to
   the normal reviewed examples, beginning with Sesame noodles. Vintage racing
   was therefore absent, not a flaky Save control.

   The seed now writes an account-scoped, current-taste-revision
   **`is_example_feed=true` curated snapshot**, including category snapshots,
   containing exactly the eight mockup cards. Every card retains
   `display_metadata.example=true`; no provider queries, Qloo/replay origins,
   invented taste connections, or production admission changes are added.
   The former fabricated feed discovery-job contexts are removed. Related
   examples on the item page and sample plan picks remain honestly `sample`.
   This is explicitly rendering-fixture coverage, not evidence that these
   fictional cards belong in a generated personal recommendation pool.
   Snapshots expire after the ordinary 24 hours. Reseed immediately before
   fidelity runs; Refresh or a taste mutation intentionally restores the
   normal generated feed.

2. **Real v22 upload:** the old selector is still correct:
   `CaptureResultView.tsx` renders `CardGrid label="Discoveries from your photo"`.
   The retained desktop trace proves an actual empty terminal response for
   capture `f3f86cfe-9395-4286-9862-d0c0cdfbecc3`:
   `status=partial`, `recommendations=[]`, `style_reading=null`;
   sections `style=failed`, `wear/eat=skipped`, `play/watch=empty`.
   The error-context screenshot likewise shows empty-category notices, not
   cards under a renamed list.

   The test-only fake worker previously supplied only `vision_photo` and
   `vision_photo_enrich`. It now also supplies the current independent
   `vision_style` wire contract: one food subject, “Bowl of noodles”, visible
   observations, no invented fashion/music aesthetics. The fixture gateway
   receives an explicitly synthetic price catalogue so the real style
   spend-cap check can run; no real qualification artifact or gate changes.
   The fake Qloo adds a fixed fictional **Fixture Noodle Makers** documentary
   with its own Documentary/Cooking tags and this returned short description:
   “The documentary follows cooks preparing noodles and explores the craft of cooking.”
   The real compiler admits that candidate using `about_subject` and the
   candidate-owned content excerpt, rejecting the unrelated untagged films.
   Its reason is “A documentary exploring cooking”.
   These are fictional upstream stand-ins only, never relabeled sample data.

   The browser journey now first requires API data containing that real
   fixture subject and useful card, then requires the rendered card in the
   existing list. An empty terminal result still fails.

## Files changed

Relative to `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration`:

- `scripts/seed-fidelity.ts`
- `scripts/seed-fidelity.test.ts` (new)
- `scripts/e2e/fake-qloo.ts` (test-only helper)
- `scripts/e2e/real-stack-fixtures.test.ts` (new)
- `apps/worker/src/e2e-fake-models.ts` (related test-only worker entry/helper)
- `apps/web/e2e/fidelity/v1-and-account.spec.ts`
- `apps/web/e2e/real/v22-journey.spec.ts`
- this report

No production admission/provenance files, other agents' work, shared `.next`
output, old evaluation databases, credentials, privileges, or counters were
changed. No Next server/build, paid call, commit, push, or deployment was run.

## Checks completed

All commands run from the worktree root:

```sh
pnpm exec vitest run scripts/seed-fidelity.test.ts scripts/e2e/real-stack-fixtures.test.ts --project node
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec tsc -p apps/web/tsconfig.json --noEmit --incremental false
pnpm exec eslint scripts/seed-fidelity.ts scripts/seed-fidelity.test.ts scripts/e2e/fake-qloo.ts scripts/e2e/real-stack-fixtures.test.ts apps/worker/src/e2e-fake-models.ts apps/web/e2e/fidelity/v1-and-account.spec.ts apps/web/e2e/real/v22-journey.spec.ts
```

Results: **7/7 tests pass**, script/web typechecks pass, scoped lint and
`git diff --check` pass. Vitest created/migrated/dropped only its new isolated
per-run test databases. The seed tests cover eight ordered labeled cards,
no personal-pool promotion, sample-only related origins, no provider query
claims, category filters, pagination, item detail/related examples, owner
isolation, and normal expiry. The real-stack helper test uses the actual
worker/compiler, PostgreSQL spend ledger, structured model gateway, Qloo
HTTP request builder/parser, and provider DTOs, with both upstream transports
in-process and no external network.

## Coordinator-only integrated runtime validation

**Not yet run.** First finish the UI agent's changes, then do the single
coordinated build/start. Do not start a second build/server against shared
`.next`. Use existing installed Playwright browsers; no installation needed.

Prerequisites: PostgreSQL role with the existing test `CREATEDB` capability;
the local S3-compatible service at `127.0.0.1:4679` and bucket `ca-v4-fixtures`
from the retained v4 setup; its private credentials/configuration; available
ports 4072 and 4470. The fixture worker must use `NODE_ENV=development`
(its production refusal is deliberate), while the web server may use the
coordinator's production build with `NODE_ENV=production`.

Create a new dedicated database and a private override env file, rather than
altering `culture_atlas`, `ca_r3_new`, or the retained old runs. This command
does not print the connection string or credentials:

```sh
ROOT=/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
SCR=/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run
BASE="$SCR/run/v4-real/fixtures.env"
RUN=$(mktemp -d /tmp/ca-team-fidelity.XXXXXX)
export BASE RUN
cd "$ROOT"
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
const base = parseEnv(readFileSync(process.env.BASE, 'utf8'));
const name = `ca_team_fidelity_${Date.now()}`;
const admin = new pg.Client({ connectionString: base.DATABASE_URL });
await admin.connect();
try { await admin.query(`CREATE DATABASE "${name}"`); }
finally { await admin.end(); }
const url = new URL(base.DATABASE_URL);
url.pathname = `/${name}`;
writeFileSync(`${process.env.RUN}/isolated.env`, [
  `DATABASE_URL=${url}`,
  `E2E_DATABASE_URL=${url}`,
  'APP_BASE_URL=http://127.0.0.1:4072',
  'QLOO_API_URL=http://127.0.0.1:4470',
  'QLOO_API_KEY=fixture-no-network',
  'LLM_PROVIDER=concentrate',
  'CONCENTRATE_API_KEY=fixture-no-network',
  'MODEL_FALLBACK=', 'ELORIAN_API_KEY=', 'ANTHROPIC_API_KEY=', 'FEATHERLESS_API_KEY=',
  'ANALYSIS_EXPERIMENTAL_ROLES=', 'CONCENTRATE_DEMO_ALLOW_ROLES=',
  'CONCENTRATE_PROFILES_JSON=', 'CONCENTRATE_PROFILE_FILE=', 'CONCENTRATE_QUALIFICATION_DIR=',
].join('\n') + '\n', { mode: 0o600 });
console.log(`Created isolated validation database ${name}; private env written.`);
JS
export ENV_FILES="$BASE:$RUN/isolated.env"
node "$SCR/run/launch.mjs" "$ROOT" env NODE_ENV=development pnpm exec tsx scripts/migrate.ts
node "$SCR/run/launch.mjs" "$ROOT" env NODE_ENV=development pnpm exec tsx scripts/seed-fidelity.ts --out "$RUN/fidelity-seed.json"
```

The retained launch helper merges env files after shell variables, so **keep
`ENV_FILES` explicitly supplied for every launch and put `isolated.env` last**.
Never omit it or rely on a shell `DATABASE_URL` override that the base env file
will overwrite. If starting commands in separate terminals, repeat/export
`ROOT`, `SCR`, `RUN`, and `ENV_FILES` there without displaying env contents.

Start/retain each long-running command with the coordinator's managed process
runner (not a shell `&` recipe). Build only after obtaining the shared-output
slot, or use the coordinator's freshly built output:

```sh
# Separate managed services:
node "$SCR/run/launch.mjs" "$ROOT" env NODE_ENV=development pnpm exec tsx scripts/e2e/fake-qloo.ts --port 4470
node "$SCR/run/launch.mjs" "$ROOT/apps/worker" env NODE_ENV=development pnpm exec tsx src/e2e-fake-models.ts
node "$SCR/run/launch.mjs" "$ROOT/apps/media-worker" env NODE_ENV=development pnpm exec tsx src/main.ts
# One coordinated build, then managed web server:
node "$SCR/run/launch.mjs" "$ROOT/apps/web" env NODE_ENV=production pnpm exec next build
node "$SCR/run/launch.mjs" "$ROOT/apps/web" env NODE_ENV=production pnpm exec next start --hostname 127.0.0.1 --port 4072

# Sequential suites (the outage test toggles the shared fake Qloo):
E2E_BASE_URL=http://127.0.0.1:4072 FIDELITY_SEED="$RUN/fidelity-seed.json" \
  node "$SCR/run/launch.mjs" "$ROOT/apps/web" pnpm exec playwright test -c playwright.fidelity.config.ts --output "$RUN/fidelity-results"
E2E_BASE_URL=http://127.0.0.1:4072 FAKE_QLOO_URL=http://127.0.0.1:4470 \
  node "$SCR/run/launch.mjs" "$ROOT/apps/web" pnpm exec playwright test -c playwright.real-v22.config.ts v22-journey.spec.ts --output "$RUN/real-results"
```

Validate all three widths, preserve traces on failures, and stop only owned
managed processes afterward. No database deletion/cleanup instructions are
needed; retain the new isolated database for diagnosis. Paid inference remains
exclusively coordinator-controlled; these commands use only stand-ins.

## Remaining coordination decisions/blockers

- Full fidelity 30-case and real v22 9-case browser suites remain unvalidated
  after these changes; worker did not start Next or a build.
- Existing v22 line after the useful-card check asserts **zero occurrences of
  `vlm|qloo|concentrate|anthropic`**. Current production
  `packages/domain/src/schemas/style.ts` consumer copy deliberately includes
  “Qloo” in `rail_empty`, `unsupported`, and `rail_running`. The retained DOM
  already showed the empty message. Once useful cards are fixed, this may be
  the next failure. Coordinator must decide whether provider attribution is
  now intended product copy (then update that expectation specifically) or
  unwanted jargon (have the UI/domain owner fix copy). This worker did not
  silently remove the assertion or edit another owner's production file.
- The 320 px overflow is still assigned to the browser/UI agent; no overflow
  assertions were weakened here.
