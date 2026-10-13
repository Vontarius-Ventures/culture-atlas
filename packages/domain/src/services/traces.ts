import type { Queryable } from '../db/pool';
import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type { TraceResponse } from '../schemas/traces';

export interface TraceEventInput {
  kind: 'stage' | 'provider_call' | 'agent_tool_call' | 'rest_call' | 'note';
  name: string;
  /** Must already be redacted: no tokens, credentials, image bytes or private prompts. */
  data?: Record<string, unknown>;
  jobId?: string | null;
  traceId?: string | null;
  ownerAccountId?: string | null;
  ownerSessionId?: string | null;
  agentConnectionId?: string | null;
  durationMs?: number | null;
}

/** Append a demo-inspector trace event. Never throws into the caller's flow. */
export async function recordTraceEvent(db: Queryable, event: TraceEventInput): Promise<void> {
  try {
    await db.query(
      `INSERT INTO trace_events (trace_id, job_id, owner_account_id, owner_session_id, agent_connection_id,
                                 kind, name, data, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        event.traceId ?? null,
        event.jobId ?? null,
        event.ownerAccountId ?? null,
        event.ownerSessionId ?? null,
        event.agentConnectionId ?? null,
        event.kind,
        event.name,
        JSON.stringify(event.data ?? {}),
        event.durationMs ?? null,
      ],
    );
  } catch (err) {
    console.warn('[trace] failed to record event', (err as Error).message);
  }
}

/**
 * GET /v1/demo/traces/{job_id} — authorized developer/demo-owner trace only.
 * Requires an account principal listed in DEMO_INSPECTOR_ACCOUNT_IDS (or
 * accounts.is_demo_owner) that owns the job; everyone else gets 404.
 * Assembles capture/observations/resolved Qloo ids/provider queries/
 * references/recommendations/taste changes/agent calls. Redact tokens.
 * TODO(inspector owner): implement.
 */
export async function getTrace(ctx: ServiceContext, input: { job_id: string }): Promise<TraceResponse> {
  void ctx;
  void input;
  notImplemented('traces.getTrace');
}
