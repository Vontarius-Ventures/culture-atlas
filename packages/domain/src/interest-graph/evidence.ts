import { createHash } from 'node:crypto';
import { AppError } from '../errors';
import type { Queryable } from '../db/pool';
import {
  type GraphAssertionRow,
  type GraphAssertionSupportRow,
  type GraphEvidenceKind,
  type GraphEvidenceRow,
  type GraphExternalProvider,
  type GraphNodeDomain,
  type GraphNodeKind,
  type GraphNodeRow,
  type GraphPredicate,
  type ProviderRightsPolicyRow,
} from './schema';
import { checkAssertionEndpoints, type NodePolicySummary } from './assertion-policy';

/**
 * Typed writers and readers for the shared versioned evidence layer of
 * migrations 210/220/300 (PR 8 discovery slice).
 *
 * Invariants enforced here (VAL-EVID-001/003/005):
 *  - Canonical identities are keyed by canonical key; a redefinition with
 *    different kind/domain/sense is a conflict, never a silent merge. A
 *    provider id maps to exactly one identity; ambiguous matches stay
 *    proposals.
 *  - Source revisions are immutable rows versioned per (source, revision).
 *    Recording the same reviewed content is idempotent; a changed document is
 *    a NEW revision. The content guards of migration 300 make in-place
 *    rewrites fail loudly.
 *  - Evidence is append-only with review provenance. Identical content reuses
 *    the row; a correction is a new row. The EVIDENCE VERSION is the revision
 *    of the source revision it was read from — the exact pair a pinned proof
 *    records, which replacement can never rewrite.
 *  - Mirrors, repeated extraction and refreshes of one source family count as
 *    ONE cultural support; independently sourced families stay separately
 *    represented (VAL-EVID-003).
 *  - Provider rights policies gate durable storage: transient providers
 *    (Qloo, until its rights are documented) fail closed — nothing of theirs
 *    is admitted (VAL-EVID-005).
 */

// --- Canonical JSON content hashing ------------------------------------------------

/** Deterministic sha256 over canonically-ordered JSON (used for document hashes). */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// --- Canonical identities and provider mappings ------------------------------------

export interface GraphIdentityInput {
  canonicalKey: string;
  canonicalName: string;
  nodeKind: GraphNodeKind;
  domain: GraphNodeDomain;
  senseKey: string;
  /** Optional 1:1 link to an existing researched cultural reference row. */
  culturalReferenceId?: string | null;
  /** Aliases are stored lowercase-keyed; duplicates are no-ops. */
  aliases?: readonly string[];
}

const NODE_COLUMNS = `id, cultural_reference_id, canonical_key, canonical_name, name_key, node_kind, domain,
  sense_key, status, merged_into_id, revision, created_at, updated_at`;

/**
 * Idempotent canonical identity upsert. The same canonical key with the same
 * identity fields returns the existing node; the same key with different
 * kind/domain/sense/name is a conflict (a name never silently re-binds an
 * identity). Aliases are add-only.
 */
