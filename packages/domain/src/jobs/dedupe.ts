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
