import { GUARDRAIL_VERSION, guardEnrichment, guardQuickRead, stage2Request } from '../../packages/providers/src/vlm/guardrails';
import {
  mergeEnrichmentContext,
  toVlmAnalysis,
  type VlmAnalysis,
  type VlmEnrichment,
  type VlmQuickRead,
} from '../../packages/providers/src/vlm/types';
import {
  VlmVerification,
  applyVerification,
  blockedIds,
  verifyTargets,
  type VerifierCheck,
  type VerifyTarget,
} from '../../packages/providers/src/vlm/verify';
import type { CallRecord, CandidateView, ReadingView, ScoredRun } from './scorer';

/**
 * Turns recorded model outputs into what a user would see, with or without
 * the runtime guardrails (docs/quality-plan.md §7.3):
 *
 *   toVlmAnalysis -> guardQuickRead -> [verify 1] -> mergeEnrichmentContext
 *     -> guardEnrichment -> [verify 2]
 *
 * The guard functions are injected (GuardModule) so the scorer and the replay
 * do not depend on one guardrail implementation, and so the unguarded
 * pipeline (the M17 "teeth" baseline) runs the same recordings.
 *
 * The verifier (vlm-verify-v3, docs/quality-plan.md §18) is binding and runs
 * before publication, exactly as the compiler runs it: the stage-1 check on
 * the first section's targets (blocked claims never publish and are not sent
 * to stage 2 as published), and the stage-2 check on what stage 2 would
 * publish. It applies only when the recording carries verifier replies.
 */

/** A recorded reading of one photo: the stage-1 quick read and, optionally, its enrichment and verifier replies. */
export interface Recording {
  photoId: string;
  runId: string;
  quick: unknown;
  enrichment?: unknown;
  quickMs?: number;
  enrichMs?: number;
  /**
   * Legacy verifier reply (vlm-verify-v1/v2: one advisory call after stage 2,
   * requalification round 1). Replayed under v3 semantics by name for both
   * checks; a claim it did not answer is blocked, so it reads as a lower
   * bound on what a v3 run would publish (information only).
   */
  verification?: unknown;
  verifyMs?: number;
  /** vlm-verify-v3, stage-1 check: the reply, or null when the call failed (its targets are blocked). */
  verification1?: unknown;
  verify1Ms?: number;
  /** vlm-verify-v3, stage-2 check: the reply, or null when the call failed. */
  verification2?: unknown;
  verify2Ms?: number;
}

export interface GuardDecisionLike {
  candidateId: string;
  name: string;
  action: string;
  rules: readonly string[];
  note?: string;
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

/** What the verifier saw and decided on one reading (empty when it did not run). */
export interface VerifyTrace {
  /** Stage-1 targets (the first section's claims it must check), on the guarded quick read. */
  targets1: VerifyTarget[];
  /** Stage-2 targets (what stage 2 would publish), computed once a stage-2 reading exists. */
  targets2: VerifyTarget[];
  /** What stage 2 is sent: the published title and names (after stage-1 blocking) and the held names. */
  stage2Input: { title: string; candidates: string[] };
  /** The visible text of the merged reading (stage 2) the stage-2 check is sent, else []. */
  stage2Text: string[];
  checks: VerifierCheck[];
  /** Candidates the verifier blocked (never published). */
  blocked: CandidateView[];
}

export interface ReadingPipeline {
  name: 'guarded' | 'guarded-without-verifier' | 'unguarded';
  /** GUARDRAIL_VERSION of the guards, null when unguarded. */
  guardrailVersion: string | null;
  run(rec: Recording): ScoredRun & {
    decisions: GuardDecisionLike[];
    finalCandidates: VlmAnalysis['candidates'];
    verify: VerifyTrace;
  };
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
    text_only: c.text_only ?? null,
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
    competing_subjects: a.competing_subjects.map((s) => s.label),
  };
}

function calls(rec: Recording, withVerifier: boolean): CallRecord[] {
  const out: CallRecord[] = [];
  if (rec.quickMs !== undefined) out.push({ stage: 'quick', ms: rec.quickMs, valid: true });
  if (rec.enrichment !== undefined && rec.enrichMs !== undefined)
    out.push({ stage: 'enrich', ms: rec.enrichMs, valid: true });
  if (!withVerifier) return out;
  if (rec.verification !== undefined && rec.verifyMs !== undefined) out.push({ stage: 'verify', ms: rec.verifyMs, valid: true });
  // A failed check (null) is recorded by eval:live as a failed call; only completed ones are calls here.
  if (rec.verification1 != null && rec.verify1Ms !== undefined) out.push({ stage: 'verify', ms: rec.verify1Ms, valid: true });
  if (rec.verification2 != null && rec.verify2Ms !== undefined) out.push({ stage: 'verify', ms: rec.verify2Ms, valid: true });
  return out;
}

const NO_VERIFY = (stage2Input: VerifyTrace['stage2Input']): VerifyTrace => ({ targets1: [], targets2: [], stage2Input, stage2Text: [], checks: [], blocked: [] });

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
      calls: calls(rec, true),
      decisions: [],
      finalCandidates: final.candidates,
      verify: NO_VERIFY({ title: stage1.title, candidates: stage1.candidates.map((c) => c.name) }),
    };
  },
};

