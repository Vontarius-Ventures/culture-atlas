import { AppError } from '../errors';
import type { Db, Queryable } from '../db/pool';
import type { GraphEvidenceKind } from './schema';
import {
  attachAssertionSupport,
  contentHash,
  insertEvidence,
  mapGraphExternalId,
  recordSourceRevision,
  requireDurableStoragePolicy,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import type { CorpusManifest } from './corpus-manifest';

/**
 * Admission loader for the reviewed pilot evidence corpus (VAL-EVID-001/005).
 *
 * Only a reviewed manifest (see corpus-manifest.ts) can reach this code, and
 * admission still fails closed on rights: a provider whose recorded policy
 * keeps responses transient (Qloo, while its retention/public-display rights
 * are undocumented) is rejected before anything is written, and the whole
 * manifest commits in ONE transaction — a rejected suffix entry rolls back the
 * accepted prefix instead of half-copying restricted material.
 *
 * Loading is idempotent: identical manifest content reuses existing source
 * revisions, evidence rows and support attachments, and adds no revision
 * anywhere. A changed manifest versions the affected source (new revision +
 * new evidence rows) without ever rewriting a pinned pair.
 */
export interface CorpusAdmissionResult {
  corpusVersion: string;
  identitiesCreated: number;
  externalIdsCreated: number;
  sourceRevisionsCreated: number;
  evidenceCreated: number;
  assertionsCreated: number;
  supportAttached: number;
  /** Sum of the loaded assertions' revisions: identical across idempotent replays. */
  assertionRevisionTotal: number;
}

export async function admitGraphCorpus(db: Db, manifest: CorpusManifest): Promise<CorpusAdmissionResult> {
  // Evidence content participates in each source's document hash, so an edited
  // extraction versions the document rather than silently reusing a revision.
  const evidenceBySource = new Map<string, CorpusManifest['assertions'][number]['evidence']>();
  for (const assertion of manifest.assertions) {
    for (const evidence of assertion.evidence) {
      const list = evidenceBySource.get(evidence.source) ?? [];
      list.push(evidence);
      evidenceBySource.set(evidence.source, list);
    }
  }

  return db.transaction(async (tx) => {
    const reviewedAt = new Date(manifest.review.reviewed_at);
    if (Number.isNaN(reviewedAt.getTime())) {
      throw new AppError('invalid_input', { message: 'The corpus review timestamp is not a valid date.' });
    }

    const nodeIds = new Map<string, string>();
    const preExisting = await tx.query<{ canonical_key: string }>(
      'SELECT canonical_key FROM graph_nodes WHERE canonical_key = ANY($1::text[])',
      [manifest.identities.map((i) => i.key)],
    );
    const existingKeys = new Set(preExisting.rows.map((r) => r.canonical_key));
    let identitiesCreated = 0;
    for (const identity of manifest.identities) {
      const row = await upsertGraphIdentity(tx, {
        canonicalKey: identity.key,
        canonicalName: identity.name,
        nodeKind: identity.kind,
        domain: identity.domain,
        senseKey: identity.sense,
        aliases: identity.aliases,
      });
      nodeIds.set(identity.key, row.id);
      if (!existingKeys.has(identity.key)) identitiesCreated += 1;
    }

    let externalIdsCreated = 0;
    for (const external of manifest.external_ids) {
      const nodeId = nodeIds.get(external.identity);
      if (!nodeId) continue; // unreachable: the schema guarantees the identity exists
      const mapped = await mapGraphExternalId(tx, {
        nodeId,
        provider: external.provider,
        externalId: external.external_id,
        matchStatus: 'confirmed',
        matchVersion: manifest.corpus_version,
        provenance: external.provenance,
      });
      externalIdsCreated += mapped.isNew ? 1 : 0;
    }

    let sourceRevisionsCreated = 0;
    const revisionIds = new Map<string, { sourceRevisionId: string; familyKey: string }>();
    for (const source of manifest.sources) {
      // Rights gate first: a transient provider rejects before any write.
      const policy = await requireDurableStoragePolicy(tx, source.provider);
      const documentHash = contentHash({
        source: {
          url: source.url,
          family_key: source.family_key,
          title: source.title,
          publisher: source.publisher,
          attribution: source.attribution,
          ...(source.locator ? { locator: source.locator } : {}),
          retrieved_at: source.retrieved_at,
          rights: source.rights,
          retention: source.retention,
        },
        evidence: (evidenceBySource.get(source.key) ?? []).map((e) => ({
          locator: e.locator ?? null,
          excerpt: e.excerpt ?? null,
          structured_value: e.structured_value ?? null,
          kind: e.kind,
          derivation: e.derivation,
          validation: e.validation,
        })),
      });
      const recorded = await recordSourceRevision(tx, {
        provider: source.provider,
        url: source.url,
        title: source.title,
        publisher: source.publisher,
        attribution: source.attribution,
        license: source.rights.license,
        licenseUrl: source.rights.license_url ?? null,
        locator: source.locator ?? null,
        sourceFamilyKey: source.family_key,
        documentHash,
        allowedDisplayMetadata: {
          title: source.title,
          publisher: source.publisher,
          attribution: source.attribution,
          license: source.rights.license,
          ...(source.rights.license_url ? { license_url: source.rights.license_url } : {}),
          permitted_use: source.rights.permitted_use,
          policy_response_retention: policy.response_retention,
        },
        retentionPolicy: { ...source.retention, provider: source.provider },
        rights: { ...source.rights, policy_basis: policy.basis },
        rightsExpiresAt:
          source.rights.expiry === 'date' && source.rights.expires_at ? new Date(source.rights.expires_at) : null,
        retrievedAt: new Date(source.retrieved_at),
      });
      sourceRevisionsCreated += recorded.isNew ? 1 : 0;
      revisionIds.set(source.key, { sourceRevisionId: recorded.sourceRevisionId, familyKey: source.family_key });
    }

    let evidenceCreated = 0;
    let assertionsCreated = 0;
    let supportAttached = 0;
    const assertionIds: string[] = [];
    for (const assertion of manifest.assertions) {
      const subjectNodeId = nodeIds.get(assertion.subject)!;
      const objectNodeId = nodeIds.get(assertion.object)!;
      const upserted = await upsertGraphAssertion(tx, {
        subjectNodeId,
        predicate: assertion.predicate,
        objectNodeId,
        associationSubtype: assertion.association_subtype ?? null,
        status: 'validated',
      });
      assertionsCreated += upserted.isNew ? 1 : 0;
      assertionIds.push(upserted.row.id);

      for (const evidence of assertion.evidence) {
        const revision = revisionIds.get(evidence.source);
        if (!revision) continue; // unreachable: the schema guarantees the source exists
        const inserted = await insertEvidence(tx, {
          sourceRevisionId: revision.sourceRevisionId,
          locator: evidence.locator ?? null,
          permittedExcerpt: evidence.excerpt ?? null,
          structuredValue: evidence.structured_value ?? null,
          validationMethod: evidence.validation.method,
          validationVersion: evidence.validation.version,
          evidenceKind: evidence.kind as GraphEvidenceKind,
          reviewedBy: manifest.review.reviewed_by,
          reviewedAt,
        });
        evidenceCreated += inserted.isNew ? 1 : 0;
        const attached = await attachAssertionSupport(tx, {
          assertionId: upserted.row.id,
          evidenceId: inserted.row.id,
          derivation: evidence.derivation,
          sourceFamilyKey: revision.familyKey,
        });
        supportAttached += attached.row ? 1 : 0;
      }
    }

    const { rows: revisionTotal } = await tx.query<{ n: number }>(
      'SELECT COALESCE(SUM(revision), 0)::int AS n FROM graph_assertions WHERE id = ANY($1::uuid[])',
      [assertionIds],
    );
    return {
      corpusVersion: manifest.corpus_version,
      identitiesCreated,
      externalIdsCreated,
      sourceRevisionsCreated,
      evidenceCreated,
      assertionsCreated,
      supportAttached,
      assertionRevisionTotal: revisionTotal[0]!.n,
    };
  });
}

// --- Corpus summary ------------------------------------------------------------------

export interface CorpusDomainSummary {
  domain: string;
  identities: number;
  assertions: number;
  evidence: number;
}

export interface GraphCorpusSummary {
  domains: CorpusDomainSummary[];
  /** Reviewed (corpus-qualified) vs unreviewed (proposal) evidence rows. */
  reviewedEvidence: number;
  unreviewedEvidence: number;
  sources: number;
  sourceRevisions: number;
  /** Assertions with two or more independently supporting source families. */
  assertionsWithIndependentSupport: number;
  /** Providers whose storage/display rights are honestly still unresolved. */
  unresolvedRightsPolicies: string[];
}

/**
 * Honest snapshot of the loaded shared corpus: per-domain coverage, reviewed
 * versus unreviewed evidence (unreviewed imports are never the qualified
 * corpus), independent-support breadth and the unresolved provider rights.
 */
export async function graphCorpusSummary(db: Queryable): Promise<GraphCorpusSummary> {
  const domains = await db.query<{ domain: string; identities: number; assertions: number; evidence: number }>(
    `SELECT n.domain,
            COUNT(DISTINCT n.id)::int AS identities,
            COUNT(DISTINCT a.id)::int AS assertions,
            COUNT(DISTINCT s.evidence_id)::int AS evidence
       FROM graph_nodes n
       LEFT JOIN graph_assertions a ON a.subject_node_id = n.id
       LEFT JOIN graph_assertion_support s ON s.assertion_id = a.id
      WHERE n.id IN (SELECT subject_node_id FROM graph_assertions)
         OR n.id IN (SELECT object_node_id FROM graph_assertions)
      GROUP BY n.domain
      ORDER BY n.domain`,
  );
  const evidence = await db.query<{ reviewed: number; unreviewed: number }>(
    `SELECT COUNT(*) FILTER (WHERE reviewed_by IS NOT NULL)::int AS reviewed,
            COUNT(*) FILTER (WHERE reviewed_by IS NULL)::int AS unreviewed
       FROM graph_evidence`,
  );
  const counts = await db.query<{ sources: number; revisions: number }>(
    `SELECT (SELECT COUNT(*)::int FROM sources) AS sources,
            (SELECT COUNT(*)::int FROM graph_source_revisions) AS revisions`,
  );
  const independent = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT a.id
         FROM graph_assertions a
         JOIN graph_assertion_support s ON s.assertion_id = a.id AND s.role = 'supports'
        GROUP BY a.id
       HAVING COUNT(DISTINCT s.source_family_key) >= 2
     ) t`,
  );
  const unresolved = await db.query<{ provider: string }>(
    'SELECT provider FROM provider_rights_policies WHERE NOT rights_documented ORDER BY provider',
  );
  return {
    domains: domains.rows,
    reviewedEvidence: evidence.rows[0]!.reviewed,
    unreviewedEvidence: evidence.rows[0]!.unreviewed,
    sources: counts.rows[0]!.sources,
    sourceRevisions: counts.rows[0]!.revisions,
    assertionsWithIndependentSupport: independent.rows[0]!.n,
    unresolvedRightsPolicies: unresolved.rows.map((r) => r.provider),
  };
}
