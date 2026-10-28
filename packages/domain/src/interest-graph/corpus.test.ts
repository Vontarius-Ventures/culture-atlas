import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeQloo } from '@culture-atlas/providers/testing';
import { storeResearch } from '../compiler/research';
import { recordProviderQuery } from '../compiler/provider-queries';
import { QlooSession } from '../composer/provider-calls';
import { createIsolatedDatabase, insertAccount } from '../testing';
import type { PoolDb } from '../db/pool';
import {
  attachAssertionSupport,
  contentHash,
  distinctAssertionSupport,
  insertEvidence,
  loadEvidenceVersions,
  recordSourceRevision,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';
import { admitGraphCorpus, graphCorpusSummary } from './corpus';
import { CorpusManifestSchema, getCorpusManifestFile, type CorpusManifest } from './corpus-manifest';
import { insertGraphRecommendation, insertRecommendationProof, loadGraphRunCards, createGraphRun } from './store';

/**
 * VAL-EVID-001 / VAL-EVID-005: the reviewed art/sculpture/ceramics/interiors
 * pilot corpus admits only reviewed, rights-limited evidence; evidence and
 * pinned proof revisions survive the destructive replacement of research
 * claims; Qloo stays transient (ids, names and ranks for traceability) and is
 * never admitted as durable evidence while its rights are undocumented.
 */

let db: PoolDb;
let drop: () => Promise<void>;

beforeAll(async () => {
  const iso = await createIsolatedDatabase('corpus');
  db = iso.db;
  drop = iso.drop;
});

afterAll(async () => {
  await drop();
});

// --- Fixtures -----------------------------------------------------------------

function syntheticManifest(over: { provider?: string; sourceKey?: string } = {}): CorpusManifest {
  const workKey = `atlas:work:${randomUUID()}`;
  const creatorKey = `atlas:creator:${randomUUID()}`;
  const sourceKey = over.sourceKey ?? 'source:1';
  return CorpusManifestSchema.parse({
    manifest_version: 1,
    corpus_version: 'test-1',
    policy_version: 'graph-policy-1',
    domains: ['art'],
    review: { reviewed_by: 'test review', reviewed_at: '2026-10-28T00:00:00.000Z', basis: 'verified against the cited source' },
    photo_candidate_inventory: {
      location: 'test research directory',
      status: 'not_a_qualified_holdout',
      note: 'candidate photo inventory is evaluation-planning material, never corpus content',
    },
    provider_policy: { transient_providers: ['qloo'], note: 'Qloo responses stay transient; they are never durable evidence.' },
    identities: [
      { key: workKey, name: 'A Test Work', kind: 'work', domain: 'art', sense: 'painting' },
      { key: creatorKey, name: 'A Test Creator', kind: 'creator', domain: 'art', sense: 'painter' },
    ],
    external_ids: [],
    sources: [
      {
        key: sourceKey,
        provider: over.provider ?? 'artic_open_access',
        url: `https://example.org/${randomUUID()}`,
        family_key: `artic:${randomUUID()}`,
        title: 'A Test Record',
        publisher: 'A Museum',
        attribution: 'A Museum',
        retrieved_at: '2026-10-28T00:00:00.000Z',
        rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
        retention: { content: 'permitted metadata fields only', basis: 'CC0' },
      },
    ],
    assertions: [
      {
        label: 'a-test-work-created-by-a-test-creator',
        subject: workKey,
        object: creatorKey,
        predicate: 'CREATED_BY',
        evidence: [
          {
            source: sourceKey,
            kind: 'fact',
            derivation: 'primary',
            validation: { method: 'provider_metadata', version: 'source-1' },
            locator: 'artist_display',
            excerpt: 'A Test Creator (Test, 1900-1901)',
          },
        ],
      },
    ],
  });
}

const CORPUS_TABLES = ['sources', 'graph_source_revisions', 'graph_evidence', 'graph_assertions', 'graph_assertion_support', 'graph_nodes'] as const;

async function tableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of CORPUS_TABLES) {
    const { rows } = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
    out[table] = rows[0]!.n;
  }
  return out;
}

