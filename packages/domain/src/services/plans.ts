import { z } from 'zod';
import { hasScope, requireAccount, requireScopes } from '../authz';
import { inputHasAnchors } from '../composer/movie-night';
import {
  InputContribution,
  PlanSnapshot,
  StoredFilm,
  StoredFood,
  StoredMusic,
  type SnapshotItem,
  type StoredPick,
} from '../composer/plan-types';
import type { ServiceContext } from '../context';
import type { Queryable } from '../db/pool';
import { PLAN_SECTIONS, type Category, type ItemKind, type PlanSection, type SectionStatus } from '../enums';
import { AppError } from '../errors';
import { cancelJobsForResult, enqueueJob, planDedupeKey, planReplacementDedupeKey } from '../jobs';
import { loadItemAnchors, type ItemAnchor } from '../library/anchors';
import { grantedIds, isGrantLimited, loadAccessibleCollection, planWithinGrant } from '../library/access';
import { tsKey } from '../library/sql';
import { loadFoodExclusions } from './onboarding';
import { consumeDailyQuota } from '../quotas';
import type { Image, PageQuery } from '../schemas/common';
import type {
  CreatePlanRequest,
  CreatePlanResponse,
  DishIdea,
  FilmPick,
  MusicPick,
  PlanConstraints,
  PlanReplacementRequest,
  PlanReplacementResponse,
  PlanResponse,
  PlansListResponse,
  PlanVersionDto,
} from '../schemas/plans';
import { decodeCursor, encodeCursor } from '../util/cursor';
import { iso } from '../util/time';
import { resolveImage } from './cards';
import { readDisplayMetadata } from './display';

/**
 * Recommendation Composer: movie-night plans. createPlan validates collection
 * ownership/grant, expected_revision (409 on stale), membership of every
 * item, fixed film is a selected film, usable anchors (else 400 with the weak
 * item ids), then snapshots inputs into plan_versions v1 and enqueues
 * generate_plan. Requires plans:write + collections:read + access to all inputs.
 * Reads re-check the CURRENT grant: plans whose inputs left the grant are 404
 * for that agent.
 */

