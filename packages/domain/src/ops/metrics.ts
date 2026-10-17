import type { Queryable } from '../db/pool';

/**
 * Operational health snapshot computed from durable state only (no payloads,
 * no per-account data). Feeds the alerts in BUILD-AND-ACCEPTANCE "Operational
 * targets" and docs/capture-v2-operations.md "Monitoring and cleanup".
 *
 * Kept to eight metrics so the AWS shape stays inside the CloudWatch custom
 * metric allowance documented in docs/deploy-aws.md.
 */
export interface OpsSnapshot {
  /** Oldest runnable capture_work item (verify/prepare/purge/cleanup/analyze); alert > 300s. */
  CaptureQueueOldestSeconds: number;
  /** Oldest runnable v1 job (analysis, plans); alert > 300s. */
  JobQueueOldestSeconds: number;
  /** Capture work and jobs that failed in the last hour. */
  WorkFailedLastHour: number;
  /** Running capture work or jobs whose lease expired (worker crash or stall). */
  ExpiredLeases: number;
  /** Uploads stuck in "verifying" for more than 30 minutes. */
  UploadsStuckVerifying: number;
  /** Quota reservations still "reserved" a day after they expired. */
  ReservationsUnsettled: number;
  /** Deleted media whose purge has not completed within 24h (storage cleanup failure). */
  PurgeOverdue: number;
  /** Model gateway attempts whose billing outcome is unknown (spend-cap input). */
  ModelAttemptsUnknown: number;
}

export async function collectOpsSnapshot(db: Queryable, now = new Date()): Promise<OpsSnapshot> {
  const { rows } = await db.query<Record<keyof OpsSnapshot, string | number | null>>(
    `SELECT
       COALESCE((SELECT EXTRACT(EPOCH FROM ($1::timestamptz - min(available_at)))
         FROM capture_work WHERE state='queued' AND available_at<=$1), 0) AS "CaptureQueueOldestSeconds",
       COALESCE((SELECT EXTRACT(EPOCH FROM ($1::timestamptz - min(available_at)))
         FROM jobs WHERE state='queued' AND available_at<=$1), 0) AS "JobQueueOldestSeconds",
       (SELECT count(*) FROM capture_work WHERE state='failed'
          AND COALESCE(completed_at,created_at) > $1::timestamptz - interval '1 hour')
       + (SELECT count(*) FROM jobs WHERE state='failed'
          AND COALESCE(finished_at,updated_at) > $1::timestamptz - interval '1 hour') AS "WorkFailedLastHour",
       (SELECT count(*) FROM capture_work WHERE state='running' AND lease_expires_at < $1)
       + (SELECT count(*) FROM jobs WHERE state='running' AND lease_expiry < $1) AS "ExpiredLeases",
       (SELECT count(*) FROM upload_sessions WHERE state='verifying'
          AND created_at < $1::timestamptz - interval '30 minutes') AS "UploadsStuckVerifying",
       (SELECT count(*) FROM usage_reservations WHERE state='reserved'
          AND expires_at < $1::timestamptz - interval '24 hours') AS "ReservationsUnsettled",
       (SELECT count(*) FROM media_assets m WHERE m.deleted_at < $1::timestamptz - interval '24 hours'
          AND EXISTS (SELECT 1 FROM capture_work w WHERE w.account_id=m.account_id AND w.asset_id=m.id
            AND w.kind='purge_media' AND w.state IN ('queued','running','failed'))) AS "PurgeOverdue",
       (SELECT count(*) FROM model_gateway_attempts WHERE state='unknown') AS "ModelAttemptsUnknown"`,
    [now],
  );
  const row = rows[0]!;
  const out = {} as OpsSnapshot;
  for (const [key, value] of Object.entries(row))
    out[key as keyof OpsSnapshot] = Math.max(0, Math.round(Number(value ?? 0)));
  return out;
}

/**
 * CloudWatch Embedded Metric Format: one JSON log line that CloudWatch Logs
 * turns into metrics without any API call or SDK. Without CloudWatch the line
 * is still a readable structured log.
 */
export function toEmbeddedMetricLine(
  snapshot: OpsSnapshot,
  options: { namespace: string; environment: string; now?: Date },
): string {
  const names = Object.keys(snapshot) as (keyof OpsSnapshot)[];
  return JSON.stringify({
    _aws: {
      Timestamp: (options.now ?? new Date()).getTime(),
      CloudWatchMetrics: [
        {
          Namespace: options.namespace,
          Dimensions: [['Environment']],
          Metrics: names.map((name) => ({
            Name: name,
            Unit: name.endsWith('Seconds') ? 'Seconds' : 'Count',
          })),
        },
      ],
    },
    Environment: options.environment,
    event: 'ops_snapshot',
    ...snapshot,
  });
}