describe('reviewed pilot corpus admission', () => {
  it('loads the committed manifest once and replays without adding anything', async () => {
    const manifest = getCorpusManifestFile();
    const evidenceRows = manifest.assertions.reduce((n, a) => n + a.evidence.length, 0);
    const first = await admitGraphCorpus(db, manifest);
    expect(first.corpusVersion).toBe(manifest.corpus_version);
    expect(first.identitiesCreated).toBe(manifest.identities.length);
    expect(first.externalIdsCreated).toBe(manifest.external_ids.length);
    expect(first.sourceRevisionsCreated).toBe(manifest.sources.length);
    expect(first.evidenceCreated).toBe(evidenceRows);
    expect(first.assertionsCreated).toBe(manifest.assertions.length);
    expect(first.supportAttached).toBe(evidenceRows);

    const replay = await admitGraphCorpus(db, manifest);
    expect(replay.identitiesCreated).toBe(0);
    expect(replay.externalIdsCreated).toBe(0);
    expect(replay.sourceRevisionsCreated).toBe(0);
    expect(replay.evidenceCreated).toBe(0);
    expect(replay.assertionsCreated).toBe(0);
    expect(replay.supportAttached).toBe(0);
    expect(replay.assertionRevisionTotal).toBe(first.assertionRevisionTotal);

    const summary = await graphCorpusSummary(db);
    for (const domain of ['art', 'sculpture', 'ceramics', 'interiors']) {
      const row = summary.domains.find((d) => d.domain === domain);
      expect(row?.identities).toBeGreaterThan(0);
      expect(row?.assertions).toBeGreaterThan(0);
    }
    expect(summary.reviewedEvidence).toBe(evidenceRows);
    expect(summary.unreviewedEvidence).toBe(0);
    expect(summary.sources).toBe(manifest.sources.length);
    expect(summary.sourceRevisions).toBe(manifest.sources.length);
    // The Bedroom's creator is corroborated by two independent source families.
    expect(summary.assertionsWithIndependentSupport).toBeGreaterThanOrEqual(1);
    expect(summary.unresolvedRightsPolicies).toContain('qloo');
  });

  it('contains only reviewed evidence for the four pilot domains with no unclaimed predicates', async () => {
    const manifest = getCorpusManifestFile();
    expect(new Set(manifest.domains)).toEqual(new Set(['art', 'sculpture', 'ceramics', 'interiors']));
    const predicates = new Set(manifest.assertions.map((a) => a.predicate));
    // No audience-affinity or subject-matter claim ships without public-source
    // evidence; the pilot corpus honestly omits those predicates.
    expect(predicates).toEqual(new Set(['CREATED_BY', 'USES_TECHNIQUE', 'HAS_ATTRIBUTE', 'DOCUMENTED_ASSOCIATION']));
    for (const source of manifest.sources) {
      expect(source.rights.license.length).toBeGreaterThan(0);
      expect(source.publisher.length).toBeGreaterThan(0);
    }
  });
});

describe('unqualified imports are not a corpus', () => {
  it('records the candidate photo inventory as not a qualified holdout and rejects photo-candidate entries', async () => {
    const manifest = getCorpusManifestFile();
    expect(manifest.photo_candidate_inventory.status).toBe('not_a_qualified_holdout');

    // A photo-candidates.json-style entry (image urls, license evidence, HEAD
    // checks) is not corpus data in any slot: the strict schema rejects it.
    const photoEntry = {
      source_id: 'artic:21023',
      subject_type: 'sculpture',
      object_url: 'https://www.artic.edu/artworks/21023',
      image_url: 'https://www.artic.edu/iiif/2/x/full/843,/0/default.jpg',
      license: 'CC0',
      title: 'Buddha Shakyamuni Seated in Meditation',
      status: 'rights_reviewed',
    };
    for (const parsed of [
      CorpusManifestSchema.safeParse({ ...manifest, identities: [...manifest.identities, photoEntry] }),
      CorpusManifestSchema.safeParse({ ...manifest, assertions: [...manifest.assertions, { ...manifest.assertions[0]!, evidence: [photoEntry] }] }),
    ]) {
      expect(parsed.success).toBe(false);
    }
  });

  it('rejects a manifest without a review record (unreviewed imports cannot be admitted)', () => {
    const manifest = syntheticManifest();
    const { review: _review, ...withoutReview } = manifest;
    expect(CorpusManifestSchema.safeParse(withoutReview).success).toBe(false);
  });

  it('rejects machine-extracted evidence in the reviewed corpus schema', () => {
    const manifest = syntheticManifest();
    const machine = {
      ...manifest.assertions[0]!,
      evidence: [{ ...manifest.assertions[0]!.evidence[0]!, validation: { method: 'machine_extraction', version: 'model-1' } }],
    };
    expect(CorpusManifestSchema.safeParse({ ...manifest, assertions: [machine] }).success).toBe(false);
  });
});

