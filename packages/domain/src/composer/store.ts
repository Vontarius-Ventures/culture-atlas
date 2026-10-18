import type { QlooEntity } from '@culture-atlas/providers';
import type { Queryable } from '../db/pool';
import type { Category, ItemKind, RecommendationOrigin } from '../enums';
import { ownerColumns, type Owner } from '../principal';
import type { DisplayMetadata } from '../services/display';
import type { RecordedQuery } from './provider-calls';

/**
 * Persistence shared by the plan composer and related discovery:
 * stable DiscoveryItem identities (deduped per owner by canonical_key),
 * provider_queries and recommendations under exactly one parent.
 */

export type RecommendationParent =
  | { kind: 'plan'; planId: string; version: number }
  | { kind: 'discovery_job'; discoveryJobId: string }
  | { kind: 'analysis'; analysisId: string }
  /** Taste seed (amendment 2.2): onboarding picks -> account feed pool. */
  | { kind: 'taste_seed'; runId: string };

export function normalizeLabel(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Canonical identity: provider ids merge duplicates; ideas tie to their supporting references. */
export function canonicalKeyFor(input: {
  kind: ItemKind;
  title: string;
  qlooId?: string | null;
  year?: number | null;
  referenceIds?: readonly string[];
}): string {
  if (input.qlooId) return `qloo:${input.qlooId}`;
  const label = normalizeLabel(input.title) || 'untitled';
  switch (input.kind) {
    case 'film':
      return `film:${label}${input.year ? `|${input.year}` : ''}`;
    case 'artist':
    case 'brand':
      return `${input.kind}:${label}`;
    default:
      return `${input.kind}:${label}|${[...new Set(input.referenceIds ?? [])].sort().join(',')}`;
  }
}

export const QLOO_KIND: Record<string, { kind: ItemKind; category: Category }> = {
  'urn:entity:movie': { kind: 'film', category: 'watch' },
  'urn:entity:artist': { kind: 'artist', category: 'play' },
  'urn:entity:brand': { kind: 'brand', category: 'wear' },
};

export function yearOf(entity: QlooEntity): number | null {
  const p = entity.properties ?? {};
  const raw = p['release_year'] ?? p['year'] ?? (typeof p['release_date'] === 'string' ? (p['release_date'] as string).slice(0, 4) : undefined);
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 1800 && n < 2200 ? n : null;
}

export interface ItemUpsert {
  kind: ItemKind;
  category: Category | null;
  canonical_key: string;
  title: string;
  display_metadata: DisplayMetadata;
  external_ids?: Record<string, unknown>;
  reference_id?: string | null;
  resolved_anchor_ids?: readonly string[];
}

/** Insert or merge a DiscoveryItem for an owner; returns its id. */
export async function upsertDiscoveryItem(db: Queryable, owner: Owner, item: ItemUpsert): Promise<string> {
  const cols = ownerColumns(owner);
  const conflict = owner.kind === 'account' ? '(owner_account_id, canonical_key)' : '(owner_session_id, canonical_key)';
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, owner_session_id, kind, category, canonical_key, reference_id,
                                  title, display_metadata, external_ids, resolved_anchor_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::uuid[])
     ON CONFLICT ${conflict} DO UPDATE SET
       display_metadata = discovery_items.display_metadata || EXCLUDED.display_metadata,
       external_ids = discovery_items.external_ids || EXCLUDED.external_ids,
       resolved_anchor_ids = ARRAY(SELECT DISTINCT unnest(discovery_items.resolved_anchor_ids || EXCLUDED.resolved_anchor_ids)),
       reference_id = COALESCE(discovery_items.reference_id, EXCLUDED.reference_id),
       updated_at = now()
     RETURNING id`,
    [
      cols.owner_account_id,
      cols.owner_session_id,
      item.kind,
      item.category,
      item.canonical_key,
      item.reference_id ?? null,
      item.title,
      JSON.stringify(stripUndefined(item.display_metadata)),
      JSON.stringify(item.external_ids ?? {}),
      [...(item.resolved_anchor_ids ?? [])],
    ],
  );
  return rows[0]!.id;
}

function stripUndefined(o: object): object {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function parentColumns(parent: RecommendationParent) {
  return {
    analysis_id: parent.kind === 'analysis' ? parent.analysisId : null,
    plan_id: parent.kind === 'plan' ? parent.planId : null,
    plan_version: parent.kind === 'plan' ? parent.version : null,
    discovery_job_id: parent.kind === 'discovery_job' ? parent.discoveryJobId : null,
    taste_seed_run_id: parent.kind === 'taste_seed' ? parent.runId : null,
  };
}

/** Persist recorded provider calls (ids were generated before the calls). */
export async function insertProviderQueries(
  db: Queryable,
  parent: RecommendationParent,
  queries: readonly RecordedQuery[],
  traceId: string | null,
): Promise<void> {
  const p = parentColumns(parent);
  for (const q of queries) {
    await db.query(
      `INSERT INTO provider_queries (id, analysis_id, plan_id, plan_version, discovery_job_id, provider, operation,
                                     sanitized_request, results, status, http_status, error_code, duration_ms,
                                     is_replay, retrieved_at, cache_expiry, query_context, trace_id, taste_seed_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15,
               $15::timestamptz + interval '1 day', $16::jsonb, $17, $18)
       ON CONFLICT (id) DO NOTHING`,
      [
        q.id,
        p.analysis_id,
        p.plan_id,
        p.plan_version,
        p.discovery_job_id,
        q.provider,
        q.operation,
        JSON.stringify(q.sanitized_request ?? {}),
        q.results === null ? null : JSON.stringify(q.results),
        q.status,
        q.http_status,
        q.error_code,
        q.duration_ms,
        q.is_replay,
        q.retrieved_at,
        JSON.stringify(q.query_context ?? {}),
        traceId,
        p.taste_seed_run_id,
      ],
    );
  }
}

export interface RecommendationInsert {
  discovery_item_id: string;
  category: Category | null;
  section?: string | null;
  rank: number;
  title: string;
  external_ids?: Record<string, unknown>;
  display_reason: string | null;
  origin: RecommendationOrigin;
  provider_query_ids: readonly string[];
  contributing_reference_ids?: readonly string[];
  source_ids?: readonly string[];
  destination_url?: string | null;
}

export async function insertRecommendations(
  db: Queryable,
  parent: RecommendationParent,
  recs: readonly RecommendationInsert[],
): Promise<string[]> {
  const p = parentColumns(parent);
  const ids: string[] = [];
  for (const r of recs) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO recommendations (analysis_id, plan_id, plan_version, discovery_job_id, discovery_item_id, category,
                                    section, rank, title, external_ids, display_reason, origin, source_ids,
                                    provider_query_ids, contributing_reference_ids, destination_url, taste_seed_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::uuid[], $14::uuid[], $15::uuid[], $16, $17)
       RETURNING id`,
      [
        p.analysis_id,
        p.plan_id,
        p.plan_version,
        p.discovery_job_id,
        r.discovery_item_id,
        r.category,
        r.section ?? null,
        r.rank,
        r.title,
        JSON.stringify(r.external_ids ?? {}),
        r.display_reason,
        r.origin,
        [...(r.source_ids ?? [])],
        [...r.provider_query_ids],
        [...(r.contributing_reference_ids ?? [])],
        r.destination_url ?? null,
        p.taste_seed_run_id,
      ],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}