interface PlanRow {
  id: string;
  owner_account_id: string;
  source_collection_id: string | null;
  template: 'movie_night';
  selected_item_ids: string[];
  fixed_film_item_id: string | null;
  constraints: Record<string, unknown>;
  exploration: 'familiar' | 'balanced' | 'adventurous';
  status: PlanResponse['status'];
  active_version: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface PlanVersionRow {
  id: string;
  plan_id: string;
  version: number;
  collection_revision: number | null;
  input_snapshot: unknown;
  fixed_film_id: string | null;
  title: string | null;
  summary: string | null;
  film: unknown;
  food: unknown;
  music: unknown;
  section_statuses: Record<string, SectionStatus>;
  rationale: string | null;
  recommendation_ids: string[];
  based_on_version: number | null;
  input_contributions: unknown;
  created_at: Date;
}

const PLAN_COLUMNS = `id, owner_account_id, source_collection_id, template, selected_item_ids, fixed_film_item_id, constraints,
  exploration, status, active_version, created_at, updated_at`;

/** Load a plan the principal may read: owner + (for limited agents) inputs still within the grant. */
export async function loadAccessiblePlan(ctx: ServiceContext, id: string, db: Queryable = ctx.db, lock = false): Promise<PlanRow> {
  const accountId = requireAccount(ctx.principal).accountId;
  const { rows } = await db.query<PlanRow>(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = $1 AND owner_account_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [id, accountId],
  );
  const plan = rows[0];
  if (!plan || !(await planWithinGrant(ctx, plan.selected_item_ids, db))) throw new AppError('not_found');
  return plan;
}

interface MemberRow {
  item_id: string;
  saved_item_id: string;
  kind: ItemKind;
  category: Category | null;
  title: string;
  canonical_key: string;
  external_ids: Record<string, unknown>;
  display_metadata: unknown;
  capture_id: string | null;
  analysis_id: string | null;
  analysis_version: number | null;
  analysis_title: string | null;
  interpretation: string | null;
}

/** Freeze the selected items, their anchors and revisions (pure over loaded rows). */
export function buildSnapshotItems(rows: MemberRow[], anchors: Map<string, ItemAnchor[]>): SnapshotItem[] {
  return rows.map((r) => {
    const meta = readDisplayMetadata(r.display_metadata);
    return {
      item_id: r.item_id,
      saved_item_id: r.saved_item_id,
      kind: r.kind,
      category: r.category,
      title: r.title,
      canonical_key: r.canonical_key,
      external_ids: r.external_ids ?? {},
      subtitle: meta.subtitle ?? null,
      year: meta.year ?? null,
      detail: meta.detail ?? null,
      anchors: (anchors.get(r.item_id) ?? []).map((a) => ({
        reference_id: a.reference_id,
        name: a.name,
        type: a.type,
        revision: a.revision,
        external_ids: a.external_ids,
        user_selected: a.user_selected,
      })),
      capture: r.capture_id
        ? {
            capture_id: r.capture_id,
            analysis_id: r.analysis_id,
            analysis_version: r.analysis_version,
            title: r.analysis_title,
            interpretation: r.interpretation,
          }
        : null,
    };
  });
}

function pendingStatuses(sections: readonly PlanSection[] = PLAN_SECTIONS): Record<PlanSection, SectionStatus> {
  return Object.fromEntries(sections.map((s) => [s, 'pending'])) as Record<PlanSection, SectionStatus>;
}

/** POST /v1/plans (202) */
export async function createPlan(ctx: ServiceContext, body: CreatePlanRequest): Promise<CreatePlanResponse> {
  requireScopes(ctx.principal, 'plans:write', 'collections:read');
  const p = requireAccount(ctx.principal);
  return ctx.db.transaction(async (db) => {
    const col = await loadAccessibleCollection(ctx, body.collection_id, { db, lock: true });
    if (col.revision !== body.expected_revision) {
      throw new AppError('revision_conflict', {
        message: 'This collection changed. Review the selected items and try again.',
        details: { current_revision: col.revision },
      });
    }
    const { rows } = await db.query<MemberRow>(
      `SELECT di.id AS item_id, si.id AS saved_item_id, di.kind, di.category, di.title, di.canonical_key, di.external_ids,
              di.display_metadata, di.capture_id, a.id AS analysis_id, a.version AS analysis_version,
              a.title AS analysis_title, a.interpretation
         FROM collection_items ci
         JOIN saved_items si ON si.id = ci.saved_item_id
         JOIN discovery_items di ON di.id = si.discovery_item_id
         LEFT JOIN captures c ON c.id = di.capture_id AND c.deleted_at IS NULL
         LEFT JOIN analyses a ON a.id = c.active_analysis_id
        WHERE ci.collection_id = $1 AND di.id = ANY($2::uuid[])`,
      [col.id, body.item_ids],
    );
    const byId = new Map(rows.map((r) => [r.item_id, r]));
    const missing = body.item_ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new AppError('invalid_input', {
        message: 'Some selected items are no longer in this collection.',
        details: { not_in_collection: missing },
      });
    }
    const ordered = body.item_ids.map((id) => byId.get(id)!);
    if (body.fixed_film_item_id && byId.get(body.fixed_film_item_id)?.kind !== 'film') {
      throw new AppError('invalid_input', { message: '“Use this movie” must be one of the selected films.' });
    }
    const anchors = await loadItemAnchors(db, body.item_ids, { unresolvedCaptureFallback: true });
    const items = buildSnapshotItems(ordered, anchors);
    const weak = items.filter((i) => !inputHasAnchors(i)).map((i) => i.item_id);
    if (weak.length) {
      throw new AppError('invalid_input', {
        message: 'Some selected items don’t have enough detail yet. Choose another item.',
        details: { weak_item_ids: weak },
      });
    }
    await consumeDailyQuota(db, { principal: p, metric: 'plans', config: ctx.config, now: ctx.now() });

    // Amendment 2.2: the account's food exclusions are the default when the
    // request states none. Agents only get them applied with preferences:read
    // (plan constraints are readable with plans:read).
    const defaultExclusions =
      body.constraints?.dietary_exclusions === undefined && hasScope(ctx.principal, 'preferences:read')
        ? await loadFoodExclusions(db, p.accountId)
        : [];
    const constraints = {
      dietary_exclusions: body.constraints?.dietary_exclusions ?? defaultExclusions,
      instruction: body.constraints?.instruction || null,
    };
    const snapshot: PlanSnapshot = {
      template: 'movie_night',
      collection: { id: col.id, name: col.name, description: col.description, revision: col.revision },
      items,
      constraints,
      exploration: body.exploration,
      fixed_film_item_id: body.fixed_film_item_id ?? null,
    };
    const plan = await db.query<{ id: string }>(
      `INSERT INTO plans (owner_account_id, source_collection_id, template, selected_item_ids, fixed_film_item_id,
                          constraints, exploration, status, active_version, created_by_agent_connection_id)
       VALUES ($1, $2, 'movie_night', $3::uuid[], $4, $5::jsonb, $6, 'queued', 1, $7) RETURNING id`,
      [
        p.accountId,
        col.id,
        body.item_ids,
        body.fixed_film_item_id ?? null,
        JSON.stringify(constraints),
        body.exploration,
        p.kind === 'agent' ? p.connectionId : null,
      ],
    );
    const planId = plan.rows[0]!.id;
    await db.query(
      `INSERT INTO plan_versions (plan_id, version, collection_revision, input_snapshot, fixed_film_id, section_statuses)
       VALUES ($1, 1, $2, $3::jsonb, $4, $5::jsonb)`,
      [planId, col.revision, JSON.stringify(snapshot), body.fixed_film_item_id ?? null, JSON.stringify(pendingStatuses())],
    );
    const { job } = await enqueueJob(db, {
      type: 'generate_plan',
      owner: { kind: 'account', accountId: p.accountId },
      payload: { plan_id: planId, version: 1, exploration: body.exploration },
      dedupeKey: planDedupeKey({ planId, version: 1 }),
      agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
      maxAttempts: ctx.config.JOB_MAX_ATTEMPTS,
      budget: { qloo_requests: ctx.config.JOB_MAX_QLOO_REQUESTS, provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES },
      traceId: ctx.traceId ?? ctx.requestId,
      resultType: 'plan',
      resultId: planId,
    });
    return { plan_id: planId, job_id: job.id };
  });
}