describe('restricted rights fail closed', () => {
  it('rejects Qloo-provider entries and copies no restricted material anywhere', async () => {
    const before = await tableCounts();
    const manifest = syntheticManifest({ provider: 'qloo' });
    await expect(admitGraphCorpus(db, manifest)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await tableCounts()).toEqual(before);
  });

  it('rejects unknown providers and rolls back every earlier entry of the same manifest', async () => {
    const before = await tableCounts();
    const good = syntheticManifest();
    const badSource = syntheticManifest({ provider: 'not-a-documented-provider', sourceKey: 'source:2' }).sources[0]!;
    const manifest = {
      ...good,
      corpus_version: 'mixed-1',
      sources: [...good.sources, badSource],
      assertions: [...good.assertions, { ...good.assertions[0]!, label: 'a-second-assertion', evidence: [{ ...good.assertions[0]!.evidence[0]!, source: badSource.key }] }],
    };
    await expect(admitGraphCorpus(db, CorpusManifestSchema.parse(manifest))).rejects.toMatchObject({ code: 'invalid_input' });
    // The good prefix was rolled back with the bad suffix: nothing persisted.
    expect(await tableCounts()).toEqual(before);
  });
});

describe('evidence survives the destructive research claims refresh (VAL-EVID-001)', () => {
  it('keeps evidence, revisions and pinned proof pairs exact across claims replacement and evidence replacement', async () => {
    // A researched reference whose claims are about to be replaced.
    const { rows: refRows } = await db.query<{ id: string }>(
      `INSERT INTO cultural_references (canonical_name, canonical_key, type, research_status)
       VALUES ('A Test Work', $1, 'work', 'complete') RETURNING id`,
      [`wikidata:${randomUUID()}`],
    );
    const referenceId = refRows[0]!.id;

    // Canonical identity linked to that reference, plus reviewed evidence.
    const subject = await upsertGraphIdentity(db, {
      canonicalKey: `atlas:work:${randomUUID()}`,
      canonicalName: 'A Test Work',
      nodeKind: 'work',
      domain: 'art',
      senseKey: 'painting',
      culturalReferenceId: referenceId,
    });
    const object = await upsertGraphIdentity(db, {
      canonicalKey: `atlas:creator:${randomUUID()}`,
      canonicalName: 'A Test Creator',
      nodeKind: 'creator',
      domain: 'art',
      senseKey: 'painter',
    });
    const family = `artic:${randomUUID()}`;
    const sourceUrl = `https://example.org/${randomUUID()}`;
    const revision = await recordSourceRevision(db, {
      provider: 'artic_open_access',
      url: sourceUrl,
      title: 'A Test Record',
      publisher: 'A Museum',
      attribution: 'A Museum',
      license: 'CC0 1.0',
      sourceFamilyKey: family,
      allowedDisplayMetadata: { provider: 'artic_open_access', title: 'A Test Record', publisher: 'A Museum', license: 'CC0 1.0' },
      retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
      rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
      documentHash: contentHash({ content: 'first crawl' }),
    });
    const evidence = await insertEvidence(db, {
      sourceRevisionId: revision.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'A Test Creator (Test, 1900-1901)',
      structuredValue: { artist_display: 'A Test Creator (Test, 1900-1901)' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    const assertion = await upsertGraphAssertion(db, {
      subjectNodeId: subject.id,
      predicate: 'CREATED_BY',
      objectNodeId: object.id,
      status: 'validated',
    });
    const { row: support } = await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: evidence.row.id,
      derivation: 'primary',
      sourceFamilyKey: family,
    });
    expect(support).not.toBeNull();

    // Pin the exact evidence version (id + source revision) in a proof.
    const account = await insertAccount(db);
    const { rows: itemRows } = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
       VALUES ($1, 'film', 'watch', $2, 'A card') RETURNING id`,
      [account.accountId, `qloo:${randomUUID()}`],
    );
    const run = await createGraphRun(db, {
      ownerAccountId: account.accountId,
      runKind: 'expansion',
      policyVersion: 'graph-policy-1',
    });
    const rec = await insertGraphRecommendation(db, {
      ownerAccountId: account.accountId,
      runId: run.id,
      discoveryItemId: itemRows[0]!.id,
      origin: 'catalog',
      title: 'A graph-backed card',
    });
    const pinnedVersion = (await loadEvidenceVersions(db, [evidence.row.id])).get(evidence.row.id)!;
    expect(pinnedVersion.revision).toBe(revision.revision);
    const proof = await insertRecommendationProof(db, {
      ownerAccountId: account.accountId,
      recommendationId: rec.id,
      graphRunId: run.id,
      intent: 'personal',
      reasonTemplate: 'created_by',
      assertions: [{ id: assertion.row.id, revision: assertion.row.revision }],
      evidence: [{ id: evidence.row.id, revision: pinnedVersion.revision }],
    });

    // The research refresh destructively replaces the reference's claims.
    const researchUrl = `https://en.wikipedia.org/wiki/${randomUUID()}`;
    await storeResearch(
      db,
      referenceId,
      [
        {
          url: researchUrl,
          title: 'A Test Work',
          publisher: 'Wikipedia',
          retrieved_at: new Date('2026-10-28T00:00:00Z').toISOString(),
          extract: 'A Test Work is a painting by A Test Creator.',
          license: 'CC BY-SA 4.0',
        },
      ],
      {
        overview: 'A Test Work is a painting.',
        sections: [{ heading: 'Overview', body: 'A Test Work is a painting by A Test Creator.', claim_indexes: [0] }],
        claims: [{ text: 'A Test Work is a painting by A Test Creator.', claim_type: 'factual', source_urls: [researchUrl] }],
      },
    );

    // Claims were really replaced (new revision, new rows)...
    const { rows: claimRows } = await db.query<{ n: number; revision: number }>(
      'SELECT COUNT(*)::int AS n, MAX(revision)::int AS revision FROM claims WHERE reference_id = $1',
      [referenceId],
    );
    expect(claimRows[0]!.n).toBe(1);
    expect(claimRows[0]!.revision).toBe(2);

    // ...but the evidence, its source revision, the identity link and the
    // pinned proof pairs are exactly what they were.
    const afterRefresh = await loadEvidenceVersions(db, [evidence.row.id]);
    expect(afterRefresh.get(evidence.row.id)!.revision).toBe(pinnedVersion.revision);
    expect(afterRefresh.get(evidence.row.id)!.permittedExcerpt).toBe('A Test Creator (Test, 1900-1901)');
    const cards = await loadGraphRunCards(db, { accountId: account.accountId });
    const reread = cards.proofs.find((p) => p.id === proof.id)!;
    expect(reread.evidence_ids).toEqual([evidence.row.id]);
    expect(reread.evidence_revisions).toEqual([pinnedVersion.revision]);
    const { rows: linkRows } = await db.query<{ cultural_reference_id: string | null }>(
      'SELECT cultural_reference_id FROM graph_nodes WHERE id = $1',
      [subject.id],
    );
    expect(linkRows[0]!.cultural_reference_id).toBe(referenceId);

    // Re-crawl the same source document (new revision) and re-extract the
    // fact: the replacement is a NEW evidence row, the old proof never moves,
    // and the family still counts as a single independent support.
    const recrawl = await recordSourceRevision(db, {
      provider: 'artic_open_access',
      url: sourceUrl,
      title: 'A Test Record',
      publisher: 'A Museum',
      attribution: 'A Museum',
      license: 'CC0 1.0',
      sourceFamilyKey: family,
      allowedDisplayMetadata: { provider: 'artic_open_access', title: 'A Test Record', publisher: 'A Museum', license: 'CC0 1.0' },
      retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
      rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
      documentHash: contentHash({ content: 'second crawl' }),
    });
    expect(recrawl.revision).toBe(revision.revision + 1);
    const replacement = await insertEvidence(db, {
      sourceRevisionId: recrawl.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'A Test Creator (Test, 1900-1902)',
      structuredValue: { artist_display: 'A Test Creator (Test, 1900-1902)' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-2',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: replacement.row.id,
      derivation: 'refresh',
      sourceFamilyKey: family,
    });

    const supportSummary = await distinctAssertionSupport(db, assertion.row.id);
    expect(supportSummary.independentFamilies).toBe(1);
    expect(supportSummary.supportRows).toBe(2);

    const cardsAfter = await loadGraphRunCards(db, { accountId: account.accountId });
    const pinnedAfter = cardsAfter.proofs.find((p) => p.id === proof.id)!;
    expect(pinnedAfter.evidence_ids).toEqual([evidence.row.id]);
    expect(pinnedAfter.evidence_revisions).toEqual([pinnedVersion.revision]);

    const replacementVersion = (await loadEvidenceVersions(db, [replacement.row.id])).get(replacement.row.id)!;
    expect(replacementVersion.revision).toBe(recrawl.revision);
    const { rows: assertionRows } = await db.query<{ revision: number }>('SELECT revision FROM graph_assertions WHERE id = $1', [
      assertion.row.id,
    ]);
    const newProof = await insertRecommendationProof(db, {
      ownerAccountId: account.accountId,
      recommendationId: rec.id,
      graphRunId: run.id,
      intent: 'personal',
      reasonTemplate: 'created_by',
      assertions: [{ id: assertion.row.id, revision: assertionRows[0]!.revision }],
      evidence: [{ id: replacement.row.id, revision: replacementVersion.revision }],
    });
    expect(newProof.evidence_revisions).toEqual([recrawl.revision]);
    expect(newProof.proof_version).toBe(proof.proof_version + 1);
  });
});

describe('Qloo remains transient under existing authorized semantics (VAL-EVID-005)', () => {
  it('persists only trace fields from Qloo responses and no Qloo rows in the evidence corpus', async () => {
    const entity = {
      entity_id: 'urn:entity:artist:1',
      name: 'A Test Artist',
      types: ['urn:entity:artist'],
      properties: { image: 'https://images.qloo.example/x.jpg', description: 'A long provider description', release_year: 1970 },
      tags: [{ id: 'urn:tag:genre:blues', name: 'Blues', type: 'urn:tag:genre' }],
      query: { affinity: 0.42 },
    };
    const session = new QlooSession(new FakeQloo({ insights: () => ({ entities: [entity], tags: [] }) }), {
      maxRequests: 2,
      maxRetries: 0,
      newId: randomUUID,
      clientMaxRetries: 0,
    });
    await session.insights({ filterType: 'urn:entity:artist', signalEntities: ['urn:entity:artist:1'], take: 5 }, { test: true });
    expect(session.recorded).toHaveLength(1);
    const recorded = session.recorded[0]!;

    // Persist through the real provider-query path (analysis parent).
    const account = await insertAccount(db);
    const { rows: captureRows } = await db.query<{ id: string }>(
      `INSERT INTO captures (owner_account_id, source, image_sha256) VALUES ($1, 'upload', $2) RETURNING id`,
      [account.accountId, randomUUID()],
    );
    const { rows: analysisRows } = await db.query<{ id: string }>(
      'INSERT INTO analyses (capture_id, version, compiler_version) VALUES ($1, 1, $2) RETURNING id',
      [captureRows[0]!.id, 'test'],
    );
    await recordProviderQuery(db, {
      parent: { analysisId: analysisRows[0]!.id },
      provider: 'qloo',
      operation: 'insights',
      request: recorded.sanitized_request,
      results: recorded.results,
      status: recorded.status,
      queryContext: recorded.query_context,
    });

    const { rows: persisted } = await db.query<{ results: { entities?: Record<string, unknown>[] } }>(
      "SELECT results FROM provider_queries WHERE provider = 'qloo' ORDER BY retrieved_at DESC LIMIT 1",
    );
    const entities = persisted[0]!.results.entities ?? [];
    expect(entities).toHaveLength(1);
    const stored = entities[0]!;
    // Transient trace fields only: rank, id, name, types, affinity. No raw
    // provider payload (properties, imagery, descriptions) is persisted.
    expect(Object.keys(stored).sort()).toEqual(['affinity', 'entity_id', 'explainability', 'name', 'rank', 'types'].sort());
    expect(stored.entity_id).toBe('urn:entity:artist:1');
    expect(JSON.stringify(persisted[0]!.results)).not.toContain('images.qloo.example');
    expect(JSON.stringify(persisted[0]!.results)).not.toContain('A long provider description');

    // Nothing from Qloo reached the evidence corpus storage.
    const { rows: providerRows } = await db.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM graph_source_revisions WHERE allowed_display_metadata->>'provider' = 'qloo'",
    );
    expect(providerRows[0]!.n).toBe(0);
  });
});
