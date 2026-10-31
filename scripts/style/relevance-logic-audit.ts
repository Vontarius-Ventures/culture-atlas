/**
 * Offline logic audit, not a provider replay or relevance evaluation.
 * pnpm exec tsx scripts/style/relevance-logic-audit.ts --manifest /abs/eval.json --out /abs/new-audit.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isArtworkSubject } from '../../packages/domain/src/style/adjacency';
import { subjectProfile } from '../../packages/domain/src/style/affinity';
import { rankAffinity } from '../../packages/domain/src/style/affinity-rail';
import { admitDiscovery } from '../../packages/domain/src/style/discovery-evidence';
import { drinkKindOf, homeKindOf, homeMatch, homeRailCarry, rankHomeCatalogue } from '../../packages/domain/src/style/home-affinity';
import { homeBrands } from '../../packages/domain/src/style/home-vocabulary';
import type { StoredSubject } from '../../packages/domain/src/style/types';

export function auditRecordedHomePool(subject: StoredSubject, entities: Parameters<typeof homeRailCarry>[0], requestSeedIds: readonly string[], queryId: string) {
  const kind = subject.category === 'interior' ? homeKindOf(subject) : subject.category === 'food' ? drinkKindOf(subject) : null;
  if (!kind) return null;
  const names = new Map(homeBrands().map((b) => [b.id, b.name]));
  const taste = {
    queryId, requestSeedIds,
    seeds: requestSeedIds.map((id) => ({ id, name: names.get(id) ?? id, subjectId: subject.id })),
  };
  const admitted = entities.filter((e) => admitDiscovery([subject], e, 'urn:entity:brand', { taste }));
  const q = subjectProfile(subject);
  const carried = homeRailCarry(admitted, q, kind);
  const ranked = rankAffinity(q, [{ list: carried.list, prior: true, fromEntity: false }], { fashion: false, match: (e) => homeMatch(q, e) });
  const recomputedSeeds = rankHomeCatalogue(subject, kind, { max: 3 });
  return {
    kind, requestSeedIds, recomputedSeeds,
    seedsUnchanged: requestSeedIds.length === recomputedSeeds.length && requestSeedIds.every((id, i) => id === recomputedSeeds[i]!.id),
    retrieved: entities.length, provenanceAdmitted: admitted.length,
    relevanceQualified: ranked.candidates.map((c) => ({ id: c.entity.entity_id, name: c.entity.name })),
    gated: { admission: entities.length - admitted.length, ...carried.gated, ...ranked.gated },
  };
}

interface AuditCandidate {
  schema_version: string;
  entity_id: string;
  name: string;
  types: string[];
  tags: { id: string; name: string }[];
  tagsTruncated: boolean;
  explainability?: { entity_id: string; score: number }[];
}

interface CaptureArtifact {
  trace: {
    analyses: { style_reading: { subjects: StoredSubject[] } | null }[];
    provider_queries: {
      id: string;
      query_context: { subject_id?: string; recipe?: string };
      sanitized_request: { query: Record<string, unknown> };
      results: unknown;
    }[];
    recommendations_rows: {
      rail: string; subject_id: string; title: string; hidden_at?: string | null;
      style_match?: { discovery_proof?: { candidateId: string } };
    }[];
  };
}

function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, out: { type: 'string' } } });
  if (!values.manifest || !values.out) throw new Error('Provide --manifest and a new --out path');
  const manifestBytes = readFileSync(values.manifest);
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    candidate_tuning: string; candidate_transfer: string;
    splits: { name: string; count: number; photos: { path: string }[] }[];
  };
  if (manifest.splits.length !== 2 || manifest.splits.some((s) => s.count !== s.photos.length)) throw new Error('Unexpected split denominator');
  const photos = manifest.splits.flatMap((split, index) => split.photos.map((photo) => {
    const file = basename(photo.path).replace(/\.[^.]+$/, '.json');
    const captureBytes = readFileSync(join(dirname(values.manifest!), index === 0 ? manifest.candidate_tuning : manifest.candidate_transfer, file));
    const capture = JSON.parse(captureBytes.toString('utf8')) as CaptureArtifact;
    const subjects = capture.trace.analyses[0]?.style_reading?.subjects ?? [];
    return {
      split: split.name, file, artifactSha256: createHash('sha256').update(captureBytes).digest('hex'),
      subjects: subjects.map((subject) => ({
        id: subject.id, label: subject.label, artwork: isArtworkSubject(subject),
        pools: capture.trace.provider_queries.filter((q) => q.query_context.subject_id === subject.id && ['interior_brand', 'coffee_brand'].includes(q.query_context.recipe ?? '')).map((query) => {
          if (!Array.isArray(query.results)) throw new Error(`Missing candidate array: ${file}`);
          const records = query.results as AuditCandidate[];
          if (records.some((e) => e.schema_version !== 'qloo_candidate_audit_v1' || !Array.isArray(e.tags) || !Array.isArray(e.types) || e.tagsTruncated !== false))
            throw new Error(`Incomplete candidate metadata: ${file}`);
          const seeds = query.sanitized_request.query['signal.interests.entities'];
          if (!Array.isArray(seeds) || seeds.some((id) => typeof id !== 'string')) throw new Error(`Missing recorded seeds: ${file}`);
          const audit = auditRecordedHomePool(subject, records.map((e) => ({
            entity_id: e.entity_id, name: e.name, types: e.types, tags: e.tags, properties: {},
            query: { explainability: e.explainability },
          })), seeds, query.id);
          const published = capture.trace.recommendations_rows.filter((r) => r.rail === 'more_like_this' && r.subject_id === subject.id && !r.hidden_at);
          const qualified = new Set(audit?.relevanceQualified.map((c) => c.id));
          return {
            ...audit, originalPublishedCount: published.length,
            previouslyPublishedStillQualified: published.filter((r) => qualified.has(r.style_match?.discovery_proof?.candidateId ?? '')).map((r) => r.title),
          };
        }),
      })),
    };
  }));
  const pools = photos.flatMap((p) => p.subjects.flatMap((s) => s.pools));
  const output = {
    version: 'relevance-logic-audit-v4',
    inputManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    limitations: [
      'Offline filtering of recorded home-brand pools only, not an end-to-end rerun or a subjective relevance score.',
      'New seed choices require different retrievals; old candidate pools do not predict those responses.',
      'No network, model calls, candidate-image verification, public-rail selection, or latency measurements.',
      'Missing/truncated candidate metadata fails the audit rather than silently changing denominators.',
    ],
    totals: {
      photos: photos.length, recordedHomePools: pools.length,
      retrieved: pools.reduce((sum, p) => sum + (p.retrieved ?? 0), 0),
      originalPublished: pools.reduce((sum, p) => sum + p.originalPublishedCount, 0),
      previouslyPublishedStillQualified: pools.reduce((sum, p) => sum + p.previouslyPublishedStillQualified.length, 0),
      changedSeedPools: pools.filter((p) => !p.seedsUnchanged).length,
    },
    photos,
  };
  // Never overwrite the frozen manifest, historical results, or an earlier audit.
  writeFileSync(values.out, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(output.totals));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