interface ItemDisplay {
  image: Image | null;
  destination_url: string | null;
  /** Item came from replayed/sample provider data (durable flag on the item). */
  example: boolean;
}

async function itemDisplays(ctx: ServiceContext, ids: string[]): Promise<Map<string, ItemDisplay>> {
  const out = new Map<string, ItemDisplay>();
  if (ids.length === 0) return out;
  const { rows } = await ctx.db.query<{ id: string; display_metadata: unknown; is_sample: boolean }>(
    'SELECT id, display_metadata, is_sample FROM discovery_items WHERE id = ANY($1::uuid[])',
    [ids],
  );
  for (const r of rows) {
    const meta = readDisplayMetadata(r.display_metadata);
    const url = meta.destination_url && z.url().safeParse(meta.destination_url).success ? meta.destination_url : null;
    out.set(r.id, { image: await resolveImage(ctx, meta.image), destination_url: url, example: r.is_sample || meta.example === true });
  }
  return out;
}

function parseOr<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null || value === undefined) return null;
  const r = schema.safeParse(value);
  return r.success ? r.data : null;
}

function picksOf(v: PlanVersionRow): StoredPick[] {
  const film = parseOr(StoredFilm, v.film);
  const food = parseOr(StoredFood, v.food);
  const music = parseOr(StoredMusic, v.music);
  return [
    ...(film?.feature ? [film.feature] : []),
    ...(film?.alternates ?? []),
    ...(food?.dishes ?? []),
    ...(music?.before ?? []),
    ...(music?.after ?? []),
  ];
}

