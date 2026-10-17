# Runbook: queue recovery

Covers `CaptureQueueAge`, `JobQueueAge`, `ExpiredLeases`, `StorageCleanup`
and `OpsMetricsMissing`.

Two durable queues live in PostgreSQL:

- `capture_work`: v2 media work (`verify_upload`, `prepare_media`,
  `purge_media`, `cleanup_upload`, `analyze_media`). It is also the outbox:
  rows commit in the same transaction as the media state change.
- `jobs`: v1 analyses, discovery and plans.

Workers lease rows with a token and an expiry, heartbeat, and re-check owner,
generation and tombstones before publishing anything. A crashed worker's lease
simply expires and another worker re-claims it with a fresh attempt token.

## 1. Look before touching anything

```sh
sudo atlas-ops pnpm ops:metrics
cd /opt/culture-atlas && sudo docker compose ps
sudo docker compose logs --since 30m worker media-worker | tail -200
```

Check which services are up, restarting or OOM-killed
(`docker inspect --format '{{.State.OOMKilled}}' <container>`). On a 1 GiB
host the media worker running ffmpeg is the usual OOM victim.

Read-only queue view (counts only):

```sql
SELECT kind, state, count(*), min(available_at) AS oldest
FROM capture_work WHERE state IN ('queued','running','failed') GROUP BY 1,2 ORDER BY 1,2;
SELECT type, state, count(*), min(available_at) FROM jobs
WHERE state IN ('queued','running') GROUP BY 1,2;
```

Run SQL with `sudo atlas-ops psql` (wrapper opens psql with the production
`DATABASE_URL`; it never echoes the URL).

## 2. Workers are down or crash-looping

1. `sudo docker compose up -d worker media-worker` (or `sudo atlas-deploy` to
   restart everything with the current image and SSM environment).
2. If they OOM: lower `MEDIA_WORKER_CONCURRENCY` to 1 (default on micro) and
   `WORKER_CONCURRENCY` to 2 in SSM, redeploy. Confirm the swap file is active
   (`swapon --show`).
3. Expired leases are re-claimed automatically once a worker runs; the
   `ExpiredLeases` metric should return to 0 within one lease period
   (60 s for capture work, `JOB_LEASE_MS` for jobs).

## 3. Workers are up but one kind keeps failing

- Look at `error_code` counts:
  `SELECT kind, error_code, count(*) FROM capture_work WHERE state='failed' AND completed_at > now() - interval '1 hour' GROUP BY 1,2;`
- `decoder_*` / video errors: ffmpeg problem or unqualified input. Pause video
  creation while investigating:
  `sudo atlas-ops pnpm ops:kill kill camera_video --reason "<incident>"` and
  `... kill file_video_upload ...`. Photos and the library keep working.
- Storage errors (`storage_*`, timeouts to S3): check the instance role and
  bucket policy, then the S3 service health page.
- If new uploads must stop entirely (e.g. storage outage):
  `kill file_photo_upload` and `kill camera_photo` as well. Already reserved
  uploads can still complete; reads and deletion continue.

Do NOT `DELETE FROM capture_work` or mark rows complete by hand. After fixing
the dependency, failed media can be retried by the owner (Retry preparation)
or requeued by the media worker's retry path, always with a fresh attempt
token.

## 4. Analysis backlog only (`JobQueueAge`, `analyze_media` growing)

Usually provider throttling (429) or a credit pause (402). Go to
[credit-exhaustion.md](credit-exhaustion.md). Capture and the library are not
affected.

## Storage cleanup

`PurgeOverdue` > 0: deleted media still has a queued/failed `purge_media`
item after 24 h. `ReservationsUnsettled` > 0: quota reservations stayed
`reserved` a day past expiry.

1. Confirm the media worker is running (purge runs immediately and again
   10 minutes after the tombstone).
2. Check S3 permissions for `s3:DeleteObject` on `accounts/*` for the
   instance role (infra/aws/culture-atlas.yaml `AppInstanceRole`).
3. Bucket lifecycle still removes staging objects after 2 days and incomplete
   multipart uploads after 1 day; that covers crashes between multipart
   creation and DB commit, not purge of committed media.
4. Never delete a bucket prefix by hand. A deleted asset's namespace is safe to
   purge repeatedly through the worker.

## Metrics missing

`OpsMetricsMissing` means no `CaptureQueueOldestSeconds` datapoint for
15 minutes. Either the `ops-metrics` service stopped, CloudWatch log shipping
broke, or the database is unreachable.

1. `sudo docker compose ps ops-metrics` and its logs (`ops_snapshot_failed`
   means the DB query failed).
2. `sudo docker compose logs --since 10m web | grep -c '"status":5'` for a
   quick web error count; check RDS (or the local `postgres` service) status.
3. Restart: `sudo docker compose up -d ops-metrics`.
