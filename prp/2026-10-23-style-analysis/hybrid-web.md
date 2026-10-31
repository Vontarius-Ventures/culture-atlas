# Hybrid recommendations — web handoff

Implemented in `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration`.
Read the fixed hybrid plan, `apps/web/AGENTS.md`, and installed Next `use client`
and image guides before editing. No contract-field deviation was necessary.
Confirmed the domain worker's actual owned image route and museum URL rules:
`/v1/visual-references/images/<64 lowercase hex characters>`, with HTTPS Met
object pages on `www.metmuseum.org` or `metmuseum.org`.

## Files written

- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/lib/client/style.ts`
  — separately parses optional `discovery_intents`; legacy style/recommendation
  fields retain their existing normalization. Invalid/absent additive structure
  becomes null without breaking the page. Only explicit `model_suggested` cards
  with complete bounded fields, safe museum links and owned cached-image paths
  can display; invalid individual cards are dropped. Non-ready states cannot
  display attached cards. Per-subject/catalog/card identity is preserved.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/lib/client/style-discovery.test.ts`
  — parser, older API compatibility, shared-wire fixture compatibility,
  malformed structures, image/link security, reason bounds and relation identity.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/lib/client/discovery-poll.ts`
  — read-only late-work polling: 1,500 ms cadence, at most 60 attempts and a
  90,000 ms wall-clock deadline. Pauses reads while hidden, resumes within the
  deadline, aborts on cleanup/deadline, and exposes timeout without changing a
  pending server result into success/failure.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/style/DiscoveryModes.tsx`
  — native accessible Connections (default) / Visual references buttons;
  existing connections subtree keeps its list semantics. Visual panel contains
  only actual new museum cards, with no contextual backfill or Save/Buy action.
  Covers unavailable/pending/running/ready/empty/failed, incomplete ready data,
  progress transport errors, timeout, missing cached-image bytes, attribution,
  bounded friendly reason copy, model-suggested/experimental labels, and explicit
  non-authentication/non-maker-attribution/non-purchasability limitations.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/style/DiscoveryModes.module.css`
  — responsive wrapping controls, 44 px minimum targets, focus visibility and
  bounded museum-card grid using existing design tokens.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/style/DiscoveryModes.dom.test.tsx`
  — default/list semantics, keyboard Tab/Enter/Space, rapid switching, all visual
  states, unknown reason codes, missing profile/image, no fake actions and
  cached-image load fallback.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/views/CaptureResultView.tsx`
  — integrates modes without another analysis request. Main photo reading,
  existing references, legacy rails/evidence and main ready-notice logic remain.
  Qloo rail-jump actions are withheld while their connections panel is hidden.
  Polls visual work even after parent readiness. Identity/capture-keyed state,
  abort controllers, request ordering and HTTP 401/403/404 stop/clear behavior
  prevent late/unmounted/previous-account reads from publishing.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/views/CaptureResultView.dom.test.tsx`
  — terminal parent + visual progression, no mode-triggered requests, main-ready
  notice separation, hanging/repeated pending bounds, unmount, stale account,
  capture navigation, auth/not-found failures, hidden/resume/deadline and older API.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/mock/discovery-intents.ts`
  — visibly synthetic additive-wire/card/capture fixtures, not acquired objects
  or real model evidence.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/mock/api.ts`
  — optional synthetic visual status/progression layered onto capture reads.
  Existing mocks remain older-payload fixtures when this option is absent.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/v22/hybrid-recommendations.spec.ts`
  — 320/390/1440 px, keyboard/axe, legacy list preservation, no requests from
  switching, terminal-parent polling, state matrix, missing candidate/profile,
  cached-asset error, no contextual backfill and older API tests.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/prp/2026-10-23-style-analysis/hybrid-web.md`
  — this requested handoff.

## Validation actually completed

1. **135 tests passed, 12 files passed**:
   from `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web`,
   `pnpm exec vitest run --config /tmp/culture-atlas-web-vitest.config.mts`.
   Temporary config includes all existing component DOM tests and the style
   parser tests, including the preserved Camera permission/lifecycle tests.
   It uses jsdom and the existing web alias/automatic JSX runtime, without root
   global setup, database creation or migrations.
   jsdom emitted three existing “navigation to another Document” notices;
   no test failed.
2. **Web TypeScript passed**:
   `pnpm exec tsc --noEmit --incremental false -p tsconfig.json`
   from the same web directory. This also traversed current shared imports.
