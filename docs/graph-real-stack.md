# Running the PR 8 graph journeys on the real stack

`apps/web/e2e/real/graph-off-visit.spec.ts` and
`apps/web/e2e/real/graph-claim.spec.ts` drive the graph-off first visit and the
anonymous-to-account claim against the running web app and job worker. There
are no `/v1` mocks; the browser uses the same cookies, CSRF tokens and pages a
person does. Both run at 1440, 390 and 320 px
(`apps/web/playwright.real.config.ts`), each spec picks its phase by the
`INTEREST_GRAPH_PROJECTION_ENABLED` value in the Playwright process
environment and skips itself in the other phase.

Both phases share one isolated database, so stop one phase's web/worker before
starting the other (same PID file, same port).

## Phase 1 — graph off (`graph-off-visit.spec.ts`)

A fresh anonymous visitor walks the existing product end to end:

- the Discover feed (including Load more) and the Play category filter;
- a sample item page: **Save** and **More options** work, and sample items
  have no "Why this?" button (they carry no recommendation parent);
- an anonymous hide from the item page (hide is allowed without an account;
  save is not and opens the account prompt instead);
- Try an example (an outfit photo replays a labeled example result) and the
  Music Mode record button;
- Library and Settings in their anonymous states, then back navigation;
- the intended save flows into account creation, the questionnaire and the
  returning feed.

The database must show the old product behavior plus zero graph side effects:
the capture and the hide moved to the account (the capture's expiry lifted),
the old session is claimed and revoked, the intended save arrived as exactly
one save and one pick, and `graph_outbox`, `personal_graph_state`,
`personal_interest_edges` and `graph_runs` for the account are all empty.

## Phase 2 — graph on (`graph-claim.spec.ts`)

Account A is created through the save dialog (an overlapping sample save),
onboards, and its own material projects: the worker sweeps the committed
outbox without any new user mutation, the state row reaches `ready`, and
nothing graph-parented reaches the feed (shadow-only). After signing out, a
fresh anonymous session prepares a capture, a hide and two legacy
session-owned saves (one overlapping the account save), then claims through
the preview-claim sign-in. The merged current state projects exactly once at
the claim revision:

- the claim response reports `{captures: 1, saved_items: 1}` plus the pending
  save, the overlapping save dedupes and the fresh session save re-owns;
- one canonical save row per item, snapshots for the session are revoked, and
  a retried claim from a second browser adds nothing (identical support
  rows);
- a third context holding the pre-claim cookies is a *different* anonymous
  session: the transferred capture answers 404 in the API and "This photo
  isn't available." in the UI, while the owner still sees it.

Saves that target shared catalog rows (the labeled examples) are real taste,
and they project as real confirmed interests: the shared row is ownerless, so
`personal_interest_edges` cannot target it with the composite
`(discovery_item_id, owner_account_id)` FK. Instead such a save roots a
private edge on the account's OWN `saved_items` row
(`saved_item_id` target, migration 270), so the support is account-owned and
isolated without forging an item owner, weakening an owner FK or inventing a
shared identity. The claim journey asserts this directly: the overlapping
sample save and the transferred sample save each produce one private
saved-item edge with `saved_item` support (four explicit roots before the
claim including the sample save; six after it including the capture card),
and removal of one account's shared-row save never touches another account's.

## No provider spend

Nothing in either journey pays a provider. The example capture replays a
recorded reading (`source='sample'`), and photo-model roles are not
configured in this environment, so the worker starts with every model role
fail-closed. Qloo's resolve path may make its normal bounded live calls for
example capture composition (existing product behavior); paid model usage is
the `model_gateway_attempts` ledger, and both specs assert its count is
unchanged from before to after the journey. Screenshots
(`apps/web/e2e/screenshots/real-graph-*.png`) mask password fields.

## Commands

```sh
export DATABASE_URL=postgres://culture_atlas:culture_atlas@127.0.0.1:5432/<isolated db>
export STORAGE_DRIVER=local STORAGE_LOCAL_DIR=<isolated objects dir>
export SESSION_SECRET=<32+ random chars> CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
export TASTE_SEED_ENABLED=false   # journeys create their own taste via picks

# Phase 1 (graph off)
(cd apps/web && pnpm exec next dev --hostname 127.0.0.1 --port 3200) &
(cd apps/worker && pnpm exec tsx src/main.ts) &
cd apps/web && E2E_BASE_URL=http://127.0.0.1:3200 \
  pnpm exec playwright test -c playwright.real.config.ts e2e/real/graph-off-visit.spec.ts

# Stop both processes, then phase 2 (graph on): the worker also needs the flag
INTEREST_GRAPH_PROJECTION_ENABLED=true in both the web and worker environments
(and in the Playwright process for the spec's phase check)
```

The worker sweeps the graph outbox on its normal tick whenever
`INTEREST_GRAPH_PROJECTION_ENABLED` is set, so a committed intent projects
without a dispatcher process or any new user mutation.

## Compatibility notes

- **Pending saves count as one pick** (amendment 2.2): the item a visitor
  tried to save before creating the account arrives with the claim as one
  onboarding pick, and every questionnaire tile pick creates ordinary saves
  (the bundled multi-tag tile contributes one pick with several members).
- **Sign-in claims do not create picks**: the preview-claim pending save is a
  plain save, and accounts with three or more explicit saves skip the
  questionnaire at sign-in.
- **Revoked cookies act as absent**: the old anonymous cookie resolves to a
  fresh anonymous session, never to the claimed one.
- Sample item pages expose no "Why this?" (no recommendation parent). The
  pre-existing React warning `Cannot update a component (ToastProvider)` on
  the capture result page is a legacy UI issue, unrelated to the graph.