/** Map a stored version to the public DTO (images resolved at read time). */
export async function toPlanVersionDto(ctx: ServiceContext, v: PlanVersionRow): Promise<PlanVersionDto> {
  const snapshot = parseOr(PlanSnapshot, v.input_snapshot);
  const film = parseOr(StoredFilm, v.film);
  const food = parseOr(StoredFood, v.food);
  const music = parseOr(StoredMusic, v.music);
  const displays = await itemDisplays(ctx, picksOf(v).flatMap((p) => (p.item_id ? [p.item_id] : [])));
  /** "Example result" when the pick itself was replayed/sample, or its item came from replayed data. */
  const isExample = (p: StoredPick): boolean =>
    p.origin === 'replay' || p.origin === 'sample' || (p.item_id ? (displays.get(p.item_id)?.example ?? false) : false);
  const filmPick = (p: StoredPick): FilmPick | null =>
    p.item_id
      ? {
          item_id: p.item_id,
          title: p.title,
          year: p.year,
          image: displays.get(p.item_id)?.image ?? null,
          reason: p.reason,
          destination_url: displays.get(p.item_id)?.destination_url ?? null,
          is_fixed: p.is_fixed,
          is_example: isExample(p),
        }
      : null;
  const dish = (p: StoredPick): DishIdea => ({
    item_id: p.item_id,
    title: p.title,
    description: p.description ?? '',
    cuisine: p.detail,
    reason: p.reason,
    image: p.item_id ? (displays.get(p.item_id)?.image ?? null) : null,
    is_example: isExample(p),
  });
  const musicPick = (p: StoredPick): MusicPick => ({
    item_id: p.item_id,
    kind: p.kind === 'track' ? 'track' : 'artist',
    title: p.title,
    artist: p.kind === 'track' ? p.detail : null,
    image: p.item_id ? (displays.get(p.item_id)?.image ?? null) : null,
    reason: p.reason,
    // No track catalog adapter in this release: nothing is marked verified.
    verified: false,
    destination_url: p.item_id ? (displays.get(p.item_id)?.destination_url ?? null) : null,
    is_example: isExample(p),
  });
  const contributions = parseOr(z.array(InputContribution), v.input_contributions) ?? [];
  const byItem = new Map(contributions.map((c) => [c.item_id, c]));
  const sections = Object.fromEntries(
    PLAN_SECTIONS.map((s) => [s, (v.section_statuses?.[s] as SectionStatus | undefined) ?? 'pending']),
  ) as Record<PlanSection, SectionStatus>;
  return {
    version: v.version,
    title: v.title,
    summary: v.summary,
    sections,
    film: film
      ? {
          feature: film.feature ? filmPick(film.feature) : null,
          alternates: film.alternates.flatMap((a) => filmPick(a) ?? []).slice(0, 2),
        }
      : null,
    food: food ? { dishes: food.dishes.map(dish).slice(0, 3) } : null,
    music: music ? { before: music.before.map(musicPick), after: music.after.map(musicPick) } : null,
    rationale: v.rationale,
    inputs: (snapshot?.items ?? []).map((i) => ({
      item_id: i.item_id,
      title: i.capture?.title ?? i.title,
      kind: i.kind,
      contribution: byItem.get(i.item_id)?.contribution ?? 'strong',
      note: byItem.get(i.item_id)?.note ?? null,
    })),
    collection_revision: v.collection_revision,
    created_at: iso(v.created_at),
  };
}

export async function loadVersion(db: Queryable, planId: string, version: number): Promise<PlanVersionRow | null> {
  const { rows } = await db.query<PlanVersionRow>('SELECT * FROM plan_versions WHERE plan_id = $1 AND version = $2', [planId, version]);
  return rows[0] ?? null;
}

