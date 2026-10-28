import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../db/pool';
import { closeTestDb, getTestDb } from '../testing';
import type { GraphNodeDomain, GraphNodeKind } from './schema';
import {
  attachAssertionSupport,
  distinctAssertionSupport,
  contentHash,
  insertEvidence,
  loadEvidenceVersions,
  mapGraphExternalId,
  providerRightsPolicy,
  recordSourceRevision,
  requireDurableStoragePolicy,
  upsertGraphAssertion,
  upsertGraphIdentity,
} from './evidence';

/**
 * VAL-EVID-001 / VAL-EVID-003 contracts: reviewed evidence admission keeps
 * canonical identity, immutable source revisions and append-only evidence rows
 * whose revision is exactly the source revision a pinned proof recorded, and
 * mirrors/repeated extraction of one source family never count as independent
 * cultural support.
 */

const db = getTestDb();
afterAll(closeTestDb);

// --- Fixtures -----------------------------------------------------------------

async function identity(dbh: Queryable, over: { key?: string; name?: string; kind?: string; domain?: string; sense?: string } = {}) {
  const key = over.key ?? `atlas:${randomUUID()}`;
  return upsertGraphIdentity(dbh, {
    canonicalKey: key,
    canonicalName: over.name ?? `Identity ${key.slice(-8)}`,
    nodeKind: (over.kind ?? 'creator') as GraphNodeKind,
    domain: (over.domain ?? 'art') as GraphNodeDomain,
    senseKey: over.sense ?? 'person',
  });
}

async function source(dbh: Queryable, over: { family?: string; url?: string; hash?: string } = {}) {
  const url = over.url ?? `https://example.org/${randomUUID()}`;
  const family = over.family ?? `family:${randomUUID()}`;
  const recorded = await recordSourceRevision(dbh, {
    provider: 'artic_open_access',
    url,
    title: 'A reviewed collection record',
    publisher: 'A museum',
    attribution: 'A museum',
    license: 'CC0 1.0',
    sourceFamilyKey: family,
    allowedDisplayMetadata: { provider: 'artic_open_access', title: 'A reviewed collection record', publisher: 'A museum', license: 'CC0 1.0' },
    retentionPolicy: { content: 'permitted metadata fields only', basis: 'CC0' },
    rights: { license: 'CC0 1.0', permitted_use: ['storage', 'display'], expiry: 'none', basis: 'museum open access policy' },
    documentHash: over.hash ?? contentHash({ url, arbitrary: randomUUID() }),
  });
  return { ...recorded, familyKey: family };
}

// --- Canonical identity and provider mapping -----------------------------------------------