export async function upsertGraphIdentity(db: Queryable, input: GraphIdentityInput): Promise<GraphNodeRow> {
  const existing = await db.query<GraphNodeRow>(
    `SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE canonical_key = $1`,
    [input.canonicalKey],
  );
  let row = existing.rows[0];
  if (row) {
    const sameIdentity =
      row.node_kind === input.nodeKind &&
      row.domain === input.domain &&
      row.sense_key === input.senseKey &&
      row.canonical_name === input.canonicalName;
    if (!sameIdentity) {
      throw new AppError('conflict', {
        message: `Canonical identity ${input.canonicalKey} already names a different identity (kind/domain/sense/name must match).`,
      });
    }
  } else {
    // Same spelling is not identity, but the same spelling AND kind/domain/
    // sense is: a second canonical key claiming that identity is a data
    // contradiction, surfaced as a typed conflict instead of a raw 23505.
    const natural = await db.query<GraphNodeRow>(
      `SELECT ${NODE_COLUMNS} FROM graph_nodes
        WHERE name_key = lower($1) AND node_kind = $2 AND domain = $3 AND sense_key = $4`,
      [input.canonicalName, input.nodeKind, input.domain, input.senseKey],
    );
    if (natural.rows[0]) {
      throw new AppError('conflict', {
        message: `Canonical identity ${natural.rows[0].canonical_key} already owns the name/kind/domain/sense of ${input.canonicalKey}.`,
      });
    }
    const inserted = await db.query<GraphNodeRow>(
      `INSERT INTO graph_nodes (canonical_key, canonical_name, name_key, node_kind, domain, sense_key, cultural_reference_id)
       VALUES ($1, $2, lower($2), $3, $4, $5, $6)
       ON CONFLICT (canonical_key) DO NOTHING
       RETURNING ${NODE_COLUMNS}`,
      [input.canonicalKey, input.canonicalName, input.nodeKind, input.domain, input.senseKey, input.culturalReferenceId ?? null],
    );
    row = inserted.rows[0];
    if (!row) {
      // Lost a race on the name natural key (same spelling+kind+domain+sense
      // under a different canonical key): surface it as a typed conflict.
      const reRead = await db.query<GraphNodeRow>(`SELECT ${NODE_COLUMNS} FROM graph_nodes WHERE canonical_key = $1`, [
        input.canonicalKey,
      ]);
      row = reRead.rows[0];
      if (!row) throw new AppError('conflict', { message: `Canonical identity ${input.canonicalKey} is already taken.` });
      else if (
        row.node_kind !== input.nodeKind ||
        row.domain !== input.domain ||
        row.sense_key !== input.senseKey ||
        row.canonical_name !== input.canonicalName
      ) {
        throw new AppError('conflict', {
          message: `Canonical identity ${input.canonicalKey} already names a different identity.`,
        });
      }
    }
  }
  for (const alias of input.aliases ?? []) {
    await db.query(
      `INSERT INTO graph_node_aliases (node_id, alias, alias_key)
       VALUES ($1, $2, lower($2))
       ON CONFLICT (node_id, alias_key) DO NOTHING`,
      [row.id, alias],
    );
  }
  return row;
}

export interface GraphExternalIdInput {
  nodeId: string;
  provider: GraphExternalProvider;
  externalId: string;
  /** Defaults to 'confirmed'; unreviewed machine suggestions stay proposals. */
  matchStatus?: 'confirmed' | 'proposed' | 'ambiguous' | 'rejected';
  matchVersion?: string | null;
  provenance?: string | null;
}

/**
 * Maps a provider id to one canonical identity. A provider id can never be
 * re-bound to a second identity (conflict); re-asserting the mapping on the
 * same node is idempotent and a review can confirm an earlier proposal.
 */