function toConstraints(raw: Record<string, unknown>): PlanConstraints {
  const out: PlanConstraints = {};
  if (Array.isArray(raw['dietary_exclusions']) && raw['dietary_exclusions'].length) {
    out.dietary_exclusions = raw['dietary_exclusions'].filter((x): x is string => typeof x === 'string');
  }
  if (typeof raw['instruction'] === 'string' && raw['instruction']) out.instruction = raw['instruction'];
  return out;
}

/** GET /v1/plans/{id} */
export async function getPlan(ctx: ServiceContext, input: { id: string }): Promise<PlanResponse> {
  requireScopes(ctx.principal, 'plans:read');
  const plan = await loadAccessiblePlan(ctx, input.id);
  const versions = await ctx.db.query<{ version: number; created_at: Date }>(
    'SELECT version, created_at FROM plan_versions WHERE plan_id = $1 ORDER BY version',
    [plan.id],
  );
  const active = plan.active_version ? await loadVersion(ctx.db, plan.id, plan.active_version) : null;
  const job = await ctx.db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE result_type = 'plan' AND result_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [plan.id],
  );
  return {
    id: plan.id,
    template: plan.template,
    status: plan.status,
    source_collection_id: plan.source_collection_id,
    selected_item_ids: plan.selected_item_ids,
    fixed_film_item_id: plan.fixed_film_item_id,
    constraints: toConstraints(plan.constraints),
    exploration: plan.exploration,
    active_version: active ? await toPlanVersionDto(ctx, active) : null,
    versions: versions.rows.map((v) => ({ version: v.version, created_at: iso(v.created_at) })),
    job_id: job.rows[0]?.id ?? null,
    created_at: iso(plan.created_at),
    updated_at: iso(plan.updated_at),
  };
}

const PlansCursor = z.object({ t: z.string(), id: z.uuid() });

