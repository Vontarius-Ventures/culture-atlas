import type { QlooEntity } from '@culture-atlas/providers';
import { echoKey, ECHO_PENALTY, entityProfile, hitSupportsClaim, reasonHit, scoreMatch, STRICT_KINDS, type MatchHit, type StyleMatchResult, type SubjectProfile } from './affinity';
import type { StyleVocabulary } from './vocabulary';
import type { StyleMatchClaim } from './reasons';

/**
 * smatch-1 rail assembly: merges the Qloo lists of one subject, gates and
 * re-ranks every result by its own tags against the reading. Pure.
 */

/** Style share of the final score; the rest is Qloo's own order in the taste lists. */
export const STYLE_SHARE = 0.8;
/** A card must match at least this share of the reference (mean of the 3 best matches): empty beats junk. */
export const MIN_RELATIVE = 0.35;
/** Matches this far above the reference rank as equals on style (Qloo's order then decides). */
export const REL_CAP = 1.5;
/** ... and at least this absolute score (one solid shared word). */
export const MIN_ABSOLUTE = 0.35;
/** With an identified brand in the photo, its own taste neighbours may match the reading more loosely. */
export const MIN_RELATIVE_ENTITY = 0.1;

export interface AffinityList {
  list: readonly QlooEntity[];
  /** Qloo's order in this list is a ranking signal (taste calls); a pool call's order is not. */
  prior: boolean;
  /** The list came from the identified brand's own signal (reason "Close to {brand}"). */
  fromEntity: boolean;
}

export interface AffinityCandidate {
  entity: QlooEntity;
  match: StyleMatchResult;
  score: number;
  fromEntity: boolean;
  /** FILL-1: a same-product taste neighbour of this matched catalogue brand (Qloo explainability), not a word match. */
  via?: string;
}

/** Legacy export only: evidence is never relaxed to fill a card quota. */
export const STRICT_FILL_TO = 4;

export function rankAffinity(
  q: SubjectProfile,
  lists: readonly AffinityList[],
  options: { exclude?: ReadonlySet<string>; entityLinked?: boolean; signalNames?: ReadonlyMap<string, string>; fashion?: boolean; v?: StyleVocabulary; echoNames?: ReadonlySet<string>; admit?: (entity: QlooEntity) => boolean; match?: (entity: QlooEntity) => StyleMatchResult } = {},
): { candidates: AffinityCandidate[]; gated: Record<string, number> } {
  const byId = new Map<string, { entity: QlooEntity; prior: number; fromEntity: boolean }>();
  for (const l of lists)
    l.list.forEach((e, i) => {
      if (options.exclude?.has(e.entity_id)) return;
      const prior = l.prior ? 1 / (1 + i / 8) : 0;
      const prev = byId.get(e.entity_id);
      if (!prev) byId.set(e.entity_id, { entity: e, prior, fromEntity: l.fromEntity });
      else {
        prev.prior = Math.max(prev.prior, prior);
        prev.fromEntity ||= l.fromEntity;
      }
    });
  const gated: Record<string, number> = {};
  const scored: { entity: QlooEntity; prior: number; fromEntity: boolean; match: StyleMatchResult }[] = [];
  for (const x of byId.values()) {
    // Provenance and relevance are separate requirements. Rejected retrievals
    // must not affect the reference scores of eligible candidates either.
    if (options.admit && !options.admit(x.entity)) {
      gated.admission = (gated.admission ?? 0) + 1;
      continue;
    }
    const match = options.match?.(x.entity) ?? scoreMatch(q, entityProfile(x.entity.tags ?? []), { fashion: options.fashion ?? true, v: options.v });
    if (match.gate) {
      gated[match.gate] = (gated[match.gate] ?? 0) + 1;
      continue;
    }
    scored.push({ ...x, match });
  }
  // The reference is the mean of the three best matches, not the single best: one brand that names the
  // exact piece ("Varsity Jacket") must not push every other on-style brand under the bar.
  const top = scored.map((x) => x.match.score).sort((a, b) => b - a).slice(0, 3);
  const ref = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
  const out: AffinityCandidate[] = [];
  const names = new Set<string>();
  for (const x of scored) {
    const rel = ref > 0 ? x.match.score / ref : 0;
    const min = x.fromEntity && options.entityLinked ? MIN_RELATIVE_ENTITY : MIN_RELATIVE;
    const linked = x.fromEntity && options.entityLinked;
    // A card shares a style claim of the reading, not only its product noun (unless the identified
    // brand in the photo links it).
    if (rel < min || x.match.score < (linked ? 0 : MIN_ABSOLUTE) || (!linked && (!reasonHit(x.match.hits) || (!x.match.styleHit && !STRICT_KINDS.includes(q.kind))))) {
      gated.weak = (gated.weak ?? 0) + 1;
      continue;
    }
    // Anchor-brand echo: down-ranked, never removed (a genuinely best echo may still show once).
    const echo = !!options.echoNames?.size && options.echoNames.has(echoKey(x.entity.name));
    if (echo) gated.echo = (gated.echo ?? 0) + 1;
    out.push({ entity: x.entity, match: x.match, fromEntity: x.fromEntity, score: (STYLE_SHARE * (Math.min(rel, REL_CAP) / REL_CAP) + (1 - STYLE_SHARE) * x.prior) * (echo ? ECHO_PENALTY : 1) });
  }
  out.sort((a, b) => b.score - a.score || a.entity.entity_id.localeCompare(b.entity.entity_id));
  // A taste explanation proves a relationship to a signal brand, not the depicted
  // product or style. Weak results never become cards merely to fill four slots.
  // Qloo sometimes lists one brand twice ("Hugo Boss" under two ids): keep the first by name.
  const deduped = out.filter((c) => {
    const k = c.entity.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (names.has(k)) return false;
    names.add(k);
    return true;
  });
  return { candidates: deduped, gated };
}

const CLAIM_SLOTS = new Set(['aesthetics', 'materials', 'lineage', 'era', 'mood', 'construction']);

/** style_match.claims: the reading's own claims the card shares words with (strongest first, one per claim). */
export function matchClaims(hits: readonly MatchHit[]): StyleMatchClaim[] {
  const seen = new Set<string>();
  const out: StyleMatchClaim[] = [];
  for (const h of hits) {
    if (!CLAIM_SLOTS.has(h.slot) || !hitSupportsClaim(h)) continue;
    const key = `${h.slot}:${h.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slot: h.slot as StyleMatchClaim['slot'], name: h.claim, wording: h.wording, tag_id: h.tagId });
    if (out.length >= 3) break;
  }
  return out;
}
