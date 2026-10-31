/**
 * Offline, allowlisted accounting of recorded captures, NOT a catalogue or relevance oracle.
 * No provider/domain imports, network, environment loading, or import-time file writes.
 */
import { open, opendir, realpath, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Obj = Record<string, unknown>;
type Availability = 'available' | 'unavailable' | 'unknown' | 'conflicting';
type State = 'empty' | 'nonempty' | 'unknown';
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const has = (o: Obj, k: string) => Object.hasOwn(o, k);
const uuid = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(v)
    ? v.toUpperCase()
    : undefined;
const tagId = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= 256 && /^urn:tag:[a-z\d_:-]+$/i.test(v) ? v : undefined;
const entityType = (v: unknown): string | undefined =>
  typeof v === 'string' && /^urn:entity:[a-z_]{1,40}$/.test(v) ? v : undefined;
const unique = (v: (string | undefined)[]) =>
  [...new Set(v.filter((x): x is string => !!x))].sort();
const sorted = (v: Set<string>) => [...v].sort();
const countBy = (values: string[]) => {
  const counts: Record<string, number> = {};
  for (const v of [...values].sort()) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
};
const state = (n: number): State => (n ? 'nonempty' : 'empty');
const allowed = (v: unknown, values: readonly string[]) =>
  typeof v === 'string' && values.includes(v) ? v : 'unknown';
const finiteRank = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const RAILS = ['more_like_this', 'cross_domain'] as const;
const RELATIONS = [
  'brand_exploration',
  'topic_connection',
  'named_work',
  'taste_affinity',
  'place_exploration',
  'unsupported',
] as const;

export const AUDIT_LIMITS = Object.freeze({
  files: 256,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  queriesPerCapture: 512,
  rowsPerQuery: 10_000,
  rowsPerCapture: 20_000,
  totalRows: 100_000,
  publicationRows: 10_000,
  judgments: 100_000,
});

export class AuditInputError extends Error {
  constructor(public readonly code: string) {
    // Never interpolate input values, paths, parser errors, or raw payloads.
    super(code);
    this.name = 'AuditInputError';
  }
}
function bound(n: number, max: number) {
  if (n > max) throw new AuditInputError('input_limit_exceeded');
}

interface Entity {
  id: string;
  occurrences: number;
  queries: Set<string>;
  explicitTypes: Set<string>;
  inferredTypes: Set<string>;
  tags: Set<string>;
  description: Set<Availability>;
  image: Set<Availability>;
}
interface Publication {
  entityId: string;
  rail: string;
  subject: string;
  rank: number | null;
  queries: Set<string>;
}
interface Pool {
  ref: string;
  complete: boolean;
  entities: Map<string, Entity>;
  publications: Publication[];
  publicationKnown: boolean;
}

export interface AuditOptions {
  includeIds?: boolean;
  judgments?: unknown;
}

function availability(row: Obj, field: 'description' | 'image'): Availability {
  const projection = obj(row.metadataAvailability);
  if (typeof projection[field] === 'boolean') {
    return projection[field] ? 'available' : 'unavailable';
  }
  const properties = obj(row.properties);
  const owner = has(row, field) ? row : has(properties, field) ? properties : undefined;
  if (!owner) return 'unknown';
  const v = owner[field];
  if (v == null || v === '') return 'unavailable';
  if (field === 'description') return typeof v === 'string' ? 'available' : 'unknown';
  // This checks URL availability only, never image semantics, rights, or visual matching.
  const url = typeof v === 'string' ? v : obj(v).url;
  return typeof url === 'string' && /^https?:\/\/\S+$/i.test(url) ? 'available' : 'unknown';
}
function mergeAvailability(values: Set<Availability>): Availability {
  if (values.has('available') && values.has('unavailable')) return 'conflicting';
  if (values.has('available')) return 'available';
  if (values.has('unavailable')) return 'unavailable';
  return 'unknown';
}
function metadata(entities: Entity[]) {
  return {
    description: countBy(entities.map((e) => mergeAvailability(e.description))),
    imageUrl: countBy(entities.map((e) => mergeAvailability(e.image))),
    imageRole: { unknown: entities.length },
  };
}

function envelope(q: Obj, operation: string): unknown[] | undefined {
  if (!has(q, 'results') || q.results == null) return undefined;
  if (Array.isArray(q.results)) return q.results;
  const root = obj(q.results);
  const nested = obj(root.results);
  const key = operation === 'tags' || operation === 'style_tags' ? 'tags' : 'entities';
  if (Array.isArray(root[key])) return root[key] as unknown[];
  if (Array.isArray(nested[key])) return nested[key] as unknown[];
  if (Array.isArray(root.results)) return root.results;
  if (operation === 'entity' || operation === 'entities') {
    if (uuid(root.entity_id)) return [root];
    if (uuid(obj(root.entity).entity_id)) return [root.entity];
  }
  return undefined; // Unknown envelope is not an empty pool.
}

const OPERATOR_KEYS = [
  'operator.filter.tags',
  'operator.signal.interests.tags',
  'filter.tags.operator',
  'signal.interests.tags.operator',
] as const;
function requestProjection(q: Obj, includeIds: boolean) {
  const request = obj(q.sanitized_request);
  const params = obj(request.query);
  const context = obj(q.query_context);
  for (const key of [
    'filter.tags',
    'signal.interests.tags',
    'signal.interests.entities',
    'types',
  ]) {
    bound(list(params[key]).length, AUDIT_LIMITS.rowsPerQuery);
  }
  const tags = unique(list(params['filter.tags']).map(tagId));
  const signalTags = unique(list(params['signal.interests.tags']).map(tagId));
  const seeds = unique(list(params['signal.interests.entities']).map(uuid));
  const types = unique([entityType(params['filter.type']), ...list(params.types).map(entityType)]);
  const operators = OPERATOR_KEYS.filter((key) => has(params, key)).map((key) => ({
    key,
    value: allowed(params[key], ['union', 'intersection', 'and', 'or']),
  }));
  return {
    method: allowed(request.method, ['GET', 'POST']),
    endpoint: allowed(request.path, ['/search', '/v2/insights', '/v2/tags', '/v2/entities']),
    requestedTypes: types,
    operators,
    operatorEvidence: operators.length ? 'explicit' : 'not_recorded',
    filterTagCount: tags.length,
    signalTagCount: signalTags.length,
    seedEntityCount: seeds.length,
    // Presence only: never output weights, free-text search, location, or request blobs.
    weightsRecorded: Object.keys(params).some((key) => /weight/i.test(key)),
    provenance: {
      rail: allowed(context.rail, RAILS),
      category: allowed(context.category, ['watch', 'wear', 'play', 'eat']),
      stage:
        typeof context.stage === 'string' && /^style:mlt:s\d{1,4}$/.test(context.stage)
          ? 'style:mlt'
          : allowed(context.stage, ['resolve', 'recommend', 'recommend:title', 'style:tags']),
      recipe: allowed(context.recipe, ['media_tag', 'interior_brand', 'fashion_brand']),
      referenceCount: list(context.signal_reference_ids).length,
    },
    ...(includeIds ? { filterTagIds: tags, signalTagIds: signalTags, seedEntityIds: seeds } : {}),
  };
}

function publicationProjection(capture: Obj, trace: Obj, queryRefs: Map<string, string>) {
  const stored = Array.isArray(trace.recommendations_rows) ? trace.recommendations_rows : undefined;
  const response = obj(capture.final_capture_response);
  const railArrays = list(response.rails).map((r) => list(obj(r).cards));
  const legacy = list(response.recommendations);
  const cardCount = legacy.length + railArrays.reduce((n, rows) => n + rows.length, 0);
  bound((stored?.length ?? 0) + cardCount, AUDIT_LIMITS.publicationRows);
  const publications: Publication[] = [];
  const hiddenIds = new Set<string>();
  const rowIds = new Set<string>();
  const storedLookup = new Map<string, Obj>();
  for (const value of stored ?? []) {
    const row = obj(value);
    for (const key of [row.id, row.discovery_item_id]) {
      if (typeof key === 'string') storedLookup.set(key, row);
    }
  }
  let invalidQlooRows = 0;
  let nonQlooRows = 0;
  let hiddenRows = 0;
  let unresolvedQueryReferences = 0;
  const add = (row: Obj, rail: unknown = row.rail) => {
    const id = uuid(obj(row.external_ids).qloo) ?? uuid(row.qloo_id);
    if (!id) {
      if (row.origin === 'qloo') invalidQlooRows++;
      else nonQlooRows++;
      return;
    }
    publications.push({
      entityId: id,
      rail: allowed(rail, RAILS),
      subject:
        typeof row.subject_id === 'string' && /^s\d{1,4}$/.test(row.subject_id)
          ? row.subject_id
          : 'unknown',
      rank: finiteRank(row.rank),
      queries: new Set(
        list(row.provider_query_ids).flatMap((v) => {
          const ref = typeof v === 'string' ? queryRefs.get(v) : undefined;
          if (!ref) unresolvedQueryReferences++;
          return ref ? [ref] : [];
        }),
      ),
    });
  };
  if (stored) {
    for (const value of stored) {
      const row = obj(value);
      // Hidden stored rows are authoritative, even if a stale public card remains.
      if (row.hidden_at != null) {
        hiddenRows++;
        for (const key of [row.id, row.discovery_item_id]) {
          if (typeof key === 'string') hiddenIds.add(key);
        }
        continue;
      }
      const rowKey = typeof row.id === 'string' ? row.id : undefined;
      if (rowKey && rowIds.has(rowKey)) continue;
      if (rowKey) rowIds.add(rowKey);
      add(row);
    }
  } else {
    // Without stored rows, prefer rails and dedupe legacy copies using public/local IDs,
    // NEVER interpret card.id/recommendation_id as a catalogue ID.
    const seen = new Set<string>();
    const visit = (value: unknown, rail: unknown) => {
      const card = obj(value);
      const eid = uuid(obj(card.external_ids).qloo) ?? uuid(card.qloo_id);
      const local =
        typeof card.recommendation_id === 'string'
          ? card.recommendation_id
          : typeof card.id === 'string'
            ? card.id
            : undefined;
      if (local && hiddenIds.has(local)) return;
      const identity =
        local ?? (eid ? `${eid}:${String(rail)}:${String(card.subject_id)}` : undefined);
      if (!identity || seen.has(identity)) return;
      seen.add(identity);
      add(card, rail);
    };
    for (const rail of list(response.rails)) {
      for (const card of list(obj(rail).cards)) visit(card, obj(rail).kind);
    }
    for (const card of legacy) {
      // A legacy card with the same catalogue ID as a rail is a duplicate view.
      const eid = uuid(obj(obj(card).external_ids).qloo) ?? uuid(obj(card).qloo_id);
      if (eid && publications.some((p) => p.entityId === eid)) continue;
      visit(card, obj(card).rail);
    }
  }
  let joinedPublicCardOccurrences = 0;
  let hiddenPublicCardOccurrences = 0;
  let unresolvedPublicCardOccurrences = 0;
  if (stored) {
    for (const value of [...railArrays.flat(), ...legacy]) {
      const card = obj(value);
      const storedRow = [card.recommendation_id, card.id].flatMap((key) =>
        typeof key === 'string' && storedLookup.has(key) ? [storedLookup.get(key)!] : [],
      )[0];
      if (!storedRow) unresolvedPublicCardOccurrences++;
      else if (storedRow.hidden_at != null) hiddenPublicCardOccurrences++;
      else joinedPublicCardOccurrences++;
    }
  }
  return {
    publications,
    known:
      invalidQlooRows === 0 &&
      (stored !== undefined ||
        ((Array.isArray(response.rails) || Array.isArray(response.recommendations)) &&
          invalidQlooRows === 0 &&
          nonQlooRows === 0)),
    source: stored ? 'stored_rows' : 'public_cards',
    hiddenRows,
    invalidQlooRows,
    nonQlooRows,
    publicCardOccurrences: cardCount,
    unresolvedQueryReferences,
    publicCardJoin: stored
      ? {
          joinedOccurrencesIncludingLegacyDuplicates: joinedPublicCardOccurrences,
          hiddenOccurrences: hiddenPublicCardOccurrences,
          unresolvedOccurrences: unresolvedPublicCardOccurrences,
        }
      : null,
  };
}

function normalizeCapture(value: unknown, index: number, includeIds: boolean) {
  const capture = obj(value);
  const trace = obj(capture.trace);
  if (!Array.isArray(trace.provider_queries)) throw new AuditInputError('unsupported_capture_root');
  bound(trace.provider_queries.length, AUDIT_LIMITS.queriesPerCapture);
  const ref = `c${String(index + 1).padStart(4, '0')}`;
  const qlooQueries = trace.provider_queries.filter((v) => obj(v).provider === 'qloo').map(obj);
  const queryRefs = new Map<string, string>();
  qlooQueries.forEach((q, i) => {
    if (typeof q.id === 'string') {
      if (queryRefs.has(q.id)) throw new AuditInputError('duplicate_query_id');
      queryRefs.set(q.id, `q${i + 1}`);
    }
  });
  const pub = publicationProjection(capture, trace, queryRefs);
  const entities = new Map<string, Entity>();
  const occurrenceTypes: string[] = [];
  let totalResultRows = 0;
  let totalNestedRows = 0;
  let complete = true;
  const queries = qlooQueries.map((q, qi) => {
    const queryRef = `q${qi + 1}`;
    const operation = allowed(q.operation, [
      'insights',
      'search',
      'tags',
      'style_tags',
      'entity',
      'entities',
    ]);
    const tagOperation = operation === 'tags' || operation === 'style_tags';
    const rows = envelope(q, operation);
    if (rows) bound(rows.length, AUDIT_LIMITS.rowsPerQuery);
    totalResultRows += rows?.length ?? 0;
    bound(totalResultRows, AUDIT_LIMITS.rowsPerCapture);
    if ((!rows || operation === 'unknown') && !tagOperation) complete = false;
    const request = requestProjection(q, includeIds);
    const queryEntities = new Set<string>();
    const queryTags = new Set<string>();
    const influences = new Set<string>();
    const occurrences: Entity[] = [];
    const descriptionAvailability: string[] = [];
    const imageAvailability: string[] = [];
    const queryTypeEvidence: string[] = [];
    let tagRows = 0;
    let unrecognizedRows = 0;
    let contributions = 0;
    let projectedRows = 0;
    for (const value of rows ?? []) {
      const row = obj(value);
      const tag = tagId(row.tag_id) ?? tagId(row.id);
      // Tag parents and nested source contributions are never candidate entities.
      if (tag) {
        tagRows++;
        queryTags.add(tag);
        continue;
      }
      const id = uuid(row.entity_id);
      if (!id || tagOperation) {
        unrecognizedRows++;
        continue;
      }
      if (row.schema_version === 'qloo_candidate_audit_v1') projectedRows++;
      queryEntities.add(id);
      let e = entities.get(id);
      if (!e) {
        e = {
          id,
          occurrences: 0,
          queries: new Set(),
          explicitTypes: new Set(),
          inferredTypes: new Set(),
          tags: new Set(),
          description: new Set(),
          image: new Set(),
        };
        entities.set(id, e);
      }
      e.occurrences++;
      e.queries.add(queryRef);
      const explicit = unique([...list(row.types).map(entityType), entityType(row.type)]);
      occurrenceTypes.push(...(explicit.length ? explicit : request.requestedTypes));
      queryTypeEvidence.push(
        explicit.length
          ? 'explicit'
          : request.requestedTypes.length
            ? 'request_inferred'
            : 'unknown',
      );
      for (const t of explicit) e.explicitTypes.add(t);
      if (!explicit.length) for (const t of request.requestedTypes) e.inferredTypes.add(t);
      bound(list(row.tags).length, AUDIT_LIMITS.rowsPerQuery);
      totalNestedRows += list(row.tags).length + list(row.explainability).length;
      bound(totalNestedRows, AUDIT_LIMITS.totalRows);
      for (const t of list(row.tags)) {
        const id = tagId(t) ?? tagId(obj(t).id) ?? tagId(obj(t).tag_id);
        if (id) e.tags.add(id);
      }
      e.description.add(availability(row, 'description'));
      e.image.add(availability(row, 'image'));
      descriptionAvailability.push(availability(row, 'description'));
      imageAvailability.push(availability(row, 'image'));
      occurrences.push(e);
      bound(contributions + list(row.explainability).length, AUDIT_LIMITS.totalRows);
      for (const item of list(row.explainability)) {
        contributions++;
        const influence = uuid(obj(item).entity_id);
        if (influence) influences.add(influence);
      }
    }
    if (unrecognizedRows && !tagOperation) complete = false;
    const linked = pub.publications.filter((p) => p.queries.has(queryRef));
    const publishedIds = new Set(linked.map((p) => p.entityId));
    const unattributed = pub.publications.some((p) => p.queries.size === 0);
    return {
      ref: queryRef,
      ...(includeIds && uuid(q.id) ? { providerQueryId: uuid(q.id) } : {}),
      operation,
      providerStatus: allowed(q.status, ['ok', 'empty', 'error', 'skipped']),
      replay: typeof q.is_replay === 'boolean' ? q.is_replay : 'unknown',
      rawResultState: rows ? state(rows.length) : ('unknown' as State),
      candidateResultState:
        rows && !unrecognizedRows && operation !== 'unknown'
          ? state(occurrences.length)
          : ('unknown' as State),
      resultsMissing: !has(q, 'results') || q.results == null,
      unsupportedEnvelope: has(q, 'results') && q.results != null && !rows,
      resultRows: rows?.length ?? null,
      reportedResultCount: finiteRank(q.n_results),
      entityOccurrences: rows ? occurrences.length : null,
      uniqueEntities: rows ? queryEntities.size : null,
      duplicateEntityOccurrences: rows ? occurrences.length - queryEntities.size : null,
      tagRows: rows ? tagRows : null,
      unrecognizedRows: rows ? unrecognizedRows : null,
      projectedRows,
      explanationContributionCount: contributions,
      explanationSourceEntityCount: influences.size,
      typeEvidence: countBy(queryTypeEvidence),
      metadataOccurrences: rows
        ? {
            description: countBy(descriptionAvailability),
            imageUrl: countBy(imageAvailability),
            imageRole: { unknown: occurrences.length },
          }
        : null,
      publicationState: pub.known && !unattributed ? state(linked.length) : ('unknown' as State),
      publishedRowsViaQuery: linked.length,
      publishedUniqueEntitiesViaQuery: publishedIds.size,
      notPublishedUniqueEntitiesViaQuery:
        rows && pub.known && !unattributed
          ? [...queryEntities].filter((id) => !publishedIds.has(id)).length
          : null,
      nonpublicationRelevance: 'unjudged' as const,
      request,
      ...(includeIds
        ? {
            entityIds: sorted(queryEntities),
            tagIds: sorted(queryTags),
            explanationSourceEntityIds: sorted(influences),
          }
        : {}),
    };
  });
  const values = [...entities.values()];
  const publishedIds = new Set(pub.publications.map((p) => p.entityId));
  const unmatched = [...publishedIds].filter((id) => !entities.has(id));
  const rawOccurrences = values.reduce((n, e) => n + e.occurrences, 0);
  const pool: Pool = {
    ref,
    complete,
    entities,
    publications: pub.publications,
    publicationKnown: pub.known,
  };
  const report = {
    ref,
    poolKnowledge: complete ? 'complete_recording' : 'incomplete_recording',
    queryCount: queries.length,
    rawEntityOccurrences: complete ? rawOccurrences : null,
    observedEntityOccurrences: rawOccurrences,
    uniqueRawEntities: complete ? entities.size : null,
    observedUniqueEntities: entities.size,
    entityOccurrencesByType: countBy(occurrenceTypes),
    typeEvidence: {
      entitiesWithExplicitTypes: values.filter((e) => e.explicitTypes.size).length,
      entitiesWithRequestInferredTypes: values.filter((e) => e.inferredTypes.size).length,
    },
    metadata: metadata(values),
    publication: {
      state: pub.known ? state(pub.publications.length) : ('unknown' as State),
      source: pub.source,
      qlooRows: pub.publications.length,
      uniqueQlooEntities: publishedIds.size,
      byRail: countBy(pub.publications.map((p) => p.rail)),
      hiddenRows: pub.hiddenRows,
      nonQlooRows: pub.nonQlooRows,
      invalidQlooRows: pub.invalidQlooRows,
      unresolvedQueryReferences: pub.unresolvedQueryReferences,
      publicCardJoin: pub.publicCardJoin,
      publicCardOccurrencesIncludingLegacyDuplicates: pub.publicCardOccurrences,
      rowsWithoutQueryProvenance: pub.publications.filter((p) => p.queries.size === 0).length,
      rawMembership: complete ? 'known' : 'unknown',
      publishedIdsNotInObservedPool: unmatched.length,
      publishedIdsAbsentFromCompletePool: complete ? unmatched.length : null,
      notPublishedUniqueEntities:
        complete && pub.known ? values.filter((e) => !publishedIds.has(e.id)).length : null,
      nonpublicationRelevance: 'unjudged',
      ...(includeIds
        ? { entityIds: sorted(publishedIds), idsNotInObservedPool: unmatched.sort() }
        : {}),
    },
    queries,
    ...(includeIds
      ? {
          entities: values
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((e) => ({
              entityId: e.id,
              occurrences: e.occurrences,
              queryRefs: sorted(e.queries),
              explicitTypes: sorted(e.explicitTypes),
              requestInferredTypes: sorted(e.inferredTypes),
              tagIds: sorted(e.tags),
              description: mergeAvailability(e.description),
              imageUrl: mergeAvailability(e.image),
              imageRole: 'unknown',
            })),
        }
      : {}),
  };
  return { pool, report, totalResultRows, totalNestedRows };
}

function judgmentsProjection(pools: Pool[], input: unknown) {
  const base = {
    status: 'not_evaluated',
    scope: input === undefined ? 'not_provided' : 'partial',
    oracleClaim: false,
    definition:
      'Useful = grade >=2, verified candidate evidence, supported relation. Unit = capture/entity. Select unique first 4 publications by rank, then stored order across rails. Yield denominator = 4 * captures; useful coverage denominator = useful entities in the complete recorded pools (not catalogue recall).',
  };
  if (input === undefined) return { ...base, reason: 'manual_judgments_required' };
  const manifest = obj(input);
  if (
    manifest.schema_version !== 'qloo_manual_judgments_v1' ||
    !Array.isArray(manifest.judgments)
  ) {
    throw new AuditInputError('unsupported_judgment_manifest');
  }
  bound(manifest.judgments.length, AUDIT_LIMITS.judgments);
  const labels = new Map<
    string,
    { grade: number | 'unverifiable'; verified: boolean; relation: string }
  >();
  for (const value of manifest.judgments) {
    const row = obj(value);
    const id = uuid(row.entity_id);
    if (
      !id ||
      typeof row.capture !== 'string' ||
      !/^c\d{4}$/.test(row.capture) ||
      !(
        row.grade === 'unverifiable' ||
        (Number.isInteger(row.grade) && Number(row.grade) >= 0 && Number(row.grade) <= 3)
      ) ||
      typeof row.candidate_evidence_verified !== 'boolean' ||
      !RELATIONS.includes(row.relation as (typeof RELATIONS)[number])
    ) {
      throw new AuditInputError('invalid_judgment');
    }
    const key = `${row.capture}:${id}`;
    if (labels.has(key)) throw new AuditInputError('duplicate_judgment');
    labels.set(key, {
      grade: row.grade as number | 'unverifiable',
      verified: row.candidate_evidence_verified,
      relation: row.relation as string,
    });
  }
  const expected = new Set(
    pools.flatMap((p) => [...p.entities.keys()].map((id) => `${p.ref}:${id}`)),
  );
  const missing = [...expected].filter((k) => !labels.has(k)).length;
  const extra = [...labels.keys()].filter((k) => !expected.has(k)).length;
  const unverifiable = [...labels.values()].filter(
    (v) => v.grade === 'unverifiable' || !v.verified,
  ).length;
  const counts = {
    expectedCandidates: expected.size,
    labeledCandidates: labels.size,
    missing,
    extra,
    unverifiable,
  };
  if (manifest.pool_complete !== true || missing || extra || pools.some((p) => !p.complete)) {
    return { ...base, ...counts, reason: 'complete_recorded_pool_judgments_required' };
  }
  if (
    unverifiable ||
    pools.some(
      (p) => !p.publicationKnown || p.publications.some((r) => !p.entities.has(r.entityId)),
    )
  ) {
    return {
      ...base,
      scope: 'complete_labels_unverifiable',
      ...counts,
      reason: 'evidence_or_publication_unverifiable',
    };
  }
  const useful = (key: string) => {
    const label = labels.get(key);
    return (
      !!label &&
      typeof label.grade === 'number' &&
      label.grade >= 2 &&
      label.verified &&
      label.relation !== 'unsupported'
    );
  };
  let usefulPool = 0;
  let usefulSelected = 0;
  let selected = 0;
  for (const pool of pools) {
    usefulPool += [...pool.entities.keys()].filter((id) => useful(`${pool.ref}:${id}`)).length;
    const ranked = pool.publications
      .map((r, i) => ({ ...r, order: i }))
      .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.order - b.order);
    const firstFour = [...new Set(ranked.map((r) => r.entityId))].slice(0, 4);
    selected += firstFour.length;
    usefulSelected += firstFour.filter((id) => useful(`${pool.ref}:${id}`)).length;
  }
  return {
    ...base,
    ...counts,
    status: 'evaluated',
    scope: 'complete_recorded_pools',
    usefulPoolCandidates: usefulPool,
    selectedCandidatesAt4: selected,
    usefulSelectedAt4: usefulSelected,
    yieldAt4: pools.length ? usefulSelected / (4 * pools.length) : null,
    pooledUsefulCoverageAt4: usefulPool ? usefulSelected / usefulPool : null,
    coverageUndefinedReason: usefulPool ? null : 'no_verified_useful_pool_candidates',
  };
}