3. **Scoped ESLint passed** from the repository root:
   `pnpm exec eslint apps/web/lib/client/style.ts apps/web/lib/client/style-discovery.test.ts apps/web/lib/client/discovery-poll.ts apps/web/components/style/DiscoveryModes.tsx apps/web/components/style/DiscoveryModes.dom.test.tsx apps/web/components/views/CaptureResultView.tsx apps/web/components/views/CaptureResultView.dom.test.tsx apps/web/e2e/mock/discovery-intents.ts apps/web/e2e/mock/api.ts apps/web/e2e/v22/hybrid-recommendations.spec.ts`
4. **52 Playwright tests collected, not executed**:
   `E2E_BASE_URL=http://127.0.0.1:9 pnpm exec playwright test --list e2e/v22/hybrid-recommendations.spec.ts`
   from the web directory. The explicit URL prevents automatic Next startup.
5. Scoped `git diff --check` passed.

## Limits and coordinator follow-up

- Coordinator must run the collected browser tests against their owned runtime
  and the existing mocked/real/fidelity regressions. Collection and jsdom are
  not evidence that actual 320/390/1440 layout or browser axe checks passed.
- No live catalog/model evaluation, actual museum acquisition or visual quality
  claim was performed. Fixtures and their intercepted one-pixel image are
  explicitly synthetic; they are not cached production-object evidence.
- The visual timeout is a local “stopped checking / result unknown” state;
  reopening reads the existing capture again, without re-analysis or retrying
  paid comparisons.
- No server route, domain/provider, native, importer/script, header/AppShell,
  Camera implementation/test or screenshot files were edited by this worker.
  Pre-existing intentional parser/mock/result-copy changes were preserved.
- No service/server, Next build, browser runtime, paid/network call, migration,
  commit, deployment or counter reset was run. No owned process remains running.
- `/tmp/culture-atlas-web-vitest.config.mts` remains available for the coordinator
  to reproduce the isolated web run; it is outside the repository.

## Follow-up: integrated REAL/FIDELITY runtime validation

The coordinator explicitly authorized local test-service startup for this
follow-up. The earlier no-service/no-browser statements describe the original
web implementation handoff, not this subsequent validation.

### Outcome and remaining blocker

- **Guarded fidelity: 30 passed, zero skipped, 32.0 seconds, exit 0.**
- **Guarded real v22 interests: 9 passed, zero skipped, 1.9 minutes, exit 0.**
  This includes 1440/390/320 px, useful fixture documentary cards, ready-toast
  navigation, interests edits, actual fake-Qloo outage/recovery, and existing
  account onboarding. Fidelity and v22 ran sequentially.
- **Keyless: three v1 journeys passed; all three v2 journeys failed at email
  callback sign-in.** The initial broad real config also selected nine
  separately opt-in v2-fidelity cases, which skipped because those fixture
  flags were absent; none of the six requested journey cases was skipped.
- The main-owned HTTP 4071 server generated email callback URLs on
  `http://127.0.0.1:4071/identity/callback`, while the browser initiated sign-in
  on `https://127.0.0.1:4471`. All three failed pages correctly said
  “Return to the browser where you started sign-in.” This is a launch-origin
  mismatch, not a locator issue. I did not rewrite emailed callbacks, weaken
  Secure cookies/browser binding, change production source or restart the
  main-owned server.
- **Required coordinator action:** after its mocked run completes, restart
  its own keyless web with `APP_BASE_URL=https://127.0.0.1:4471` supplied
  **after** the env-merging launcher, and rerun the six keyless journey cases
  (or at least the three blocked v2 cases) with the same CA/SPKI setup.
  Passing `APP_BASE_URL` to the Playwright process cannot fix a server that
  is already running with the HTTP origin.
- No application/test source fix was needed or made during this follow-up.
  The web source can be frozen independently of this remaining launch fix.

### Network isolation correction — retained, not concealed

The supplied private fixture env files did not override Wikipedia endpoints.
The initial, otherwise passing v22 run recorded **15 successful logical
`wikipedia/find_sources` operations** against the default public research
provider. That is not fully offline evidence. The number of underlying HTTP
requests was not measured; a logical lookup may make several requests.
No live paid provider was used, and these were synthetic test-journey subjects,
not private evaluation photos. The original provider-query records and results
remain intact; no provenance or counters were rewritten.

