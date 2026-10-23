# Capture v2 media worker

`apps/media-worker` (`pnpm media-worker`) is the resource-bounded worker for
delivery packages 1–2 of `specs/capture-platform-v2/`. It claims leased
`capture_work` rows (`verify_upload`, `prepare_media`, `purge_media`,
`cleanup_upload`) and dispatches them to the domain `MediaPreparation` module.
`analyze_media` belongs to the analysis worker (Concentrate) and is not claimed here.

Without this process, uploads stay in `verifying` and `/v2/capabilities` keeps
video off (video needs a fresh qualified heartbeat from this worker).

## What it does

| Work | Implementation |
| --- | --- |
| `verify_upload` | Completes the multipart object, streams it once through SHA-256 and the verifier, seals it to the immutable key `accounts/{account}/media/{asset}/{generation}/original`, commits upload + asset + `prepare_media` in one transaction, then deletes staging. |
| Photo verification | sharp decode with pixel limit (`photoMediaVerifier`). |
| Video verification | Bounded write to scratch → `ffprobe` → declared MIME, magic bytes, container and codec must match the qualified matrix → full `ffmpeg` decode of video and audio with a duration cap (limit + 1s). Any decoder error rejects (`unsupported_media`); multithreaded ffmpeg can exit 0 on damaged input, so stderr is authoritative. Over-limit duration rejects as `duration_exceeded`. |
| `prepare_media` (photo) | Oriented, metadata-stripped JPEG ≤2048 px (`normalized-jpeg-v1`, `share_safe`). |
| `prepare_media` (video) | Remux (H.264 High/Main/Baseline yuv420p, no rotation, AAC, fits budget) or transcode to faststart H.264/AAC MP4 (`playback-mp4-h264-aac-v1`) with container metadata removed, rotation applied, bitrate sized to the 32 MiB derivative reservation; poster JPEG near 1s (`poster-jpeg-v1`); up to 8 frames (`frames-v1`). Audio is never dropped or invented: a source with audio must produce output with audio, a silent source stays silent. |
| `frames-v1` | `n = min(8, max(1, floor(duration_s)))` targets at the midpoints of `n` equal slices of the whole duration; each target snaps to the nearest real presentation timestamp of the playback output (from `ffprobe` packet PTS); duplicates collapse. Timestamps stored are the actual frame times, strictly inside the duration. |
| `purge_media` / `cleanup_upload` | Domain cleanup: aborts multipart, deletes staging/original/derivatives and the asset namespace; purge repeats 10 min after the tombstone. |

Every write is fenced: the domain rechecks lease, owner, generation and tombstone
before each derivative upload and again inside the publish transaction. Output is
written only under `.../derived/{attempt_id}/`, which is purged when an attempt loses.

## Resource bounds

- One scratch directory per attempt (`MEDIA_WORKER_SCRATCH_DIR`, default OS temp), mode 0700, removed after the attempt; stale directories are removed at startup and hourly.
- ffmpeg/ffprobe run without a shell, with a minimal environment (no credentials or proxy variables), `-protocol_whitelist file` on every input, `-threads` (`MEDIA_WORKER_THREADS`, default 2), wall-clock timeouts (probe 20s, decode 180s, transcode 240s), capped stdout/stderr, and `-fs` on outputs.
- Leases: 60s, heartbeat every 10s; a failed heartbeat or the 15-minute attempt ceiling kills the running ffmpeg process. Ownership comes only from the persisted lease.
- Concurrency: `MEDIA_WORKER_CONCURRENCY` (default 1).

## Qualification

At startup the worker generates short synthetic clips with its own encoders and runs
them through the same verifier used for customer files; a codec is accepted only
after that passes. It then runs the full transcode/poster/frames pipeline on a
synthetic VP9/Opus clip. Only if that succeeds does it write
`media_worker_capabilities` (matrix `media-worker-2026-10-17.1`) every 30s; on
shutdown it deletes its row. An unqualified worker still verifies photos; video
work is retried later instead of being rejected.

Matrix: MP4/MOV with H.264 or HEVC video and AAC audio; WebM with VP8, VP9 or AV1
video and Opus or Vorbis audio; one video and at most one audio track.

Qualification here proves the decoder/encoder build of this host. It is **not**
MED-05: browser/iOS/Android playback of the produced MP4s has not been tested on
devices.

## Periodic maintenance

| Task | Interval | Notes |
| --- | --- | --- |
| Queue reap | 15s | exhausted work → `failed` |
| Upload expiry | 30s | 24h sessions → `expired`, reservation released, multipart aborted by purge |
| Legacy backfill | 60s | `backfillLegacyCaptures` (below) |
| Storage reconciliation | 1h | `reconcileCaptureStorage`, 24h safety window |
| Capability heartbeat | 30s | only when qualified |

`reconcileCaptureStorage` inventories `accounts/` and removes, after the safety
window, staging objects whose session is no longer active, objects of unknown or
tombstoned assets, superseded originals and unreferenced attempt output (never while
a live lease could still publish). It aborts incomplete multipart uploads without an
active session. Referenced objects that are missing are only counted
(`missingReferenced`) when the inventory was complete. Logs carry counts only.

## Legacy captures and Sensor

Migrations 051/054 backfilled v1 captures that existed at deploy time.
`backfillLegacyCaptures` keeps later v1 captures (and anonymous captures later
claimed by an account) in the v2 library with their stored keys verbatim, mirrors v1
deletions as tombstones and keeps `analysis_status` in step. Sample captures are
never imported. World Sensor imports are a separate legacy source and enter the
library only with `CAPTURE_LEGACY_SENSOR_IMPORT_ENABLED=true`; all v2 media tests run
with it off.

## Hosting notes

The worker needs ffmpeg (installed in the `Dockerfile` runtime stage from Debian
bookworm), PostgreSQL and the same private S3 bucket as the web app
(`STORAGE_DRIVER=s3`; the filesystem driver is refused in production). For a small
single-instance deployment (for example one 1 GiB AWS instance), run
`MEDIA_WORKER_CONCURRENCY=1` and `MEDIA_WORKER_THREADS=1`: a 120s 1080p transcode is
CPU-bound and is the heaviest workload in the system. No AWS allowance makes this
free today: the legacy 12-month free tier has ended for every account, and the
Free plan pays instance hours from credits ([deploy-aws.md](deploy-aws.md)).

## Not verified here

- Real S3 (multipart, `ListMultipartUploads`, ranged GET) was not exercised: no
  network access. The S3 driver is covered by command-level unit tests; the
  filesystem driver by integration tests.
- Device playback of outputs (MED-05), physical glasses, and load/latency targets.
- Scene-diversity frame selection: `frames-v1` is uniform over the duration.
