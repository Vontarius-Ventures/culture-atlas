# Native client contract fixtures

Shared, platform-neutral facts and decision tables for the native apps
(`apps/ios`, `apps/android`). Both apps implement the rules independently (no
shared Swift/Kotlin source); these files are the single place where the
expected behaviour is written down.

| File | What it pins | Read by |
| --- | --- | --- |
| `contract.json` | Contract version, headers, token formats, identity callbacks, every `/v2` route the apps call (and whether the server routes it yet), upload/command/capture constants | iOS `ContractTests`, Android `ContractTest`, TS test |
| `messages.json` | Example request/response bodies, each tagged with the server zod schema it must satisfy | iOS/Android codec tests, TS test |
| `enrollment-signature.json` | Enrollment proof payload rule, P-256 public key, signature vectors (P1363 and DER) and DER to P1363 conversions | iOS `EnrollmentProofTests`, Android `EnrollmentProofTest`, TS test |
| `upload-parts.json` | Part planning, `/parts` batching, resume receipt merging, next step for each server upload state | `PartPlannerTests` / `PartPlannerTest`, TS test |
| `command-lifecycle.json` | Phone-side remote command decisions (execute, resend stored ack, unknown after crash, skip expired, refuse), outcome to ack mapping, and ack sequences the server accepts | `CommandProcessorTests` / `CommandProcessorTest`, TS test |
| `draft-lock.json` | Account ownership of local drafts, sign-out order and choices, server responses that lock a draft | `DraftLockPolicyTests` / `DraftLockPolicyTest`, TS test |
| `capability-gate.json` | Experimental Meta glasses state from server policy + local SDK state; phone camera gating | `CapabilityGateTests` / `CapabilityGateTest`, TS test |
| `error-policy.json` | Client action per server error code, backoff schedule, refresh retry rules | `ErrorPolicyTests` / `ErrorPolicyTest`, TS test |
| `onboarding.json` | Taste onboarding (amendment 2.2, screens 14/15/18): the 11 `/v1` routes a phone may call as its account owner (native owner bridge), exact copy, limits, counter, search, exclusion, entry, complete and seed decision tables | `OnboardingTests` / `OnboardingTest`, TS test |
| `ready-notice.json` | Ready notice (screen 17): silent APNs/FCM wake shapes, valid and invalid wakes, push-token registration, watched-analysis limits and the notification/toast decision table | `ReadyNoticeTests` / `ReadyNoticeTest`, TS test |

## How they are verified

`apps/web/lib/server/native-contract.test.ts` (runs with `pnpm test`):

- parses every example message with its server zod schema;
- checks the enrollment vectors against the server's `enrollmentSignaturePayload`
  and verifies both signature encodings with Node's crypto;
- checks the part plans, the error table against `ERROR_CODES`, and the
  capability reasons against `evaluateCaptureCapabilities`;
- checks the onboarding routes against `ROUTES` and `NATIVE_OWNER_OPERATIONS`,
  the copy against `specs/capture-platform-v2/design/copy.json`, the limits
  against the onboarding schemas, every onboarding and ready-notice table
  against a reference implementation, and the wake shapes against the real
  APNs (local HTTP/2 server) and FCM (stubbed fetch) drivers;
- drives an enrolled phone through `apiRoute` on every bridged onboarding
  route (account-owner principal, expected-account rule, ended installation
  refused, every other `/v1` route `scope_denied`) and registers the fixture
  push token through `PUT /v2/device/push-token` before a wake;
- drives a simulated phone through the real `/v2/identity/*` and `/v2/*` HTTP
  handlers: email sign-in with PKCE, enrollment with a P-256 proof, refresh
  with lost-response retry, part upload and resume from server receipts,
  every fixture ack sequence against an armed phone, and account switching
  that locks a pending upload to its original account (TEN-02).

The Swift and Kotlin unit tests read the same files (the Xcode test bundle and
the Gradle test task copy this directory as test resources). Those tests have
not been run in this repository's CI: there is no Xcode or Android SDK here.

## Rules

- No real credentials. Token-shaped values are examples in the documented
  format. The signature vectors were made with a throwaway key whose private
  half was never stored.
- Change a server contract and these files together; the TS test fails when a
  routed path, error code, part size or capability reason drifts.