I stopped only my app roots and added a **private runtime-only** loopback
transport guard, inherited through `NODE_OPTIONS`. It rejects non-loopback
fetch, HTTP(S) and socket requests before transport, without returning fake
research documents or changing authentication. The constrained repeat still
passed all 30 fidelity and all nine v22 cases. The guarded fixture worker log
records seven blocked attempts to reach `en.wikipedia.org`; the normal compiler
retains its unavailable/failed research outcomes. These passes do not qualify
live research, live visual comparison or recommendation relevance.

Private helper files created:

- `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/run/team-runtime/hybrid-launch.mjs`
- `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/run/team-runtime/hybrid-loopback-only.mjs`

The launcher initially delegated directly to the existing `run/launch.mjs`;
its final version adds the guard for child processes. Existing env files,
TLS proxy/certificate, exact Chromium SPKI pin and browser configs were not
modified.

### Exact commands and environments

Definitions used below:

```sh
REPO=/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
SCR=/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run
RUN="$SCR/run"
LAUNCH="$RUN/team-runtime/hybrid-launch.mjs"
CA="$RUN/team-runtime/tls/localhost.crt"
```

Every service and suite explicitly supplied
`ENV_FILES="$RUN/team-runtime/<kind>.env:$RUN/hybrid45.env:$RUN/hybrid-catalog.env"`.
Sanitized preflight verified the exact three private databases, compiler
`compiler-2026-10-27-intent-visual-v7`, visual comparisons `0`, fake-only fixture
provider keys, Qloo loopback 4470, S3 loopback 4679 and SES loopback 4680.
No migration or reseed was performed.

All exact service commands, original/new root PIDs, log paths and stop status:

`/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/runtime-v1/services.json`

This includes the existing local-AWS and fake-Qloo entrypoints, existing TLS
proxy, keyless worker/media worker, and fixture/fidelity production web and
development fake-model/media workers. No Next build was run.

First keyless command (exit 1; three pass, three fail, nine unrelated skips):

```sh
ENV_FILES="$RUN/team-runtime/keyless.env:$RUN/hybrid45.env:$RUN/hybrid-catalog.env" \
NODE_EXTRA_CA_CERTS="$CA" node "$LAUNCH" "$REPO/apps/web" \
env NODE_ENV=production APP_BASE_URL=https://127.0.0.1:4471 \
E2E_BASE_URL=https://127.0.0.1:4471 \
FIDELITY_SEED="$RUN/team-runtime/fidelity-seed.json" \
pnpm exec playwright test -c "$RUN/team-runtime/playwright.real.config.ts" \
--workers=1 --output "$SCR/hybrid/real-keyless-results-v1" \
> "$SCR/hybrid/real-keyless-browser-v1.log" 2>&1
```

Final constrained commands (executed sequentially, both exit 0):

```sh
ENV_FILES="$RUN/team-runtime/fidelity.env:$RUN/hybrid45.env:$RUN/hybrid-catalog.env" \
NODE_EXTRA_CA_CERTS="$CA" node "$LAUNCH" "$REPO/apps/web" \
env NODE_ENV=production APP_BASE_URL=https://127.0.0.1:4473 \
E2E_BASE_URL=https://127.0.0.1:4473 FAKE_QLOO_URL=http://127.0.0.1:4470 \
FIDELITY_SEED="$RUN/team-runtime/fidelity-seed.json" \
pnpm exec playwright test -c "$RUN/team-runtime/playwright.fidelity.config.ts" \
--workers=1 --output "$SCR/hybrid/fidelity-results-offline-v2" \
> "$SCR/hybrid/fidelity-browser-offline-v2.log" 2>&1

ENV_FILES="$RUN/team-runtime/fixtures.env:$RUN/hybrid45.env:$RUN/hybrid-catalog.env" \
NODE_EXTRA_CA_CERTS="$CA" node "$LAUNCH" "$REPO/apps/web" \
env NODE_ENV=production APP_BASE_URL=https://127.0.0.1:4472 \
E2E_BASE_URL=https://127.0.0.1:4472 FAKE_QLOO_URL=http://127.0.0.1:4470 \
FIDELITY_SEED="$RUN/team-runtime/fidelity-seed.json" \
pnpm exec playwright test -c "$RUN/team-runtime/playwright.real-v22.config.ts" \
v22-journey.spec.ts --workers=1 --output "$SCR/hybrid/real-v22-results-offline-v2" \
> "$SCR/hybrid/real-v22-browser-offline-v2.log" 2>&1
```

