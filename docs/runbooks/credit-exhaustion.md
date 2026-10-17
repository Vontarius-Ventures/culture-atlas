# Runbook: model credit exhaustion and spend caps

Applies once Concentrate analysis is enabled (docs/concentrate.md). Until then
`concentrate_analysis_enabled` evaluates to off and this runbook is not
needed.

## Invariants

- Credit exhaustion pauses AI only. Capture, uploads, the library, sharing and
  deletion keep working; no capture is lost (AI-02).
- There is no silent fallback to another gateway or an unqualified model.
- Reserved and unknown attempts count against the caps until the billing
  reconciler settles them. Missing usage never settles to zero.

## Signals

- Provider 402: the gateway persists a global AI-only pause; analysis requests
  show a recoverable "AI is paused" state.
- `ModelAttemptsUnknown` rising (alarm `ModelSpendUnknown`): dispatched
  attempts are not yet reconciled against billing; caps may be approached
  even with low real spend.
- 429: throttling. The gateway records Retry-After and pauses dispatch; this
  normally clears by itself.

## Steps

1. Confirm the scope: is it 402 (credits), 429 (throttle) or a cap
   (`MODEL_DAILY_SPEND_LIMIT_USD`, `MODEL_MAX_UNKNOWN_SPEND_USD`)? Use log
   events and the ledger, never provider error bodies.
2. Optional, to stop new analysis requests from queueing while you work:

   ```sh
   sudo atlas-ops pnpm ops:kill kill concentrate_analysis_enabled --reason "<incident>: credits"
   ```

   Clients then see analysis as unavailable with reason
   `temporarily_disabled`; existing results stay readable.
3. Credits: the operator tops up the Concentrate account (outside this
   system). Do not raise spend caps to "make it work".
4. Unknown spend: run the billing reconciliation (`ledger.reconcile(id,
   actualCostMicros)` per attempt, from billing evidence only).
5. Resume: after credits are restored and readiness reports qualified, call
   `ledger.resume()` as described in docs/concentrate.md, then lift the kill:

   ```sh
   sudo atlas-ops pnpm ops:kill lift concentrate_analysis_enabled
   ```

6. Queued analysis jobs resume through the scheduler; they are not replayed
   in-process. Users can re-request analysis on media whose job failed.

## AWS cost note

None of this incurs AWS charges by itself. Model spend is billed by the model
provider, not AWS, and is not covered by any AWS free allowance.
