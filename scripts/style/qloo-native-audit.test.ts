import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUDIT_LIMITS, auditCaptures, auditDirectories, main } from './qloo-native-audit';

// Entirely synthetic, intentionally no recorded provider fixtures.
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const C = '00000000-0000-4000-8000-000000000003';
const Q = '00000000-0000-4000-8000-000000000010';
const TAG = 'urn:tag:theme:qloo:synthetic';
const entity = (id = A, extra = {}) => ({ entity_id: id, name: 'Synthetic only', ...extra });
const query = (results: unknown = [entity()], extra = {}) => ({
  id: Q,
  provider: 'qloo',
  operation: 'insights',
  status: 'ok',
  results,
  sanitized_request: {
    method: 'GET',
    path: '/v2/insights',
    query: { 'filter.type': 'urn:entity:brand' },
  },
  ...extra,
});
const publication = (id = A, extra = {}) => ({
  id: 'row-1',
  discovery_item_id: 'item-1',
  origin: 'qloo',
  external_ids: { qloo: id },
  rail: 'more_like_this',
  subject_id: 's1',
  rank: 1,
  provider_query_ids: [Q],
  hidden_at: null,
  ...extra,
});
const capture = (queries: unknown[] = [query()], rows: unknown[] = []) => ({
  trace: { provider_queries: queries, recommendations_rows: rows },
});
const manifest = (judgments: unknown[], complete = true) => ({
  schema_version: 'qloo_manual_judgments_v1',
  pool_complete: complete,
  judgments,
});
const label = (id = A, extra = {}) => ({
  capture: 'c0001',
  entity_id: id,
  grade: 3,
  candidate_evidence_verified: true,
  relation: 'brand_exploration',
  ...extra,
});
const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp('/tmp/qloo-native-audit-test-');
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('offline recorded candidate accounting', () => {
  it('does not confuse provider status empty, raw nonempty, and publication empty', async () => {
    const report = await auditCaptures([capture([query([entity()], { status: 'empty' })])]);
    expect(report.summary.statusEmptyWithNonemptyResults).toBe(1);
    expect(report.summary.rawEntityOccurrences).toBe(1);
    expect(report.captures[0]?.publication.state).toBe('empty');
    expect(report.captures[0]?.queries[0]).toMatchObject({
      rawResultState: 'nonempty',
      candidateResultState: 'nonempty',
      publicationState: 'empty',
      nonpublicationRelevance: 'unjudged',
    });
    expect(report.evaluation).toMatchObject({ status: 'not_evaluated', oracleClaim: false });
  });

  it('keeps missing legacy results unknown, even when n_results is zero or positive', async () => {
    const legacy = query();
    const { results: _results, ...withoutResults } = legacy;
    const report = await auditCaptures([
      capture([{ ...withoutResults, n_results: 20 }], [publication()]),
      capture([{ ...withoutResults, n_results: 0 }]),
    ]);
    expect(report.summary).toMatchObject({
      rawEntityOccurrences: null,
      uniqueRawEntities: null,
      observedEntityOccurrences: 0,
      queriesMissingResults: 2,
    });
    expect(report.captures[0]?.queries[0]).toMatchObject({
      rawResultState: 'unknown',
      entityOccurrences: null,
      reportedResultCount: 20,
    });
    expect(report.captures[0]?.publication).toMatchObject({
      rawMembership: 'unknown',
      publishedIdsAbsentFromCompletePool: null,
    });
  });

  it('counts only actual entities, not tags, tag parents, or explanation influences', async () => {
    const report = await auditCaptures(
      [
        capture([
          query([{ id: TAG, type: 'urn:tag:theme:qloo', parents: ['urn:entity:book', A] }], {
            id: 'tags',
            operation: 'style_tags',
          }),
          query([entity(A, { explainability: [{ entity_id: B, score: 1 }] })]),
        ]),
      ],
      { includeIds: true },
    );
    expect(report.summary).toMatchObject({
      rawEntityOccurrences: 1,
      uniqueRawEntities: 1,
      tagRowsObserved: 1,
      explanationContributionsObserved: 1,
    });
    expect(report.captures[0]?.entities?.map((e) => e.entityId)).toEqual([A]);
    expect(report.captures[0]?.queries[0]?.tagIds).toEqual([TAG]);
    expect(report.captures[0]?.queries[1]?.explanationSourceEntityIds).toEqual([B]);
    expect(report.summary.uniqueEntitiesByType).not.toHaveProperty('urn:entity:book');
  });

  it('dedupes UUIDs across queries, never entity names, and preserves type evidence', async () => {
    const report = await auditCaptures(
      [
        capture([
          query([entity(A), entity(A), entity(B)]),
          query([entity(A, { types: ['urn:entity:place'] })], {
            id: 'second',
            operation: 'search',
          }),
        ]),
      ],
      { includeIds: true },
    );
    expect(report.summary.rawEntityOccurrences).toBe(4);
    expect(report.summary.uniqueRawEntities).toBe(2);
    expect(report.captures[0]?.queries[0]).toMatchObject({
      entityOccurrences: 3,
      uniqueEntities: 2,
      duplicateEntityOccurrences: 1,
      typeEvidence: { request_inferred: 3 },
    });
    expect(report.captures[0]?.entityOccurrencesByType).toEqual({
      'urn:entity:brand': 3,
      'urn:entity:place': 1,
    });
    expect(report.captures[0]?.entities?.find((e) => e.entityId === A)).toMatchObject({
      occurrences: 3,
      queryRefs: ['q1', 'q2'],
      explicitTypes: ['urn:entity:place'],
      requestInferredTypes: ['urn:entity:brand'],
    });
  });

  it('keeps missing metadata unknown and URL availability separate from visual role', async () => {
    const report = await auditCaptures(
      [
        capture([
          query([
            entity(A),
            entity(B, { image: { url: 'https://synthetic.invalid/image?sig=private' } }),
            entity(C, {
              schema_version: 'qloo_candidate_audit_v1',
              metadataAvailability: { description: true, image: false, imageRole: 'unknown' },
            }),
          ]),
        ]),
      ],
      { includeIds: true },
    );
    expect(report.summary.metadata).toEqual({
      description: { available: 1, unknown: 2 },
      imageUrl: { available: 1, unavailable: 1, unknown: 1 },
      imageRole: { unknown: 3 },
    });
    expect(report.captures[0]?.entities?.find((e) => e.entityId === B)?.imageRole).toBe('unknown');
    expect(JSON.stringify(report)).not.toContain('sig=private');
    expect(report.captures[0]?.queries[0]?.projectedRows).toBe(1);
  });

  it('does not let published card images pretend to be raw candidate metadata', async () => {
    const input = {
      ...capture([query()], [publication()]),
      final_capture_response: {
        rails: [
          {
            kind: 'more_like_this',
            cards: [
              {
                id: 'item-1',
                recommendation_id: 'row-1',
                image: { url: 'https://synthetic.invalid' },
              },
            ],
          },
        ],
      },
    };
    const report = await auditCaptures([input]);
    expect(report.summary.metadata.imageUrl).toEqual({ unknown: 1 });
  });

  it('reports conflicting explicit metadata observations without turning missing into false', async () => {
    const report = await auditCaptures(
      [
        capture([
          query([entity(A, { metadataAvailability: { image: false } })]),
          query([entity(A, { metadataAvailability: { image: true } })], { id: 'second' }),
        ]),
      ],
      { includeIds: true },
    );
    expect(report.captures[0]?.entities?.[0]?.imageUrl).toBe('conflicting');
    expect(report.captures[0]?.queries[0]?.metadataOccurrences?.imageUrl).toEqual({
      unavailable: 1,
    });
    expect(report.captures[0]?.queries[1]?.metadataOccurrences?.imageUrl).toEqual({ available: 1 });
  });

  it('treats hidden rows, multirail publication and legacy duplicate cards correctly', async () => {
    const input = {
      ...capture(
        [query([entity(A), entity(B)])],
        [
          publication(),
          publication(A, { id: 'row-2', discovery_item_id: 'item-2', rail: 'cross_domain' }),
          publication(B, { id: 'hidden', hidden_at: 'synthetic-time' }),
        ],
      ),
      final_capture_response: {
        rails: [
          { kind: 'more_like_this', cards: [{ id: 'item-1', recommendation_id: 'row-1' }] },
          { kind: 'cross_domain', cards: [{ id: 'item-2', recommendation_id: 'row-2' }] },
        ],
        recommendations: [{ id: 'item-2', recommendation_id: 'row-2' }],
      },
    };
    const report = await auditCaptures([input]);
    expect(report.captures[0]?.publication).toMatchObject({
      qlooRows: 2,
      uniqueQlooEntities: 1,
      hiddenRows: 1,
      byRail: { cross_domain: 1, more_like_this: 1 },
      notPublishedUniqueEntities: 1,
      publicCardOccurrencesIncludingLegacyDuplicates: 3,
      publicCardJoin: { joinedOccurrencesIncludingLegacyDuplicates: 3, unresolvedOccurrences: 0 },
    });
    expect(report.captures[0]?.queries[0]?.publishedRowsViaQuery).toBe(2);
  });

  it('reconciles hidden stale public cards without publishing them', async () => {
    const input = {
      ...capture([query()], [publication(A, { hidden_at: 'synthetic-time' })]),
      final_capture_response: { recommendations: [{ recommendation_id: 'row-1' }] },
    };
    const report = await auditCaptures([input]);
    expect(report.captures[0]?.publication).toMatchObject({
      qlooRows: 0,
      publicCardJoin: { hiddenOccurrences: 1 },
    });
  });

  it('uses public catalogue IDs only when stored rows are absent and dedupes legacy views', async () => {
    const card = { id: 'local-item', external_ids: { qloo: A } };
    const report = await auditCaptures([
      {
        trace: { provider_queries: [query()] },
        final_capture_response: {
          rails: [{ kind: 'more_like_this', cards: [card] }],
          recommendations: [card],
        },
      },
    ]);
    expect(report.captures[0]?.publication).toMatchObject({
      state: 'nonempty',
      qlooRows: 1,
      uniqueQlooEntities: 1,
      source: 'public_cards',
    });
  });

  it('never mistakes a public item UUID for a Qloo UUID', async () => {
    const report = await auditCaptures([
      {
        trace: { provider_queries: [query()] },
        final_capture_response: { recommendations: [{ id: A, origin: 'qloo' }] },
      },
    ]);
    expect(report.captures[0]?.publication).toMatchObject({ state: 'unknown', qlooRows: 0 });
  });

  it('keeps malformed Qloo stored IDs and missing provenance unknown instead of empty', async () => {
    const malformed = await auditCaptures([
      capture([query()], [publication(A, { external_ids: {} })]),
    ]);
    expect(malformed.captures[0]?.publication).toMatchObject({
      state: 'unknown',
      invalidQlooRows: 1,
    });
    const unlinked = await auditCaptures([
      capture([query()], [publication(A, { provider_query_ids: ['unrecorded-query'] })]),
    ]);
    expect(unlinked.captures[0]?.queries[0]).toMatchObject({
      publicationState: 'unknown',
      notPublishedUniqueEntitiesViaQuery: null,
    });
  });

  it('reports publication IDs absent from the complete pool without inventing candidates', async () => {
    const report = await auditCaptures([capture([query()], [publication(B)])], {
      includeIds: true,
    });
    expect(report.summary.uniqueRawEntities).toBe(1);
    expect(report.captures[0]?.publication).toMatchObject({
      publishedIdsAbsentFromCompletePool: 1,
      idsNotInObservedPool: [B],
    });
  });

  it('keeps unrecorded operators unknown and explicit operators separate from signals', async () => {
    const report = await auditCaptures([
      capture([
        query([], {
          sanitized_request: {
            method: 'GET',
            path: '/v2/insights',
            query: {
              'filter.type': 'urn:entity:brand',
              'filter.tags': [TAG],
              'operator.filter.tags': 'intersection',
              'operator.signal.interests.tags': 'union',
              'signal.interests.tags': [TAG],
              'signal.interests.entities': [A],
              'signal.interests.tags.weight': 'never-output-this',
            },
          },
        }),
        query([], { id: 'second' }),
      ]),
    ]);
    expect(report.captures[0]?.queries[0]?.request).toMatchObject({
      operators: [
        { key: 'operator.filter.tags', value: 'intersection' },
        { key: 'operator.signal.interests.tags', value: 'union' },
      ],
      filterTagCount: 1,
      signalTagCount: 1,
      seedEntityCount: 1,
      weightsRecorded: true,
    });
    expect(report.captures[0]?.queries[1]?.request.operatorEvidence).toBe('not_recorded');
    expect(JSON.stringify(report)).not.toContain('never-output-this');
  });

  it('allowlists output instead of redacting arbitrary private payloads', async () => {
    const secret = 'private-person@example.invalid';
    const input = {
      ...capture([
        query(
          [
            entity(A, {
              name: secret,
              description: secret,
              image: { url: `https://invalid/?sig=${secret}` },
              cookies: secret,
              email: secret,
              session: secret,
              explainability: [{ entity_id: B, score: 1, email: secret }],
            }),
          ],
          {
            sanitized_request: {
              method: secret,
              path: secret,
              query: { 'filter.query': secret, 'filter.location': secret, cookie: secret },
            },
            query_context: { candidate_name: secret, rail: secret, stage: secret },
          },
        ),
      ]),
      email: secret,
      capture_id: secret,
      photo_path: secret,
    };
    for (const includeIds of [false, true]) {
      const text = JSON.stringify(await auditCaptures([input], { includeIds }));
      expect(text).not.toContain(secret);
      expect(text).not.toMatch(/https?:|sig=|cookies|session|@/);
      expect(text).not.toContain('Synthetic only');
    }
  });

  it('understands bounded known insights, tag and entity envelopes, not arbitrary recursion', async () => {
    const report = await auditCaptures([
      capture([
        query({ results: { entities: [entity(A)] } }),
        query({ tags: [{ tag_id: TAG }] }, { id: 'tags', operation: 'tags' }),
        query({ entity: entity(B) }, { id: 'detail', operation: 'entity' }),
      ]),
    ]);
    expect(report.summary).toMatchObject({ rawEntityOccurrences: 2, tagRowsObserved: 1 });
    const unsupported = await auditCaptures([
      capture([query({ arbitrary: { entities: [entity()] } })]),
    ]);
    expect(unsupported.summary.rawEntityOccurrences).toBeNull();
    expect(unsupported.captures[0]?.queries[0]?.unsupportedEnvelope).toBe(true);
  });

  it('rejects unsupported roots and resource excess with safe, stable errors', async () => {
    await expect(auditCaptures([{ private: 'not-an-artifact' }])).rejects.toThrow(
      'unsupported_capture_root',
    );
    await expect(auditCaptures([])).rejects.toThrow('no_capture_artifacts');
    await expect(
      auditCaptures([capture([query(Array(AUDIT_LIMITS.rowsPerQuery + 1).fill(entity()))])]),
    ).rejects.toThrow('input_limit_exceeded');
    await expect(auditCaptures([capture([query(), query()])])).rejects.toThrow(
      'duplicate_query_id',
    );
  });
});

