import type { Queryable } from '../db/pool';
import type { ServiceContext } from '../context';
import type { JobState, JobType } from '../enums';
import { AppError } from '../errors';
import type { TraceResponse } from '../schemas/traces';
import { iso } from '../util/time';
import { resolveImage } from './cards';

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

// ---------------------------------------------------------------------------
// Redaction (defence in depth: stored data is already supposed to be clean)
// ---------------------------------------------------------------------------

const SECRET_KEY = /token|credential|authorization|password|secret|api[_-]?key|cookie|signature/i;
const PRIVATE_KEY = /^(object_key|private_object_key|original_object_key|storage_key|bucket)$/i;
const TOKEN_TEXT = /\b(cat_[a-z0-9]+_[A-Za-z0-9_-]{8,}|Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})/g;
const PRIVATE_URL = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1|[^/]*\.internal\b|[^/]*\.local\b)/i;

/** Remove credentials and private deployment details (internal URLs, storage keys) from inspector data. */
export function redactTraceData(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (PRIVATE_URL.test(value)) return '[private url]';
    return value.replace(TOKEN_TEXT, '[redacted]');
  }
  if (typeof value !== 'object') return value;
  if (depth > 8) return '[…]';
  if (Array.isArray(value)) return value.map((v) => redactTraceData(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (PRIVATE_KEY.test(k)) out[k] = '[private]';
    else out[k] = redactTraceData(v, depth + 1);
  }
  return out;
}

/** Compact view of a provider result list: count + the first ranked entries with ids, names and scores. */
export function summarizeProviderResults(results: unknown): unknown {
  if (results === null || results === undefined) return null;
  const pickList = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      for (const key of ['entities', 'results', 'tags', 'items', 'pages', 'sources']) {
        if (Array.isArray(o[key])) return o[key] as unknown[];
      }
    }
    return null;
  };
  const list = pickList(results);
  if (!list) {
    const text = JSON.stringify(results);
    return text.length <= 4000 ? results : { truncated: true, bytes: text.length };
  }
  const FIELDS = ['rank', 'entity_id', 'id', 'name', 'title', 'type', 'types', 'affinity', 'score', 'popularity', 'url', 'explainability', 'query'];
  const top = list.slice(0, 10).map((entry, i) => {
    if (!entry || typeof entry !== 'object') return entry;
    const e = entry as Record<string, unknown>;
    const out: Record<string, unknown> = { rank: i + 1 };
    for (const f of FIELDS) if (e[f] !== undefined) out[f] = e[f];
    return out;
  });
  return { count: list.length, top };
}

// ---------------------------------------------------------------------------
// GET /v1/demo/traces/{job_id}
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  type: JobType;
  state: JobState;
  payload: Record<string, unknown>;
  result_type: string | null;
  result_id: string | null;
  trace_id: string | null;
  created_at: Date;
  finished_at: Date | null;
}

interface SnapshotItemLike {
  item_id: string;
  title: string;
  kind: string;
  external_ids?: Record<string, unknown>;
  anchors?: { reference_id: string }[];
}

