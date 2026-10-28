import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrate';
import { closeTestDb, createIsolatedDatabase, getTestDb, insertAccount, insertAnonymousSession } from '../testing';
import type { Queryable } from '../db/pool';

/**
 * PR 8 package A contract tests (VAL-PROJ-001): the graph migrations apply on
 * PostgreSQL 17, canonical identities distinguish kind/domain/sense and keep
 * provider mappings, database constraints reject cross-account private links
 * and invalid target/parent combinations, recommendations AND provider queries
 * accept a graph-run parent exclusively of their other parents, and existing
 * origins/rows stay intact.
 */

const db = getTestDb();
afterAll(closeTestDb);

const GRAPH_MIGRATIONS = [
  '210_graph_nodes_and_external_ids.sql',
  '220_graph_evidence_and_assertions.sql',
  '230_personal_graph_state.sql',
  '240_graph_runs_frontier_proofs_outbox.sql',
  '250_graph_flags.sql',
  '260_graph_projector_backfill.sql',
  '270_shared_save_graph_support.sql',
  '280_owner_bound_graph_dependencies.sql',
  '290_projection_support_version.sql',
];

// --- Fixtures -----------------------------------------------------------------

async function accountItem(dbh: Queryable, accountId: string, key = randomUUID()): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO discovery_items (owner_account_id, kind, category, canonical_key, title)
     VALUES ($1, 'film', 'watch', $2, 'A film') RETURNING id`,
    [accountId, `qloo:${key}`],
  );
  return rows[0]!.id;
}

async function node(
  dbh: Queryable,
  over: { nameKey?: string; name?: string; kind?: string; domain?: string; sense?: string } = {},
): Promise<string> {
  const name = over.name ?? over.nameKey ?? randomUUID();
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO graph_nodes (canonical_key, canonical_name, name_key, node_kind, domain, sense_key)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      `atlas:${randomUUID()}`,
      name,
      (over.nameKey ?? name).toLowerCase(),
      over.kind ?? 'creator',
      over.domain ?? 'art',
      over.sense ?? 'person',
    ],
  );
  return rows[0]!.id;
}

async function sourceRevision(dbh: Queryable): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO sources (url) VALUES ($1) RETURNING id`,
    [`https://example.org/${randomUUID()}`],
  );
  const sourceId = rows[0]!.id;
  const rev = await dbh.query<{ id: string }>(
    `INSERT INTO graph_source_revisions (source_id, url, revision, source_family_key)
     VALUES ($1, $2, 1, $3) RETURNING id`,
    [sourceId, `https://example.org/${randomUUID()}`, `family:${randomUUID()}`],
  );
  return rev.rows[0]!.id;
}

async function evidence(dbh: Queryable, sourceRevisionId: string, kind = 'fact'): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO graph_evidence (source_revision_id, permitted_excerpt, validation_method,
                                  validation_version, evidence_kind)
     VALUES ($1, $2, 'curated_passage', 'manual-1', $3) RETURNING id`,
    [sourceRevisionId, 'A permitted short excerpt.', kind],
  );
  return rows[0]!.id;
}

async function capture(dbh: Queryable, accountId: string): Promise<{ captureId: string; analysisId: string }> {
  const c = await dbh.query<{ id: string }>(
    `INSERT INTO captures (owner_account_id, source, image_sha256) VALUES ($1, 'upload', $2) RETURNING id`,
    [accountId, randomUUID()],
  );
  const a = await dbh.query<{ id: string }>(
    `INSERT INTO analyses (capture_id, version, compiler_version) VALUES ($1, 1, 'test') RETURNING id`,
    [c.rows[0]!.id],
  );
  return { captureId: c.rows[0]!.id, analysisId: a.rows[0]!.id };
}

async function pick(dbh: Queryable, accountId: string): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO onboarding_picks (account_id, source, choice_key, catalog_item_id, label, item_kind)
     VALUES ($1, 'catalog', $2, $3, 'A pick', 'film') RETURNING id`,
    [accountId, `catalog:${randomUUID()}`, `item-${randomUUID().slice(0, 8)}`],
  );
  return rows[0]!.id;
}

async function run(dbh: Queryable, accountId: string, kind = 'expansion'): Promise<string> {
  const { rows } = await dbh.query<{ id: string }>(
    `INSERT INTO graph_runs (owner_account_id, run_kind, policy_version)
     VALUES ($1, $2, 'graph-policy-1') RETURNING id`,
    [accountId, kind],
  );
  return rows[0]!.id;
}

