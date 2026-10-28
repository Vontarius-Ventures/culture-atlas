/**
 * Reviewed pilot evidence corpus loader (PR 8 discovery runbook tooling).
 *   pnpm graph:corpus
 *
 * Admits the committed reviewed art/sculpture/ceramics/interiors corpus
 * (fixtures/graph-corpus/pilot-manifest.json) into the shared versioned
 * evidence layer. Admission fails closed on rights: a provider whose recorded
 * policy keeps responses transient (Qloo, while its retention/public-display
 * rights are undocumented) is rejected before anything is written, and the
 * whole manifest commits in one transaction. Loading is idempotent — replay
 * reuses existing source revisions, evidence rows and support attachments.
 *
 * This is operational setup for SHARED public-source evidence only: no
 * account-private data, no paid provider calls, no graph flags involved.
 * See docs/graph-corpus.md.
 */
import path from 'node:path';
import { loadRootEnv } from '../packages/domain/src/config';
import { createDb } from '../packages/domain/src/db/pool';
import { getCorpusManifestFile } from '../packages/domain/src/interest-graph/corpus-manifest';
import { admitGraphCorpus, graphCorpusSummary } from '../packages/domain/src/interest-graph/corpus';

loadRootEnv(path.resolve(import.meta.dirname, '..'));

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const db = createDb(url, 1);
try {
  const manifest = getCorpusManifestFile();
  const result = await admitGraphCorpus(db, manifest);
  const summary = await graphCorpusSummary(db);
  console.log(
    JSON.stringify({
      corpus_version: result.corpusVersion,
      identities_created: result.identitiesCreated,
      external_ids_created: result.externalIdsCreated,
      source_revisions_created: result.sourceRevisionsCreated,
      evidence_created: result.evidenceCreated,
      assertions_created: result.assertionsCreated,
      support_attached: result.supportAttached,
      assertion_revision_total: result.assertionRevisionTotal,
      summary: {
        domains: summary.domains,
        reviewed_evidence: summary.reviewedEvidence,
        unreviewed_evidence: summary.unreviewedEvidence,
        sources: summary.sources,
        source_revisions: summary.sourceRevisions,
        assertions_with_independent_support: summary.assertionsWithIndependentSupport,
        unresolved_rights_policies: summary.unresolvedRightsPolicies,
      },
    }),
  );
} catch (error) {
  console.error(`Corpus admission failed: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}