export async function mapGraphExternalId(db: Queryable, input: GraphExternalIdInput): Promise<{ isNew: boolean }> {
  const held = await db.query<{ node_id: string }>(
    'SELECT node_id FROM graph_external_ids WHERE provider = $1 AND external_id = $2',
    [input.provider, input.externalId],
  );
  const current = held.rows[0];
  if (current && current.node_id !== input.nodeId) {
    throw new AppError('conflict', {
      message: `${input.provider} id ${input.externalId} is already mapped to a different canonical identity.`,
    });
  }
  if (current && current.node_id === input.nodeId) {
    if (input.matchStatus && input.matchStatus !== 'rejected') {
      await db.query(
        `UPDATE graph_external_ids
            SET match_status = $3, match_version = COALESCE($4, match_version), provenance = COALESCE($5, provenance)
          WHERE node_id = $1 AND provider = $2 AND external_id = $6`,
        [input.nodeId, input.provider, input.matchStatus, input.matchVersion ?? null, input.provenance ?? null, input.externalId],
      );
    }
    return { isNew: false };
  }
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO graph_external_ids (node_id, provider, external_id, match_status, match_version, provenance)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (node_id, provider, external_id) DO NOTHING
     RETURNING id`,
    [input.nodeId, input.provider, input.externalId, input.matchStatus ?? 'confirmed', input.matchVersion ?? null, input.provenance ?? null],
  );
  return { isNew: inserted.rows.length > 0 };
}

// --- Provider rights policies (VAL-EVID-005) ----------------------------------------

export async function providerRightsPolicy(db: Queryable, provider: string): Promise<ProviderRightsPolicyRow | null> {
  const { rows } = await db.query<ProviderRightsPolicyRow>(
    `SELECT provider, response_retention, public_display, privacy_settings, rights_documented,
            unresolved_notes, basis, recorded_at, updated_at
       FROM provider_rights_policies WHERE provider = $1`,
    [provider],
  );
  return rows[0] ?? null;
}

/**
 * Fail-closed durable-storage gate. Evidence admission requires a provider
 * whose recorded policy permits retaining responses as durable evidence;
 * transient providers (Qloo while its rights are undocumented) and unknown
 * providers are both rejected before anything is written.
 */
export async function requireDurableStoragePolicy(db: Queryable, provider: string): Promise<ProviderRightsPolicyRow> {
  const policy = await providerRightsPolicy(db, provider);
  if (!policy) {
    throw new AppError('invalid_input', {
      message: `Provider ${JSON.stringify(provider)} has no recorded rights policy; durable evidence admission fails closed.`,
    });
  }
  if (policy.response_retention !== 'permitted_documented') {
    throw new AppError('invalid_input', {
      message: `${provider} responses are transient under the recorded rights policy and are never admitted as durable evidence.`,
      details: { provider, unresolved: policy.unresolved_notes },
    });
  }
  return policy;
}

// --- Durable source revisions --------------------------------------------------------

export interface RecordSourceRevisionInput {
  /** Provider rights policy key (checked against provider_rights_policies). */
  provider: string;
  url: string;
  /** Attribution: display metadata we are permitted to show. */
  title: string;
  publisher: string;
  attribution: string;
  license: string;
  licenseUrl?: string | null;
  /** Position inside the document, e.g. "collection record" or "#Materials". */
  locator?: string | null;
  sourceFamilyKey: string;
  /**
   * Hash of the reviewed content snapshot. Recording the same hash is
   * idempotent (the existing revision is returned); a different hash is a NEW
   * revision. NULL always creates a new revision.
   */
  documentHash?: string | null;
  allowedDisplayMetadata: Record<string, unknown>;
  retentionPolicy: Record<string, unknown>;
  rights: Record<string, unknown>;
  /** Applicable rights expiry; NULL when the recorded rights do not expire. */
  rightsExpiresAt?: Date | null;
  retrievedAt?: Date;
}

export interface RecordedSourceRevision {
  sourceId: string;
  sourceRevisionId: string;
  /** The version number of this source revision. */
  revision: number;
  /** True when this call created the revision row. */
  isNew: boolean;
}

/**
 * Records one immutable source revision. The sources row is upserted by URL
 * (display metadata only); the revision itself is append-only: identical
 * content reuses the latest revision, changed content versions the document.
 * The provider's rights policy must permit durable storage first.
 */
export async function recordSourceRevision(db: Queryable, input: RecordSourceRevisionInput): Promise<RecordedSourceRevision> {
  await requireDurableStoragePolicy(db, input.provider);
  const metadata = {
    ...input.allowedDisplayMetadata,
    provider: input.provider,
    title: input.title,
    publisher: input.publisher,
    license: input.license,
    ...(input.licenseUrl ? { license_url: input.licenseUrl } : {}),
    attribution: input.attribution,
  };
  const upserted = await db.query<{ id: string }>(
    `INSERT INTO sources (url, title, publisher, retrieved_at, allowed_display_metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, publisher = EXCLUDED.publisher,
            retrieved_at = EXCLUDED.retrieved_at, allowed_display_metadata = EXCLUDED.allowed_display_metadata
     RETURNING id`,
    [input.url, input.title, input.publisher, input.retrievedAt ?? new Date(), JSON.stringify(metadata)],
  );
  const sourceId = upserted.rows[0]!.id;

  const latest = await db.query<{ id: string; revision: number; document_hash: string | null }>(
    `SELECT id, revision, document_hash FROM graph_source_revisions
      WHERE source_id = $1 ORDER BY revision DESC LIMIT 1`,
    [sourceId],
  );
  const current = latest.rows[0];
  if (current && input.documentHash != null && current.document_hash === input.documentHash) {
    return { sourceId, sourceRevisionId: current.id, revision: current.revision, isNew: false };
  }

  const { rows } = await db.query<{ id: string; revision: number }>(
    `INSERT INTO graph_source_revisions (source_id, url, locator, revision, document_hash, allowed_display_metadata,
                                          retention_policy, source_family_key, rights, rights_expires_at, retrieved_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb, $10, $11)
     RETURNING id, revision`,
    [
      sourceId,
      input.url,
      input.locator ?? null,
      (current?.revision ?? 0) + 1,
      input.documentHash ?? null,
      JSON.stringify(metadata),
      JSON.stringify(input.retentionPolicy),
      input.sourceFamilyKey,
      JSON.stringify(input.rights),
      input.rightsExpiresAt ?? null,
      input.retrievedAt ?? new Date(),
    ],
  );
  return { sourceId, sourceRevisionId: rows[0]!.id, revision: rows[0]!.revision, isNew: true };
}

// --- Append-only evidence --------------------------------------------------------------

export interface InsertEvidenceInput {
  sourceRevisionId: string;
  locator?: string | null;
  /** Permitted excerpt only (bounded); content retention obeys source terms. */
  permittedExcerpt?: string | null;
  structuredValue?: unknown;
  validationMethod: 'provider_metadata' | 'curated_passage' | 'machine_extraction';
  validationVersion: string;
  evidenceKind: GraphEvidenceKind;
  expiresAt?: Date | null;
  /** Review provenance; both must be set for reviewed corpus evidence. */
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
}

export interface InsertedEvidence {
  row: GraphEvidenceRow;
  /** False when identical content already existed (idempotent replay). */
  isNew: boolean;
  /** The evidence version: the source revision this row was read from. */
  revision: number;
}

const EVIDENCE_COLUMNS = `id, source_revision_id, locator, permitted_excerpt, structured_value, validation_method,
  validation_version, evidence_kind, expires_at, reviewed_by, reviewed_at, validity_state, invalidated_at,
  invalidation_reason, created_at`;

/**
 * Appends one evidence row. Identical content within the same source revision
 * reuses the existing row (idempotent corpus replay); any change is a NEW row
 * — the migration 300 content guard makes in-place rewrites impossible, so a
 * pinned proof's recorded evidence version can never drift.
 */
export async function insertEvidence(db: Queryable, input: InsertEvidenceInput): Promise<InsertedEvidence> {
  const structured = input.structuredValue === undefined ? null : JSON.stringify(input.structuredValue);
  const existing = await db.query<{ id: string; revision: number }>(
    `SELECT e.id, r.revision
       FROM graph_evidence e
       JOIN graph_source_revisions r ON r.id = e.source_revision_id
      WHERE e.source_revision_id = $1
        AND e.locator IS NOT DISTINCT FROM $2
        AND e.permitted_excerpt IS NOT DISTINCT FROM $3
        AND e.structured_value IS NOT DISTINCT FROM $4::jsonb
        AND e.validation_method = $5
        AND e.validation_version = $6
        AND e.evidence_kind = $7
        AND e.reviewed_by IS NOT DISTINCT FROM $8
        AND e.reviewed_at IS NOT DISTINCT FROM $9
      ORDER BY e.created_at, e.id
      LIMIT 1`,
    [
      input.sourceRevisionId,
      input.locator ?? null,
      input.permittedExcerpt ?? null,
      structured,
      input.validationMethod,
      input.validationVersion,
      input.evidenceKind,
      input.reviewedBy ?? null,
      input.reviewedAt ?? null,
    ],
  );
  if (existing.rows[0]) {
    const row = (await db.query<GraphEvidenceRow>(`SELECT ${EVIDENCE_COLUMNS} FROM graph_evidence WHERE id = $1`, [
      existing.rows[0].id,
    ])).rows[0]!;
    return { row, isNew: false, revision: existing.rows[0].revision };
  }
  const inserted = await db.query<GraphEvidenceRow>(
    `INSERT INTO graph_evidence (source_revision_id, locator, permitted_excerpt, structured_value, validation_method,
                                  validation_version, evidence_kind, expires_at, reviewed_by, reviewed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
     RETURNING ${EVIDENCE_COLUMNS}`,
    [
      input.sourceRevisionId,
      input.locator ?? null,
      input.permittedExcerpt ?? null,
      structured,
      input.validationMethod,
      input.validationVersion,
      input.evidenceKind,
      input.expiresAt ?? null,
      input.reviewedBy ?? null,
      input.reviewedAt ?? null,
    ],
  );
  const revision = await db.query<{ revision: number }>('SELECT revision FROM graph_source_revisions WHERE id = $1', [
    input.sourceRevisionId,
  ]);
  return { row: inserted.rows[0]!, isNew: true, revision: revision.rows[0]!.revision };
}

// --- Assertions and family-deduped support ---------------------------------------------

export interface UpsertGraphAssertionInput {
  subjectNodeId: string;
  predicate: GraphPredicate;
  objectNodeId: string;
  /** Required for DOCUMENTED_ASSOCIATION, forbidden otherwise. */
  associationSubtype?: string | null;
  /** Insert status for new assertions; corpus admission uses 'validated'. */
  status?: 'proposed' | 'validated';
}

export interface UpsertedAssertion {
  row: GraphAssertionRow;
  isNew: boolean;
}

const ASSERTION_COLUMNS = `id, subject_node_id, predicate, object_node_id, association_subtype, status, revision,
  valid_from, invalidated_at, recorded_at, superseded_at, created_at, updated_at`;

/**
 * Loads the identity facts the endpoint/scope policy needs for a set of
 * nodes. Ids that do not exist are absent from the map; the caller decides
 * whether that is a not_found or a rejection.
 */
export async function loadNodePolicySummaries(
  db: Queryable,
  nodeIds: readonly string[],
): Promise<Map<string, NodePolicySummary>> {
  if (nodeIds.length === 0) return new Map();
  const { rows } = await db.query<{ id: string; node_kind: GraphNodeKind; domain: GraphNodeDomain; sense_key: string; status: string }>(
    `SELECT id, node_kind, domain, sense_key, status FROM graph_nodes WHERE id = ANY($1::uuid[])`,
    [nodeIds],
  );
  const out = new Map<string, NodePolicySummary>();
  for (const row of rows) {
    out.set(row.id, {
      nodeKind: row.node_kind,
      domain: row.domain,
      senseKey: row.sense_key,
      status: row.status as NodePolicySummary['status'],
    });
  }
  return out;
}

/**
 * Natural-key assertion upsert (one row per subject/predicate/object/subtype).
 * A reviewed corpus admission can validate an existing proposal (the decision
 * is a correction and bumps the revision); it can never silently re-validate
 * a retracted/rejected/disputed assertion, and a proposed replay never
 * downgrades a validated one.
 *
 * The predicate-specific endpoint/scope rules (VAL-EVID-002) are enforced
 * HERE, at the single admission point every writer shares: wrong endpoint
 * kinds, wrong domain scope, a missing DOCUMENTED_ASSOCIATION subtype and
 * ambiguous/merged/retired identity endpoints reject with typed rules before
 * anything is written. A generic RELATED_TO is not an admitted predicate at
 * all (the typed predicate set and the database CHECK both refuse it).
 */
export async function upsertGraphAssertion(db: Queryable, input: UpsertGraphAssertionInput): Promise<UpsertedAssertion> {
  const status = input.status ?? 'proposed';
  const summaries = await loadNodePolicySummaries(db, [input.subjectNodeId, input.objectNodeId]);
  const subject = summaries.get(input.subjectNodeId);
  const object = summaries.get(input.objectNodeId);
  if (!subject || !object) {
    throw new AppError('not_found', { message: 'Assertion endpoints must be existing canonical identities.' });
  }
  const check = checkAssertionEndpoints(subject, input.predicate, object, input.associationSubtype ?? null);
  if (!check.valid) {
    throw new AppError('invalid_input', { message: check.rejection!.message, details: { rule: check.rejection!.code } });
  }
  const existing = await db.query<GraphAssertionRow>(
    `SELECT ${ASSERTION_COLUMNS} FROM graph_assertions
      WHERE subject_node_id = $1 AND predicate = $2 AND object_node_id = $3
        AND COALESCE(association_subtype, '') = COALESCE($4, '')`,
    [input.subjectNodeId, input.predicate, input.objectNodeId, input.associationSubtype ?? null],
  );
  const current = existing.rows[0];
  if (!current) {
    const inserted = await db.query<GraphAssertionRow>(
      `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id, association_subtype, status)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (subject_node_id, predicate, object_node_id, COALESCE(association_subtype, '')) DO NOTHING
       RETURNING ${ASSERTION_COLUMNS}`,
      [input.subjectNodeId, input.predicate, input.objectNodeId, input.associationSubtype ?? null, status],
    );
    if (inserted.rows[0]) return { row: inserted.rows[0], isNew: true };
    const raced = await db.query<GraphAssertionRow>(
      `SELECT ${ASSERTION_COLUMNS} FROM graph_assertions
        WHERE subject_node_id = $1 AND predicate = $2 AND object_node_id = $3
          AND COALESCE(association_subtype, '') = COALESCE($4, '')`,
      [input.subjectNodeId, input.predicate, input.objectNodeId, input.associationSubtype ?? null],
    );
    return { row: raced.rows[0]!, isNew: false };
  }
  if (current.status === 'proposed' && status === 'validated') {
    const updated = await db.query<GraphAssertionRow>(
      `UPDATE graph_assertions SET status = 'validated', revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING ${ASSERTION_COLUMNS}`,
      [current.id],
    );
    return { row: updated.rows[0]!, isNew: false };
  }
  if (['retracted', 'rejected', 'disputed', 'superseded'].includes(current.status) && status === 'validated') {
    throw new AppError('conflict', {
      message: `Assertion ${current.id} is ${current.status}; a reviewed corpus admission cannot silently re-validate it.`,
    });
  }
  return { row: current, isNew: false };
}

export interface AttachSupportInput {
  assertionId: string;
  evidenceId: string;
  role?: 'supports' | 'refutes';
  /** How this support row was derived; same-family rows count as one support. */
  derivation: 'primary' | 'mirror' | 'refresh' | 'reextraction';
  sourceFamilyKey: string;
}

export interface AttachedSupport {
  /** Null when the support row already existed (idempotent replay). */
  row: GraphAssertionSupportRow | null;
  assertionRevision: number;
  revisionBumped: boolean;
}

/**
 * Attaches evidence to an assertion. Newly attached evidence bumps the
 * assertion's revision (new evidence or corrections version the assertion
 * instead of duplicating it); replaying an existing attachment is a no-op.
 */
export async function attachAssertionSupport(db: Queryable, input: AttachSupportInput): Promise<AttachedSupport> {
  const inserted = await db.query<GraphAssertionSupportRow>(
    `INSERT INTO graph_assertion_support (assertion_id, evidence_id, role, derivation, source_family_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (assertion_id, evidence_id) DO NOTHING
     RETURNING id, assertion_id, evidence_id, role, derivation, source_family_key, created_at`,
    [input.assertionId, input.evidenceId, input.role ?? 'supports', input.derivation, input.sourceFamilyKey],
  );
  let revision: number;
  let revisionBumped = false;
  if (inserted.rows[0]) {
    const updated = await db.query<{ revision: number }>(
      `UPDATE graph_assertions SET revision = revision + 1, updated_at = now()
        WHERE id = $1 RETURNING revision`,
      [input.assertionId],
    );
    revision = updated.rows[0]?.revision ?? 0;
    revisionBumped = true;
  } else {
    const current = await db.query<{ revision: number }>('SELECT revision FROM graph_assertions WHERE id = $1', [
      input.assertionId,
    ]);
    revision = current.rows[0]?.revision ?? 0;
  }
  return { row: inserted.rows[0] ?? null, assertionRevision: revision, revisionBumped };
}

export interface DistinctSupportFamily {
  sourceFamilyKey: string;
  role: 'supports' | 'refutes';
  derivations: Array<'primary' | 'mirror' | 'refresh' | 'reextraction'>;
  /** Evidence ids behind this family's support, sorted for determinism. */
  evidenceIds: string[];
}

export interface AssertionSupportSummary {
  assertionId: string;
  /** Raw support rows (mirrors and refreshes included). */
  supportRows: number;
  /** One entry per (family, role), sorted by family then role. */
  distinct: DistinctSupportFamily[];
  /** Distinct families whose current role is 'supports' (the real support set). */
  independentFamilies: number;
  /** Distinct families with a refuting role. */
  refutingFamilies: number;
}

/**
 * The family-deduped support set of an assertion (VAL-EVID-003): mirrors,
 * repeated extraction and refreshes of one source family collapse to a single
 * entry, while independently sourced families stay separately represented.
 * The exact array is the support set downstream admission must compare
 * against — never the raw row count.
 */
export async function distinctAssertionSupport(db: Queryable, assertionId: string): Promise<AssertionSupportSummary> {
  const { rows } = await db.query<{
    source_family_key: string;
    role: 'supports' | 'refutes';
    derivations: Array<'primary' | 'mirror' | 'refresh' | 'reextraction'>;
    evidence_ids: string[];
  }>(
    `SELECT source_family_key,
            role,
            array_agg(DISTINCT derivation ORDER BY derivation) AS derivations,
            array_agg(evidence_id ORDER BY evidence_id) AS evidence_ids
       FROM graph_assertion_support
      WHERE assertion_id = $1
      GROUP BY source_family_key, role
      ORDER BY source_family_key, role`,
    [assertionId],
  );
  const distinct: DistinctSupportFamily[] = rows.map((r) => ({
    sourceFamilyKey: r.source_family_key,
    role: r.role,
    derivations: r.derivations,
    evidenceIds: r.evidence_ids,
  }));
  return {
    assertionId,
    supportRows: distinct.reduce((n, d) => n + d.evidenceIds.length, 0),
    distinct,
    independentFamilies: distinct.filter((d) => d.role === 'supports').length,
    refutingFamilies: distinct.filter((d) => d.role === 'refutes').length,
  };
}

// --- Evidence versions (read AND publication checks) ----------------------------------

export interface EvidenceVersion {
  evidenceId: string;
  /** The immutable evidence version: its source revision's number. */
  revision: number;
  sourceRevisionId: string;
  sourceFamilyKey: string;
  locator: string | null;
  permittedExcerpt: string | null;
  rights: unknown;
  rightsExpiresAt: Date | null;
  evidenceExpiresAt: Date | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  /** Retraction status (migration 310); a retracted row justifies nothing. */
  validityState: 'valid' | 'retracted';
  invalidatedAt: Date | null;
  invalidationReason: string | null;
}

/**
 * Exact evidence versions for pinned proof revalidation at read AND
 * publication time: the revision a proof recorded stays what it was because
 * evidence rows are append-only. Ids that no longer exist are simply absent
 * (a proof pinning a deleted row must revalidate as invalid, not resurrect).
 */
export async function loadEvidenceVersions(db: Queryable, evidenceIds: readonly string[]): Promise<Map<string, EvidenceVersion>> {
  if (evidenceIds.length === 0) return new Map();
  const { rows } = await db.query<{
    evidence_id: string;
    revision: number;
    source_revision_id: string;
    source_family_key: string;
    locator: string | null;
    permitted_excerpt: string | null;
    rights: unknown;
    rights_expires_at: Date | null;
    evidence_expires_at: Date | null;
    reviewed_by: string | null;
    reviewed_at: Date | null;
    validity_state: 'valid' | 'retracted';
    invalidated_at: Date | null;
    invalidation_reason: string | null;
  }>(
    `SELECT e.id AS evidence_id, r.revision, e.source_revision_id, r.source_family_key, e.locator,
            e.permitted_excerpt, r.rights, r.rights_expires_at, e.expires_at AS evidence_expires_at,
            e.reviewed_by, e.reviewed_at, e.validity_state, e.invalidated_at, e.invalidation_reason
       FROM graph_evidence e
       JOIN graph_source_revisions r ON r.id = e.source_revision_id
      WHERE e.id = ANY($1::uuid[])`,
    [evidenceIds],
  );
  const out = new Map<string, EvidenceVersion>();
  for (const r of rows) {
    out.set(r.evidence_id, {
      evidenceId: r.evidence_id,
      revision: r.revision,
      sourceRevisionId: r.source_revision_id,
      sourceFamilyKey: r.source_family_key,
      locator: r.locator,
      permittedExcerpt: r.permitted_excerpt,
      rights: r.rights,
      rightsExpiresAt: r.rights_expires_at,
      evidenceExpiresAt: r.evidence_expires_at,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      validityState: r.validity_state,
      invalidatedAt: r.invalidated_at,
      invalidationReason: r.invalidation_reason,
    });
  }
  return out;
}