// --- Migrations -----------------------------------------------------------------

describe('graph migrations', () => {
  it('apply on this PostgreSQL server and reapply idempotently', async () => {
    const iso = await createIsolatedDatabase({ migrate: false, prefix: 'ca_graphmig' });
    try {
      const { rows } = await iso.db.query<{ version_num: string }>(
        'SELECT current_setting($1) AS version_num',
        ['server_version_num'],
      );
      expect(Number(rows[0]!.version_num)).toBeGreaterThanOrEqual(170000);
      const first = await runMigrations(iso.url);
      for (const file of GRAPH_MIGRATIONS) expect(first.applied).toContain(file);
      const again = await runMigrations(iso.url);
      expect(again.applied).toEqual([]);
      expect(again.skipped).toEqual(expect.arrayContaining(GRAPH_MIGRATIONS));
      expect(again.reconciled).toEqual([]);
    } finally {
      await iso.drop();
    }
  });
});

// --- Canonical identities ---------------------------------------------------------

describe('graph canonical identities', () => {
  it('distinguishes same-name identities by kind, domain and sense', async () => {
    const nameKey = `mercury-${randomUUID()}`;
    const same = { nameKey, name: 'Mercury', sense: 'element' };
    await node(db, { ...same, kind: 'object', domain: 'art' });
    // Same name in a different domain/sense is a distinct identity.
    await node(db, { ...same, kind: 'object', domain: 'music', sense: 'mythology' });
    // Same spelling, same kind/domain/sense is the same identity: rejected.
    await expect(node(db, { ...same, kind: 'object', domain: 'art' })).rejects.toThrow(/unique/i);
  });

  it('keeps provider mappings unique per provider id, with proposals for ambiguity', async () => {
    const a = await node(db);
    const b = await node(db);
    const externalId = `qloo:${randomUUID()}`;
    await db.query(
      `INSERT INTO graph_external_ids (node_id, provider, external_id, match_status, provenance)
       VALUES ($1, 'qloo', $2, 'confirmed', 'seed corpus')`,
      [a, externalId],
    );
    // The same provider id cannot map to a second identity.
    await expect(
      db.query(
        `INSERT INTO graph_external_ids (node_id, provider, external_id, match_status)
         VALUES ($1, 'qloo', $2, 'proposed')`,
        [b, externalId],
      ),
    ).rejects.toThrow(/unique/i);
    // An ambiguous mapping to the same node stays a proposal, not an identity.
    const other = `qloo:${randomUUID()}`;
    await db.query(
      `INSERT INTO graph_external_ids (node_id, provider, external_id, match_status)
       VALUES ($1, 'qloo', $2, 'ambiguous')`,
      [a, other],
    );
  });

  it('keys aliases per node by normalized text', async () => {
    const a = await node(db);
    await db.query('INSERT INTO graph_node_aliases (node_id, alias, alias_key) VALUES ($1, $2, $3)', [
      a,
      'Vincent Willem van Gogh',
      'vincent willem van gogh',
    ]);
    await expect(
      db.query('INSERT INTO graph_node_aliases (node_id, alias, alias_key) VALUES ($1, $2, $3)', [
        a,
        'Van Gogh',
        'vincent willem van gogh',
      ]),
    ).rejects.toThrow(/unique/i);
  });
});

// --- Evidence and assertions --------------------------------------------------------

