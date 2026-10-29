import { z } from 'zod';
import { hasWholeLibrary, requireScopes } from '../authz';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { LIMITS, type Category, type ItemKind, type RecommendationOrigin, type ReferenceType } from '../enums';
import { AppError } from '../errors';
import { SAMPLE_ITEMS, sampleKey } from '../feed/samples';
import { enqueueJob, relatedDiscoveryDedupeKey } from '../jobs';
import { lockAgentGrantEpoch, recordDiscoveryGrantAuthority, resolveScopedOriginSave } from '../interest-graph/scoped-discovery';
import { loadItemAnchors } from '../library/anchors';
import {
  grantedIds,
  hiddenKeys,
  isGrantLimited,
  loadAccessibleCollection,
  memberItemsSql,
  membershipsFor,
  requireVisibleItem,
  visibleItemIds,
} from '../library/access';
import { ownerColumns, ownerOf, ownerPredicate, type Owner } from '../principal';
import { consumeDailyQuota } from '../quotas';
import type { ReferenceSummary, SourceDto } from '../schemas/common';
import type {
  ItemDetailResponse,
  ItemQuery,
  RelatedDiscoveryRequest,
  RelatedDiscoveryResponse,
} from '../schemas/items';
import { iso } from '../util/time';
import { loadCards, type CardRecommendationContext } from './cards';
import { clipText, isProviderBackedItem, preferPicturedCards, readDisplayMetadata } from './display';
import { getTasteRevision } from './taste';

/**
 * Item detail and related discoveries. Related results use the item's
 * canonical entities/tags as anchors. Opening a card never triggers
 * generation; only POST .../discoveries starts one bounded discover_related
 * job (dedupe: relatedDiscoveryDedupeKey). Agents: the item must be within a
 * granted collection (pass collection_id) and results stay tied to that origin.
 * A selected-collection enqueue also pins its durable grant authority — owner,
 * initiating connection, enqueue-time authorization version, granted collection
 * and origin item — in one immutable row for the approved scoped graph branch
 * (interest-graph/scoped-discovery.ts); legacy whole-library enqueues write none.
 */

interface ItemRow {
  id: string;
  kind: ItemKind;
  category: Category | null;
  title: string;
  canonical_key: string;
  display_metadata: unknown;
  external_ids: Record<string, unknown>;
  reference_id: string | null;
  resolved_anchor_ids: string[];
  capture_id: string | null;
  is_sample: boolean;
}

interface RecRow {
  id: string;
  origin: RecommendationOrigin;
  display_reason: string | null;
  source_ids: string[];
  destination_url: string | null;
}