/** Async iteration lets directory input be read one bounded capture at a time. */
export async function auditCaptures(
  captures: AsyncIterable<unknown> | Iterable<unknown>,
  options: AuditOptions = {},
) {
  const reports: ReturnType<typeof normalizeCapture>['report'][] = [];
  const pools: Pool[] = [];
  const globalEntities = new Map<string, Entity>();
  let resultRows = 0;
  let nestedRows = 0;
  let publicationRows = 0;
  for await (const capture of captures) {
    bound(reports.length + 1, AUDIT_LIMITS.files);
    const normalized = normalizeCapture(capture, reports.length, !!options.includeIds);
    resultRows += normalized.totalResultRows;
    bound(resultRows, AUDIT_LIMITS.totalRows);
    nestedRows += normalized.totalNestedRows;
    publicationRows += normalized.pool.publications.length;
    bound(nestedRows, AUDIT_LIMITS.totalRows);
    bound(publicationRows, AUDIT_LIMITS.totalRows);
    reports.push(normalized.report);
    pools.push(normalized.pool);
    for (const [id, e] of normalized.pool.entities) {
      const old = globalEntities.get(id);
      if (!old) {
        globalEntities.set(id, {
          ...e,
          description: new Set(e.description),
          image: new Set(e.image),
          explicitTypes: new Set(e.explicitTypes),
          inferredTypes: new Set(e.inferredTypes),
        });
      } else {
        for (const v of e.description) old.description.add(v);
        for (const v of e.image) old.image.add(v);
        for (const v of e.explicitTypes) old.explicitTypes.add(v);
        for (const v of e.inferredTypes) old.inferredTypes.add(v);
      }
    }
  }
  if (!reports.length) throw new AuditInputError('no_capture_artifacts');
  const complete = pools.every((p) => p.complete);
  const queries = reports.flatMap((r) => r.queries);
  const globalValues = [...globalEntities.values()];
  return {
    schema_version: 'qloo_recorded_audit_v1',
    interpretation: {
      scope: 'recorded_requests_only_not_catalogue_coverage',
      relevance: 'unpublished_is_unjudged',
      typeEvidence: 'row_types_explicit_request_types_inferred',
      missingFields: 'unknown_not_false',
      imageRole: 'unknown_even_when_url_available',
      queryOperators: 'explicit_only_no_invented_defaults',
      noRawNamesRequestsUrlsOrThirdPartyResponses: true,
    },
    summary: {
      captures: reports.length,
      queries: queries.length,
      poolKnowledge: complete ? 'complete_recording' : 'incomplete_recording',
      rawEntityOccurrences: complete
        ? reports.reduce((n, r) => n + r.observedEntityOccurrences, 0)
        : null,
      observedEntityOccurrences: reports.reduce((n, r) => n + r.observedEntityOccurrences, 0),
      uniqueRawEntities: complete ? globalEntities.size : null,
      observedUniqueEntities: globalEntities.size,
      uniqueEntitiesByType: countBy(
        globalValues.flatMap((e) => [...new Set([...e.explicitTypes, ...e.inferredTypes])]),
      ),
      tagRowsObserved: queries.reduce((n, q) => n + (q.tagRows ?? 0), 0),
      explanationContributionsObserved: queries.reduce(
        (n, q) => n + q.explanationContributionCount,
        0,
      ),
      queriesMissingResults: queries.filter((q) => q.resultsMissing).length,
      queriesUnsupportedEnvelope: queries.filter((q) => q.unsupportedEnvelope).length,
      statusEmptyWithNonemptyResults: queries.filter(
        (q) => q.providerStatus === 'empty' && q.rawResultState === 'nonempty',
      ).length,
      candidateEmptyQueries: queries.filter((q) => q.candidateResultState === 'empty').length,
      candidateUnknownQueries: queries.filter((q) => q.candidateResultState === 'unknown').length,
      publicationEmptyCaptures: reports.filter((r) => r.publication.state === 'empty').length,
      publishedQlooRows: reports.reduce((n, r) => n + r.publication.qlooRows, 0),
      metadata: metadata(globalValues),
    },
    evaluation: judgmentsProjection(pools, options.judgments),
    captures: reports,
  };
}

