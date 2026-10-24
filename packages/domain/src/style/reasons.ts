import { lowerFirst } from './text';
import type { AcceptedTag } from './map-tags';

/**
 * Per-card reasons from REAL tag overlap only (style design §C.4, template
 * set sr-1). A reason names a claim only when one of the claim's accepted
 * tag ids is on the result; the words are the claim's own (as shown in the
 * style reading), never the Qloo label. Reasons never say "you", never
 * mention people and are at most 90 characters.
 */
export const REASON_TEMPLATES_VERSION = 'sr-1';
export const REASON_MAX_CHARS = 90;

export type ReasonVia = 'overlap' | 'entity' | 'bridge' | 'exemplar';

export interface StyleMatchClaim {
  slot: AcceptedTag['slot'];
  name: string;
  wording: AcceptedTag['wording'];
  tag_id: string;
}

/** recommendations.style_match (C.4). */
export interface StyleMatch {
  subject_id: string;
  claims: StyleMatchClaim[];
  palette: string[];
  via_entity: string | null;
  via: ReasonVia;
  rail: 'more_like_this' | 'cross_domain';
}

const and = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Claims the result shares with the subject, strongest slot first, one entry per claim. */
export function sharedClaims(accepted: readonly AcceptedTag[], resultTagIds: readonly string[]): StyleMatchClaim[] {
  const tags = new Set(resultTagIds);
  const byClaim = new Map<string, StyleMatchClaim & { weight: number; primary: boolean }>();
  for (const t of accepted) {
    if (!tags.has(t.id)) continue;
    const key = `${t.slot}:${t.claimName}`;
    const prev = byClaim.get(key);
    if (!prev || (!prev.primary && t.primary)) byClaim.set(key, { slot: t.slot, name: t.claimName, wording: t.wording, tag_id: t.id, weight: t.weight, primary: t.primary });
  }
  const sorted = [...byClaim.values()].sort((a, b) => b.weight - a.weight);
  // "Classic denim" already says "denim": a claim whose words are inside a stronger claim's adds nothing.
  const fold = (x: string) => ` ${x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const kept = sorted.filter((c, i) => !sorted.some((o, j) => j < i && fold(o.name).includes(fold(c.name))));
  return kept.map(({ weight: _w, primary: _p, ...c }) => c);
}

export interface ReasonInput {
  claims: readonly StyleMatchClaim[];
  /** The subject's palette color names, used only alongside a shared aesthetic. */
  palette: readonly string[];
  via: ReasonVia;
  /** The identified entity in the photo (entity-only fallback) or the bridge (bridge template). */
  entityName?: string | null;
  bridgeName?: string | null;
}

/** An aesthetic reads as a look ("the varsity look"); materials and lineage keep their own words. */
function claimPhrase(c: StyleMatchClaim): string {
  const name = lowerFirst(c.name);
  return c.slot === 'aesthetics' && !/\b(?:look|style|aesthetic|design|wear)$/i.test(name) ? `${name} look` : name;
}

function render(claims: readonly StyleMatchClaim[], palette: readonly string[], input: ReasonInput): string {
  const names = claims.map(claimPhrase);
  if (input.via === 'bridge' && input.bridgeName) return `Linked through ${input.bridgeName}, which shares the ${and(names)}`;
  const paletteClause = palette.length ? ` and the ${and(palette.map((p) => p.toLowerCase()))} palette` : '';
  if (claims.some((c) => c.wording === 'resembles')) return `For the ${and(claims.map((c) => lowerFirst(c.name)))} look your photo resembles${paletteClause}`;
  return `Because of the ${and(names)}${paletteClause}`;
}

/**
 * The reason for one card, or null when nothing overlaps and no entity
 * connects it (an honest absence; never a guessed reason).
 */
export function buildStyleReason(input: ReasonInput): string | null {
  const claims = input.claims.slice(0, 2);
  if (!claims.length) {
    if (input.via === 'entity' && input.entityName) return `Connected to ${input.entityName} in your photo.`.slice(0, REASON_MAX_CHARS);
    return null;
  }
  const palette = claims.some((c) => c.slot === 'aesthetics') ? input.palette.slice(0, 2) : [];
  // Long reasons drop the palette clause first, then the second claim.
  for (const attempt of [
    { c: claims, p: palette },
    { c: claims, p: [] as string[] },
    { c: claims.slice(0, 1), p: [] as string[] },
  ]) {
    const text = render(attempt.c, attempt.p, input);
    if (text.length <= REASON_MAX_CHARS) return text;
  }
  const text = render(claims.slice(0, 1), [], input);
  return `${text.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…`;
}

/** Every attribute a reason names is in the overlap (M-R3 faithfulness): the names it may use. */
export function reasonAttributes(reason: string | null, claims: readonly StyleMatchClaim[]): string[] {
  if (!reason) return [];
  return claims.filter((c) => reason.toLowerCase().includes(c.name.toLowerCase())).map((c) => c.name);
}
