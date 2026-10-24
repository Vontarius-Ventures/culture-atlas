import type { QlooEntity } from '@culture-atlas/providers';
import { entityProfile, scoreMatch, STRICT_KINDS, type MatchHit, type StyleMatchResult, type SubjectProfile } from './affinity';
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

/** FILL-1: a filtered product rail (shoes, bags, ...) is topped up to this many cards from Qloo's own taste order. */
export const STRICT_FILL_TO = 4;

export function rankAffinity(
  q: SubjectProfile,
  lists: readonly AffinityList[],
  options: { exclude?: ReadonlySet<string>; entityLinked?: boolean; signalNames?: ReadonlyMap<string, string> } = {},
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
  const weak: typeof scored = [];
  for (const x of byId.values()) {
    const match = scoreMatch(q, entityProfile(x.entity.tags ?? []));
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
    if (rel < min || x.match.score < (linked ? 0 : MIN_ABSOLUTE) || (!linked && !x.match.styleHit && !STRICT_KINDS.includes(q.kind))) {
      gated.weak = (gated.weak ?? 0) + 1;
      weak.push(x);
      continue;
    }
    out.push({ entity: x.entity, match: x.match, fromEntity: x.fromEntity, score: STYLE_SHARE * (Math.min(rel, REL_CAP) / REL_CAP) + (1 - STYLE_SHARE) * x.prior });
  }
  out.sort((a, b) => b.score - a.score || a.entity.entity_id.localeCompare(b.entity.entity_id));
  // FILL-1: a shoe or bag reading often has few style words; Qloo's taste list was already filtered to
  // the product genre and signalled by the best-matching catalogue brands, so its own order tops the
  // rail up, saying which matched brand it shares a taste with (explainability). Region-tied and gated
  // results stay out.
  if (STRICT_KINDS.includes(q.kind) && out.length < STRICT_FILL_TO && options.signalNames?.size) {
    const fill = weak
      .filter((x) => x.prior > 0 && x.match.regionFactor === 1)
      .sort((a, b) => b.prior - a.prior)
      .map((x) => ({ x, via: (x.entity.query?.explainability ?? []).map((e) => options.signalNames!.get(e.entity_id)).find((n): n is string => !!n) }))
      .filter((f) => !!f.via);
    for (const f of fill) {
      if (out.length >= STRICT_FILL_TO) break;
      out.push({ entity: f.x.entity, match: f.x.match, fromEntity: false, score: 0, via: f.via });
    }
  }
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
    if (!CLAIM_SLOTS.has(h.slot)) continue;
    const key = `${h.slot}:${h.claim}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ slot: h.slot as StyleMatchClaim['slot'], name: h.claim, wording: h.wording, tag_id: h.tagId });
    if (out.length >= 3) break;
  }
  return out;
}