async function readBoundedJson(
  path: string,
  maxBytes: number,
): Promise<{ value: unknown; bytes: number }> {
  // Check before allocation and read at most cap+1 even if a file grows during reading.
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new AuditInputError('unsupported_input_file');
    bound(stat.size, maxBytes);
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const read = await file.read(buffer);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      bound(bytes, maxBytes);
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    try {
      return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, bytes };
    } catch {
      throw new AuditInputError('invalid_json');
    }
  } finally {
    await file.close();
  }
}

/** Nonrecursive JSON capture directories only; overlapping directories are deduped. */
export async function auditDirectories(directories: string[], options: AuditOptions = {}) {
  const files = new Set<string>();
  bound(directories.length, AUDIT_LIMITS.files);
  try {
    for (const directory of [...new Set(directories)].sort()) {
      const canonical = await realpath(directory);
      const dir = await opendir(canonical);
      for await (const entry of dir) {
        if (!entry.name.endsWith('.json')) continue;
        if (!entry.isFile()) throw new AuditInputError('unsupported_input_file');
        files.add(join(canonical, entry.name));
        bound(files.size, AUDIT_LIMITS.files);
      }
    }
    async function* readCaptures() {
      let bytes = 0;
      for (const file of sorted(files)) {
        if ((await lstat(file)).isSymbolicLink())
          throw new AuditInputError('unsupported_input_file');
        const read = await readBoundedJson(file, AUDIT_LIMITS.fileBytes);
        bytes += read.bytes;
        bound(bytes, AUDIT_LIMITS.totalBytes);
        yield read.value;
      }
    }
    return await auditCaptures(readCaptures(), options);
  } catch (error) {
    if (error instanceof AuditInputError) throw error;
    throw new AuditInputError('input_io_error');
  }
}