/** Account allowed to open the inspector: a demo owner (flag or DEMO_INSPECTOR_ACCOUNT_IDS). */
function inspectorAccountId(ctx: ServiceContext): string {
  const p = ctx.principal;
  // Browser account sessions only; agents, anonymous visitors and everyone else see "not found".
  if (p.kind !== 'account') throw new AppError('not_found');
  if (!p.isDemoOwner && !ctx.config.DEMO_INSPECTOR_ACCOUNT_IDS.includes(p.accountId)) throw new AppError('not_found');
  return p.accountId;
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

function externalEntities(
  externalIds: Record<string, unknown> | null | undefined,
  name: string,
  type: string | null,
  referenceId: string | null,
): TraceResponse['resolved_entities'] {
  const out: TraceResponse['resolved_entities'] = [];
  for (const [provider, raw] of Object.entries(externalIds ?? {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      const id = typeof v === 'string' || typeof v === 'number' ? String(v) : v && typeof v === 'object' && 'id' in v ? String((v as { id: unknown }).id) : null;
      if (id) out.push({ name, provider, provider_id: id, type, reference_id: referenceId });
    }
  }
  return out;
}

/**
 * Demo inspector trace for one job: the photo, visual observations, resolved
 * provider ids, provider queries with their inputs and ranked results, sourced
 * references, recommendations with provenance, saved taste changes on the
 * involved items, and the separate agent's service calls. Owner + demo-owner
 * only; everyone else gets 404 (never reveals that the job exists).
 */
export async function getTrace(ctx: ServiceContext, input: { job_id: string }): Promise<TraceResponse> {
  const accountId = inspectorAccountId(ctx);
  const db = ctx.db;
  const { rows: jobRows } = await db.query<JobRow>(
    `SELECT id, type, state, payload, result_type, result_id, trace_id, created_at, finished_at
       FROM jobs WHERE id = $1 AND owner_account_id = $2`,
    [input.job_id, accountId],
  );
  const job = jobRows[0];
  if (!job) throw new AppError('not_found');
  const payload = job.payload ?? {};

  let captureId: string | null = null;
  let analysisId: string | null = null;
  let planId: string | null = null;
  let planVersion: number | null = null;
  let discoveryJobId: string | null = null;
  let section: string | null = null;

  switch (job.type) {
    case 'analyze_capture': {
      captureId = (payload.capture_id as string) ?? (job.result_type === 'capture' ? job.result_id : null);
      const { rows } = await db.query<{ id: string }>(
        `SELECT a.id FROM analyses a JOIN captures c ON c.id = a.capture_id
          WHERE c.owner_account_id = $3 AND (a.job_id = $1 OR (a.capture_id = $2 AND a.version = $4))
          ORDER BY (a.job_id = $1) DESC NULLS LAST, a.version DESC LIMIT 1`,
        [job.id, captureId, accountId, Number(payload.analysis_version ?? 0)],
      );
      analysisId = rows[0]?.id ?? null;
      break;
    }
    case 'discover_related':
      discoveryJobId = (payload.discovery_job_id as string) ?? null;
      break;
    case 'generate_plan':
    case 'replace_plan_section':
      planId = (payload.plan_id as string) ?? null;
      planVersion = typeof payload.version === 'number' ? payload.version : null;
      section = job.type === 'replace_plan_section' ? ((payload.section as string) ?? null) : null;
      break;
    default:
      break;
  }

  // --- Related-discovery context --------------------------------------------
  let relatedOrigin: TraceResponse['related_origin'] = null;
  let anchorReferenceIds: string[] = [];
  if (discoveryJobId) {
    const { rows } = await db.query<{ origin_item_id: string; anchor_reference_ids: string[]; title: string; kind: string; capture_id: string | null }>(
      `SELECT dj.origin_item_id, dj.anchor_reference_ids, di.title, di.kind, di.capture_id
         FROM discovery_jobs dj JOIN discovery_items di ON di.id = dj.origin_item_id
        WHERE dj.id = $1 AND dj.owner_account_id = $2`,
      [discoveryJobId, accountId],
    );
    const dj = rows[0];
    if (dj) {
      relatedOrigin = { item_id: dj.origin_item_id, title: dj.title, kind: dj.kind };
      anchorReferenceIds = dj.anchor_reference_ids ?? [];
      captureId = dj.capture_id;
    } else {
      discoveryJobId = null;
    }
  }

  // --- Plan context -----------------------------------------------------------
  let plan: TraceResponse['plan'] = null;
  let planItems: SnapshotItemLike[] = [];
  if (planId) {
    const { rows } = await db.query<{ id: string; title: string | null; version: number; input_snapshot: { items?: SnapshotItemLike[] } }>(
      `SELECT p.id, pv.title, pv.version, pv.input_snapshot
         FROM plans p JOIN plan_versions pv ON pv.plan_id = p.id
        WHERE p.id = $1 AND p.owner_account_id = $2 AND ($3::int IS NULL OR pv.version = $3)
        ORDER BY pv.version DESC LIMIT 1`,
      [planId, accountId, planVersion],
    );
    const pv = rows[0];
    if (pv) {
      planItems = pv.input_snapshot?.items ?? [];
      planVersion = pv.version;
      plan = {
        id: pv.id,
        version: pv.version,
        section,
        title: pv.title,
        inputs: planItems.map((i) => ({ item_id: i.item_id, title: i.title, kind: i.kind })),
      };
    } else {
      planId = null;
    }
  }

  // --- Capture and observations ----------------------------------------------
  let capture: TraceResponse['capture'] = null;
  if (captureId) {
    const { rows } = await db.query<{ id: string; private_object_key: string | null; width: number | null; height: number | null }>(
      `SELECT id, private_object_key, width, height FROM captures
        WHERE id = $1 AND owner_account_id = $2 AND deleted_at IS NULL`,
      [captureId, accountId],
    );
    const c = rows[0];
    if (c) {
      capture = {
        id: c.id,
        image: c.private_object_key
          ? await resolveImage(ctx, { object_key: c.private_object_key, width: c.width, height: c.height, alt: 'The analyzed photo' })
          : null,
      };
    } else {
      captureId = null;
      analysisId = null;
    }
  }
  let observations: unknown[] = [];
  let candidates: unknown[] = [];
  if (analysisId) {
    const { rows } = await db.query<{ observations: unknown[]; candidates: unknown[] }>(
      'SELECT observations, candidates FROM analyses WHERE id = $1',
      [analysisId],
    );
    observations = rows[0]?.observations ?? [];
    candidates = rows[0]?.candidates ?? [];
  }

  // --- Provider queries and recommendations -----------------------------------
  const parent =
    analysisId ? { col: 'analysis_id', id: analysisId } : discoveryJobId ? { col: 'discovery_job_id', id: discoveryJobId } : planId ? { col: 'plan_id', id: planId } : null;
  const versionFilter = parent?.col === 'plan_id' && planVersion !== null ? ' AND (plan_version IS NULL OR plan_version = $2)' : '';
  const parentParams = parent ? (versionFilter ? [parent.id, planVersion] : [parent.id]) : [];

  const queries = parent
    ? (
        await db.query<{
          id: string;
          provider: string;
          operation: string;
          sanitized_request: unknown;
          results: unknown;
          status: 'ok' | 'empty' | 'error';
          is_replay: boolean;
          retrieved_at: Date;
          duration_ms: number | null;
          query_context: unknown;
          error_code: string | null;
        }>(
          `SELECT id, provider, operation, sanitized_request, results, status, is_replay, retrieved_at, duration_ms, query_context, error_code
             FROM provider_queries WHERE ${parent.col} = $1${versionFilter} ORDER BY retrieved_at, id`,
          parentParams,
        )
      ).rows
    : [];

  const recs = parent
    ? (
        await db.query<{
          id: string;
          title: string;
          category: string | null;
          section: string | null;
          origin: TraceResponse['recommendations'][number]['origin'];
          rank: number;
          provider_query_ids: string[];
          discovery_item_id: string;
          contributing_reference_ids: string[];
        }>(
          `SELECT id, title, category, section, origin, rank, provider_query_ids, discovery_item_id, contributing_reference_ids
             FROM recommendations WHERE ${parent.col} = $1${versionFilter} ORDER BY section NULLS FIRST, rank, id`,
          parentParams,
        )
      ).rows
    : [];

  // --- References and resolved entities ---------------------------------------
  const captureRefRows = analysisId
    ? (
        await db.query<{ reference_id: string; resolution_status: string }>(
          'SELECT reference_id, resolution_status FROM capture_references WHERE analysis_id = $1 ORDER BY is_anchor DESC, certainty DESC NULLS LAST',
          [analysisId],
        )
      ).rows
    : [];
  const referenceIds = uniq([
    ...captureRefRows.map((r) => r.reference_id),
    ...anchorReferenceIds,
    ...planItems.flatMap((i) => (i.anchors ?? []).map((a) => a.reference_id)),
    ...recs.flatMap((r) => r.contributing_reference_ids ?? []),
  ]);
  const refRows = referenceIds.length
    ? (
        await db.query<{ id: string; canonical_name: string; type: string; external_ids: Record<string, unknown>; claim_count: number; source_count: number }>(
          `SELECT r.id, r.canonical_name, r.type, r.external_ids,
                  (SELECT count(*) FROM claims cl WHERE cl.reference_id = r.id) AS claim_count,
                  (SELECT count(DISTINCT s) FROM claims cl, unnest(cl.source_ids) s WHERE cl.reference_id = r.id) AS source_count
             FROM cultural_references r WHERE r.id = ANY($1::uuid[])`,
          [referenceIds],
        )
      ).rows
    : [];
  const refOrder = new Map(referenceIds.map((id, i) => [id, i]));
  refRows.sort((a, b) => (refOrder.get(a.id) ?? 0) - (refOrder.get(b.id) ?? 0));

  const resolved: TraceResponse['resolved_entities'] = [
    ...refRows.flatMap((r) => externalEntities(r.external_ids, r.canonical_name, r.type, r.id)),
    ...planItems.flatMap((i) => externalEntities(i.external_ids, i.title, i.kind, null)),
  ];
  if (relatedOrigin) {
    const { rows } = await db.query<{ external_ids: Record<string, unknown> }>('SELECT external_ids FROM discovery_items WHERE id = $1', [relatedOrigin.item_id]);
    resolved.push(...externalEntities(rows[0]?.external_ids, relatedOrigin.title, relatedOrigin.kind, null));
  }
  const seenEntity = new Set<string>();
  const resolvedEntities = resolved.filter((e) => {
    const k = `${e.provider}:${e.provider_id}:${e.reference_id ?? ''}`;
    if (seenEntity.has(k)) return false;
    seenEntity.add(k);
    return true;
  });

  // --- Taste changes on the involved items --------------------------------------
  const involvedItemIds = uniq([
    ...recs.map((r) => r.discovery_item_id),
    ...planItems.map((i) => i.item_id),
    ...(relatedOrigin ? [relatedOrigin.item_id] : []),
  ]);
  if (captureId) {
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM discovery_items WHERE capture_id = $1 AND kind = 'capture'`, [captureId]);
    involvedItemIds.push(...rows.map((r) => r.id));
  }
  const tasteRows = involvedItemIds.length || captureId
    ? (
        await db.query<{ created_at: Date; action: string; target_id: string }>(
          `SELECT created_at, action, target_id FROM preference_events
            WHERE owner_account_id = $1 AND (target_id = ANY($2::uuid[]) OR target_id = $3)
            ORDER BY created_at, id LIMIT 100`,
          [accountId, involvedItemIds, captureId],
        )
      ).rows
    : [];

  // --- The separate agent's service calls --------------------------------------
  const linkIds = uniq([job.id, job.result_id, planId, captureId, discoveryJobId].filter((v): v is string => !!v));
  const { rows: agentRows } = await db.query<{ created_at: Date; name: string; data: Record<string, unknown>; client_name: string | null }>(
    `SELECT te.created_at, te.name, te.data, ac.client_name
       FROM trace_events te LEFT JOIN agent_connections ac ON ac.id = te.agent_connection_id
      WHERE te.kind = 'agent_tool_call' AND te.owner_account_id = $1
        AND (te.job_id = $2 OR (te.data -> 'refs') ?| $3::text[])
      ORDER BY te.created_at, te.id LIMIT 100`,
    [accountId, job.id, linkIds],
  );

  // --- Pipeline events --------------------------------------------------------
  const { rows: eventRows } = await db.query<{ created_at: Date; kind: string; name: string; data: unknown; duration_ms: number | null }>(
    `SELECT created_at, kind, name, data, duration_ms FROM trace_events
      WHERE kind <> 'agent_tool_call' AND (job_id = $1 OR ($2::text IS NOT NULL AND trace_id = $2))
        AND (owner_account_id IS NULL OR owner_account_id = $3)
      ORDER BY created_at, id LIMIT 200`,
    [job.id, job.trace_id, accountId],
  );

  return {
    job: { id: job.id, type: job.type, state: job.state, created_at: iso(job.created_at), finished_at: iso(job.finished_at) },
    capture,
    plan,
    related_origin: relatedOrigin,
    observations: redactTraceData(observations.length ? observations : candidates) as unknown[],
    resolved_entities: resolvedEntities,
    provider_queries: queries.map((q) => ({
      id: q.id,
      provider: q.provider,
      operation: q.operation,
      request: redactTraceData({ ...((q.sanitized_request as object) ?? {}), ...(q.query_context && Object.keys(q.query_context as object).length ? { context: q.query_context } : {}) }),
      result_summary: redactTraceData(q.status === 'error' ? { error: q.error_code } : summarizeProviderResults(q.results)),
      status: q.status,
      is_replay: q.is_replay,
      retrieved_at: iso(q.retrieved_at),
      duration_ms: q.duration_ms,
    })),
    references: refRows.map((r) => ({ id: r.id, name: r.canonical_name, claim_count: r.claim_count, source_count: r.source_count })),
    recommendations: recs.map((r) => ({
      id: r.id,
      title: r.section ? `${r.title} · ${r.section}` : r.title,
      category: r.category,
      origin: r.origin,
      rank: r.rank,
      provider_query_ids: r.provider_query_ids ?? [],
    })),
    taste_changes: tasteRows.map((t) => ({ at: iso(t.created_at), action: t.action, target_id: t.target_id })),
    agent_calls: agentRows.map((a) => ({
      at: iso(a.created_at),
      client_name: a.client_name ?? (typeof a.data.client_name === 'string' ? a.data.client_name : 'agent'),
      tool: a.name,
      summary: String(redactTraceData(typeof a.data.summary === 'string' ? a.data.summary : a.data.outcome ?? '')),
    })),
    events: eventRows.map((e) => ({
      at: iso(e.created_at),
      kind: e.kind,
      name: e.name,
      data: redactTraceData(e.data),
      duration_ms: e.duration_ms,
    })),
  };
}