async function loadItem(db: Queryable, id: string): Promise<ItemRow> {
  const { rows } = await db.query<ItemRow>(
    `SELECT id, kind, category, title, canonical_key, display_metadata, external_ids, reference_id, resolved_anchor_ids,
            capture_id, is_sample FROM discovery_items WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new AppError('not_found');
  return rows[0];
}

/**
 * A recommendation for the item in one of the owner's own contexts (capture,
 * plan, related job). Grant-limited agents only see recommendations whose
 * parent is visible under the CURRENT grant: the analysis of a capture in a
 * granted collection (or one this connection uploaded), a discovery job that
 * originated from a granted collection item, or a plan derived entirely from
 * granted items. Anything else could carry private context from outside the
 * grant (e.g. "Connected to <brand> in your photo.").
 * A taste-seed recommendation (amendment 2.2) derives from the whole taste
 * (onboarding picks), so only full-library principals of the account see it.
 */
async function ownedRecommendation(ctx: ServiceContext, owner: Owner, itemId: string, recommendationId?: string): Promise<RecRow | null> {
  const own = (alias: string) => ownerPredicate(owner, alias, 3).sql;
  const params: unknown[] = [itemId, recommendationId ?? null, ...ownerPredicate(owner, '', 3).params];
  const planOwner = owner.kind === 'account' ? `pl.owner_account_id = $3` : 'false';
  const seedOwner = owner.kind === 'account' && !isGrantLimited(ctx.principal) ? `ts.owner_account_id = $3` : 'false';
  let captureGrant = '';
  let jobGrant = '';
  let planGrant = '';
  const p = ctx.principal;
  if (isGrantLimited(p)) {
    params.push(grantedIds(p), p.kind === 'agent' ? p.connectionId : null);
    const g = `$${params.length - 1}`;
    const conn = `$${params.length}`;
    const members = `(${memberItemsSql('$3', g)})`;
    captureGrant = `AND (c.created_by_agent_connection_id = ${conn}::uuid
                      OR EXISTS (SELECT 1 FROM discovery_items cdi
                                  WHERE cdi.capture_id = c.id AND cdi.owner_account_id = $3 AND cdi.id IN ${members}))`;
    jobGrant = `AND dj.origin_collection_id = ANY(${g}::uuid[]) AND dj.origin_item_id IN ${members}`;
    planGrant = `AND pl.selected_item_ids <@ ARRAY${members}`;
  }
  const { rows } = await ctx.db.query<RecRow>(
    `SELECT r.id, r.origin, r.display_reason, r.source_ids, r.destination_url
       FROM recommendations r
       LEFT JOIN analyses a ON a.id = r.analysis_id
       LEFT JOIN captures c ON c.id = a.capture_id
       LEFT JOIN discovery_jobs dj ON dj.id = r.discovery_job_id
       LEFT JOIN plans pl ON pl.id = r.plan_id
       LEFT JOIN taste_seed_runs ts ON ts.id = r.taste_seed_run_id
      WHERE r.discovery_item_id = $1 AND ($2::uuid IS NULL OR r.id = $2)
        AND ((c.id IS NOT NULL AND c.deleted_at IS NULL AND ${own('c')} ${captureGrant})
          OR (dj.id IS NOT NULL AND ${own('dj')} ${jobGrant})
          OR (pl.id IS NOT NULL AND ${planOwner} ${planGrant})
          OR (ts.id IS NOT NULL AND ${seedOwner}))
      ORDER BY r.created_at DESC LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

async function loadSources(db: Queryable, ids: readonly string[]): Promise<SourceDto[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<{ id: string; url: string; title: string | null; publisher: string | null; retrieved_at: Date }>(
    'SELECT id, url, title, publisher, retrieved_at FROM sources WHERE id = ANY($1::uuid[])',
    [ids],
  );
  return rows.flatMap((r) => (z.url().safeParse(r.url).success ? [{ ...r, retrieved_at: iso(r.retrieved_at) }] : []));
}

async function referenceSummaries(db: Queryable, item: ItemRow): Promise<ReferenceSummary[]> {
  const anchors = (await loadItemAnchors(db, [item.id])).get(item.id) ?? [];
  if (anchors.length === 0) return [];
  const { rows } = await db.query<{ id: string; research_status: string; overview: string | null }>(
    'SELECT id, research_status, overview FROM cultural_references WHERE id = ANY($1::uuid[])',
    [anchors.map((a) => a.reference_id)],
  );
  const meta = new Map(rows.map((r) => [r.id, r]));
  return anchors.map((a) => ({
    id: a.reference_id,
    name: a.name,
    type: a.type as ReferenceType,
    relation: null,
    qualified: false,
    has_page: meta.get(a.reference_id)?.research_status === 'complete' || Boolean(meta.get(a.reference_id)?.overview),
  }));
}

/**
 * Same-category pictured cards already in this owner's interest pool.
 * Opening a card never calls Qloo; this fills Similar immediately from
 * taste-seed / expand recs so the rail is not empty while a related job runs.
 */
async function interestPoolRelatedIds(
  ctx: ServiceContext,
  owner: Owner,
  item: ItemRow,
  hidden: Set<string>,
  take: number,
): Promise<string[]> {
  if (owner.kind !== 'account' || take <= 0) return [];
  const { rows } = await ctx.db.query<{ item_id: string; canonical_key: string }>(
    `SELECT di.id AS item_id, di.canonical_key
       FROM recommendations r
       JOIN discovery_items di ON di.id = r.discovery_item_id
       JOIN taste_seed_runs ts ON ts.id = r.taste_seed_run_id
      WHERE ts.owner_account_id = $1
        AND ts.state IN ('complete', 'partial')
        AND di.id <> $2
        AND di.canonical_key <> $3
      ORDER BY (di.category IS NOT DISTINCT FROM $4) DESC,
               (di.display_metadata ? 'image') DESC,
               ts.updated_at DESC, r.rank
      LIMIT $5`,
    [owner.accountId, item.id, item.canonical_key, item.category, take * 8],
  );
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (hidden.has(row.canonical_key) || seen.has(row.canonical_key)) continue;
    seen.add(row.canonical_key);
    out.push(row.item_id);
    if (out.length >= take) break;
  }
  return out;
}

function sampleRelated(item: ItemRow, available: { id: string; canonical_key: string; category: Category | null }[]): string[] {
  const idx = SAMPLE_ITEMS.findIndex((s) => sampleKey(s.slug) === item.canonical_key);
  const rotated = [...available.slice(idx + 1), ...available.slice(0, idx + 1)];
  const out: string[] = [];
  const perCategory = new Map<string, number>();
  for (const c of rotated) {
    if (c.id === item.id) continue;
    const g = c.category ?? 'other';
    if (g === (item.category ?? 'other')) continue;
    if ((perCategory.get(g) ?? 0) >= 2) continue;
    perCategory.set(g, (perCategory.get(g) ?? 0) + 1);
    out.push(c.id);
    if (out.length >= LIMITS.relatedCachedMax) break;
  }
  return out;
}

/** Latest related-discovery context for this item visible under the principal's grant. */
async function latestDiscoveryJobs(ctx: ServiceContext, owner: Owner, itemId: string) {
  const own = ownerPredicate(owner, 'dj', 2);
  const limited = isGrantLimited(ctx.principal);
  const params: unknown[] = [itemId, ...own.params];
  let grant = '';
  if (limited) {
    params.push(grantedIds(ctx.principal));
    grant = `AND dj.origin_collection_id = ANY($${params.length}::uuid[])`;
  }
  const { rows } = await ctx.db.query<{ id: string; job_id: string | null; status: string; job_state: string | null }>(
    `SELECT dj.id, dj.job_id, dj.status, j.state AS job_state
       FROM discovery_jobs dj LEFT JOIN jobs j ON j.id = dj.job_id
      WHERE dj.origin_item_id = $1 AND ${own.sql} ${grant}
      ORDER BY dj.created_at DESC LIMIT 5`,
    params,
  );
  return rows;
}

/** GET /v1/items/{id} */
export async function getItem(ctx: ServiceContext, input: { id: string; query: ItemQuery }): Promise<ItemDetailResponse> {
  const owner = ownerOf(ctx.principal);
  if (input.query.collection_id) await loadAccessibleCollection(ctx, input.query.collection_id);
  await requireVisibleItem(ctx, input.id);
  const item = await loadItem(ctx.db, input.id);
  const meta = readDisplayMetadata(item.display_metadata);

  const rec = item.is_sample ? null : await ownedRecommendation(ctx, owner, item.id, input.query.recommendation_id);
  const recContext = new Map<string, CardRecommendationContext>();
  if (rec) recContext.set(item.id, { id: rec.id, origin: rec.origin, display_reason: rec.display_reason });
  const [card] = await loadCards(ctx, [item.id], { recommendations: recContext });
  if (!card) throw new AppError('not_found');

  // Provider-backed rows carry no displayable prose (VAL-EVID-005: Qloo
  // descriptions are transient-only); user/model-authored descriptions on
  // owned rows still display.
  const description = isProviderBackedItem(item.external_ids) ? null : clipText(meta.description);
  const detail = meta.detail?.trim() || null;
  const reason = rec?.display_reason ?? null;
  const sources = rec ? await loadSources(ctx.db, rec.source_ids) : [];
  const destination = rec?.destination_url ?? meta.destination_url ?? null;

  // Related: cached only. Opening an item never starts generation.
  const hidden = await hiddenKeys(ctx.db, owner);
  let relatedIds: string[] = [];
  let relatedState: ItemDetailResponse['related_state'] = 'none';
  let relatedJobId: string | null = null;
  if (item.is_sample) {
    const { rows } = await ctx.db.query<{ id: string; canonical_key: string; category: Category | null }>(
      `SELECT id, canonical_key, category FROM discovery_items WHERE is_sample AND canonical_key = ANY($1::text[])`,
      [SAMPLE_ITEMS.map((s) => sampleKey(s.slug))],
    );
    const byKey = new Map(rows.map((r) => [r.canonical_key, r]));
    const ordered = SAMPLE_ITEMS.flatMap((s) => byKey.get(sampleKey(s.slug)) ?? []).filter((r) => !hidden.has(r.canonical_key));
    relatedIds = sampleRelated(item, ordered);
    relatedState = relatedIds.length ? 'cached' : 'none';
  } else {
    const jobs = await latestDiscoveryJobs(ctx, owner, item.id);
    const active = jobs.find((j) => j.job_state === 'queued' || j.job_state === 'running');
    const done = jobs.find((j) => j.status === 'complete' || j.status === 'partial');
    if (active) {
      relatedState = 'pending';
      relatedJobId = active.job_id;
    }
    if (done) {
      const { rows } = await ctx.db.query<{ item_id: string; canonical_key: string }>(
        `SELECT r.discovery_item_id AS item_id, di.canonical_key FROM recommendations r
           JOIN discovery_items di ON di.id = r.discovery_item_id
          WHERE r.discovery_job_id = $1 ORDER BY r.rank, r.created_at`,
        [done.id],
      );
      relatedIds = rows.filter((r) => !hidden.has(r.canonical_key) && r.item_id !== item.id).map((r) => r.item_id);
      if (!active) relatedJobId = done.job_id;
      if (!active && relatedIds.length) relatedState = 'cached';
    }
  }
  if (!item.is_sample && relatedIds.length < LIMITS.relatedCachedMax) {
    const poolIds = await interestPoolRelatedIds(ctx, owner, item, hidden, LIMITS.relatedCachedMax);
    for (const id of poolIds) {
      if (relatedIds.includes(id)) continue;
      relatedIds.push(id);
      if (relatedIds.length >= LIMITS.relatedCachedMax) break;
    }
  }
  const visibleRelated = await visibleItemIds(ctx, relatedIds);
  const relatedCards = await loadCards(ctx, relatedIds.filter((id) => visibleRelated.has(id)).slice(0, LIMITS.relatedCachedMax));
  const related = preferPicturedCards(relatedCards);
  if (related.length > 0 && relatedState === 'none') relatedState = 'cached';

  let collectionIds: string[] = [];
  if (card.saved_item_id) collectionIds = (await membershipsFor(ctx, [card.saved_item_id])).get(card.saved_item_id)?.collectionIds ?? [];

  return {
    item: card,
    description,
    detail,
    reason,
    why_this: reason ? { text: reason, sources } : null,
    destination_url: destination && z.url().safeParse(destination).success ? destination : null,
    references: await referenceSummaries(ctx.db, item),
    related,
    related_state: relatedState,
    related_job_id: relatedJobId,
    collection_ids: collectionIds,
    capture_id: item.capture_id,
  };
}

/** True when the item has something a provider can be asked about. */
export function hasDiscoveryAnchors(item: Pick<ItemRow, 'kind' | 'external_ids' | 'reference_id' | 'resolved_anchor_ids'>, anchorCount: number): boolean {
  if (anchorCount > 0 || item.reference_id || item.resolved_anchor_ids.length > 0) return true;
  if (typeof item.external_ids?.['qloo'] === 'string') return true;
  // Named things (films, artists, brands...) can be resolved by name; photos need analysis anchors.
  return item.kind !== 'capture';
}

/** POST /v1/items/{id}/discoveries — 202, explicit and bounded. */
export async function startRelatedDiscovery(
  ctx: ServiceContext,
  input: { id: string; body: RelatedDiscoveryRequest },
): Promise<RelatedDiscoveryResponse> {
  const p = ctx.principal;
  const owner = ownerOf(p);
  let originCollectionId: string | null = input.body.collection_id ?? null;
  if (p.kind === 'agent') {
    if (isGrantLimited(p) || originCollectionId) {
      requireScopes(p, 'collections:read');
      if (!originCollectionId) {
        throw new AppError('invalid_input', { message: 'Pass the collection_id that contains this item.' });
      }
    } else {
      requireScopes(p, 'taste:read');
    }
  }
  if (originCollectionId) {
    await loadAccessibleCollection(ctx, originCollectionId);
    // The origin must currently be a member of that collection.
    const m = await ctx.db.query(
      `SELECT 1 FROM collection_items ci JOIN saved_items si ON si.id = ci.saved_item_id
        WHERE ci.collection_id = $1 AND si.discovery_item_id = $2`,
      [originCollectionId, input.id],
    );
    if (!m.rowCount) throw new AppError('not_found');
  } else if (!hasWholeLibrary(p)) {
    throw new AppError('not_found');
  }
  await requireVisibleItem(ctx, input.id);
  const item = await loadItem(ctx.db, input.id);
  const anchors = (await loadItemAnchors(ctx.db, [item.id])).get(item.id) ?? [];
  if (!hasDiscoveryAnchors(item, anchors.length)) {
    throw new AppError('invalid_input', {
      message: 'This photo needs to finish analyzing before we can find related discoveries.',
      details: { reason: 'no_anchors' },
    });
  }
  if (!originCollectionId) originCollectionId = null;

  const tasteRevision = await getTasteRevision(ctx.db, owner);
  const grantContext = p.kind === 'agent' ? `${p.connectionId}:${originCollectionId ?? 'all'}` : originCollectionId;
  const dedupeKey = relatedDiscoveryDedupeKey({
    owner,
    originItemId: item.id,
    category: input.body.category ?? null,
    tasteRevision,
    grantContext,
  });

  return ctx.db.transaction(async (db) => {
    // Approved grant-scoped extension: FIRST, under the enqueue lock, validate
    // the initiating epoch and the live operation permission (DISC-SCR-031).
    // The lock serializes with owner grant mutations, and the request's
    // authenticated version must still be the live one with collections:read
    // still in the live scope set — revoke, expiry, a narrowed/stale
    // authenticated principal or a vanished grant fail the enqueue closed
    // here, BEFORE any job, quota or authority row exists. Versionless legacy
    // principals keep the live-permission policy (live scope + grant recheck).
    const grantEpoch =
      originCollectionId && p.kind === 'agent'
        ? await lockAgentGrantEpoch(db, {
            accountId: p.accountId,
            connectionId: p.connectionId,
            collectionId: originCollectionId,
            now: ctx.now(),
            expectedAuthorizationVersion: p.authorizationVersion,
            requiredScope: 'collections:read',
          })
        : null;
    // The owner's save row that grounds this origin's membership in the exact
    // collection (DISC-SCR-030): an owned item or a validated public sample,
    // saved by this owner into this collection. Resolving it inside the
    // enqueue transaction keeps the authority bound through the save, and a
    // foreign private item, an arbitrary ownerless item or an ungrounded
    // membership rejects non-disclosing before anything is written.
    const originSavedItemId =
      originCollectionId && owner.kind === 'account'
        ? await resolveScopedOriginSave(db, {
            ownerAccountId: owner.accountId,
            originCollectionId,
            originItemId: item.id,
          })
        : null;
    const existing = await db.query<{ id: string; payload: { discovery_job_id: string } }>(
      `SELECT id, payload FROM jobs WHERE dedupe_key = $1 AND state NOT IN ('failed', 'cancelled')`,
      [dedupeKey],
    );
    if (existing.rows[0]) {
      return { job_id: existing.rows[0].id, discovery_job_id: existing.rows[0].payload.discovery_job_id, reused: true };
    }
    await consumeDailyQuota(db, { principal: p, metric: 'analyses', config: ctx.config, now: ctx.now() });
    const cols = ownerColumns(owner);
    const dj = await db.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, owner_session_id, origin_item_id, agent_connection_id,
                                   origin_collection_id, category, anchor_reference_ids, taste_revision,
                                   scoped_authority_required)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9) RETURNING id`,
      [
        cols.owner_account_id,
        cols.owner_session_id,
        item.id,
        p.kind === 'agent' ? p.connectionId : null,
        originCollectionId,
        input.body.category ?? null,
        anchors.map((a) => a.reference_id),
        tasteRevision,
        originCollectionId != null,
      ],
    );
    const discoveryJobId = dj.rows[0]!.id;
    const { job, reused } = await enqueueJob(db, {
      type: 'discover_related',
      owner,
      payload: {
        discovery_job_id: discoveryJobId,
        origin_item_id: item.id,
        category: input.body.category,
        taste_revision: tasteRevision,
      },
      dedupeKey,
      agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
      maxAttempts: ctx.config.JOB_MAX_ATTEMPTS,
      budget: { qloo_requests: ctx.config.JOB_MAX_QLOO_REQUESTS, provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES },
      traceId: ctx.traceId ?? ctx.requestId,
      resultType: 'discovery_job',
      resultId: discoveryJobId,
    });
    if (reused) {
      // Lost a race with an identical request: keep the existing context only.
      await db.query('DELETE FROM discovery_jobs WHERE id = $1', [discoveryJobId]);
      const payload = job.payload as { discovery_job_id: string };
      return { job_id: job.id, discovery_job_id: payload.discovery_job_id, reused: true };
    }
    // Durable producer authority for the approved scoped graph branch: the
    // selected-collection operation pins owner, initiating connection,
    // enqueue-time authorization version, granted collection and origin item in
    // one immutable row (migration 360), bound through the owner's save row
    // (migration 390), written after the dedupe arbiter decided this
    // transaction owns the job, so retry, redelivery and dedupe cannot adopt a
    // later grant epoch, owner or resource. Legacy whole-library enqueues (no
    // collection) write none.
    if (originCollectionId && owner.kind === 'account') {
      await recordDiscoveryGrantAuthority(db, {
        ownerAccountId: owner.accountId,
        discoveryJobId,
        jobId: job.id,
        agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
        authorizationVersion: grantEpoch?.authorizationVersion ?? null,
        collectionGrantedAt: grantEpoch?.collectionGrantedAt ?? null,
        originCollectionId,
        originItemId: item.id,
        originSavedItemId: originSavedItemId!,
      });
    }
    await db.query('UPDATE discovery_jobs SET job_id = $2 WHERE id = $1', [discoveryJobId, job.id]);
    return { job_id: job.id, discovery_job_id: discoveryJobId, reused: false };
  });
}