export async function main(args: string[]) {
  const directories: string[] = [];
  let out: string | undefined;
  let judgmentsPath: string | undefined;
  let includeIds = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--include-ids') includeIds = true;
    else if (arg === '--out' || arg === '--judgments') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new AuditInputError('invalid_arguments');
      if (arg === '--out') out = value;
      else judgmentsPath = value;
    } else if (arg?.startsWith('-')) throw new AuditInputError('invalid_arguments');
    else if (arg) directories.push(arg);
  }
  if (!directories.length) throw new AuditInputError('capture_directory_required');
  let judgments: unknown;
  if (judgmentsPath) {
    try {
      judgments = (await readBoundedJson(judgmentsPath, AUDIT_LIMITS.fileBytes)).value;
    } catch (error) {
      if (error instanceof AuditInputError) throw error;
      throw new AuditInputError('judgment_io_error');
    }
  }
  const report = await auditDirectories(directories, { includeIds, judgments });
  const json = `${JSON.stringify(report)}\n`;
  if (out) {
    // Exclusive creation avoids replacing existing private files; mode is never inherited.
    let file;
    try {
      file = await open(resolve(out), 'wx', 0o600);
      await file.writeFile(json);
    } catch {
      throw new AuditInputError('output_io_error');
    } finally {
      await file?.close();
    }
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `Qloo offline audit: ${error instanceof AuditInputError ? error.code : 'audit_failed'}\n`,
    );
    process.exitCode = 1;
  });
}
