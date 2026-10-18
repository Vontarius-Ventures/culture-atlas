# Build plan v2.2: taste onboarding, fast analysis, "While we look"

Status: plan, October 18, 2026. Implements [specs/onboarding-and-fast-analysis.md](../specs/onboarding-and-fast-analysis.md). Measurements and schemas come from [docs/analysis-latency-plan.md](analysis-latency-plan.md). Base: branch `claude/wizardly-cannon-yu8trw` at `a980448`.

## Inputs needed from the owner

| Input | Why | Needed by |
| --- | --- | --- |
| 10+ real, owned photos (outfits, rooms, food, a logo or label, a busy scene) | Live qualification of the two analysis roles (FAST-01) | Phase 4 |
| Confirm in the Concentrate dashboard that zero data retention and no content logging cover `anthropic/claude-haiku-5-5` | Profiles may only be marked privacy-verified by the operator | Phase 4 |
| Approve the HTML mockups for screens 14–18 | UI is built 1:1 against them | Gate after phase 1 |

Everything else proceeds with the keys already in `.env` (Qloo, Concentrate) and capped spend.

## Phases and factory packages

The factory runs one integration agent, then parallel package agents in isolated worktrees, then merge, fidelity, review and fix, as in the v2 build.

### Phase 0: integrate (1 agent)

- Spec plumbing: apply the amendment's table to the v1 spec ("First visit", acceptance row) and v2 `SCREEN-CONTRACT.md`/`README.md` (screens 14–18, build order), add the new copy to `specs/capture-platform-v2/design/copy.json`, add `onboarding_*` flags to `feature-flags.json`.
- Shared contracts (additive) so parallel agents agree: zod schemas for onboarding catalog, picks, onboarding state and seed status (`packages/domain/src/schemas/onboarding.ts`); `VlmQuickRead` and `VlmEnrichment` (`packages/providers/src/vlm/types.ts`); `reasoningEffort` on `ModelProfileSchema`; new role `vision_photo_enrich`; migration number ranges per package.
- Gate: install, typecheck, lint, test green.

### Phase 1: design mockups (1 agent) → owner approval gate

- Editable HTML mockups for screens 14 (desktop one page; mobile three steps), 15, 16, 17 and 18 in `specs/capture-platform-v2/design/` (extend `index.html` sections 14–18), using `tokens.css` and v1 component rules. Real licensed sample images only.
- Screenshots at 1440 / 390 / 320 saved under `specs/capture-platform-v2/design/screens/`.
- **Stop for owner review** before phase 2's UI package starts. Backend packages can start in parallel with the review.

### Phase 2: build (5 package agents in parallel)