describe('graph identity mapping', () => {
  it('is idempotent per canonical key and refuses silent redefinition', async () => {
    const first = await identity(db, { key: `atlas:work:${randomUUID()}`, name: 'A Work', kind: 'work', domain: 'art', sense: 'painting' });
    const again = await upsertGraphIdentity(db, {
      canonicalKey: first.canonical_key,
      canonicalName: 'A Work',
      nodeKind: 'work',
      domain: 'art',
      senseKey: 'painting',
    });
    expect(again.id).toBe(first.id);
    expect(again.revision).toBe(first.revision);

    // Same canonical key, different identity fields: never a silent merge.
    await expect(
      upsertGraphIdentity(db, {
        canonicalKey: first.canonical_key,
        canonicalName: 'A Work',
        nodeKind: 'work',
        domain: 'sculpture',
        senseKey: 'painting',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects a second canonical key claiming an existing identity (name+kind+domain+sense)', async () => {
    const name = `Same Name ${randomUUID().slice(0, 8)}`;
    const first = await identity(db, { key: `atlas:work:${randomUUID()}`, name, kind: 'work', domain: 'art', sense: 'painting' });
    // A different key cannot claim the same name/kind/domain/sense identity.
    await expect(
      upsertGraphIdentity(db, {
        canonicalKey: `atlas:work:${randomUUID()}`,
        canonicalName: name,
        nodeKind: 'work',
        domain: 'art',
        senseKey: 'painting',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    // The same spelling in a different domain is a DIFFERENT identity: the
    // name alone never dedupes (kind/domain/sense distinguish it).
    const other = await identity(db, { key: `atlas:work:${randomUUID()}`, name, kind: 'work', domain: 'sculpture', sense: 'bust' });
    expect(other.id).not.toBe(first.id);
  });

  it('rejects a provider id mapped to a second identity and upgrades proposals on the same node', async () => {
    const a = await identity(db);
    const b = await identity(db);
    const externalId = `Q${Math.floor(Math.random() * 1000000)}`;
    await mapGraphExternalId(db, { nodeId: a.id, provider: 'wikidata', externalId, provenance: 'review 2026-10-28' });
    await expect(
      mapGraphExternalId(db, { nodeId: b.id, provider: 'wikidata', externalId, provenance: 'review 2026-10-28' }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // A proposed mapping on the same node is idempotent and reviewable.
    const proposed = `Q${Math.floor(Math.random() * 1000000)}`;
    await mapGraphExternalId(db, { nodeId: a.id, provider: 'wikidata', externalId: proposed, matchStatus: 'proposed', provenance: 'machine proposal' });
    await mapGraphExternalId(db, { nodeId: a.id, provider: 'wikidata', externalId: proposed, matchStatus: 'confirmed', provenance: 'review 2026-10-28' });
    const { rows } = await db.query<{ match_status: string }>(
      'SELECT match_status FROM graph_external_ids WHERE node_id = $1 AND external_id = $2',
      [a.id, proposed],
    );
    expect(rows[0]?.match_status).toBe('confirmed');
  });
});

// --- Durable source revisions and append-only evidence -------------------------------------

describe('source revisions and evidence', () => {
  it('reuses the revision for identical content and versions the next crawl', async () => {
    const url = `https://example.org/${randomUUID()}`;
    const hash = contentHash({ url, title: 'same content' });
    const first = await source(db, { url, hash });
    expect(first.isNew).toBe(true);
    expect(first.revision).toBe(1);

    const replay = await source(db, { url, hash });
    expect(replay.isNew).toBe(false);
    expect(replay.sourceRevisionId).toBe(first.sourceRevisionId);
    expect(replay.revision).toBe(1);

    const recrawl = await source(db, { url, hash: contentHash({ url, title: 'changed content' }) });
    expect(recrawl.isNew).toBe(true);
    expect(recrawl.revision).toBe(2);
    expect(recrawl.sourceRevisionId).not.toBe(first.sourceRevisionId);
  });

  it('keeps evidence append-only: identical content reuses the row, new content is a new row', async () => {
    const rev = await source(db);
    const inserted = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'A permitted short excerpt.',
      structuredValue: { title: 'A Work' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    expect(inserted.isNew).toBe(true);
    expect(inserted.revision).toBe(rev.revision);

    const replay = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'A permitted short excerpt.',
      structuredValue: { title: 'A Work' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    expect(replay.isNew).toBe(false);
    expect(replay.row.id).toBe(inserted.row.id);

    const corrected = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'A corrected permitted excerpt.',
      structuredValue: { title: 'A Work' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    expect(corrected.isNew).toBe(true);
    expect(corrected.row.id).not.toBe(inserted.row.id);
    // The original row still exists with its original content.
    expect(corrected.row.permitted_excerpt).toBe('A corrected permitted excerpt.');
  });

  it('stores review provenance on reviewed evidence and allows unreviewed proposals without it', async () => {
    const rev = await source(db);
    const reviewed = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      permittedExcerpt: 'Reviewed excerpt.',
      validationMethod: 'curated_passage',
      validationVersion: 'manual-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    expect(reviewed.row.reviewed_by).toBe('corpus review');
    expect(reviewed.row.reviewed_at).toEqual(new Date('2026-10-28T00:00:00Z'));

    const proposal = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      permittedExcerpt: 'Unreviewed machine extraction.',
      validationMethod: 'machine_extraction',
      validationVersion: 'model-1',
      evidenceKind: 'fact',
    });
    expect(proposal.row.reviewed_by).toBeNull();
    expect(proposal.row.reviewed_at).toBeNull();

    // A half review (reviewer without a date or vice versa) is invalid.
    await expect(
      db.query(
        `INSERT INTO graph_evidence (source_revision_id, permitted_excerpt, validation_method, validation_version, evidence_kind, reviewed_by)
         VALUES ($1, $2, 'curated_passage', 'manual-1', 'fact', 'corpus review')`,
        [rev.sourceRevisionId, 'Half reviewed.'],
      ),
    ).rejects.toThrow(/review_pair/i);
  });

  it('rejects in-place replacement of evidence or source revision content', async () => {
    const rev = await source(db);
    const ev = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      permittedExcerpt: 'Original excerpt.',
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });

    // Evidence content is immutable: replacement is a NEW row, never a rewrite.
    await expect(
      db.query('UPDATE graph_evidence SET permitted_excerpt = $2 WHERE id = $1', [ev.row.id, 'Rewritten excerpt.']),
    ).rejects.toThrow(/immutable/i);
    await expect(
      db.query('UPDATE graph_evidence SET structured_value = $2::jsonb WHERE id = $1', [ev.row.id, JSON.stringify({ changed: true })]),
    ).rejects.toThrow(/immutable/i);
    // A no-op update (same values) stays allowed for generic tooling.
    await expect(
      db.query('UPDATE graph_evidence SET permitted_excerpt = $2 WHERE id = $1', [ev.row.id, 'Original excerpt.']),
    ).resolves.toBeTruthy();

    // Source revision content is immutable the same way.
    await expect(
      db.query('UPDATE graph_source_revisions SET rights = $2::jsonb WHERE id = $1', [
        rev.sourceRevisionId,
        JSON.stringify({ license: 'rewritten' }),
      ]),
    ).rejects.toThrow(/immutable/i);
    const { rows } = await db.query<{ rights: { license?: string } }>('SELECT rights FROM graph_source_revisions WHERE id = $1', [
      rev.sourceRevisionId,
    ]);
    expect(rows[0]?.rights.license).toBe('CC0 1.0');
  });
});

// --- Assertions and source-family dedupe (VAL-EVID-003) ------------------------------------

describe('assertion support and family dedupe', () => {
  async function assertionWithFamily(dbh: Queryable) {
    const subject = await identity(dbh, { kind: 'work' });
    const object = await identity(dbh);
    const upserted = await upsertGraphAssertion(dbh, {
      subjectNodeId: subject.id,
      predicate: 'CREATED_BY',
      objectNodeId: object.id,
      status: 'validated',
    });
    return { subject, object, assertion: upserted };
  }

  it('counts mirrors, refreshes and reextractions of one family as a single support', async () => {
    const { assertion } = await assertionWithFamily(db);
    const family = `artic:${randomUUID()}`;
    const revA = await source(db, { family });
    const primary = await insertEvidence(db, {
      sourceRevisionId: revA.sourceRevisionId,
      permittedExcerpt: 'Primary page excerpt.',
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });

    const first = await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: primary.row.id,
      derivation: 'primary',
      sourceFamilyKey: family,
    });
    expect(first.revisionBumped).toBe(true);

    // A mirror of the same document family, then a refreshed crawl of it, then
    // a repeated extraction: four support rows, ONE independent support.
    const mirrorRev = await source(db, { family, url: `https://api.example.org/${randomUUID()}` });
    const mirror = await insertEvidence(db, {
      sourceRevisionId: mirrorRev.sourceRevisionId,
      permittedExcerpt: 'Mirror of the same record.',
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: mirror.row.id,
      derivation: 'mirror',
      sourceFamilyKey: family,
    });

    const refreshHash = contentHash({ recrawl: randomUUID() });
    const refreshed = await source(db, { family, hash: refreshHash });
    const refresh = await insertEvidence(db, {
      sourceRevisionId: refreshed.sourceRevisionId,
      permittedExcerpt: 'Refreshed record excerpt.',
      validationMethod: 'provider_metadata',
      validationVersion: 'source-2',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: refresh.row.id,
      derivation: 'refresh',
      sourceFamilyKey: family,
    });

    const reextraction = await insertEvidence(db, {
      sourceRevisionId: revA.sourceRevisionId,
      locator: 'medium_display',
      permittedExcerpt: 'Re-extracted passage of the same record.',
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: reextraction.row.id,
      derivation: 'reextraction',
      sourceFamilyKey: family,
    });

    let summary = await distinctAssertionSupport(db, assertion.row.id);
    expect(summary.supportRows).toBe(4);
    expect(summary.independentFamilies).toBe(1);
    expect(summary.distinct).toHaveLength(1);
    expect(summary.distinct[0]).toMatchObject({ sourceFamilyKey: family, role: 'supports' });
    expect(new Set(summary.distinct[0]!.derivations)).toEqual(new Set(['primary', 'mirror', 'refresh', 'reextraction']));

    // An independent source family adds one more independent support — and
    // only one, no matter how it was derived.
    const otherFamily = `wikipedia:${randomUUID()}`;
    const revB = await source(db, { family: otherFamily });
    const independent = await insertEvidence(db, {
      sourceRevisionId: revB.sourceRevisionId,
      permittedExcerpt: 'Independent source excerpt.',
      validationMethod: 'curated_passage',
      validationVersion: 'manual-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: independent.row.id,
      derivation: 'primary',
      sourceFamilyKey: otherFamily,
    });
    const independentMirrorRev = await source(db, { family: otherFamily, url: `https://mirror.example.org/${randomUUID()}` });
    const independentMirror = await insertEvidence(db, {
      sourceRevisionId: independentMirrorRev.sourceRevisionId,
      permittedExcerpt: 'Independent source mirror.',
      validationMethod: 'curated_passage',
      validationVersion: 'manual-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: independentMirror.row.id,
      derivation: 'mirror',
      sourceFamilyKey: otherFamily,
    });

    summary = await distinctAssertionSupport(db, assertion.row.id);
    expect(summary.supportRows).toBe(6);
    expect(summary.independentFamilies).toBe(2);
    expect(summary.distinct.map((d) => d.sourceFamilyKey)).toEqual([family, otherFamily].sort());
    expect(summary.distinct[0]!.evidenceIds).toEqual([primary.row.id, mirror.row.id, refresh.row.id, reextraction.row.id].sort());

    // Replaying an existing attachment adds no row, no revision and no family.
    const beforeRevision = summary;
    const replay = await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: primary.row.id,
      derivation: 'primary',
      sourceFamilyKey: family,
    });
    expect(replay.row).toBeNull();
    expect(replay.revisionBumped).toBe(false);
    const after = await distinctAssertionSupport(db, assertion.row.id);
    expect(after.independentFamilies).toBe(beforeRevision.independentFamilies);
    expect(after.supportRows).toBe(beforeRevision.supportRows);

    // A refuting family is tracked separately and never corroborates.
    const refutingFamily = `family:${randomUUID()}`;
    const refutingRev = await source(db, { family: refutingFamily });
    const refuting = await insertEvidence(db, {
      sourceRevisionId: refutingRev.sourceRevisionId,
      permittedExcerpt: 'A refuting passage.',
      validationMethod: 'curated_passage',
      validationVersion: 'manual-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    await attachAssertionSupport(db, {
      assertionId: assertion.row.id,
      evidenceId: refuting.row.id,
      role: 'refutes',
      derivation: 'primary',
      sourceFamilyKey: refutingFamily,
    });
    const refuted = await distinctAssertionSupport(db, assertion.row.id);
    expect(refuted.independentFamilies).toBe(2);
    expect(refuted.refutingFamilies).toBe(1);
    expect(refuted.distinct.find((d) => d.role === 'refutes')).toMatchObject({ sourceFamilyKey: refutingFamily });
  });

  it('bumps the assertion revision only on newly attached evidence and validates proposals without rewriting retractions', async () => {
    const subject = await identity(db, { kind: 'work' });
    const object = await identity(db);
    const proposed = await upsertGraphAssertion(db, {
      subjectNodeId: subject.id,
      predicate: 'ABOUT',
      objectNodeId: object.id,
      status: 'proposed',
    });
    expect(proposed.row.status).toBe('proposed');

    const validated = await upsertGraphAssertion(db, {
      subjectNodeId: subject.id,
      predicate: 'ABOUT',
      objectNodeId: object.id,
      status: 'validated',
    });
    expect(validated.row.status).toBe('validated');
    expect(validated.row.revision).toBe(proposed.row.revision + 1);

    // A proposed replay never downgrades a validated assertion.
    const replay = await upsertGraphAssertion(db, {
      subjectNodeId: subject.id,
      predicate: 'ABOUT',
      objectNodeId: object.id,
      status: 'proposed',
    });
    expect(replay.row.status).toBe('validated');

    // A retracted assertion cannot be silently re-validated by corpus import.
    await db.query(
      `UPDATE graph_assertions SET status = 'retracted', invalidated_at = now(), revision = revision + 1 WHERE id = $1`,
      [validated.row.id],
    );
    await expect(
      upsertGraphAssertion(db, {
        subjectNodeId: subject.id,
        predicate: 'ABOUT',
        objectNodeId: object.id,
        status: 'validated',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('reports the exact evidence version (source revision) a proof can pin', async () => {
    const rev = await source(db);
    const ev = await insertEvidence(db, {
      sourceRevisionId: rev.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'Pinnable excerpt.',
      structuredValue: { artist_display: 'Pinnable excerpt.' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });

    const versions = await loadEvidenceVersions(db, [ev.row.id, randomUUID()]);
    expect(versions.size).toBe(1);
    const version = versions.get(ev.row.id)!;
    expect(version.revision).toBe(rev.revision);
    expect(version.sourceFamilyKey).toBe(rev.familyKey);
    expect(version.reviewedBy).toBe('corpus review');
    expect(version.permittedExcerpt).toBe('Pinnable excerpt.');

    // After a replaced source revision, the ORIGINAL evidence version still
    // reports its original revision — a pinned proof's pair never drifts.
    const recrawl = await source(db, { family: rev.familyKey, hash: contentHash({ changed: randomUUID() }) });
    const replacement = await insertEvidence(db, {
      sourceRevisionId: recrawl.sourceRevisionId,
      locator: 'artist_display',
      permittedExcerpt: 'Pinnable excerpt.',
      structuredValue: { artist_display: 'Pinnable excerpt.' },
      validationMethod: 'provider_metadata',
      validationVersion: 'source-1',
      evidenceKind: 'fact',
      reviewedBy: 'corpus review',
      reviewedAt: new Date('2026-10-28T00:00:00Z'),
    });
    expect(replacement.revision).toBe(recrawl.revision);
    const after = await loadEvidenceVersions(db, [ev.row.id, replacement.row.id]);
    expect(after.get(ev.row.id)!.revision).toBe(rev.revision);
    expect(after.get(replacement.row.id)!.revision).toBe(recrawl.revision);
  });
});

// --- Provider rights policy (VAL-EVID-005) ---------------------------------------------------

describe('provider rights policy', () => {
  it('records Qloo as transient with honestly unresolved rights', async () => {
    const qloo = await providerRightsPolicy(db, 'qloo');
    expect(qloo).not.toBeNull();
    expect(qloo!.response_retention).toBe('transient_only');
    expect(qloo!.public_display).toBe('owned_or_cleared_only');
    expect(qloo!.rights_documented).toBe(false);
    expect(qloo!.unresolved_notes).toMatch(/retention/i);

    // Documented public-source providers permit durable reviewed storage.
    for (const provider of ['wikipedia', 'wikidata', 'artic_open_access']) {
      const policy = await requireDurableStoragePolicy(db, provider);
      expect(policy.response_retention).toBe('permitted_documented');
      expect(policy.rights_documented).toBe(true);
    }
  });

  it('fail-closes durable evidence admission for transient or unknown providers', async () => {
    await expect(requireDurableStoragePolicy(db, 'qloo')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(requireDurableStoragePolicy(db, `unknown-${randomUUID()}`)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
