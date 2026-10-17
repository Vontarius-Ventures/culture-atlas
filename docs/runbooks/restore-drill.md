# Runbook: restore drill

Goal: prove that the database and the media objects can be restored, that the
restored copy cannot act on users' devices, and that deleted media stays
deleted. Run quarterly and before each rollout stage. ISOLATED STAGING ONLY.

What is automated: `pnpm ops:backup` (scripts/capture-backup.ts) takes a
consistent metadata snapshot plus object and tombstone inventories;
`pnpm ops:restore-drill` (scripts/restore-drill.ts) restores into a new empty
database, neutralises restored authority, replays tombstones and the deletion
journal, and verifies every inventoried object by size and SHA-256.
`scripts/restore-drill.test.ts` runs that whole path with real `pg_dump` and
`pg_restore` on every test run. That local run is development evidence only;
OPS-01 still needs this drill against the real cloud database and bucket.

## 0. Prerequisites

- A backup directory from `pnpm ops:backup` (manifest, `database.dump`,
  `objects.json`, `tombstones.json`), 0700, outside the repository.
- A copy of the objects listed in `objects.json`: a separate restore bucket
  (S3 versioning/replication or `aws s3 sync` of the listed keys), or a local
  directory for a small drill. Never the production bucket.
- A deletion journal newer than the snapshot (tombstones exported after it),
  as JSON in the `tombstones.json` shape.
- `pg_restore` with the same major version as the database (16).

## 1. Take the snapshot

On the host (writes into the `backups` volume):

```sh
sudo atlas-ops env CAPTURE_BACKUP_DIR=/backups pnpm ops:backup
```

With RDS, also note the automated snapshot / PITR time that matches. The
manifest says `objects_backed_up: false` on purpose: the dump is not a media
backup.

## 2. Create isolated drill resources

- A new empty database (RDS: restore a snapshot to a NEW instance and create
  an empty database in it, or use a local PostgreSQL 16 for metadata-only
  practice). Disable email, push and model credentials for the drill
  environment: do not give it the production SSM parameters.
- The restore copy of the objects.

## 3. Run the drill

```sh
RESTORE_DRILL_CONFIRM=isolated \
RESTORE_TARGET_DATABASE_URL='<new empty database URL>' \
pnpm ops:restore-drill -- --backup <backup dir> \
  --objects s3:<restore bucket>   # or local:<dir> \
  --journal <journal.json>
```

The tool refuses a non-empty target and a target equal to `DATABASE_URL`.
It prints a JSON report with counts only and exits 1 if migrations differ or
any object is missing, truncated or corrupt.

In the restored database it has already:

- revoked every browser session, native session family, enrollment grant,
  email proof and agent connection;
- ended capture sessions and remote arming, fenced every installation and
  cleared push tokens;
- cancelled queued/delivered/executing camera commands (never replayed);
- expired stale uploads, applied snapshot tombstones and the newer journal;
- returned running work to `queued` without leases (except deleted media).

## 4. Manual verification (record pass/fail)

1. Start the app against the restored database with a drill-only
   environment. Media opens for a restored test account after it signs in
   again with email.
2. Photos, video playback/poster/frames and a legacy asset load.
3. Two NEW accounts: guessed media/upload/content/device/job IDs are denied
   (404), an account switch mid-upload does not move anything, and a
   delete-during-prepare race leaves the asset deleted.
4. A restored phone cannot call the API (its tokens were revoked) and must
   enroll again.
5. Media deleted after the snapshot (journal) is not visible.

## 5. Record

Snapshot time, journal cutoff, report JSON, missing/corrupt object counts,
manual results, RPO (snapshot age at incident time) and RTO (`elapsed_ms`
plus manual steps), approver. Then delete only the drill database and the
restore copy you created.

Targets (not measured SLOs): database point-in-time recovery within 15
minutes, daily object inventory, backups expire within 30 days.