describe('graph evidence contracts', () => {
  it('keeps durable source revisions keyed by source and revision', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO sources (url) VALUES ($1) RETURNING id`,
      [`https://example.org/${randomUUID()}`],
    );
    const sourceId = rows[0]!.id;
    await db.query(
      `INSERT INTO graph_source_revisions (source_id, url, revision, source_family_key) VALUES ($1, $2, 1, 'fam')`,
      [sourceId, 'https://example.org/a'],
    );
    await expect(
      db.query(
        `INSERT INTO graph_source_revisions (source_id, url, revision, source_family_key) VALUES ($1, $2, 1, 'fam')`,
        [sourceId, 'https://example.org/a'],
      ),
    ).rejects.toThrow(/unique/i);
    // The next revision of the same document is a new durable row.
    await db.query(
      `INSERT INTO graph_source_revisions (source_id, url, revision, source_family_key) VALUES ($1, $2, 2, 'fam')`,
      [sourceId, 'https://example.org/a'],
    );
  });

  it('requires permitted excerpt or structured value in evidence', async () => {
    const revId = await sourceRevision(db);
    await expect(
      db.query(
        `INSERT INTO graph_evidence (source_revision_id, validation_method, validation_version, evidence_kind)
         VALUES ($1, 'curated_passage', 'manual-1', 'fact')`,
        [revId],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('rejects self-assertions, untyped associations and private visual predicates', async () => {
    const subject = await node(db);
    const object = await node(db);
    await expect(
      db.query(
        `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id)
         VALUES ($1, 'CREATED_BY', $1)`,
        [subject],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id)
         VALUES ($1, 'DOCUMENTED_ASSOCIATION', $2)`,
        [subject, object],
      ),
    ).rejects.toThrow(/check/i);
    // VISUALLY_RESEMBLES is a private interpretation, never a shared assertion.
    await expect(
      db.query(
        `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id)
         VALUES ($1, 'VISUALLY_RESEMBLES', $2)`,
        [subject, object],
      ),
    ).rejects.toThrow(/check/i);
    // Subtypes only exist on DOCUMENTED_ASSOCIATION.
    await expect(
      db.query(
        `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id, association_subtype)
         VALUES ($1, 'CREATED_BY', $2, 'member_of')`,
        [subject, object],
      ),
    ).rejects.toThrow(/check/i);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id, association_subtype, status)
       VALUES ($1, 'DOCUMENTED_ASSOCIATION', $2, 'studied_at', 'validated') RETURNING id`,
      [subject, object],
    );
    // One asserted relation per (subject, predicate, object, subtype).
    await expect(
      db.query(
        `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id, association_subtype)
         VALUES ($1, 'DOCUMENTED_ASSOCIATION', $2, 'studied_at')`,
        [subject, object],
      ),
    ).rejects.toThrow(/duplicate|unique/i);
    void rows;
  });

  it('makes assertion support unique per evidence and tracks its source family', async () => {
    const subject = await node(db);
    const object = await node(db);
    const revId = await sourceRevision(db);
    const evidenceId = await evidence(db, revId);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO graph_assertions (subject_node_id, predicate, object_node_id, status)
       VALUES ($1, 'CREATED_BY', $2, 'validated') RETURNING id`,
      [subject, object],
    );
    await db.query(
      `INSERT INTO graph_assertion_support (assertion_id, evidence_id, role, derivation, source_family_key)
       VALUES ($1, $2, 'supports', 'primary', 'fam:a')`,
      [rows[0]!.id, evidenceId],
    );
    await expect(
      db.query(
        `INSERT INTO graph_assertion_support (assertion_id, evidence_id, role, source_family_key)
         VALUES ($1, $2, 'refutes', 'fam:a')`,
        [rows[0]!.id, evidenceId],
      ),
    ).rejects.toThrow(/unique/i);
    // Refutation is a first-class role from other evidence.
    const refuting = await evidence(db, await sourceRevision(db), 'subject_matter');
    await db.query(
      `INSERT INTO graph_assertion_support (assertion_id, evidence_id, role, source_family_key)
       VALUES ($1, $2, 'refutes', 'fam:b')`,
      [rows[0]!.id, refuting],
    );
  });
});

// --- Account-owned graph state -------------------------------------------------------

describe('account-owned graph state', () => {
  it('requires exactly one edge target form and confirms explicit edges', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const n = await node(db);
    const itemA = await accountItem(db, a.accountId);
    await expect(
      db.query(
        `INSERT INTO personal_interest_edges (owner_account_id, node_id, discovery_item_id, origin, policy_version)
         VALUES ($1, $2, $3, 'derived', 'graph-policy-1')`,
        [a.accountId, n, itemA],
      ),
    ).rejects.toThrow(/check/i);
    await expect(
      db.query(
        `INSERT INTO personal_interest_edges (owner_account_id, origin, policy_version)
         VALUES ($1, 'derived', 'graph-policy-1')`,
        [a.accountId],
      ),
    ).rejects.toThrow(/check/i);
    // An explicit edge is confirmed until withdrawn, never tentative.
    await expect(
      db.query(
        `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version)
         VALUES ($1, $2, 'explicit', 'tentative', 'graph-policy-1')`,
        [a.accountId, n],
      ),
    ).rejects.toThrow(/check/i);
    await db.query(
      `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version)
       VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1')`,
      [a.accountId, n],
    );
    void b;
  });

  it('rejects cross-account edge targets', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const itemB = await accountItem(db, b.accountId);
    await expect(
      db.query(
        `INSERT INTO personal_interest_edges (owner_account_id, discovery_item_id, origin, state, policy_version)
         VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1')`,
        [a.accountId, itemB],
      ),
    ).rejects.toThrow(/foreign key/i);
    // Same account works.
    const itemA = await accountItem(db, a.accountId);
    await db.query(
      `INSERT INTO personal_interest_edges (owner_account_id, discovery_item_id, origin, state, policy_version)
       VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1')`,
      [a.accountId, itemA],
    );
  });
  it('gives shared-row saves a private saved-item target without weakening owner foreign keys', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    // An ownerless shared catalog row, the way sample items are seeded.
    const { rows: shared } = await db.query<{ id: string }>(
      `INSERT INTO discovery_items (is_sample, kind, canonical_key, title)
       VALUES (true, 'film', $1, 'Shared sample') RETURNING id`,
      [`sample:${randomUUID()}`],
    );
    const sharedId = shared[0]!.id;
    const { rows: savedA } = await db.query<{ id: string }>(
      'INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id',
      [a.accountId, sharedId],
    );
    const { rows: savedB } = await db.query<{ id: string }>(
      'INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id',
      [b.accountId, sharedId],
    );
    // The account's own save of an ownerless row is a valid private target.
    const { rows: edgeA } = await db.query<{ id: string }>(
      `INSERT INTO personal_interest_edges (owner_account_id, saved_item_id, origin, state, policy_version)
       VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1') RETURNING id`,
      [a.accountId, savedA[0]!.id],
    );
    expect(edgeA[0]!.id).toBeTruthy();
    // Exactly one target form still holds: a saved-item edge cannot also
    // carry a node or discovery-item target.
    await expect(
      db.query(
        `INSERT INTO personal_interest_edges (owner_account_id, saved_item_id, node_id, origin, policy_version)
         VALUES ($1, $2, $3, 'derived', 'graph-policy-1')`,
        [a.accountId, savedA[0]!.id, await node(db)],
      ),
    ).rejects.toThrow(/check/i);
    // The composite FK is not weakened: one account cannot target another
    // account's save of the same shared row.
    await expect(
      db.query(
        `INSERT INTO personal_interest_edges (owner_account_id, saved_item_id, origin, state, policy_version)
         VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1')`,
        [a.accountId, savedB[0]!.id],
      ),
    ).rejects.toThrow(/foreign key/i);
    // Two accounts get independent private edges over the same shared row.
    await db.query(
      `INSERT INTO personal_interest_edges (owner_account_id, saved_item_id, origin, state, policy_version)
       VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1')`,
      [b.accountId, savedB[0]!.id],
    );
    // No owner is forged onto the shared row by any of this.
    const { rows: owner } = await db.query<{ owner_account_id: string | null }>(
      'SELECT owner_account_id FROM discovery_items WHERE id = $1',
      [sharedId],
    );
    expect(owner[0]!.owner_account_id).toBeNull();
  });

  it('rejects cross-account support sources through composite foreign keys', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const n = await node(db);
    const { rows: edges } = await db.query<{ id: string }>(
      `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version)
       VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1') RETURNING id`,
      [a.accountId, n],
    );
    const edgeId = edges[0]!.id;

    // Another account's edge cannot carry this account's support row.
    await expect(
      db.query(
        `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind)
         VALUES ($1, $2, 'saved_item')`,
        [b.accountId, edgeId],
      ),
    ).rejects.toThrow(/check|foreign key/i);

    // Another account's saved item is not support for this account's edge.
    const itemB = await accountItem(db, b.accountId);
    const { rows: savedB } = await db.query<{ id: string }>(
      'INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id',
      [b.accountId, itemB],
    );
    await expect(
      db.query(
        `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, saved_item_id)
         VALUES ($1, $2, 'saved_item', $3)`,
        [a.accountId, edgeId, savedB[0]!.id],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Another account's onboarding pick is not support either.
    const pickB = await pick(db, b.accountId);
    await expect(
      db.query(
        `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, pick_id)
         VALUES ($1, $2, 'pick_group', $3)`,
        [a.accountId, edgeId, pickB],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Another account's capture cannot back a capture_reference support row.
    const itemA = await accountItem(db, a.accountId);
    const { rows: savedA } = await db.query<{ id: string }>(
      'INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2) RETURNING id',
      [a.accountId, itemA],
    );
    const ref = await db.query<{ id: string }>(
      `INSERT INTO cultural_references (canonical_name, canonical_key, type) VALUES ($1, $2, 'work') RETURNING id`,
      ['A work', `work:${randomUUID()}`],
    );
    const capB = await capture(db, b.accountId);
    await db.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation) VALUES ($1, $2, 'depicted')`,
      [capB.analysisId, ref.rows[0]!.id],
    );
    const { rows: refsB } = await db.query<{ id: string }>(
      'SELECT id FROM capture_references WHERE analysis_id = $1 LIMIT 1',
      [capB.analysisId],
    );
    await expect(
      db.query(
        `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, capture_reference_id,
           analysis_id, capture_id)
         VALUES ($1, $2, 'capture_reference', $3, $4, $5)`,
        [a.accountId, edgeId, refsB[0]!.id, capB.analysisId, capB.captureId],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Same-account support of every kind is accepted.
    await db.query(
      `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, saved_item_id)
       VALUES ($1, $2, 'saved_item', $3)`,
      [a.accountId, edgeId, savedA[0]!.id],
    );
    const pickA = await pick(db, a.accountId);
    await db.query(
      `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, pick_id)
       VALUES ($1, $2, 'pick_group', $3)`,
      [a.accountId, edgeId, pickA],
    );
    const capA = await capture(db, a.accountId);
    await db.query(
      `INSERT INTO capture_references (analysis_id, reference_id, relation) VALUES ($1, $2, 'depicted')`,
      [capA.analysisId, ref.rows[0]!.id],
    );
    const { rows: refsA } = await db.query<{ id: string }>(
      'SELECT id FROM capture_references WHERE analysis_id = $1 LIMIT 1',
      [capA.analysisId],
    );
    await db.query(
      `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, capture_reference_id,
         analysis_id, capture_id)
       VALUES ($1, $2, 'capture_reference', $3, $4, $5)`,
      [a.accountId, edgeId, refsA[0]!.id, capA.analysisId, capA.captureId],
    );
    await db.query(
      `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, analysis_id, capture_id)
       VALUES ($1, $2, 'analysis', $3, $4)`,
      [a.accountId, edgeId, capA.analysisId, capA.captureId],
    );
  });

  it('keys suppression markers by owner and identity so they survive rebuilds', async () => {
    const a = await insertAccount(db);
    const n = await node(db);
    await db.query('INSERT INTO personal_edge_suppressions (owner_account_id, node_id, policy_version) VALUES ($1, $2, $3)', [
      a.accountId,
      n,
      'graph-policy-1',
    ]);
    await expect(
      db.query('INSERT INTO personal_edge_suppressions (owner_account_id, node_id, policy_version) VALUES ($1, $2, $3)', [
        a.accountId,
        n,
        'graph-policy-1',
      ]),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('binds private observation links to the owning capture', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const n = await node(db);
    const capB = await capture(db, b.accountId);
    await expect(
      db.query(
        `INSERT INTO graph_private_links (owner_account_id, capture_id, node_id, interpretation)
         VALUES ($1, $2, $3, 'ABOUT')`,
        [a.accountId, capB.captureId, n],
      ),
    ).rejects.toThrow(/foreign key/i);
    const capA = await capture(db, a.accountId);
    // A private visual interpretation requires the analysis it came from.
    await expect(
      db.query(
        `INSERT INTO graph_private_links (owner_account_id, capture_id, node_id, interpretation)
         VALUES ($1, $2, $3, 'VISUALLY_RESEMBLES')`,
        [a.accountId, capA.captureId, n],
      ),
    ).rejects.toThrow(/check/i);
    await db.query(
      `INSERT INTO graph_private_links (owner_account_id, capture_id, analysis_id, node_id, interpretation)
       VALUES ($1, $2, $3, $4, 'VISUALLY_RESEMBLES')`,
      [a.accountId, capA.captureId, capA.analysisId, n],
    );
  });

  it('keeps anonymous sessions out of account graph state', async () => {
    const s = await insertAnonymousSession(db);
    await expect(
      db.query(
        `INSERT INTO personal_graph_state (owner_account_id) VALUES ($1)`,
        [s.sessionId],
      ),
    ).rejects.toThrow(/foreign key/i);
  });
});

// --- Graph run parents -----------------------------------------------------------------

describe('graph run parents for recommendations and provider queries', () => {
  it('accepts a graph run as the exclusive parent on both tables', async () => {
    const a = await insertAccount(db);
    const runId = await run(db, a.accountId);
    const itemA = await accountItem(db, a.accountId);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO recommendations (discovery_item_id, title, origin, provider_query_ids, graph_run_id, owner_account_id)
       VALUES ($1, 'A graph-backed card', 'qloo', ARRAY[$2::uuid], $3, $4) RETURNING id`,
      [itemA, randomUUID(), runId, a.accountId],
    );
    expect(rows[0]).toBeTruthy();
    await db.query(
      `INSERT INTO provider_queries (provider, operation, graph_run_id, owner_account_id)
       VALUES ('qloo', 'search', $1, $2)`,
      [runId, a.accountId],
    );
  });

  it('rejects a graph parent alongside another parent or with no parent', async () => {
    const a = await insertAccount(db);
    const s = await insertAnonymousSession(db);
    const runId = await run(db, a.accountId);
    const itemA = await accountItem(db, a.accountId);
    const capA = await capture(db, a.accountId);
    // Graph parent + analysis parent.
    await expect(
      db.query(
        `INSERT INTO recommendations (discovery_item_id, title, origin, provider_query_ids, analysis_id, graph_run_id, owner_account_id)
         VALUES ($1, 'x', 'qloo', ARRAY[$2::uuid], $3, $4, $5)`,
        [itemA, randomUUID(), capA.analysisId, runId, a.accountId],
      ),
    ).rejects.toThrow(/check/i);
    // Graph parent + discovery job parent.
    const { rows: job } = await db.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id) VALUES ($1, $2) RETURNING id`,
      [a.accountId, itemA],
    );
    await expect(
      db.query(
        `INSERT INTO provider_queries (provider, operation, discovery_job_id, graph_run_id, owner_account_id)
         VALUES ('qloo', 'search', $1, $2, $3)`,
        [job[0]!.id, runId, a.accountId],
      ),
    ).rejects.toThrow(/check/i);
    // No parent at all is still invalid.
    await expect(
      db.query(`INSERT INTO provider_queries (provider, operation) VALUES ('qloo', 'search')`),
    ).rejects.toThrow(/check/i);
    void s;
  });

  it('binds graph-parented cards to the run owner and the owner-owned discovery item', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const runA = await run(db, a.accountId);
    const runB = await run(db, b.accountId);
    const itemB = await accountItem(db, b.accountId);

    // The owner column must follow the run: B's run cannot parent A's card.
    await expect(
      db.query(
        `INSERT INTO recommendations (discovery_item_id, title, origin, provider_query_ids, graph_run_id, owner_account_id)
         VALUES ($1, 'x', 'qloo', ARRAY[$2::uuid], $3, $4)`,
        [itemB, randomUUID(), runB, a.accountId],
      ),
    ).rejects.toThrow(/foreign key/i);
    // A's run cannot carry another account's discovery item even with A's owner.
    await expect(
      db.query(
        `INSERT INTO recommendations (discovery_item_id, title, origin, provider_query_ids, graph_run_id, owner_account_id)
         VALUES ($1, 'x', 'qloo', ARRAY[$2::uuid], $3, $4)`,
        [itemB, randomUUID(), runA, a.accountId],
      ),
    ).rejects.toThrow(/foreign key/i);
    // The graph parent pair must be complete or absent.
    await expect(
      db.query(
        `INSERT INTO recommendations (discovery_item_id, title, origin, graph_run_id)
         VALUES ($1, 'x', 'qloo', $2)`,
        [itemB, runB],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('keeps legacy rows valid and preserves real origins', async () => {
    const a = await insertAccount(db);
    const itemA = await accountItem(db, a.accountId);
    // A legacy row: parented the old way, no graph parent, and its owner
    // column stays NULL so ownership is derived from the parent join.
    const { rows: job } = await db.query<{ id: string }>(
      `INSERT INTO discovery_jobs (owner_account_id, origin_item_id) VALUES ($1, $2) RETURNING id`,
      [a.accountId, itemA],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO recommendations (discovery_item_id, discovery_job_id, title, origin)
       VALUES ($1, $2, 'A legacy card', 'research') RETURNING id`,
      [itemA, job[0]!.id],
    );
    expect(rows[0]!.id).toBeTruthy();
    // Storage method is not provenance: there is no 'graph' origin.
    const runA = await run(db, a.accountId);
    await expect(
      db.query(
        `INSERT INTO recommendations (discovery_item_id, title, origin, graph_run_id, owner_account_id)
         VALUES ($1, 'x', 'graph', $2, $3)`,
        [itemA, runA, a.accountId],
      ),
    ).rejects.toThrow(/check/i);
    // Real origins keep working under a graph parent.
    await db.query(
      `INSERT INTO provider_queries (provider, operation, graph_run_id, owner_account_id)
       VALUES ('research', 'relation_search', $1, $2)`,
      [runA, a.accountId],
    );
  });
});