/** The recorded reply for one verifier check: the v3 field if present (null = failed call), else the legacy reply. */
function replyFor(rec: Recording, stage: 1 | 2): VlmVerification | null | undefined {
  const own = stage === 1 ? rec.verification1 : rec.verification2;
  if (own === null) return null;
  if (own !== undefined) return VlmVerification.parse(own);
  if (rec.verification !== undefined && rec.verification !== null) return VlmVerification.parse(rec.verification);
  return undefined;
}

/** A blocked claim, as the inspector records it (a private observation, rule G-VERIFY). */
function verifierDecision(c: VerifierCheck): GuardDecisionLike {
  return { candidateId: c.candidateId, name: c.name, action: c.action === 'publish' ? 'publish' : 'observe', rules: ['G-VERIFY'], note: c.note };
}

/**
 * The production order with guards: stage 1 is guarded as if stage 2 will
 * run (claims are held, not dropped); a quick-only recording therefore shows
 * what the first sections publish, and held claims never appear.
 */
export function guardedPipeline(guards: GuardModule, options: { verifier?: boolean } = {}): ReadingPipeline {
  const useVerifier = options.verifier !== false;
  return {
    name: useVerifier ? 'guarded' : 'guarded-without-verifier',
    guardrailVersion: guards.GUARDRAIL_VERSION,
    run(rec) {
      const quick = rec.quick as VlmQuickRead;
      const raw1 = toVlmAnalysis(quick);
      const g1 = guards.guardQuickRead(raw1, { twoStage: true });
      const decisions = [...g1.decisions];
      const verifierRan = useVerifier && (rec.verification1 !== undefined || rec.verification2 !== undefined || rec.verification !== undefined);
      const checks: VerifierCheck[] = [];
      const blocked: CandidateView[] = [];
      // Stage-1 check: the first section's claims, before they publish (in parallel with Qloo in production).
      const targets1 = verifyTargets(g1.analysis.candidates);
      let published1 = g1.analysis;
      if (verifierRan && targets1.length) {
        const reply = replyFor(rec, 1);
        const c1 = applyVerification(targets1, reply ?? null);
        checks.push(...c1);
        decisions.push(...c1.map(verifierDecision));
        const out = blockedIds(c1);
        blocked.push(...g1.analysis.candidates.filter((c) => out.has(c.id)).map(candidateView));
        published1 = { ...g1.analysis, candidates: g1.analysis.candidates.filter((c) => !out.has(c.id)) };
      }
      const stage2Input = stage2Request(published1, g1.held);
      let final = published1;
      let emitted = raw1.candidates;
      let targets2: VerifyTarget[] = [];
      let stage2Text: string[] = [];
      if (rec.enrichment !== undefined) {
        const enrichment = rec.enrichment as VlmEnrichment;
        emitted = toVlmAnalysis(quick, enrichment).candidates;
        const { analysis: merged, merge } = guards.mergeEnrichmentContext(published1, enrichment, g1.held);
        const g2 = guards.guardEnrichment({ published: published1, held: g1.held, merged, merge });
        decisions.push(...g2.decisions);
        final = g2.analysis;
        stage2Text = final.visible_text.map((t) => t.text);
        // Stage-2 check: what stage 2 would publish (held claims it confirmed and additions).
        const before = new Set(published1.candidates.map((c) => c.id));
        targets2 = verifyTargets(final.candidates.filter((c) => !before.has(c.id)));
        if (verifierRan && targets2.length) {
          const c2 = applyVerification(targets2, replyFor(rec, 2) ?? null);
          checks.push(...c2);
          decisions.push(...c2.map(verifierDecision));
          const out = blockedIds(c2);
          blocked.push(...final.candidates.filter((c) => out.has(c.id)).map(candidateView));
          final = { ...final, candidates: final.candidates.filter((c) => !out.has(c.id)) };
        }
      }
      const view = readingView(final);
      const published = new Map(checks.filter((c) => c.action === 'publish').map((c) => [c.candidateId, c]));
      view.candidates = final.candidates.map((c) => {
        const v = candidateView(c);
        return published.has(c.id) ? { ...v, verifier: 'yes' as const } : v;
      });
      return {
        photoId: rec.photoId,
        runId: rec.runId,
        twoStage: rec.enrichment !== undefined,
        emitted: emitted.map(candidateView),
        stage1Published: published1.candidates.map(candidateView),
        final: view,
        calls: calls(rec, useVerifier),
        ...(verifierRan ? { verifierBlocked: blocked } : {}),
        decisions,
        finalCandidates: final.candidates,
        verify: { targets1, targets2, stage2Input, stage2Text, checks, blocked },
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

/** The guarded pipeline over the runtime guardrails (what production publishes), with any recorded verifier replies applied. */
export const runtimeGuardedPipeline: ReadingPipeline = guardedPipeline(RUNTIME_GUARDS);
/** The same readings scored as if the verifier were off (the tune-split comparison). */
export const runtimeGuardedPipelineWithoutVerifier: ReadingPipeline = guardedPipeline(RUNTIME_GUARDS, { verifier: false });