Before the constrained repeat, the initial fidelity command used the same
options with `fidelity-results-v1` / `fidelity-browser-v1.log`: 30 passed,
zero skipped, 39.6 seconds. Initial v22 used the real-v22 config without the
`v22-journey.spec.ts` filter or `FIDELITY_SEED`, with `real-v22-results-v1` /
`real-v22-browser-v1.log`: nine passed, 18 unrelated opt-in v22-fidelity cases
skipped, 2.0 minutes. No assertions or cases were removed; the final explicit
filter selects exactly the requested nine journey cases.

### Artifacts, state and cleanup

- Final fidelity log:
  `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/fidelity-browser-offline-v2.log`
- Final v22 log:
  `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/real-v22-browser-offline-v2.log`
- Keyless failure log and three retained traces/error contexts:
  `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/real-keyless-browser-v1.log`
  and
  `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/real-keyless-results-v1/`.
- All service logs, including blocked external attempts and shutdown diagnostics:
  `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/runtime-v1/`.
- **Exact absolute file list**, including 108 generated/updated screenshot PNGs,
  result artifacts, private helpers, logs and this handoff:
  `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/runtime-v1/artifact-manifest.json`.
  Screenshot outputs are the existing tests' normal
  `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/screenshots/real-*.png`
  and
  `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/screenshots/fidelity/v1-and-account/*.png`.
- Read-only private DB verification after the first fidelity run: current taste
  revision **16**, seeded snapshot revision **16**, **8** cards,
  `is_example_feed=true`, **0** owner jobs. The seed/password/identifiers were
  never printed, and no reseed or sample-to-provider promotion was performed.
- All **17 newly started roots are stopped**. First stop group:
  `80002 80004 80017 80022 80059 80074 80084 80090` (52 owned tree processes
  signalled). Final stop group:
  `79982 79985 79989 86501 86504 86506 86510 86512 86514`
  (50 owned tree processes signalled). Both used only the supplied validated
  `team-runtime/stop-owned.py`, with explicit private `ENV_FILES`.
- Final listener inspection showed only the unchanged main-owned 4071 listener
  (PID **73945**, main root **73927**) among assigned ports; 4072/4073,
  4470–4473 and 4679/4680 were closed. Managed termination notifications confirm
  every owned root exited.
- Sending SIGTERM to the whole owned process trees also caused media-worker
  shutdown logs to report `Called end on pool more than once`; this happened
  during cleanup, not the browser runs. No worker/backend source was edited
  to mask or repair this separate shutdown-idempotency issue.
- Main's HTTP4071 mocked matrix, paid runtime4030 / `ca_r3_new`, build outputs,
  production security settings and all other workers' source changes were
  untouched. No build, migration, paid model call, commit, deployment, privilege
  change or counter reset was performed.

Live/device/cloud/provider-visual qualification is still not claimed.

## Final frozen-build follow-up: all 45 requested cases passed

This final pass **supersedes the earlier keyless callback blocker**. The
coordinator replaced its old server with main-owned root **93611**, using
`APP_BASE_URL=https://127.0.0.1:4471` after the guarded launcher. Its source
changes were already built/frozen before this validation. This worker made
**no application or test source edits** and did not build or restart that
main-owned server.

Production build ID was **`LrYcVLjlpMnv-1vcWQYXX`** before and after the
complete pass.

| Exact requested suite | Passed | Failed | Skipped | Reported duration |
| --- | ---: | ---: | ---: | --- |
| Keyless v1/v2 journeys, three widths | 6 | 0 | 0 | 1.8 min |
| Real v22 interests journeys, three widths | 9 | 0 | 0 | 2.5 min |
| Fidelity, three widths | 30 | 0 | 0 | 37.0 sec |
| **Total** | **45** | **0** | **0** | |

All three commands exited **0**. Suites ran sequentially, with one Playwright
worker each. Exact spec selectors were:

- Real config: `e2e/real/journey.spec.ts e2e/real/v2-journey.spec.ts`
  — exactly six cases, no unrelated opt-in fidelity selection.
- Real-v22 config: `v22-journey.spec.ts` — exactly nine cases.
- Fidelity config: the complete existing 30-case suite.

All reused the existing private DB environments, existing TLS CA and exact
Chromium SPKI wrappers, and the unchanged loopback-only guarded launcher.
Every command explicitly used
`ENV_FILES=<kind>.env:hybrid45.env:hybrid-catalog.env`; browser/server origins
were HTTPS 4471/4472/4473, production web mode was set after the launcher,
and fake-model workers remained in development mode. Compiler v7 and visual
comparison maximum `0` were verified. No seeds or migrations were run.

