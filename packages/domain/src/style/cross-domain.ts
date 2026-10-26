import type { Category } from '../enums';
import type { StoredSubject } from './types';
import { COLOR_WORDS, echoKey, ECHO_CAP, ECHO_PENALTY, entityProfile, REGION_WORDS, scoreMatch, subjectProfile, type MatchHit, type MatchSlot, type StyleMatchResult } from './affinity';

/**
 * Cross-domain re-ranking (eval r3), pure and deterministic: how the reading
 * judges an entertainment card a Qloo call returned, and when a card without
 * style evidence must go. Lives in style/ so the policy is unit-testable
 * without a stage host; compiler/style-stage.ts keeps thin instance wrappers.
 */

/** TOPIC-1 films are ranked mostly by the reading (their tags: "Midcentury modern", "Decay", "Sushi"), then Qloo's order. */
export const TOPIC_STYLE_SHARE = 0.75;
/** ... and a film is kept only with a real overlap: at least this score, and this share of the best film's. */
export const TOPIC_MIN_SCORE = 0.6;
export const TOPIC_MIN_RELATIVE = 0.45;

export interface CrossDomainOptions {
  /** Wear cards for a garment pass the product gates of its rail (gateFashion). */
  gateFashion?: boolean;
  /** Drop every card whose own tags share no style word with the reading. */
  dropStyleless?: boolean;
  /** Anchor names already surfaced; repeats are down-ranked then capped (echo). */
  echoNames?: ReadonlySet<string>;
}

/**
 * When a cross-domain card is only real with its own style evidence. True when the
 * reading is the only signal at all (no entity signals: measured, a bodybuilding
 * label for a tennis court), and — eval r3, judges' audience-overlap finding — when
 * a fashion bridge fed the rail: a music or film card a garment's co-liked brand
 * pulled in stays only when its own tags name a style word of the reading, so
 * "Crazy Rich Asians" on four different outfits and reggaeton for a varsity jacket
 * no longer ride brand-audience overlap. Wear keeps Qloo's product-filtered order.
 */
export function dropStylelessFor(category: Category, signalled: number, bridged: number): boolean {
  if (signalled === 0) return true;
  return bridged > 0 && (category === 'play' || category === 'watch');
}

/**
 * smatch-1 for cross-domain cards: Qloo's own order, re-ranked by how well each result's own tags
 * match the reading (half and half), so a film tagged "Midcentury design history" or "Culinary
 * cinema" rises for the room or the dish it echoes. Drops a result only for a stated policy:
 * no style evidence, or a repeat of an anchor brand beyond the echo cap — an echo is penalized
 * first, so a genuinely best echo can still show once.
 */
