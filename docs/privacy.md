# Privacy, retention and deletion

What culture atlas keeps, for how long, what deletion does, and what still has to be confirmed with providers before release. The behavior rules come from the build spec ("Privacy and retention"). This page records how the build implements them and where something remains open. Items marked **TODO** are release blockers for claims made to users.

## What is stored

| Data | Where | Retention |
| --- | --- | --- |
| Anonymous session and everything it owns (captures, uploads, results, hides) | Postgres + private object storage | 24 hours (`ANON_SESSION_TTL_HOURS`), then purged by the hourly `purge_deleted` job. Creating an account claims it instead. |
| Account captures | Postgres; the normalized derivative (≤ 2048 px, oriented, **all metadata stripped, including GPS**) in private storage | Until the user deletes the capture or the account. Originals are not kept (`STORE_ORIGINALS=false` by default). |
| Uploads not turned into captures | Private storage + `uploads` | 24 hours |
| Analyses, private reference links, recommendations, saves, collections, plans, preference events | Postgres, owner-scoped | Until deleted by the user; capture deletion removes the ones derived from that capture |
| Public reference facts (names, sourced claims, source URLs) | Postgres, shared | Kept. They never include private image context or who saved them. |
| Agent and bridge tokens | Postgres: sha256 hash + display prefix only | Until revoked or expired |
| World Sensor viewer credential (poll mode) | Postgres, AES-256-GCM encrypted with `CREDENTIAL_ENCRYPTION_KEY`, bound to the connection id | Until the connection is deleted (the credential is erased then) |
| World Sensor import ledger (`sensor_imports`: relay asset id, declared hash, capture time, status) | Postgres | Kept after capture deletion so a deleted photo is not re-imported; removed with the account. **TODO:** clear the hash and capture time once the capture is purged, keeping only the asset id. |
| Bridge state file (relay asset ids, pending upload ids) | The bridge machine, `BRIDGE_STATE_FILE`, mode 0600 | Until the operator deletes it. It holds no credentials. |
| Idempotency records (request hash and response) | Postgres | 24 hours. Routes that return a credential (`POST /v1/sensor-connections`) are not replayable, so a token is never stored there. **TODO** (agent stream): `POST /v1/agent-connections` is replayable and stores its shown-once credential in this table for 24 hours. |
| Demo inspector traces | Postgres `trace_events` | Ids, counts, timings, provider ids and ranks only. No tokens, credentials, image bytes or full prompts. Removed with the job or account. |
| Application logs | Hosting platform | Ids, timings, counts and safe error codes only (no images, credentials, collection names or full private prompts). **TODO:** record the platform's log retention here. |

Photos and private preferences are never used for training.

## Deletion

`DELETE /v1/captures/{id}` (implemented in `packages/domain/src/services/captures.ts`; see [pipeline.md](pipeline.md)):

- **Immediately:**
  - cancels unfinished jobs (workers re-check before publishing, so a running analysis cannot publish afterwards);
  - removes the capture's saved item, memberships and collection covers;
  - removes preference links, personal recommendations and dependent plans;
  - recomputes taste.
- **Right after the transaction commits:** deletes the media objects, so signed links (short-lived, 5 minutes by default) stop working.
- **Within 24 hours:** the hourly purge job physically removes the deleted records.
- **Retained:** independently saved canonical items supported by other evidence, and shared public reference facts (without private associations).

Disconnecting World Sensor (`DELETE /v1/sensor-connections/{id}`) erases the stored viewer credential and revokes the bridge token. Captures already imported stay until deleted individually.

**TODO (account deletion):** the spec requires deletion and disclosure. Confirm the account deletion flow end to end once the accounts stream lands. Every private table cascades from `accounts`.

## Backups

The spec allows encrypted backups to expire after at most 30 days, and that window must be disclosed in settings. **TODO:** configure the managed Postgres backup or point-in-time-recovery window to ≤ 30 days, then record the actual value here and in the settings copy. Object storage must not keep versions of deleted media: disable bucket versioning, or set a lifecycle rule that expires noncurrent versions within 30 days.

## What providers receive

| Provider | Receives | Does not receive | Retention by the provider |
| --- | --- | --- | --- |
| Anthropic (VLM, research and composer models) | The normalized derivative image (metadata stripped), the chosen focus, and user-supplied corrections and constraints as data; for research, public source excerpts | Account ids, other users' data, location | **TODO:** confirm the current commercial API data-retention terms for this account (and whether zero data retention applies) and state them here. Do not promise deletion from Anthropic beyond those terms. |
| Qloo | Entity and tag names or ids resolved from the analysis, and category filters | Images, account ids, collection names | **TODO:** confirm whether Qloo logs or retains queries, and whether we may store responses (`provider_queries.results`). Until confirmed, store only ids, names and ranks needed for traceability. |
| Wikipedia / Wikimedia | Public reference names (search and page summary requests) with a descriptive User-Agent | Images or anything private | Governed by the Wikimedia privacy policy; requests contain no personal data. |
| Object storage (S3-compatible) | Encrypted-at-rest private media | n/a | Deletion as configured above. **TODO:** record the bucket's encryption and lifecycle settings. |
| World Sensor relay | Viewer-authenticated read requests from the poller or the bridge | Nothing is written to the relay | The Sensor evidence chain is not modified. |

## Before release (checklist)

- [ ] Fill every **TODO** above with the confirmed provider or platform terms.
- [ ] Settings page discloses: anonymous 24-hour expiry, capture deletion behavior, 24-hour purge, backup window.
- [ ] `SESSION_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` and `STORAGE_SIGNING_SECRET` (local driver only) are set from a secret store, not committed.
- [ ] Bucket versioning or lifecycle rules match the backup window.
- [ ] Qloo storage and display rights are recorded in `docs/capability-matrix.md`.