### Final evidence and exact paths

All exact service and suite commands, eleven new root PIDs, results, durations
and cleanup status:

`/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/frozen45-v3/services-and-results.json`

Final logs:

- `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/frozen45-v3/real-keyless-browser.log`
- `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/frozen45-v3/real-v22-browser.log`
- `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/frozen45-v3/fidelity-browser.log`

Fresh result directories are `real-keyless-results`, `real-v22-results` and
`fidelity-results` under that same absolute `frozen45-v3` directory. Earlier
failure traces/logs were not overwritten or deleted.

The exact absolute list of created/updated files, including **141**
regenerated normal screenshot PNGs, is:

`/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/frozen45-v3/artifact-manifest.json`

Sanitized read-only state audit:

`/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run/hybrid/frozen45-v3/sanitized-audit.json`

The curated fidelity seed remains revision **16**, snapshot revision **16**,
**8** example cards, **0** owner jobs. The final fixture worker blocked eight
external Wikipedia transport attempts before sending; its fifteen logical
research operations remain recorded as errors, with no successful external
research operation in this pass. Keyless and fidelity recorded no Wikipedia
operations. No paid provider, live key or external network request was used
for this final guarded pass. Historical first-pass external research evidence
described above remains retained and is not relabeled.

### Final owned cleanup

Stopped exactly these newly started roots with the supplied validated
`stop-owned.py`:

`94056 94059 94062 94064 94069 94071 94074 94076 94116 94122 94136`

The helper signalled **62 owned tree processes**; all eleven managed roots
reported SIGTERM completion. Final assigned-port inspection showed only
main's unchanged **4071 listener PID 93627**, under main root **93611**.
Owned 4072/4073, 4470–4473, 4679 and 4680 listeners were closed. No owned
runtime remains. The existing media-worker duplicate pool-close diagnostic
appeared only during process-tree cleanup, not as a browser test failure;
no backend source was changed.

Main's concurrent mocked run, source freeze, `.next` build, paid diagnostics,
security settings and all unrelated processes were left untouched.
No source edits, build, seed, migration, auth weakening, paid call, commit,
deployment, privilege change or counter reset was performed in this final pass.
These are real local-stack regressions with offline stand-ins, not live
provider, device, cloud or visual-comparison qualification.

## Commons iteration — licensed attributed reference images

This iteration extends the web/public card contract only. The catalog worker
owns Commons catalog v2; main owns mapping catalog licenses into public card
credits. Neither catalog, selection, providers nor visual producer was edited.
The reported Met-only supply (3/24) is context, not a result verified here.
Separate AI benchmarks for both modes remain separate work; **human usefulness
remains unverified**. The historical frozen-build runtime results above do not
validate this new Commons iteration.

### API and types

`GET /v1/captures/{id}` still optionally adds `discovery_intents`, version
`atlas_discovery_intents_v1`, `default_intent: "connections"`; old responses,
legacy recommendations and Met cards without credit remain compatible.
`catalog_id` accepts only `met:<positive integer>` or
`commons:<positive page ID>` without leading zeros or whitespace.
Source namespace and the exact decimal ID must match:

- Met: `https://www.metmuseum.org/art/collection/search/<id>` or
  `https://metmuseum.org/art/collection/search/<id>`; optional trailing slash.
- Commons: exactly `https://commons.wikimedia.org/?curid=<id>`. No extra query,
  duplicate query, encoded ID, fragment (including empty `#`), userinfo, port
  (including explicit 443), insecure scheme or surrounding whitespace.

Optional `credit` (required on Commons; malformed supplied Met credit also
rejects the card):

```ts
{
  attribution: string; // trimmed, nonempty, maximum 600 characters
  license: 'CC0' | 'CC-BY-4.0' | 'CC-BY-SA-4.0';
  license_url: string; // exact matching canonical URL below
  changes: string; // trimmed, nonempty, maximum 200 characters
}
```

Exact canonical URL map exported as `VISUAL_REFERENCE_LICENSE_URLS`:

- `CC0`: `https://creativecommons.org/publicdomain/zero/1.0/`
- `CC-BY-4.0`: `https://creativecommons.org/licenses/by/4.0/`
- `CC-BY-SA-4.0`: `https://creativecommons.org/licenses/by-sa/4.0/`

