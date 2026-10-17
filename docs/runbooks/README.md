# culture atlas runbooks

Operational procedures for capture platform v2. They assume the AWS shape in
[deploy-aws.md](../deploy-aws.md) (one EC2 host running Docker Compose), but
every command also works on any host with the repository and `DATABASE_URL`:
replace `atlas-ops <command>` with `pnpm <command>`.

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
| `Http5xxRate` (> 5 % for 5 min) | Web errors | check `docker compose logs web`, then the runbook for the failing area |
| `InstanceStatusCheck`, `CpuCreditsLow` | Host health / CPU credits exhausted | [deploy-aws.md](../deploy-aws.md#operating-the-host) |
| `BudgetOverOneDollar` (AWS Budgets email) | The account is incurring charges | [deploy-aws.md](../deploy-aws.md#costs) |
| Meta SDK / glasses incident | Glasses misbehaving or SDK terms issue | [glasses-kill-switch.md](glasses-kill-switch.md) |
| Suspected account compromise | User reports someone else in their account | [account-security.md](account-security.md) |

Scheduled exercise: [restore-drill.md](restore-drill.md) (quarterly, and
before each public rollout stage).