| Package | Scope | Key files | Tests | Effort |
| --- | --- | --- | --- | --- |
| **A. Onboarding backend** | Catalog (`fixtures/onboarding/catalog.json`) built by `scripts/build-onboarding-catalog.ts` from live Qloo `/v2/tags` + `/search` (real ids, retrieval date, ≤3 concurrent); onboarding state migration; services: get catalog, record pick (creates SavedItem via `preferences.saveItem`, source `onboarding`, image→tags counted once), remove pick, complete (≥3 check), exclusions in account preferences; REST `/v1/onboarding/*`, existing-account trigger (<3 saves); agent scope rules | `packages/domain/src/services/onboarding.ts` (new), `preferences.ts`, `taste.ts`, `accounts.ts`, `apps/web/app/v1/onboarding/**`, `db/migrations/1xx_onboarding.sql` | ONB-01/02/03/05/06, isolation, agent scopes | 2–3 d |
| **B. Taste seed job** | `taste_seed` job type: Qloo insights per category from picks (≤6 requests, ≤3 concurrent), recommendations into feed pool, FeedSnapshot rebuild, progressive status, retry when Qloo is down, labeled-example fallback | `packages/domain/src/pipeline/taste-seed.ts` (new), `pipeline/index.ts`, `services/discovery.ts`, `feed/` | ONB-03/04, no fabrication with empty/429 fixtures | 1.5–2 d |
| **C. Fast two-stage analysis** | `reasoningEffort` in profiles + transport (sent only when set); `VlmQuickRead` prompt and `toVlmAnalysis()`; `ConcentrateVlm` uses quick read for `vision_photo` (5 candidates, 512 px); `vision_photo_enrich` role, `VlmEnrichment` prompt, `enrich` compiler stage with deterministic merge and advisory vetoes; budget for both calls; v2 worker stage 1 per frame + one stage 2; Qloo resolve concurrency ≤3; qualification script learns both roles and effort | `packages/providers/src/concentrate/{profiles,transport,providers}.ts`, `model-gateway/*`, `vlm/{types,prompt}.ts`, `packages/domain/src/compiler/*`, `pipeline/analyze-capture.ts`, `apps/worker/src/media-analysis.ts`, `scripts/qualify-concentrate*.ts` | FAST-02/03, contract fixtures, merge rules, worker tests | 5–6 d |
| **D. Web UI** (starts after the mockup gate) | Screens 14–18: onboarding flow wired into account creation and sign-in redirect, building-feed interstitial, While-we-look strip in `CaptureResultView` and v2 `MediaDetailView`, ready toast + title badge, Settings → Taste; 1:1 against approved mockups | `apps/web/app/welcome/**`, `apps/web/app/settings/taste/**`, `apps/web/components/onboarding/**`, `components/views/CaptureResultView.tsx`, `components/v2/MediaDetailView.tsx`, `UploadStatusBar.tsx`, e2e specs | ONB-07, FAST-04, Playwright at 1440/390/320, screenshot comparison | 3–4 d |
| **E. Native parity** | iOS/Android onboarding screens and ready push handling against the same REST contracts; contract fixtures | `apps/ios/**`, `apps/android/**`, `fixtures/native-contract/**` | Contract fixture tests (cannot compile here) | 1.5–2 d |

### Phase 3: merge and end-to-end (1 agent)

Merge package branches; full gate (install, typecheck, lint, tests, build, fresh-DB migrate); real-stack Playwright journeys: anonymous browse → example → sign up → questionnaire (≥3 picks from all three sources, one exclusion) → building feed → personal Discover → upload photo → While we look → quick read → enrichment → ready toast; Qloo-down variant (catalog-only completion); existing-account trigger.

### Phase 4: live qualification (1 agent, capped spend)

- Rebuild the onboarding catalog from live Qloo and commit it.
- Qualify `vision_photo` (quick read) and `vision_photo_enrich` on `anthropic/claude-haiku-5-5` with effort `none` against the owner's ≥10 real photos; record artifacts and update `docs/concentrate.md` and `docs/capability-matrix.md`.
- Measure FAST-01 and ONB-04 locally (and on the deployed demo when it exists).
- Spend caps: ≤60 Concentrate requests, ≤40 Qloo requests for the catalog, ≤30 Qloo requests for seed tests.

### Phase 5: fidelity, review, fix (as in the v2 build)

- Fidelity pass on screens 14–18 against the approved mockups, plus a regression look at screens 01–13.
- Two reviewers: security/privacy/tenancy (picks as saves, exclusions, agent scopes, seed job ownership, two-call budget) and spec conformance (ONB/FAST acceptance, copy, no fabrication).
- Fix agent applies verified findings; final gate; push.

## Order and timing

```
Phase 0 ─▶ Phase 1 (mockups) ─▶ [owner approval] ─▶ Package D ─┐
       └▶ Packages A, B, C, E (start immediately) ─────────────┴▶ Phase 3 ─▶ Phase 4 ─▶ Phase 5
```

Estimated agent effort: about 15–19 package-days, run in parallel; wall-clock is dominated by package C and the approval gate.

## Risks

- **Required picks add sign-up friction.** Mitigated by three pick styles, cached catalog (always completable), and preserving the save that triggered sign-up.
- **Qloo burst throttling** on the hackathon key affects onboarding search, the seed job and analysis together. All Qloo callers share a ≤3-concurrency limiter and the existing retry/backoff.
- **Real-photo quality** of the quick read is unproven until phase 4.
- **Catalog freshness:** Qloo tag ids are cached; the build script records retrieval dates and the README documents the refresh.
- **Native apps** still cannot be compiled in this environment.