/** GET /v1/plans */
export async function listPlans(ctx: ServiceContext, query: PageQuery): Promise<PlansListResponse> {
  requireScopes(ctx.principal, 'plans:read');
  const accountId = requireAccount(ctx.principal).accountId;
  const limit = query.limit ?? 24;
  const params: unknown[] = [accountId, isGrantLimited(ctx.principal) ? grantedIds(ctx.principal) : null];
  let cursorSql = '';
  if (query.cursor) {
    const c = decodeCursor(query.cursor, PlansCursor);
    params.push(c.t, c.id);
    cursorSql = `AND (p.created_at, p.id) < ($3::timestamptz, $4::uuid)`;
  }
  params.push(limit + 1);
  const { rows } = await ctx.db.query<{
    id: string;
    template: 'movie_night';
    status: PlanResponse['status'];
    created_at: Date;
    ts_key: string;
    title: string | null;
    feature_item_id: string | null;
  }>(
    `SELECT p.id, p.template, p.status, p.created_at, ${tsKey('p.created_at', 'ts_key')},
            v.title, v.film #>> '{feature,item_id}' AS feature_item_id
       FROM plans p
       LEFT JOIN plan_versions v ON v.plan_id = p.id AND v.version = p.active_version
      WHERE p.owner_account_id = $1
        AND ($2::uuid[] IS NULL OR p.selected_item_ids <@ ARRAY(
              SELECT si.discovery_item_id FROM collection_items ci JOIN saved_items si ON si.id = ci.saved_item_id
               WHERE ci.owner_account_id = $1 AND ci.collection_id = ANY($2::uuid[])))
        ${cursorSql}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const page = rows.slice(0, limit);
  const displays = await itemDisplays(ctx, page.flatMap((r) => (r.feature_item_id ? [r.feature_item_id] : [])));
  const last = page[page.length - 1];
  return {
    plans: page.map((r) => ({
      id: r.id,
      template: r.template,
      title: r.title,
      status: r.status,
      cover: r.feature_item_id ? (displays.get(r.feature_item_id)?.image ?? null) : null,
      created_at: iso(r.created_at),
    })),
    next_cursor: rows.length > limit && last ? encodeCursor({ t: last.ts_key, id: last.id }) : null,
  };
}

/**
 * POST /v1/plans/{id}/replacements (202) — new version copying the other
 * sections unchanged; the replace_plan_section job regenerates only `section`.
 */
export async function replacePlanSection(
  ctx: ServiceContext,
  input: { id: string; body: PlanReplacementRequest },
): Promise<PlanReplacementResponse> {
  requireScopes(ctx.principal, 'plans:write');
  const p = requireAccount(ctx.principal);
  return ctx.db.transaction(async (db) => {
    const plan = await loadAccessiblePlan(ctx, input.id, db, true);
    const active = await db.query(
      `SELECT 1 FROM jobs WHERE result_type = 'plan' AND result_id = $1 AND state IN ('queued', 'running')`,
      [plan.id],
    );
    if (active.rowCount) throw new AppError('conflict', { message: 'This plan is still being prepared. Try again in a moment.', retryable: true });
    if (!plan.active_version) throw new AppError('conflict', { message: 'This plan has no version to change yet.' });
    const base = await loadVersion(db, plan.id, plan.active_version);
    if (!base) throw new AppError('not_found');
    await consumeDailyQuota(db, { principal: p, metric: 'plans', config: ctx.config, now: ctx.now() });
    const next = await db.query<{ v: number }>('SELECT max(version) + 1 AS v FROM plan_versions WHERE plan_id = $1', [plan.id]);
    const version = next.rows[0]!.v;
    const statuses = { ...base.section_statuses, [input.body.section]: 'pending' };
    await db.query(
      `INSERT INTO plan_versions (plan_id, version, collection_revision, input_snapshot, fixed_film_id, title, summary,
                                  film, food, music, section_statuses, rationale, recommendation_ids, based_on_version,
                                  input_contributions)
       SELECT plan_id, $2, collection_revision, input_snapshot, fixed_film_id, title, summary, film, food, music,
              $3::jsonb, rationale, recommendation_ids, version, input_contributions
         FROM plan_versions WHERE plan_id = $1 AND version = $4`,
      [plan.id, version, JSON.stringify(statuses), base.version],
    );
    await db.query(`UPDATE plans SET active_version = $2, status = 'queued', updated_at = now() WHERE id = $1`, [plan.id, version]);
    const { job } = await enqueueJob(db, {
      type: 'replace_plan_section',
      owner: { kind: 'account', accountId: p.accountId },
      payload: {
        plan_id: plan.id,
        base_version: base.version,
        version,
        section: input.body.section,
        instruction: input.body.instruction || undefined,
      },
      dedupeKey: planReplacementDedupeKey({
        planId: plan.id,
        baseVersion: base.version,
        section: input.body.section,
        instruction: input.body.instruction,
      }),
      agentConnectionId: p.kind === 'agent' ? p.connectionId : null,
      maxAttempts: ctx.config.JOB_MAX_ATTEMPTS,
      budget: { qloo_requests: ctx.config.JOB_MAX_QLOO_REQUESTS, provider_retries: ctx.config.JOB_MAX_PROVIDER_RETRIES },
      traceId: ctx.traceId ?? ctx.requestId,
      resultType: 'plan',
      resultId: plan.id,
    });
    return { plan_id: plan.id, job_id: job.id, section: input.body.section };
  });
}

/** DELETE /v1/plans/{id} */
export async function deletePlan(ctx: ServiceContext, input: { id: string }): Promise<void> {
  requireScopes(ctx.principal, 'plans:write');
  await ctx.db.transaction(async (db) => {
    const plan = await loadAccessiblePlan(ctx, input.id, db, true);
    await cancelJobsForResult(db, 'plan', plan.id);
    await db.query('DELETE FROM plans WHERE id = $1', [plan.id]);
  });
}