// --- Frontier, proofs, outbox ------------------------------------------------------------

describe('frontier and proof contracts', () => {
  it('caps frontier lifetime at seven days and dedupes per account', async () => {
    const a = await insertAccount(db);
    const runA = await run(db, a.accountId);
    const n = await node(db);
    await expect(
      db.query(
        `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, dedupe_key, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '8 days')`,
        [a.accountId, runA, n, `node:${n}`],
      ),
    ).rejects.toThrow(/check/i);
    await db.query(
      `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, dedupe_key, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
      [a.accountId, runA, n, `node:${n}`],
    );
    await expect(
      db.query(
        `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, dedupe_key, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [a.accountId, runA, n, `node:${n}`],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('rejects cross-account frontier runs and proof parents', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const runA = await run(db, a.accountId);
    const n = await node(db);
    await expect(
      db.query(
        `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, dedupe_key, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [b.accountId, runA, n, `node:${n}`],
      ),
    ).rejects.toThrow(/foreign key/i);

    const itemA = await accountItem(db, a.accountId);
    const { rows: rec } = await db.query<{ id: string }>(
      `INSERT INTO recommendations (discovery_item_id, title, origin, provider_query_ids, graph_run_id, owner_account_id)
       VALUES ($1, 'A card', 'qloo', ARRAY[$2::uuid], $3, $4) RETURNING id`,
      [itemA, randomUUID(), runA, a.accountId],
    );
    // The proof's run must be the recommendation's own graph parent.
    const runB = await run(db, b.accountId);
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
           proof_version, intent, reason_template, reason_template_version)
         VALUES ($1, $2, $3, 1, 'personal', 'created_by', 'reason-1')`,
        [a.accountId, rec[0]!.id, runB],
      ),
    ).rejects.toThrow(/foreign key/i);
    // Cross-owner proofs are rejected even against the right run.
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
           proof_version, intent, reason_template, reason_template_version)
         VALUES ($1, $2, $3, 1, 'personal', 'created_by', 'reason-1')`,
        [b.accountId, rec[0]!.id, runA],
      ),
    ).rejects.toThrow(/foreign key/i);
    await db.query(
      `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
         proof_version, intent, reason_template, reason_template_version)
       VALUES ($1, $2, $3, 1, 'personal', 'created_by', 'reason-1')`,
      [a.accountId, rec[0]!.id, runA],
    );
    // One proof per version of a recommendation.
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
           proof_version, intent, reason_template, reason_template_version)
         VALUES ($1, $2, $3, 1, 'personal', 'created_by', 'reason-1')`,
        [a.accountId, rec[0]!.id, runA],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    // Pinned assertion/evidence revisions must line up.
    await expect(
      db.query(
        `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
           proof_version, intent, reason_template, reason_template_version, assertion_ids, assertion_revisions)
         VALUES ($1, $2, $3, 2, 'personal', 'created_by', 'reason-1', ARRAY[$4::uuid, $4::uuid], ARRAY[1])`,
        [a.accountId, rec[0]!.id, runA, runB],
      ),
    ).rejects.toThrow(/check/i);
  });

  it('writes one outbox row per logical event key and revision', async () => {
    const a = await insertAccount(db);
    const key = 'taste';
    await db.query(
      `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, target_taste_revision, job_intent)
       VALUES ($1, 'taste', $2, 5, 'project_interest_graph')`,
      [a.accountId, key],
    );
    await expect(
      db.query(
        `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, target_taste_revision, job_intent)
         VALUES ($1, 'taste', $2, 5, 'project_interest_graph')`,
        [a.accountId, key],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
    // A newer effective revision is a distinct durable intent.
    await db.query(
      `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, target_taste_revision, job_intent)
       VALUES ($1, 'taste', $2, 6, 'project_interest_graph')`,
      [a.accountId, key],
    );
    const b = await insertAccount(db);
    await db.query(
      `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, target_taste_revision, job_intent)
       VALUES ($1, 'taste', $2, 5, 'project_interest_graph')`,
      [b.accountId, key],
    );
  });
});

// --- Cleanup --------------------------------------------------------------------------

describe('account deletion cleanup', () => {
  it('removes every private graph row and graph-parented card with the account', async () => {
    const a = await insertAccount(db);
    const b = await insertAccount(db);
    const runA = await run(db, a.accountId);
    const runB = await run(db, b.accountId);
    const n = await node(db);
    const itemA = await accountItem(db, a.accountId);
    const itemB = await accountItem(db, b.accountId);
    const { rows: recA } = await db.query<{ id: string }>(
      `INSERT INTO recommendations (discovery_item_id, title, origin, provider_query_ids, graph_run_id, owner_account_id)
       VALUES ($1, 'A card', 'qloo', ARRAY[$2::uuid], $3, $4) RETURNING id`,
      [itemA, randomUUID(), runA, a.accountId],
    );
    await db.query(
      `INSERT INTO recommendation_graph_proofs (owner_account_id, recommendation_id, graph_run_id,
         proof_version, intent, reason_template, reason_template_version)
       VALUES ($1, $2, $3, 1, 'personal', 'created_by', 'reason-1')`,
      [a.accountId, recA[0]!.id, runA],
    );
    await db.query(
      `INSERT INTO provider_queries (provider, operation, graph_run_id, owner_account_id)
       VALUES ('qloo', 'search', $1, $2)`,
      [runA, a.accountId],
    );
    await db.query(
      `INSERT INTO graph_frontier (owner_account_id, run_id, node_id, dedupe_key, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
      [a.accountId, runA, n, `node:${n}`],
    );
    await db.query(
      `INSERT INTO graph_outbox (owner_account_id, event_type, logical_event_key, target_taste_revision, job_intent)
       VALUES ($1, 'taste', 'taste', 1, 'project_interest_graph')`,
      [a.accountId],
    );
    const { rows: edge } = await db.query<{ id: string }>(
      `INSERT INTO personal_interest_edges (owner_account_id, node_id, origin, state, policy_version)
       VALUES ($1, $2, 'explicit', 'confirmed', 'graph-policy-1') RETURNING id`,
      [a.accountId, n],
    );
    await db.query('INSERT INTO saved_items (owner_account_id, discovery_item_id) VALUES ($1, $2)', [
      a.accountId,
      itemA,
    ]);
    await db.query(
      `INSERT INTO personal_interest_support (owner_account_id, edge_id, origin_kind, saved_item_id)
       SELECT $1, $2, 'saved_item', si.id FROM saved_items si WHERE si.owner_account_id = $1 AND si.discovery_item_id = $3`,
      [a.accountId, edge[0]!.id, itemA],
    );
    await db.query('DELETE FROM accounts WHERE id = $1', [a.accountId]);

    const counts = async (table: string, owner: string) =>
      Number(
        (await db.query<{ n: string }>(`SELECT COUNT(*)::int AS n FROM ${table} WHERE owner_account_id = $1`, [owner]))
          .rows[0]!.n,
      );
    for (const table of [
      'graph_runs',
      'graph_frontier',
      'graph_outbox',
      'personal_graph_state',
      'personal_interest_edges',
      'personal_interest_support',
      'recommendation_graph_proofs',
    ]) {
      expect(await counts(table, a.accountId)).toBe(0);
    }
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            'SELECT COUNT(*)::int AS n FROM recommendations WHERE graph_run_id IS NOT NULL AND owner_account_id = $1',
            [a.accountId],
          )
        ).rows[0]!.n,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await db.query<{ n: string }>(
            'SELECT COUNT(*)::int AS n FROM provider_queries WHERE graph_run_id IS NOT NULL AND owner_account_id = $1',
            [a.accountId],
          )
        ).rows[0]!.n,
      ),
    ).toBe(0);
    // Shared canonical identities survive account deletion.
    expect(Number((await db.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM graph_nodes WHERE id = $1', [n])).rows[0]!.n)).toBe(1);
    // Another account's graph state is untouched.
    expect(Number((await db.query<{ n: string }>('SELECT COUNT(*)::int AS n FROM graph_runs WHERE id = $1', [runB])).rows[0]!.n)).toBe(1);
    void itemB;
  });
});
