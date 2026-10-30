# culture atlas runbooks

Operational procedures for capture platform v2. Production is the on-prem
Compose stack ([deploy.md](../deploy.md)): run every `atlas-ops <command>`
below as `docker compose --profile ops run --rm ops <command>` from the
directory holding `docker-compose.yml` (the `ops` image has the code and the
PostgreSQL 16 client tools). `atlas-ops` itself belongs to the AWS reference
shape in [deploy-aws.md](../deploy-aws.md); any host with the repository and
`DATABASE_URL` can also use `pnpm <command>`.

`atlas-ops` is installed on the AWS host by `infra/aws/bootstrap.sh`. It runs a
one-off container from the deployed image with the production environment:

```sh
sudo atlas-ops pnpm ops:kill list
```

## Rules for every incident

- Log and paste IDs, codes, counts and times only. Never paste request bodies,
  tokens, cookies, signed URLs, email links, filenames, images or model text
  into tickets or chat. `logEvent` (packages/domain/src/ops/log.ts) already
  redacts these from application logs.
- Prefer a kill switch to a deploy. Kills only turn features off; the library,
  deletion and already captured media keep working.

## Agent and sharing kill switches

These are enforced by the services on every request (not only reported by
`GET /v2/capabilities`), globally (`FEATURE_KILL_SWITCHES` or a kill without
an account) or for one account (`--account <uuid>`):

| Kill | Effect while active (answers 503 `service_unavailable`) |
| --- | --- |
| `agent_api_enabled` | Every agent call: REST v1 and v2, MCP tool calls, the agent media gateway, open event streams (on their next poll) and agent capture requests. Grants are kept; lifting the kill restores access. |
| `agent_remote_capture_enabled` | New capture requests; queued commands are cancelled when the phone next claims; a delivered command fails its pre-execution check. Off by default anyway until `AGENT_REMOTE_CAPTURE_ENABLED=true`. |
| `collection_sharing_enabled` | Viewing shared collections and media, redeeming links, accepting invitations, creating or broadening shares. Owners can still list, narrow and revoke. Shares, sessions and memberships are kept. |

Amendment 2.2 adds four killable flags: `onboarding_required`, `taste_seed_enabled`,
`fast_analysis_two_stage` and `while_we_look_enabled`. The kill list and flag
evaluation accept them now; the services that honor them land with build plan
v2.2 packages A–D, so until then a kill only changes the evaluated flag (and
`GET /v2/capabilities`). Intended effects: new accounts reach the feed without
the questionnaire; no new seed jobs (labeled examples fill the feed); photos
use the single-call reading; the "While we look" strip is hidden.

```sh
sudo atlas-ops pnpm ops:kill kill agent_api_enabled --reason "<why>"
sudo atlas-ops pnpm ops:kill kill collection_sharing_enabled --account <uuid> --reason "<why>"
```
- Never delete queue rows, outbox rows or bucket prefixes to "fix" a backlog.
- Never point restore tooling at production.

## Alerts and where to go

Alarms are defined in `infra/aws/culture-atlas.yaml` and fire to the
`AlertEmail` SNS subscription. Metrics come from `pnpm ops:metrics`
(namespace `CultureAtlas`, see packages/domain/src/ops/metrics.ts).

| Alarm | Meaning | Runbook |
| --- | --- | --- |
| `CaptureQueueAge` (> 300 s) | Uploads are not being verified/prepared | [queue-recovery.md](queue-recovery.md) |
| `JobQueueAge` (> 300 s) | Analyses/plans are not starting | [queue-recovery.md](queue-recovery.md) |
| `ExpiredLeases` (> 0 for 15 min) | A worker died or stalled mid-job | [queue-recovery.md](queue-recovery.md) |
| `OpsMetricsMissing` | The metrics job or the database is down | [queue-recovery.md](queue-recovery.md#metrics-missing) |
| `StorageCleanup` (purge overdue or reservations unsettled) | Deleted media not purged within 24 h | [queue-recovery.md](queue-recovery.md#storage-cleanup) |
| `ModelSpendUnknown` / provider 402 in logs | Credits exhausted or billing unreconciled | [credit-exhaustion.md](credit-exhaustion.md) |
| Graph rollout, rollback or spend-ceiling question (PR 8) | Interest-graph flags, kills, budgets, telemetry | [graph-rollout.md](graph-rollout.md) |
| `Http5xxRate` (> 5 % for 5 min) | Web errors | check `docker compose logs web`, then the runbook for the failing area |
| `InstanceStatusCheck`, `CpuCreditsLow` | Host health / CPU credits exhausted | [deploy-aws.md](../deploy-aws.md#operating-the-host) |
| `BudgetOverOneDollar` (AWS Budgets email) | The account is incurring charges | [deploy-aws.md](../deploy-aws.md#costs) |
| Meta SDK / glasses incident | Glasses misbehaving or SDK terms issue | [glasses-kill-switch.md](glasses-kill-switch.md) |
| Suspected account compromise | User reports someone else in their account | [account-security.md](account-security.md) |

Scheduled exercise: [restore-drill.md](restore-drill.md) (quarterly, and
before each public rollout stage).