`VisualReferenceCreditSchema` and inferred `VisualReferenceCredit` are newly
exported through the existing schemas barrel. `VisualReferenceCardSchema` /
`VisualReferenceCard` now include optional credit. Web uses the shared refined
schema via `safeExtend`, requiring nonempty display text and dropping only
malformed individual cards. Domain rejects malformed cards/credit outright.
Source checks compare original strings: Zod URL validation trims whitespace,
so it is deliberately not used before exact source comparison. Catalog IDs
and owned image paths use strict end-of-input checks, including final-newline
rejection. Images remain exclusively
`/v1/visual-references/images/<64 lowercase hex>`.

Credit attribution and changes render as React text inside `figcaption`,
adjacent to the image/fallback; the declared license is a keyboard-focusable
canonical link with `noopener noreferrer`. No HTML parsing or arbitrary links.
List name is now **Attributed reference images**; generic status/fallback copy
does not call Commons a museum or BY/SA public domain. Experimental,
model-suggested, non-authentication, non-maker-attribution and non-sale limits
remain; no contextual backfill or Save/Buy actions were added.

### Exact files changed in this iteration

- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/domain/src/schemas/discovery-intents.ts` — only shared domain file changed; card/credit/URL contract.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/lib/client/style.ts` — reuse shared security validation, preserve individual-card leniency.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/lib/client/style-discovery.test.ts` — shared/domain rejection and web card-drop matrix, all three licenses, legacy Met, exact namespace/ID binding, whitespace/newline, image-route and canonical-license safety.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/style/DiscoveryModes.tsx` — adjacent escaped credit, generic copy and accessible list name.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/style/DiscoveryModes.module.css` — zero-margin figure, wrapping credit inherited from card, 44 px license-link target.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/style/DiscoveryModes.dom.test.tsx` — BY/SA text-only credit, license/source focus order, panel ARIA binding, Commons image-load fallback retaining credit, missing/invalid-credit and retained Met assertions.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/components/views/CaptureResultView.dom.test.tsx` — expected copy/list-name updates only; main's legacy settled-refresh tests retained.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/mock/discovery-intents.ts` — synthetic Commons BY/SA, missing-credit and invalid-credit-with-valid-Met fixtures.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/web/e2e/v22/hybrid-recommendations.spec.ts` — retain existing assertions with updated copy; add Commons BY/SA at 320/390/1440, keyboard/axe/text-credit/safe-link checks and credit-drop cases.
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/prp/2026-10-23-style-analysis/hybrid-web.md` — this iteration handoff.

No edit to `CaptureResultView.tsx`, polling, palette CSS, item-settings,
mock API implementation, other workers' dirty work or native clients.

### Exact validation and limits

All commands below ran from this worktree; final exits **0**:

1. In `apps/web`:
   `pnpm exec vitest run --config /tmp/culture-atlas-web-vitest.config.mts`
   — **199 tests / 12 files passed**, no skips or failures. This isolated
   jsdom config has no root global setup, services or DB writes.
   Existing jsdom navigation-not-implemented diagnostics were non-failing.
2. In `apps/web`:
   `pnpm exec tsc --noEmit --incremental false -p tsconfig.json` — passed.
3. At repo root:
   `pnpm exec eslint packages/domain/src/schemas/discovery-intents.ts apps/web/lib/client/style.ts apps/web/lib/client/style-discovery.test.ts apps/web/components/style/DiscoveryModes.tsx apps/web/components/style/DiscoveryModes.dom.test.tsx apps/web/components/views/CaptureResultView.dom.test.tsx apps/web/e2e/mock/discovery-intents.ts apps/web/e2e/v22/hybrid-recommendations.spec.ts`
   — passed.
4. In `apps/web`:
   `E2E_BASE_URL=http://127.0.0.1:9 pnpm exec playwright test --list e2e/v22/hybrid-recommendations.spec.ts`
   — **84 cases collected**, across four configured projects. Collection only;
   no browser run, web startup, axe execution or screenshot qualification.
5. Scoped `git diff --check` on changed source paths — passed.

Initial checks caught and fixed a museum-specific synthetic Commons limitation,
unchecked test array indexes, and Zod URL whitespace normalization before the
final all-green run. No services, builds, network/paid calls, seeds, migrations,
DB writes, commits or additional agents were used in this iteration.

Required follow-up: main maps catalog v2 attribution/license/changes into the
exact public credit contract above. Runtime browser/axe checks and separate AI
benchmarks for Connections and Visual references are still outstanding for this
iteration; none establish human usefulness without human evaluation.