describe('manual candidate-evidence judgments', () => {
  it('does not compute metrics from partial labels or a false completeness declaration', async () => {
    const input = capture([query([entity(A), entity(B)])], [publication()]);
    for (const judgments of [manifest([label()]), manifest([label(), label(B)], false)]) {
      const report = await auditCaptures([input], { judgments });
      expect(report.evaluation).toMatchObject({
        status: 'not_evaluated',
        scope: 'partial',
        oracleClaim: false,
      });
      expect(report.evaluation).not.toHaveProperty('yieldAt4');
      expect(report.evaluation).not.toHaveProperty('pooledUsefulCoverageAt4');
    }
  });

  it('requires verified full-pool labels and rejects unverifiable evidence for metrics', async () => {
    for (const extra of [{ grade: 'unverifiable' }, { candidate_evidence_verified: false }]) {
      const report = await auditCaptures([capture([query()], [publication()])], {
        judgments: manifest([label(A, extra)]),
      });
      expect(report.evaluation).toMatchObject({
        status: 'not_evaluated',
        scope: 'complete_labels_unverifiable',
        unverifiable: 1,
      });
    }
  });

  it('computes pooled useful coverage and fixed-slot yield@4 only on complete verified pools', async () => {
    const input = capture(
      [query([entity(A), entity(B), entity(C)])],
      [
        publication(A, { rank: 1 }),
        publication(A, { id: 'duplicate-rail', rail: 'cross_domain', rank: 2 }),
        publication(B, { id: 'second', rank: 3 }),
      ],
    );
    const report = await auditCaptures([input], {
      judgments: manifest([label(A), label(B, { grade: 1 }), label(C)]),
    });
    expect(report.evaluation).toMatchObject({
      status: 'evaluated',
      scope: 'complete_recorded_pools',
      oracleClaim: false,
      usefulPoolCandidates: 2,
      selectedCandidatesAt4: 2,
      usefulSelectedAt4: 1,
      yieldAt4: 0.25,
      pooledUsefulCoverageAt4: 0.5,
    });
  });

  it('does not evaluate unknown historical pools, extras, or unmatched publications', async () => {
    const { results: _results, ...legacy } = query();
    const cases = [
      { input: capture([legacy]), judgments: manifest([]) },
      { input: capture([query()]), judgments: manifest([label(A), label(B)]) },
      { input: capture([query()], [publication(B)]), judgments: manifest([label(A)]) },
    ];
    for (const c of cases) {
      const report = await auditCaptures([c.input], { judgments: c.judgments });
      expect(report.evaluation.status).toBe('not_evaluated');
    }
  });

  it('validates grades, evidence flags, relation vocabulary and duplicate labels', async () => {
    for (const extra of [
      { grade: 4 },
      { grade: -1 },
      { grade: '3' },
      { relation: 'private-name' },
    ]) {
      await expect(
        auditCaptures([capture()], { judgments: manifest([label(A, extra)]) }),
      ).rejects.toThrow('invalid_judgment');
    }
    await expect(
      auditCaptures([capture()], { judgments: manifest([label(A), label(A)]) }),
    ).rejects.toThrow('duplicate_judgment');
  });
});

