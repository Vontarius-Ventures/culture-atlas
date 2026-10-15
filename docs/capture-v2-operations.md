# Capture v2 operations and restore

## Runtime and rollout

Apply additive migrations051–057 before clients. Keep v1 tables and routes.
S3 is required in production, private bucket with public access blocked, TLS,
least-privilege service roles and per-environment buckets. Clients receive only
scoped multipart-part URLs (900s), never list/read/delete credentials. CORS allows
PUT from the actual app origins, permits signed headers and exposes ETag.
Enable provider lifecycle: abort incomplete multipart uploads after1 day; remove
staging objects after2 days. Never expire retained `accounts/*/media/*` by age.
Use bucket encryption and separate operational/backup identities.

`LocalMultipartStorage` is a durable filesystem **test double**, not cloud
deployment evidence. It exposes only HMAC-authorized bounded part PUTs and
authenticated media gateways. Its root must not be served as static content.
Do not use the filesystem driver for multi-host production.

Configure `setCaptureV2Runtime` at server startup:

- Identity adapter: recoverable-account requirement; non-consuming/consuming
  native enrollment grants; native issuance/revocation. Resolve every cna_ token
  through live identity family revocation.
- Register `endCaptureAuthority` as identity's synchronous lifecycle hook before
  activating enrollment. Its transaction ends capture/arm and tombstones pending
  uploads by pausing and fencing them. User device removal tombstones pending
  uploads. The identity workstream persists `identity_authority_events`.
- P2 workers write qualified-matrix heartbeats through heartbeatMediaWorker only
  after resource-bounded decoder qualification. Web requires a fresh (<2min)
  record plus CAPTURE_VIDEO_UPLOAD_ENABLED. No client flag can grant
  experimental glasses; defaults remain unavailable until all server gates pass.

Keep startup adapters in one composition root. Domain contexts are injected
explicitly for workers/tests. The default HTTP path fails closed if recoverable
identity is not configured. Native refresh, email delivery and device SDK
qualification belong to their owning packages.

P2 media workers claim CaptureQueue verify_upload/prepare_media/purge_media/
cleanup_upload. Dispatch to MediaPreparation verifyUpload/prepareMedia/cleanup.
P4 claims analyze_media and uses MediaAnalysis loadWork/publish; no automatic AI.
Heartbeat at most every10s with60s leases. Maximum lease extension300s; bound
individual storage/decoder operations below5min, stop on heartbeat failure.
Worker scratch is disposable and bounded, with no decoder network access.
Never use a worker's ambient/founder account: reconstruct ownership from lease.
Worker polling must run queue.reap() and preparation.expireUploads() periodically.
Purge executes immediately and again10min after the tombstone to catch late
attempt writes; startup/restarts resume the durable second pass.

`CAPTURE_MEDIA_CREATION_ENABLED=false` pauses new captures but keeps library
reads, deletion, URL refresh and completion of already reserved uploads working.
Account quota defaults5GiB, configured by ACCOUNT_MEDIA_QUOTA_BYTES. Reservations
include32MiB bounded derivatives, settle once and shrink to actual prepared
bytes. Historical captures use stored keys and known upload sizes; inventory
unmeasured legacy objects before production quota qualification.

## Monitoring and cleanup

Alert on queue age>5min, work failed/exhausted, expired leases, reservations
unsettled beyond24h, staging growth, purge errors and deleted assets without a
completed delayed purge within24h. Log IDs, codes and elapsed times only, never
request bodies, tokens, filenames, images or model text.
The queue is its transactional outbox: work rows commit with media transitions.
Do not delete outbox rows to “fix” stuck work; investigate and retry with a fresh
attempt token after restoring the dependency.

Reconciliation must compare immutable media namespaces to live DB references
after a safety window: report missing referenced objects; delete orphan attempt
keys only after confirming no live upload/lease can still publish. Never blindly
delete a bucket prefix or a record that has a live24h upload. Tombstoned media
namespaces are safe to purge repeatedly. Bucket lifecycle covers staging orphans
from a process crash between multipart creation and DB commit.

## Backups

Targets, not measured SLOs: DB point-in-time recovery within15min, daily immutable
object inventory, primary physical deletion within24h, backup expiration within
30 days. Configure and verify the provider lifecycle and backup expiration;
setting a variable does not configure either. No paid cloud action is performed
by this implementation.

1. Use managed DB PITR plus daily encrypted logical snapshots. Store exports in
   a0700 directory outside the repository. Do not put credentials in CLI args or
   logs. PG_DUMP_BIN may identify an installed pg_dump matching the DB major.
2. Run `DATABASE_URL=… CAPTURE_BACKUP_DIR=… pnpm exec tsx scripts/capture-backup.ts`
   using private injected environment variables. It exports a consistent
   repeatable-read DB snapshot and object/tombstone inventories. The resulting
   manifest deliberately says `objects_backed_up:false`.
3. Independently back up/version all immutable keys in objects.json, including
   legacy keys verbatim. A DB snapshot without those bytes is not a media backup.
   Validate object presence and SHA-256, not multipart ETags. Preserve provider
   version IDs in the backup inventory. Protect backup buckets from primary
   deletion roles but impose the30-day retention bound.
4. Keep an encrypted, access-controlled deletion journal newer than the DB
   snapshot, including account/asset UUID, generation and deletion time only.
   Export current tombstones frequently. On restore replay the newest journal
   before exposing any media. A backup must never resurrect a deleted library.
5. Verify snapshot/backup encryption, recovery keys, retention and access logs.
   No media contents, account emails, tokens or signed URLs belong in reports.

## Restore drill (isolated staging, never production)

1. Create a new empty DB and a separate private restore bucket/root. Disable all
   workers, email/push delivery and model calls. Never point restore tooling at
   production or pass `--clean` against an existing DB.
2. `PGDATABASE=<isolated restore URL> pg_restore --no-owner --no-acl --exit-on-error database.dump`
   with PGDATABASE supplied privately; migrate only forward after checking the
   recorded schema checksums. Restore immutable object versions to their exact
   stored keys; never reconstruct paths from current owner IDs.
3. Revoke restored sessions/token families, disable remote capture and apply the
   latest deletion journal. Abort expired uploads. Requeue only nondeleted media
   jobs with fresh lease/attempt tokens. Do not replay camera commands.
4. Validate every inventory reference: existence, actual size and SHA-256; verify
   normal photos, video playback/poster/frames and legacy assets. Missing originals
   remain unavailable; never synthesize them from thumbnails.
5. With two new accounts, repeat guessed-ID denials for media/upload/content/
   devices/jobs, account-switch assertions and a delete-during-prepare race.
   Revoked devices must not regain authority from restored data.
6. Record snapshot time, object backup/version inventory, journal cutoff, missing
   object count, test counts, RPO/RTO and approver. Destroy only the explicitly
   created drill resources after recording results.

Local PostgreSQL/filesystem tests and a local metadata restore are development
evidence only. OPS-01 still requires the managed cloud/object restore drill,
alerts, monitoring and independent-user trials in staging.
