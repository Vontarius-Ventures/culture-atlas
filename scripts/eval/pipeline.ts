import { GUARDRAIL_VERSION, guardEnrichment, guardQuickRead } from '../../packages/providers/src/vlm/guardrails';
import {
  mergeEnrichmentContext,
  toVlmAnalysis,
  type VlmAnalysis,
  type VlmEnrichment,
  type VlmQuickRead,
} from '../../packages/providers/src/vlm/types';
import type { CallRecord, CandidateView, ReadingView, ScoredRun } from './scorer';

/**
 * Turns recorded model outputs into what a user would see, with or without
 * the runtime guardrails (docs/quality-plan.md §7.3):
 *
 *   toVlmAnalysis -> guardQuickRead -> mergeEnrichmentContext -> guardEnrichment
 *
 * The guard functions are injected (GuardModule) so the scorer and the replay
 * do not depend on one guardrail implementation, and so the unguarded
 * pipeline (the M17 "teeth" baseline) runs the same recordings.
 */

/** A recorded reading of one photo: the stage-1 quick read and, optionally, its enrichment. */
export interface Recording {
  photoId: string;
  runId: string;
  quick: unknown;
  enrichment?: unknown;
  quickMs?: number;
  enrichMs?: number;
}

export interface GuardDecisionLike {
  candidateId: string;
  name: string;
  action: string;
  rules: readonly string[];
}

/**
 * The guardrail surface frozen in §4.1 (method shorthand so the real module,
 * whose merge context type is richer, is assignable).
 */
export interface GuardModule {
  GUARDRAIL_VERSION: string;
  guardQuickRead(
    a: VlmAnalysis,
    ctx: { twoStage: boolean },
  ): { analysis: VlmAnalysis; held: VlmAnalysis['candidates']; decisions: readonly GuardDecisionLike[] };
  mergeEnrichmentContext(
    base: VlmAnalysis,
    enrichment: VlmEnrichment,
    held: VlmAnalysis['candidates'],
  ): { analysis: VlmAnalysis; merge: unknown };
  guardEnrichment(input: {
    published: VlmAnalysis;
    held: VlmAnalysis['candidates'];
    merged: VlmAnalysis;
    merge: unknown;
  }): { analysis: VlmAnalysis; decisions: readonly GuardDecisionLike[] };
}

export interface ReadingPipeline {
  name: 'guarded' | 'unguarded';
  /** GUARDRAIL_VERSION of the guards, null when unguarded. */
  guardrailVersion: string | null;
  run(rec: Recording): ScoredRun & { decisions: GuardDecisionLike[]; finalCandidates: VlmAnalysis['candidates'] };
}

export function candidateView(c: VlmAnalysis['candidates'][number]): CandidateView {
  const extra = c as unknown as { domain?: string | null; evidence?: string | null; evidence_text?: string | null };
  return {
    name: c.name,
    type: c.type,
    relation: c.relation,
    certainty: c.certainty,
    categories: [...c.suggested_categories],
    domain: extra.domain ?? null,
    evidence: extra.evidence ?? null,
    evidence_text: extra.evidence_text ?? null,
  };
}

export function readingView(a: VlmAnalysis): ReadingView {
  return {
    title: a.title,
    interpretation: a.interpretation,
    candidates: a.candidates.map(candidateView),
    observations: a.observations.map((o) => ({ text: o.text, kind: o.kind })),
    visible_text: a.visible_text.map((t) => t.text),
    quality: { usable: a.quality.usable, issue: a.quality.issue ?? null },
  };
}

function calls(rec: Recording): CallRecord[] {
  const out: CallRecord[] = [];
  if (rec.quickMs !== undefined) out.push({ stage: 'quick', ms: rec.quickMs, valid: true });
  if (rec.enrichment !== undefined && rec.enrichMs !== undefined)
    out.push({ stage: 'enrich', ms: rec.enrichMs, valid: true });
  return out;
}

/** Everything the model emitted, as the pre-guard compiler would have published it. */
export const unguardedPipeline: ReadingPipeline = {
  name: 'unguarded',
  guardrailVersion: null,
  run(rec) {
    const quick = rec.quick as VlmQuickRead;
    const stage1 = toVlmAnalysis(quick);
    const final = rec.enrichment === undefined ? stage1 : toVlmAnalysis(quick, rec.enrichment as VlmEnrichment);
    return {
      photoId: rec.photoId,
      runId: rec.runId,
      twoStage: rec.enrichment !== undefined,
      emitted: final.candidates.map(candidateView),
      stage1Published: stage1.candidates.map(candidateView),
      final: readingView(final),
      calls: calls(rec),
      decisions: [],
      finalCandidates: final.candidates,
    };
  },
};

/**
 * The production order with guards: stage 1 is guarded as if stage 2 will
 * run (claims are held, not dropped); a quick-only recording therefore shows
 * what the first sections publish, and held claims never appear.
 */
export function guardedPipeline(guards: GuardModule): ReadingPipeline {
  return {
    name: 'guarded',
    guardrailVersion: guards.GUARDRAIL_VERSION,
    run(rec) {
      const quick = rec.quick as VlmQuickRead;
      const raw1 = toVlmAnalysis(quick);
      const g1 = guards.guardQuickRead(raw1, { twoStage: true });
      const decisions = [...g1.decisions];
      let final = g1.analysis;
      let emitted = raw1.candidates;
      if (rec.enrichment !== undefined) {
        const enrichment = rec.enrichment as VlmEnrichment;
        emitted = toVlmAnalysis(quick, enrichment).candidates;
        const { analysis: merged, merge } = guards.mergeEnrichmentContext(g1.analysis, enrichment, g1.held);
        const g2 = guards.guardEnrichment({ published: g1.analysis, held: g1.held, merged, merge });
        decisions.push(...g2.decisions);
        final = g2.analysis;
      }
      return {
        photoId: rec.photoId,
        runId: rec.runId,
        twoStage: rec.enrichment !== undefined,
        emitted: emitted.map(candidateView),
        stage1Published: g1.analysis.candidates.map(candidateView),
        final: readingView(final),
        calls: calls(rec),
        decisions,
        finalCandidates: final.candidates,
      };
    },
  };
}

/**
 * The runtime guardrails (packages/providers/src/vlm/guardrails.ts) and the
 * context merge from vlm/types.ts, imported statically: the evaluation always
 * scores the exact guard code production runs, and there is no "module
 * absent" path that could skip the guarded replay or qualification.
 */
export const RUNTIME_GUARDS: GuardModule = {
  GUARDRAIL_VERSION,
  guardQuickRead,
  guardEnrichment,
  mergeEnrichmentContext,
};

/** The guarded pipeline over the runtime guardrails (what production publishes). */
export const runtimeGuardedPipeline: ReadingPipeline = guardedPipeline(RUNTIME_GUARDS);