export function rerankCrossDomain<T extends { entity_id: string; name?: string; tags?: { id: string; name: string }[] }>(
  subjects: readonly StoredSubject[],
  entities: readonly T[],
  styleShare = 0.5,
  options: CrossDomainOptions = {},
): T[] {
  // Wear cards for a garment pass the same product and tier gates as its rail (no couture house
  // next to a casual dress, no eyewear house for a jacket).
  const garment = options.gateFashion ? subjects.find((x) => x.category === 'fashion') : undefined;
  const q = garment ? subjectProfile(garment) : null;
  const kept0 = q ? entities.filter((e) => !scoreMatch(q, entityProfile(e.tags ?? [])).gate) : entities;
  // Eval r4 (h71): a play or watch card is a music or film entity, so a genre/period word of the
  // same spelling is not garment style evidence; a wear card is a garment brand whose own tags are.
  const periodGuard = !options.gateFashion;
  let kept = kept0;
  let scored = crossDomainScores(subjects, kept, { periodGuard });
  if (options.dropStyleless) {
    // A real style claim, not any shared word (eval r5): a card matching only a feature or
    // detail word ("ribbed" of a trim, "oil" of a medium) carried `style > 0` and stayed on
    // bridge-fed rails; only a word a shown claim or the label names keeps a card.
    kept = scored.filter((x) => x.styleHit).map((x) => x.e);
    scored = crossDomainScores(subjects, kept, { periodGuard });
  }
  const best = Math.max(0, ...scored.map((x) => x.style));
  if (best <= 0 || kept.length < 2) return dedupeByName(capEchoes([...kept], options.echoNames));
  const echo = (e: T) => !!options.echoNames?.size && !!e.name && options.echoNames.has(echoKey(e.name));
  let echoes = 0;
  const out = scored
    .map((x) => ({ ...x, score: (styleShare * (x.style / best) + (1 - styleShare) / (1 + x.i / 5)) * (echo(x.e) ? ECHO_PENALTY : 1) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .filter((x) => {
      if (!echo(x.e)) return true;
      // At most one card may repeat an anchor brand; repeats beyond that are cut (eval r3, cause 4).
      if (echoes >= ECHO_CAP) return false;
      echoes++;
      return true;
    })
    .map((x) => x.e);
  return dedupeByName(out);
}

/** The echo cap for the degenerate paths (no style signal to re-rank by): keep the best, cut repeats. */
export function capEchoes<T extends { entity_id: string; name?: string }>(entities: readonly T[], echoNames: ReadonlySet<string> | undefined): T[] {
  if (!echoNames?.size) return [...entities];
  let echoes = 0;
  return entities.filter((e) => {
    if (!e.name || !echoNames.has(echoKey(e.name))) return true;
    if (echoes >= ECHO_CAP) return false;
    echoes++;
    return true;
  });
}

/** Two Qloo entities can share one name (eval r5: two "Dunhill" brand ids on one rail): the best-ranked stays, later same-name ids go. */
function dedupeByName<T extends { name?: string }>(entities: readonly T[]): T[] {
  const seen = new Set<string>();
  return entities.filter((e) => {
    if (!e.name) return true;
    const key = echoKey(e.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * TOPIC-1 films: only those whose own Qloo tags share a style claim with the reading ("Midcentury
 * modern", "Urban decay", "Ramen", "Cafe"), strongest first. A topic alone ("design") is not a
 * match: with no overlapping film the Watch rail stays empty rather than showing popular films
 * about something else.
 */
export function topicFilms<T extends { entity_id: string; tags?: { id: string; name: string }[] }>(subjects: readonly StoredSubject[], entities: readonly T[]): T[] {
  const scored = crossDomainScores(subjects, entities).filter((x) => x.styleHit);
  const best = Math.max(0, ...scored.map((x) => x.style));
  if (best < TOPIC_MIN_SCORE) return [];
  return scored
    .filter((x) => x.style >= Math.max(TOPIC_MIN_SCORE, TOPIC_MIN_RELATIVE * best))
    .map((x) => ({ ...x, score: TOPIC_STYLE_SHARE * (x.style / best) + (1 - TOPIC_STYLE_SHARE) / (1 + x.i / 5) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.e);
}

export interface CrossDomainScore<T> {
  e: T;
  i: number;
  style: number;
  styleHit: boolean;
}

/**
 * Eval r4 (h71): art-history periods and classical genres. On a music or film card these name the
 * work's genre or era ("Romantic" = the Romantic period of classical music, "Baroque" = the period),
 * not how a garment looks; a reading word of the same spelling ("sweet romantic", "baroque pearl")
 * is a different sense, so the collision is not a shared *style* word. Live visual subcultures are
 * deliberately absent — "punk", "grunge", "goth", "mod", "bohemian", "varsity", "campus" really are
 * shared between a garment and a card and must keep counting.
 */
export const PERIOD_STYLE_WORDS: ReadonlySet<string> = new Set(
  `romantic romanticism neoromantic baroque rococo classical neoclassical neoclassic renaissance
   medieval byzantine victorian edwardian georgian regency impressionist impressionism expressionist
   expressionism surrealist surrealism cubist cubism dada dadaist symbolist symbolism futurist futurism
   brutalist brutalism constructivist constructivism`.split(/\s+/).filter(Boolean),
);

/**
 * Eval r6 (h28, h29, h47, h48, h71): a film or music tag is mostly a plot, cast or sound keyword, so
 * most words it shares with a garment reading are another sense of the word — "American" (a
 * nationality, from "American collegiate sportswear"), "Club-Ready Rap" (from "Club tennis dress"),
 * "Black and white scene" (a palette), "2010s" (a release decade), "Polished" (a mood), "Suit and
 * tie" or "Heart on sleeve" (a garment noun or a construction word). Only a word of the reading's
 * own aesthetic, lineage or material claim, written in the tag itself ("Sneakers", "Satin"), is
 * garment style evidence on such a card. A word reached by folding ("kicks" -> sneaker) is not.
 */
const CLAIM_SLOTS: ReadonlySet<MatchSlot> = new Set(['aesthetics', 'lineage', 'materials']);
// "american" is folded into, but not listed in, REGION_WORDS (it is the catalogue's default market).
const SENSE_COLLISION_WORDS: ReadonlySet<string> = new Set(['american', 'club', 'jersey']);

function isCrossDomainClaimHit(h: MatchHit): boolean {
  if (h.level !== 'name' || !CLAIM_SLOTS.has(h.slot)) return false;
  const t = h.token;
  if (COLOR_WORDS.has(t) || REGION_WORDS.has(t) || PERIOD_STYLE_WORDS.has(t) || SENSE_COLLISION_WORDS.has(t) || /\d/.test(t)) return false;
  return h.label
    .toLowerCase()
    .split(/[^\p{L}]+/u)
    .some((w) => w.length >= 3 && (w.startsWith(t) || (t.startsWith(w) && w.length >= 4)));
}

/** Strike a match's genre/period hits and re-derive the score and style claim from what is left. */
function withoutPeriodWords(m: StyleMatchResult): { score: number; styleHit: boolean } {
  if (!m.hits.some((h) => PERIOD_STYLE_WORDS.has(h.token))) return { score: m.score, styleHit: m.styleHit };
  const raw = m.hits.reduce((t, h) => t + h.contribution, 0);
  if (raw <= 0) return { score: 0, styleHit: false };
  const kept = m.hits.filter((h) => !PERIOD_STYLE_WORDS.has(h.token));
  const keptRaw = kept.reduce((t, h) => t + h.contribution, 0);
  const nameShare = kept.filter((h) => h.slot !== 'entity' && h.level === 'name').reduce((t, h) => t + h.contribution, 0);
  return { score: m.score * (keptRaw / raw), styleHit: nameShare > 0 && nameShare >= 0.35 * keptRaw };
}

export interface CrossDomainScoreOptions {
  /**
   * Eval r4 (h71): score a cross-domain card against a garment reading by style words only, so a
   * genre or period term it shares with the reading ("Romantic" for a "sweet romantic" dress) is
   * not evidence. Off for a wear rail, whose cards are garment brands and whose own tags really are
   * garment style.
   */
  periodGuard?: boolean;
}

/** Each entity's own tags scored against every subject of the reading (best subject wins). */
export function crossDomainScores<T extends { entity_id: string; tags?: { id: string; name: string }[] }>(
  subjects: readonly StoredSubject[],
  entities: readonly T[],
  options: CrossDomainScoreOptions = {},
): CrossDomainScore<T>[] {
  const profiles = subjects.map((x) => subjectProfile(x));
  return entities.map((e, i) => {
    const prof = entityProfile(e.tags ?? []);
    let style = 0;
    let styleHit = false;
    for (let s = 0; s < profiles.length; s++) {
      const m = scoreMatch(profiles[s]!, prof, { fashion: false });
      // A garment reading's cross-domain (music/film) evidence must be a style word, not a genre or
      // period term of the same spelling (eval r4, h71: Beethoven/Schubert/Brahms for a mint dress).
      const garment = options.periodGuard && subjects[s]!.category === 'fashion';
      const kept = garment ? withoutPeriodWords(m) : m;
      if (kept.score > style) {
        style = kept.score;
        styleHit = kept.styleHit && (!garment || m.hits.some(isCrossDomainClaimHit));
      }
    }
    return { e, i, style, styleHit };
  });
}
