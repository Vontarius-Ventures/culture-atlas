# Model gateway: Concentrate (Phase A)

The current default remains Featherless. `LLM_PROVIDER=concentrate` is an
explicit switch, not an endpoint override. Qloo remains independent.
There are **no qualified production model IDs** in this change. Tests use
`fixture/model-1`, which is synthetic and must never be deployed.

## Implemented boundary

`createModelGateway(config, { db, profiles, identity })` creates photo,
video-frame, research and composer adapters. `db` must be a pool-level handle
compatible with domain `Db`. Migration `065_model_gateway.sql` must be applied.
Alternatively inject a `ModelSpendLedger` backed by a durable `SpendStore`.
No ledger means unavailable roles. Missing profiles disable only those roles.
Every dispatch also requires verified account/job/stage identity. The default
registry intentionally cannot run Concentrate until the worker supplies these
dependencies. Asset-analysis worker integration is a separate stacked change.

```ts
const modelIdentity = identityFromCaptureLease(lease, 'observe:frame:1500');
const gateway = createModelGateway(providerConfig, {
  db,
  profiles,
  identity: modelIdentity,
});
await gateway.videoFrames.analyzeImage(
  { image: normalizedJpeg },
  {
    signal,
    modelIdentity,
  },
);
```

The structural lease seam uses P1's `account_id`, `job_id`, `asset_id`,
`attempt_id`. Account/job/stage identifies the logical billable attempt.
`attempt_id` is audit-only, so reclaiming a queue lease cannot silently rebill
the same stage. Retries inside one invocation append a bounded attempt suffix.
An already-reserved stage fails closed, even after a crash or successful
response: reconcile/recover its durable stage output rather than send twice.
The queue owner must checkpoint validated results and fence publication on
lease, account, asset generation and tombstone. This provider package has no
asset mutation or deletion capability.

## Profiles and privacy

`CONCENTRATE_PROFILE_FILE` contains an array of independently qualified profiles.
See `ModelProfileSchema` in `packages/providers/src/concentrate/profiles.ts`
for the complete strict contract. All fields are mandatory. Each profile pins:

- `gateway: concentrate`, role, version, exact `provider/model` and provider.
- Empty `allowedFallbackProviders`. No auto-routing, model fallback, alternate
  gateway or automatic billing switch is supported in Phase A.
- Output/input token and UTF-8 text/schema-byte caps; JPEG count, byte, pixel,
  and dimension caps. Text deadlines are at most 15 seconds, vision 30.
- Structured-output support, ZDR eligibility, logging off, verified privacy
  timestamp, catalog timestamp and qualification artifact ID.
- Prompt/schema/pricing versions and worst-case `reservationMicros` (integer
  millionths of USD), including image and capped input/output charges.

`VLM_MODEL`, `RESEARCH_MODEL`, `COMPOSER_MODEL`, if set, must match qualified
profiles. There is no implicit composer-to-research model fallback.
Profiles require operator verification of ZDR ON and content logging OFF on
the actual key/workspace, and the selected model/provider's detailed catalog.
Environment assertions do not change vendor settings. No invented privacy
flags, idempotency headers, reasoning or tool settings are sent.

The Responses adapter uses only `https://api.concentrate.ai/v1/responses`,
nonstreaming JSON Schema output, instructions separate from input data, bounded
JPEG data URIs, no tools and no redirects. It scans all output messages for
text/refusal/incomplete/error outcomes. Atlas independently rejects missing or
extra keys, invalid JSON, schema/semantic failures, model/route mismatches,
and invalid VLM cross-references/geometry. Unrepresentable schemas fail before
dispatch, without a permissive object/unknown fallback.

Video analysis accepts 1–8 ordered server-owned frame derivatives and effective
timestamps, up to a 180-second overall deadline. Partial frame results retain
their timestamp/derivative linkage; the model cannot assign it. No native video
endpoint is assumed. Byte decoding/normalization remains media preparation's
responsibility; the VLM checks JPEG metadata and qualified limits.

## Durable spending and failure handling

Set positive `MODEL_DAILY_SPEND_LIMIT_USD`,
`MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD`, `MODEL_MAX_UNKNOWN_SPEND_USD`, and
`ACCOUNT_DAILY_MEDIA_ANALYSES`. Each HTTP attempt reserves its profile's
qualified worst-case amount before dispatch. A global PostgreSQL row lock
serializes global/account checks and commits the attempt before any HTTP work.
Retries get new reservations and consult the same allowance.

Reserved and unknown attempts remain counted, including across midnight,
worker restarts and abandoned leases. A daily analysis count uses unique
account/job identity. Completed token usage is recorded but is **not** proof of
the actual dollar charge. All dispatched attempts remain unknown until the
operator's billing reconciler calls `ledger.reconcile(id, actualCostMicros)`.
Only explicit billing evidence can settle zero; missing usage never does.
Stale reservations never expire automatically. A charge exceeding its qualified
reservation pauses dispatch. Reconciliation is idempotent and conflicting
amounts fail. The initial store loads operational ledger metadata under a
global lock for correctness; high-volume deployments should replace its query
strategy with equivalent locked aggregates, not weaken policy.

402 persists a global AI-only pause. Restore credits/profile readiness and
explicitly call `ledger.resume()` before recovery. No paid health probe or
cross-gateway fallback occurs. 429 records Retry-After, persists a dispatch
pause and returns to the scheduler instead of spinning/retrying in-process.
Authentication, unknown-model and privacy-route failures disable that role
instance pending operator reconstruction. Scheduler retries must obey this
status and the ledger. One transient provider retry is permitted within the
total role deadline and independently reserved. Timeout/cancellation can leave
upstream work and charges; neither is automatically retried. Refusal, incomplete,
invalid schema and policy failures never trigger schema repair in Phase A.

`runner.readiness()` is read-only and distinguishes qualified, available,
degraded and unavailable evidence. Configuration/catalog compatibility are
offline profile-loader gates, not inference probes. Registry capabilities are
synchronous configuration/last-observed summaries; use async readiness for
durable credit/throttle state. Keep metadata/library/capture/upload/deletion
available when AI pauses. Never expose error bodies, prompts, image base64,
keys or operator billing state in consumer errors.

## Validation and remaining release gates

Offline fake-fetch/transport tests cover AI-01 failure classifications and
AI-02 reservation/unknown accounting. Real PostgreSQL tests cover concurrent
global/account caps, crash persistence, attempt deduplication, transactional
rollback, credit circuit persistence and reconciliation. Existing Featherless
and Anthropic tests remain required.

No network/model calls, account inspection, real credits, real privacy settings,
model catalog or live cultural-label quality were qualified in Phase A.
Production stays blocked until deliberate live qualification using owned
fixtures: at least ten varied photos and three short videos, research/composer
schemas, real image interpretation, timestamps, privacy, exact routes,
cost/latency and safe failure handling.

Before any Phase B call, build and review a one-request-per-invocation harness
with a persistent hard counter in a private 0700 directory/0600 file outside
the repository. Read the key only from its approved private file. Use no SDK or
transport retries, reserve the counter before request, and count unknown outcomes.
Proposed initial cap: **four requests**, one per role, to verify basic Responses,
image and schema contracts before seeking a separate larger fixture allowance.
Four requests are not production qualification.
