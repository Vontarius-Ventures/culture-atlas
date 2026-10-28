import { createHash } from 'node:crypto';
import { stableStringify } from '../util/stable-json';
import type { Owner } from '../principal';

/**
 * Dedupe keys. "Same input and version reuse an existing job." Keys include the
 * owner so hashing never exposes another user's result.
 */
function ownerKey(owner: Owner): string {
  return owner.kind === 'account' ? `a:${owner.accountId}` : `s:${owner.sessionId}`;
}

function digest(parts: unknown): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex');
}

/** Cache/reuse analysis by owner, image hash, chosen focus and compiler version. */
export function analysisDedupeKey(input: {
  owner: Owner;
  imageSha256: string;
  focus: unknown;
  compilerVersion: string;
  correctionOf?: string;
  /**
   * Set for grant-limited agents (their connection id): they may only reuse
   * their own uploads, so an identical photo the owner analyzed outside the
   * grant is neither revealed (reused: true + id) nor returned unreadable.
   */
  grantContext?: string | null;
}): string {
  const parts: unknown[] = [ownerKey(input.owner), input.imageSha256, input.focus, input.compilerVersion, input.correctionOf ?? null];
  if (input.grantContext) parts.push(`grant:${input.grantContext}`);
  return `analyze_capture:${digest(parts)}`;
}

export function relatedDiscoveryDedupeKey(input: {
  owner: Owner;
  originItemId: string;
  category?: string | null;
  tasteRevision: number;
  grantContext?: string | null;
}): string {
  return `discover_related:${digest([ownerKey(input.owner), input.originItemId, input.category ?? null, input.tasteRevision, input.grantContext ?? null])}`;
}

export function planDedupeKey(input: { planId: string; version: number }): string {
  return `generate_plan:${input.planId}:${input.version}`;
}

export function planReplacementDedupeKey(input: { planId: string; baseVersion: number; section: string; instruction?: string }): string {
  return `replace_plan_section:${digest([input.planId, input.baseVersion, input.section, input.instruction ?? null])}`;
}

/** One active seed per account and taste revision (a re-completion after new picks seeds again). */
export function tasteSeedDedupeKey(input: { owner: Owner; tasteRevision: number }): string {
  return `taste_seed:${digest([ownerKey(input.owner), input.tasteRevision])}`;
}

/** One expand job per account and time-bucketed wave (complete jobs occupy the key). */
export function interestExpandDedupeKey(input: { owner: Owner; wave: number }): string {
  return `interest_expand:${digest([ownerKey(input.owner), input.wave])}`;
}

export function audioAnalysisDedupeKey(input: { owner: Owner; analysisId: string }): string {
  return `analyze_audio:${digest([ownerKey(input.owner), input.analysisId])}`;
}

/**
 * One active graph-projection job per account and unsatisfied intent set. The
 * set of (event id, attempt) pairs is the freshness dimension: attempts grow
 * with every dispatch cycle, so a re-delivery of the same events, a new
 * intent joining the set, or a terminally failed job always produces a fresh
 * job, while concurrent dispatchers seeing the same state compute the same
 * key and dedupe. A completed job's event set is done by definition, so its
 * key never needs to be reused.
 *
 * `catchUpTo` keys support-version catch-up jobs (upgrade reprojection),
 * which have no intent set: their key space is per target version, so a
 * future marker bump can never be blocked by a completed catch-up job of an
 * older version.
 */
export function interestGraphProjectionDedupeKey(input: {
  accountId: string;
  events: readonly { id: string; attempts: number }[];
  catchUpTo?: number;
}): string {
  return `graph_projection:${digest([
    `a:${input.accountId}`,
    ...input.events.map((e) => `${e.id}:${e.attempts}`).sort(),
    ...(input.catchUpTo !== undefined ? [`v:${input.catchUpTo}`] : []),
  ])}`;
}

/**
 * One active graph-expansion job per account and dispatch window. The window
 * is the account's PRE-dispatch `last_expansion_at` stamp, so concurrent
 * sweeps compute the same key (one job) while the stamp the dispatch writes
 * makes the next window's key fresh — a dispatched window can never block the
 * next one. This key is also the LOGICAL identity the durable expansion budget
 * anchors to: redeliveries of the same job reserve against the same budget row.
 */
export function interestGraphExpansionDedupeKey(input: { accountId: string; lastExpansionAt: Date | null }): string {
  return `graph_expansion:${digest([
    `a:${input.accountId}`,
    input.lastExpansionAt ? input.lastExpansionAt.toISOString() : 'never',
  ])}`;
}

/**
 * One research job per (account, subject, object, predicate, subtype) pair: a
 * completed job keeps its key, so a pair is researched once rather than
 * re-bought; a failed or cancelled job frees the key for a fresh dispatch.
 */
export function graphResearchDedupeKey(input: {
  accountId: string;
  subjectNodeId: string;
  objectNodeId: string;
  predicate: string;
  associationSubtype?: string | null;
}): string {
  return `graph_research:${digest([
    `a:${input.accountId}`,
    input.subjectNodeId,
    input.objectNodeId,
    input.predicate,
    input.associationSubtype ?? null,
  ])}`;
}