describe('directory and CLI boundaries', () => {
  it('reads sorted directories deterministically and dedupes overlapping directory arguments', async () => {
    const directory = await temp();
    await writeFile(join(directory, 'b.json'), JSON.stringify(capture([query([entity(B)])])));
    await writeFile(join(directory, 'a.json'), JSON.stringify(capture()));
    const first = await auditDirectories([directory, `${directory}/.`], { includeIds: true });
    const second = await auditDirectories([directory], { includeIds: true });
    expect(first).toEqual(second);
    expect(first.captures[0]?.entities?.[0]?.entityId).toBe(A);
    expect(first.summary.captures).toBe(2);
  });

  it('does no file writes during import or audit; explicit CLI output is private and exclusive', async () => {
    const directory = await temp();
    await writeFile(join(directory, 'capture.json'), JSON.stringify(capture()));
    const before = await readdir(directory);
    await import('./qloo-native-audit');
    await auditDirectories([directory]);
    expect(await readdir(directory)).toEqual(before);
    const outputDirectory = await temp();
    const output = join(outputDirectory, 'private-audit.json');
    await main([directory, '--out', output]);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(output, 'utf8')).summary.rawEntityOccurrences).toBe(1);
    await expect(main([directory, '--out', output])).rejects.toThrow('output_io_error');
  });

  it('fails unsupported JSON roots, invalid JSON and symlink inputs without leaking payloads', async () => {
    const directory = await temp();
    const path = join(directory, 'bad.json');
    await writeFile(path, '{email:private@example.invalid}');
    await expect(auditDirectories([directory])).rejects.toThrow('invalid_json');
    await writeFile(path, JSON.stringify({ email: 'private@example.invalid' }));
    await expect(auditDirectories([directory])).rejects.toThrow('unsupported_capture_root');
    const links = await temp();
    await symlink(path, join(links, 'link.json'));
    await expect(auditDirectories([links])).rejects.toThrow('unsupported_input_file');
  });
});
