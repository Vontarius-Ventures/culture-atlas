import { isUsable, type CallOptions, type ProviderRegistry, type ResearchExtraction, type ResearchSourceDoc } from '@culture-atlas/providers';
import type { Db, Queryable } from '../db/pool';
import type { ReferenceType, SectionStatus } from '../enums';
import { attemptCounter, errorSummary, recordProviderQuery } from './provider-queries';

/**
 * Stage 5: research up to N reference pages from authoritative sources
 * (Wikipedia/Wikimedia), extract individual claims with source URLs, and store
 * them in the PUBLIC reference library (cultural_references / claims /
 * sources). Nothing private (photo, observations, user) is sent or stored.
 * A reference researched recently is reused, not re-fetched.
 */

export const RESEARCH_FRESH_DAYS = 30;

export interface ResearchTarget {
  referenceId: string;
  name: string;
  type: ReferenceType;
}

export interface ResearchOutcome {
  status: SectionStatus;
  researched: string[];
  reused: string[];
  failed: string[];
  unsupported: string[];
}

interface RefState {
  research_status: string;
  researched_at: Date | null;
  revision: number;
}

async function refState(db: Queryable, id: string): Promise<RefState | null> {
  const { rows } = await db.query<RefState>('SELECT research_status, researched_at, revision FROM cultural_references WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** Persist one reference page: sources (by URL), claims (new revision), overview and sections. */
export async function storeResearch(db: Db, referenceId: string, sources: ResearchSourceDoc[], extraction: ResearchExtraction): Promise<void> {
  await db.transaction(async (tx) => {
    const urlToId = new Map<string, string>();
    for (const s of sources) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO sources (url, title, publisher, retrieved_at, allowed_display_metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (url) DO UPDATE SET title = EXCLUDED.title, publisher = EXCLUDED.publisher,
                retrieved_at = EXCLUDED.retrieved_at, allowed_display_metadata = EXCLUDED.allowed_display_metadata
         RETURNING id`,
        [s.url, s.title, s.publisher, s.retrieved_at, JSON.stringify({ title: s.title, publisher: s.publisher, license: s.license ?? null })],
      );
      urlToId.set(s.url, rows[0]!.id);
    }
    const { rows: refRows } = await tx.query<{ revision: number }>('SELECT revision FROM cultural_references WHERE id = $1 FOR UPDATE', [referenceId]);
    const revision = (refRows[0]?.revision ?? 1) + 1;
    await tx.query('DELETE FROM claims WHERE reference_id = $1', [referenceId]);
    const claimIds: string[] = [];
    for (const c of extraction.claims) {
      const sourceIds = c.source_urls.map((u) => urlToId.get(u)).filter((v): v is string => !!v);
      if (c.claim_type === 'factual' && sourceIds.length === 0) {
        claimIds.push('');
        continue;
      }
      const { rows } = await tx.query<{ id: string }>(
        'INSERT INTO claims (reference_id, text, claim_type, source_ids, revision) VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING id',
        [referenceId, c.text, c.claim_type, sourceIds, revision],
      );
      claimIds.push(rows[0]!.id);
    }
    const sections = extraction.sections
      .map((s) => ({ heading: s.heading, body: s.body, claim_ids: s.claim_indexes.map((i) => claimIds[i]).filter((id): id is string => !!id) }))
      .filter((s) => s.claim_ids.length > 0)
      .slice(0, 3);
    await tx.query(
      `UPDATE cultural_references
          SET overview = $2, sections = $3::jsonb, research_status = 'complete', researched_at = now(),
              revision = $4, updated_at = now()
        WHERE id = $1`,
      [referenceId, extraction.overview || null, JSON.stringify(sections), revision],
    );
  });
}

async function markStatus(db: Queryable, referenceId: string, status: 'pending' | 'failed' | 'unsupported'): Promise<void> {
  // Never downgrade a page that already has sourced content.
  await db.query(
    `UPDATE cultural_references SET research_status = $2, updated_at = now()
      WHERE id = $1 AND research_status <> 'complete'`,
    [referenceId, status],
  );
}

export async function researchReferences(input: {
  db: Db;
  providers: ProviderRegistry;
  targets: ResearchTarget[];
  maxRefs: number;
  analysisId: string;
  traceId: string | null;
  callOptions: (stage: string) => CallOptions;
  shouldStop: () => boolean;
  concurrency?: number;
}): Promise<ResearchOutcome> {
  const { db, providers } = input;
  const caps = providers.research.capability();
  const outcome: ResearchOutcome = { status: 'complete', researched: [], reused: [], failed: [], unsupported: [] };
  if (input.targets.length === 0) return { ...outcome, status: 'skipped' };
  if (!isUsable(caps.sources) || !isUsable(caps.claims)) return { ...outcome, status: 'unavailable' };

  const queue: ResearchTarget[] = [];
  for (const t of input.targets) {
    const state = await refState(db, t.referenceId);
    const fresh = state?.research_status === 'complete' && state.researched_at && Date.now() - state.researched_at.getTime() < RESEARCH_FRESH_DAYS * 86_400_000;
    if (fresh) outcome.reused.push(t.referenceId);
    else if (queue.length < input.maxRefs) queue.push(t);
  }

  const runOne = async (t: ResearchTarget) => {
    if (input.shouldStop()) return;
    await markStatus(db, t.referenceId, 'pending');
    const stage = `research:${t.referenceId}`;
    const counter = attemptCounter();
    const started = Date.now();
    let sources: ResearchSourceDoc[];
    try {
      sources = await providers.research.findSources({ name: t.name, type: t.type, limit: 2 }, { ...input.callOptions(stage), onAttempt: counter.observer });
      await recordProviderQuery(db, {
        parent: { analysisId: input.analysisId },
        provider: 'wikipedia',
        operation: 'find_sources',
        request: { name: t.name, type: t.type, limit: 2 },
        results: sources.map((s) => ({ url: s.url, title: s.title })),
        status: sources.length ? 'ok' : 'empty',
        durationMs: Date.now() - started,
        queryContext: { reference_id: t.referenceId, attempts: counter.count() },
        traceId: input.traceId,
      });
    } catch (err) {
      const e = errorSummary(err);
      await recordProviderQuery(db, {
        parent: { analysisId: input.analysisId },
        provider: 'wikipedia',
        operation: 'find_sources',
        request: { name: t.name, type: t.type, limit: 2 },
        status: 'error',
        errorCode: e.code,
        httpStatus: e.status,
        durationMs: Date.now() - started,
        queryContext: { reference_id: t.referenceId, attempts: counter.count() },
        traceId: input.traceId,
      });
      await markStatus(db, t.referenceId, 'failed');
      outcome.failed.push(t.referenceId);
      return;
    }
    if (sources.length === 0) {
      await markStatus(db, t.referenceId, 'unsupported');
      outcome.unsupported.push(t.referenceId);
      return;
    }
    if (input.shouldStop()) return;
    const t1 = Date.now();
    const c2 = attemptCounter();
    try {
      const extraction = await providers.research.extractClaims({ name: t.name, type: t.type, sources, maxClaims: 8 }, { ...input.callOptions(`${stage}:claims`), onAttempt: c2.observer });
      await recordProviderQuery(db, {
        parent: { analysisId: input.analysisId },
        provider: 'text_model',
        operation: 'extract_claims',
        request: { name: t.name, type: t.type, source_urls: sources.map((s) => s.url) },
        results: { claims: extraction.claims.length, sections: extraction.sections.length },
        status: extraction.claims.length ? 'ok' : 'empty',
        durationMs: Date.now() - t1,
        queryContext: { reference_id: t.referenceId, attempts: c2.count() },
        traceId: input.traceId,
      });
      if (extraction.claims.length === 0) {
        await markStatus(db, t.referenceId, 'unsupported');
        outcome.unsupported.push(t.referenceId);
        return;
      }
      await storeResearch(db, t.referenceId, sources, extraction);
      outcome.researched.push(t.referenceId);
    } catch (err) {
      const e = errorSummary(err);
      await recordProviderQuery(db, {
        parent: { analysisId: input.analysisId },
        provider: 'text_model',
        operation: 'extract_claims',
        request: { name: t.name, type: t.type, source_urls: sources.map((s) => s.url) },
        status: 'error',
        errorCode: e.code,
        httpStatus: e.status,
        durationMs: Date.now() - t1,
        queryContext: { reference_id: t.referenceId, attempts: c2.count() },
        traceId: input.traceId,
      });
      await markStatus(db, t.referenceId, 'failed');
      outcome.failed.push(t.referenceId);
    }
  };

  const concurrency = Math.max(1, input.concurrency ?? 2);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (next < queue.length) await runOne(queue[next++]!);
    }),
  );

  const done = outcome.researched.length + outcome.reused.length;
  const attempted = queue.length;
  if (done === 0 && outcome.failed.length > 0) outcome.status = 'failed';
  else if (outcome.failed.length > 0 || (input.shouldStop() && done + outcome.unsupported.length < attempted)) outcome.status = 'partial';
  else outcome.status = 'complete';
  return outcome;
}
