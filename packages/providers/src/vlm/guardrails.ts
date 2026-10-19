import {
  COLOURS,
  FASHION,
  FILM,
  FILM_PHRASES,
  FOOD,
  FOOD_EVIDENCE,
  FOOD_NAME_ENDINGS,
  FOOD_PHRASES,
  GENERIC_NOUNS,
  GENERIC_QUALIFIERS,
  MAKERS,
  MATERIALS,
  MUSIC,
  MUSIC_PHRASES,
  STOP,
  foldText,
  hasPhrase,
  isNonLatin,
  nameTokens,
} from './lexicons';
import {
  candidateNameKey,
  type VlmAnalysis,
  type VlmCandidate,
  type VlmDomain,
  type VlmEvidence,
  type VlmMergeContext,
  type VLM_CATEGORIES,
} from './types';

/**
 * Deterministic reading guardrails (docs/quality-plan.md §4, guard-v1).
 *
 * The model proposes; this module decides what may reach Qloo or the screen.
 * It is pure (no I/O, no clock, no randomness): the same reading always gets
 * the same decisions, and every decision names the rules that fired, so the
 * compiler can record them in the analysis trace for the inspector and the
 * scorer.
 *
 * Hold, then confirm: risky stage-1 claims (brands, names of places or works
 * that do not match the text read, low-certainty resemblances, styles read
 * off a sign) are held instead of published. Stage 2's verdict on a held
 * claim is binding because nothing was published from it; if stage 2 is off
 * or fails, held claims are dropped (fail closed). A card that is already
 * published is never removed (FAST-02): a stage-2 "unsupported" on it stays
 * an advisory veto.
 */
export const GUARDRAIL_VERSION = 'guard-v1';

/** Neutral analysis title when G-MEDIUM leaves too little of the model's title and nothing is publishable. */
export const NEUTRAL_TITLE = 'What stood out in your photo';
/** Neutral interpretation when G-MEDIUM leaves too little of the model's sentence. */
export const NEUTRAL_INTERPRETATION = 'A few references stood out in this photo.';

export type GuardAction = 'publish' | 'hold' | 'demote' | 'drop';
export type GuardRule =
  | 'G-QUAL'
  | 'G-MEDIUM'
  | 'G-PERSON-ROLE'
  | 'G-IDENTITY'
  | 'G-STYLE-OF'
  | 'G-CUISINE-FOOD'
  | 'G-FLOOR'
  | 'G-DEPICTED'
  | 'G-GENERIC'
  | 'G-BRAND'
  | 'G-PLACE'
  | 'G-TEXT-ECHO'
  | 'G-LOWCERT'
  | 'G-ADDITION-FLOOR'
  | 'G-VERDICT'
  | 'G-BRAND-CORROBORATE'
  | 'G-CATEGORY'
  // Additive (not candidate rules): visible_text and observation filters, counted in `dropped`.
  | 'G-VTEXT'
  | 'G-PERSON-OBS';

export interface GuardDecision {
  candidateId: string;
  /** The candidate's name; '[withheld]' when a person rule dropped it, so no name reaches the trace. */
  name: string;
  action: GuardAction;
  rules: GuardRule[];
  note?: string;
}

/** A candidate after the guardrails: domain and evidence are always filled (schema value or §4.4 inference). */
export type GuardedCandidate = VlmCandidate & { domain: VlmDomain; evidence: VlmEvidence };

type Category = (typeof VLM_CATEGORIES)[number];

export interface Stage1Guard {
  /** Publish-only candidates, sanitized (relation, categories, domain, evidence, tag query); demoted ones as observations. */
  analysis: VlmAnalysis;
  /** Claims kept back for stage-2 confirmation; never published, resolved or anchored before it. */
  held: VlmCandidate[];
  /** Generic objects kept only as `object` observations; never resolved or anchored. */
  demoted: VlmCandidate[];
  decisions: GuardDecision[];
  /** The title or the interpretation was rewritten by G-MEDIUM. */
  titleChanged: boolean;
  /** Visible-text entries and observations removed (counts only; their text never reaches the trace). */
  dropped: { visibleText: number; observations: number };
}

export interface Stage2Guard {
  /** Held claims that passed stage 2, then additions that passed, in that order (to append after published cards). */
  publishNow: VlmCandidate[];
  /** Names of published stage-1 candidates stage 2 does not support: advisory only (certainty x 0.5), never removed. */
  advisoryVetoes: string[];
  /** Ids in publishNow that publish only as a resembling, non-anchor reference (a weak verdict on a held style). */
  nonAnchorIds: string[];
  /** Published candidates, then publishNow; sanitized visible text and observations; title unchanged. */
  analysis: VlmAnalysis;
  decisions: GuardDecision[];
  dropped: { visibleText: number; observations: number };
}

// ---- rule patterns (§4.2, exact) -------------------------------------------

export const VTEXT_RE =
  /illegib|unreadabl|blur|placard|label cards?|resolution|characters are|text (is |on )|appears to|written in|licen[cs]e plate|number plate|registration/i;
/** The plan's list plus mouth/lips/teeth/grimace (the v2 smoke described "his mouth open mid-gesture"). */
export const PERSON_OBS_RE =
  /\b(hair|haired|bald|shaved|beard|moustache|mustache|face|facial|expression|smil\w*|frown\w*|grimac\w*|mouth|lips|teeth|serious|age[ds]?|young|elderly|middle-aged|teen\w*|skin|complexion|eyes|physique|build|body)\b/i;
export const MEDIUM_RE =
  /\b(still[- ]?life|paintings?|painted|illustrat\w*|drawings?|sketch(es)?|render(ing)?|watercolou?r|oil on canvas|vector|cartoons?|clip ?art|photographs?|digital art)\b/i;
export const ROLE_RE =
  /\b(coach\w*|player|athlete|referee|manager|politician|president|minister|celebrity|actor|actress|singer|ceo)\b/i;
export const PEOPLE_RE = /\b(man|men|woman|women|person|people|crowd)\b/i;
/**
 * "Eames-style lounge chair", "Shaker-inspired cabinet", "Eames style chair".
 * Narrower than the plan's /^(\S+)[- ](style|inspired)\b/: a bare style name
 * such as "Empire style" (a real style the plan keeps, §4.5) does not match.
 */
export const STYLE_OF_RE = /^(\S+)(?:-(?:style|inspired)\b|\s(?:style|inspired)\s+\S)/i;

const FLOOR = 0.25;
const DEPICTED_MIN = 0.5;
const PLACE_MIN = 0.5;
const LOWCERT_MAX = 0.35;
const ADDITION_MIN = 0.5;
const DEPICTED_EVIDENCE: ReadonlySet<VlmEvidence> = new Set(['read_text', 'logo', 'distinctive_form']);

// ---- token helpers -----------------------------------------------------------

const contentTokens = (name: string): string[] => nameTokens(name).filter((t) => !STOP.has(t));
const isGenericToken = (t: string): boolean =>
  GENERIC_NOUNS.has(t) || COLOURS.has(t) || MATERIALS.has(t) || GENERIC_QUALIFIERS.has(t);

/** `token` (already folded) occurs in `text` as a whole token; non-Latin tokens may occur inside a longer run. */
function textHasToken(text: string, token: string): boolean {
  if (!token) return false;
  if (nameTokens(text).includes(token)) return true;
  return isNonLatin(token) && foldText(text).includes(token);
}

/** First content token of a name (not a stop word). */
function headContentToken(name: string): string | null {
  return contentTokens(name)[0] ?? null;
}

/**
 * The brand's own word: the first content token that is not a generic noun
 * or qualifier. "Spalding NBA basketball" -> spalding, "Cannondale CAAD8" -> cannondale.
 */
export function brandHeadToken(name: string): string | null {
  return contentTokens(name).find((t) => !GENERIC_NOUNS.has(t) && !GENERIC_QUALIFIERS.has(t)) ?? null;
}

/** Words after the first that are written with a capital (or in caps/digits) and are not generic. */
function properTokensAfterFirst(name: string): string[] {
  const words = name.trim().split(/\s+/).slice(1);
  const out: string[] = [];
  for (const word of words) {
    const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    // "X-Trail", "NBA", "CAAD8", "911S": a capital first letter, or a digit-led code with capitals.
    const capital = /^\p{Lu}/u.test(clean) || (/^\p{N}/u.test(clean) && /\p{Lu}/u.test(clean));
    if (!capital) continue;
    for (const t of nameTokens(clean)) if (!STOP.has(t) && !isGenericToken(t)) out.push(t);
  }
  return out;
}

// ---- domain, categories, evidence (§4.3, §4.4) -------------------------------

function inferDomain(c: Pick<VlmCandidate, 'name' | 'type' | 'tag_queries'>): VlmDomain {
  if (c.type === 'cuisine') return 'food';
  const folded = foldText([c.name, ...c.tag_queries].join(' '));
  const tokens = folded ? folded.split(' ') : [];
  const any = (words: ReadonlySet<string>, phrases: readonly string[] = []) =>
    tokens.some((t) => words.has(t)) || phrases.some((p) => hasPhrase(folded, p));
  if (any(FOOD, FOOD_PHRASES)) return 'food';
  if (any(FASHION)) return 'fashion';
  if (any(MUSIC, MUSIC_PHRASES)) return 'music';
  if (any(FILM, FILM_PHRASES)) return 'film';
  return 'other';
}

/** The candidate's domain: the schema value (reading v2), else lexicon inference (§4.4). */
export function domainOf(c: Pick<VlmCandidate, 'name' | 'type' | 'tag_queries'> & { domain?: VlmDomain | null }): VlmDomain {
  return c.domain ?? inferDomain(c);
}

/**
 * G-CATEGORY (§4.3): a fixed table from domain (or type cuisine) to discovery
 * categories. Architecture, interiors, design, craft, art, vehicles, sport,
 * places, signage, people and other get none: they stay under "Explore the
 * references" and still act as cross-domain taste signals.
 */
export function categoriesFor(c: Pick<VlmCandidate, 'name' | 'type' | 'tag_queries'> & { domain?: VlmDomain | null }): Category[] {
  const domain = domainOf(c);
  if (c.type === 'cuisine' || domain === 'food') return ['eat'];
  if (domain === 'fashion') return ['wear'];
  if (domain === 'music') return ['play'];
  if (domain === 'film') return ['watch'];
  return [];
}

/** Evidence for a candidate: the schema value, else read_text when a specific name token is in the visible text (§4.4). */
function evidenceFor(c: VlmCandidate, texts: readonly string[]): { evidence: VlmEvidence; evidence_text: string | null } {
  if (c.evidence) {
    const withText = c.evidence === 'read_text' || c.evidence === 'logo';
    return { evidence: c.evidence, evidence_text: withText ? (c.evidence_text?.trim() || null) : null };
  }
  const specific = contentTokens(c.name).filter((t) => !isGenericToken(t) && (t.length >= 3 || isNonLatin(t)));
  // The entry that names the head word wins; otherwise the one sharing the most specific words.
  const head = headContentToken(c.name);
  let best: { text: string; score: number } | null = null;
  for (const text of texts) {
    const shared = specific.filter((t) => textHasToken(text, t)).length;
    if (!shared) continue;
    const score = shared + (head && textHasToken(text, head) ? 100 : 0);
    if (!best || score > best.score) best = { text, score };
  }
  return best ? { evidence: 'read_text', evidence_text: best.text.slice(0, 60) } : { evidence: 'context', evidence_text: null };
}

/**
 * Brand-like (G-BRAND): type brand; evidence logo; a maker name; or an object
 * or work with a capitalized, non-generic word after the first ("Nissan
 * X-Trail", "Spalding NBA basketball", "London Routemaster").
 */
export function isBrandLike(c: Pick<VlmCandidate, 'name' | 'type'> & { evidence?: VlmEvidence | null }): boolean {
  if (c.type === 'brand' || c.evidence === 'logo') return true;
  if (contentTokens(c.name).some((t) => MAKERS.has(t))) return true;
  return (c.type === 'object' || c.type === 'work') && properTokensAfterFirst(c.name).length > 0;
}

// ---- visible text, observations, title (G-VTEXT, G-PERSON-OBS, G-MEDIUM) ----

/** G-VTEXT: visible_text holds verbatim transcriptions only; descriptions of text are dropped. */
export function sanitizeVisibleText(texts: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const text of texts) {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const longPlain = words > 12 && !/["'“”‘’«»\d]/.test(text);
    (VTEXT_RE.test(text) || longPlain ? dropped : kept).push(text);
  }
  return { kept, dropped };
}

/** G-PERSON-OBS: no hair, face, skin, age, body or expression descriptions. */
export function sanitizeObservations(obs: VlmAnalysis['observations']): { kept: VlmAnalysis['observations']; dropped: VlmAnalysis['observations'] } {
  const kept: VlmAnalysis['observations'] = [];
  const dropped: VlmAnalysis['observations'] = [];
  for (const o of obs) (PERSON_OBS_RE.test(o.text) ? dropped : kept).push(o);
  return { kept, dropped };
}

const MEDIUM_PHRASE_RE = new RegExp(
  `(?:\\b(?:a|an|the)\\s+)?${MEDIUM_RE.source}(?:\\s+(?:of|with|in)\\b)?`,
  'gi',
);
/** Dangling words left at either end after a medium phrase is removed (articles only at the end). */
const LEADING_CONNECTORS = /^(?:and|or|of|with|in|&|-|–|,|:|;)$/i;
const TRAILING_CONNECTORS = /^(?:and|or|of|with|in|a|an|the|&|-|–|,|:|;)$/i;

/** Removes medium phrases and tidies the connectors left behind. */
function stripMedium(text: string): string {
  const words = text
    .replace(MEDIUM_PHRASE_RE, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\b(and|or)\s+\1\b/gi, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length && LEADING_CONNECTORS.test(words[0]!)) words.shift();
  while (words.length && TRAILING_CONNECTORS.test(words[words.length - 1]!.replace(/[.,;:]$/, ''))) words.pop();
  const out = words.join(' ').replace(/^[,;:\s]+|[,;:\s]+$/g, '');
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}
const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// ---- candidate rules (§4.2) ----------------------------------------------------

interface ReadingFacts {
  title: string;
  interpretation: string;
  mentionsPeople: boolean;
  /** Food words in the title/interpretation, or (stage 2) an observation of kind food. */
  foodText: boolean;
  /** The candidates that can show depicted food (by id). */
  candidates: readonly VlmCandidate[];
  texts: readonly string[];
}

interface Verdict {
  action: GuardAction;
  rules: GuardRule[];
  candidate: VlmCandidate;
  /** Set by G-STYLE-OF when the dropped "X-style" candidate is replaced by its tag query as a style. */
  replacement?: VlmCandidate;
  note?: string;
}

function readingFacts(
  a: Pick<VlmAnalysis, 'title' | 'interpretation' | 'observations' | 'candidates'>,
  texts: readonly string[],
  stage2: boolean,
): ReadingFacts {
  const head = `${a.title} ${a.interpretation}`;
  const headTokens = nameTokens(head);
  return {
    title: a.title,
    interpretation: a.interpretation,
    mentionsPeople:
      PEOPLE_RE.test(head) ||
      a.observations.some((o) => o.kind === 'person_style') ||
      a.candidates.some((c) => c.domain === 'people'),
    foodText:
      headTokens.some((t) => FOOD_EVIDENCE.has(t)) ||
      FOOD_PHRASES.some((p) => hasPhrase(foldText(head), p)) ||
      (stage2 && a.observations.some((o) => o.kind === 'food')),
    candidates: a.candidates,
    texts,
  };
}

function isFoodReference(c: VlmCandidate): boolean {
  if (c.type === 'cuisine') return true;
  const tokens = nameTokens(c.name);
  return tokens.length > 0 && FOOD_NAME_ENDINGS.has(tokens[tokens.length - 1]!);
}

/**
 * Applies the candidate rules in plan order. The first drop wins (later
 * rules are not evaluated); every rule that fired before it is recorded.
 * Hold beats demote; both continue through the remaining rules.
 */
function evaluate(
  input: VlmCandidate,
  facts: ReadingFacts,
  opts: { stage: 1 | 2; twoStage: boolean; addition: boolean },
): Verdict {
  const rules: GuardRule[] = [];
  const ev = evidenceFor(input, facts.texts);
  let c: VlmCandidate = {
    ...input,
    ...ev,
    domain: domainOf(input),
    tag_queries:
      ['style', 'tradition', 'cuisine'].includes(input.type) && !input.tag_queries.some((t) => t.trim())
        ? [input.name]
        : input.tag_queries,
  };
  let replacement: VlmCandidate | undefined;
  const drop = (rule: GuardRule, note?: string): Verdict => ({
    action: 'drop',
    rules: [...rules, rule],
    candidate: c,
    ...(replacement ? { replacement } : {}),
    ...(note ? { note } : {}),
  });
  let hold = false;
  let demote = false;

  // G-MEDIUM: medium words in the name or tag query, unless a labelled artwork.
  const labelledArt = (c.type === 'work' || c.type === 'creator') && c.evidence === 'read_text';
  if (!labelledArt && (MEDIUM_RE.test(c.name) || c.tag_queries.some((t) => MEDIUM_RE.test(t)))) return drop('G-MEDIUM');
  // G-PERSON-ROLE: roles inferred for people in the photo.
  if (ROLE_RE.test(c.name) && facts.mentionsPeople) return drop('G-PERSON-ROLE');
  // G-IDENTITY: no creator or person unless their name is read in the photo.
  if (c.type === 'creator' || c.domain === 'people') {
    const named =
      c.evidence === 'read_text' &&
      !!c.evidence_text &&
      contentTokens(c.name).some((t) => textHasToken(c.evidence_text!, t));
    if (!named) return drop('G-IDENTITY');
  }
  // G-STYLE-OF: "Eames-style lounge chair" -> the style itself, if a tag query names it.
  if (STYLE_OF_RE.test(c.name)) {
    const tq = c.tag_queries.find((t) => t.trim());
    if (!tq) return drop('G-STYLE-OF');
    rules.push('G-STYLE-OF');
    replacement = {
      ...c,
      name: tq.trim(),
      type: 'style',
      relation: 'resembles',
      tag_queries: [tq.trim()],
      evidence: 'context',
      evidence_text: null,
      domain: input.domain ?? inferDomain({ name: tq, type: 'style', tag_queries: [tq] }),
    };
    c = replacement;
  }
  // G-CUISINE-FOOD: a cuisine needs food in the photo.
  if (isFoodReference(c)) {
    const otherFood = facts.candidates.some(
      (o) => o.id !== input.id && o.relation === 'depicted' && domainOf(o) === 'food',
    );
    if (!facts.foodText && !otherFood) return drop('G-CUISINE-FOOD');
  }
  // G-FLOOR.
  if (c.certainty < FLOOR) return drop('G-FLOOR');
  // G-DEPICTED: "depicted" needs real evidence.
  if (c.relation === 'depicted' && (c.certainty < DEPICTED_MIN || !DEPICTED_EVIDENCE.has(c.evidence!))) {
    rules.push('G-DEPICTED');
    c = { ...c, relation: 'resembles' };
  }
  // G-GENERIC: every content token is generic -> an observation, not a reference.
  // Also for styles and traditions ("Kraft paper", "Marble staircase"): the plan maps
  // filler activities (E4/E5) to this rule, and they arrive typed as style or tradition.
  if (c.type === 'object' || c.type === 'cuisine' || c.type === 'style' || c.type === 'tradition') {
    if (contentTokens(c.name).every(isGenericToken)) {
      rules.push('G-GENERIC');
      demote = true;
    }
  }
  // G-BRAND: brands never publish from stage 1 alone.
  const brandLike = isBrandLike(c);
  if (brandLike && opts.stage === 1) {
    if (!opts.twoStage) return drop('G-BRAND', 'no_stage_2');
    rules.push('G-BRAND');
    hold = true;
  }
  // G-PLACE: an uncertain resembled place is not a reference.
  if (c.type === 'place' && c.relation === 'resembles' && c.certainty < PLACE_MIN && c.evidence !== 'read_text')
    return drop('G-PLACE');
  // G-TEXT-ECHO: a name that does not match the text it was read from, or a style read off a sign.
  if (c.evidence === 'read_text') {
    if (c.type === 'place' || c.type === 'work' || c.type === 'creator') {
      const head = headContentToken(c.name);
      if (!head || !c.evidence_text || !textHasToken(c.evidence_text, head)) {
        rules.push('G-TEXT-ECHO');
        hold = true;
      }
    } else if (c.type === 'style' || c.type === 'tradition') {
      rules.push('G-TEXT-ECHO');
      hold = true;
    }
  }
  // G-LOWCERT: low-certainty resemblances wait for stage 2.
  if (c.relation === 'resembles' && c.certainty <= LOWCERT_MAX) {
    rules.push('G-LOWCERT');
    hold = true;
  }
  if (opts.stage === 2 && opts.addition) {
    if (c.certainty < ADDITION_MIN) return drop('G-ADDITION-FLOOR');
  }
  // A generic thing is never a reference, whatever stage 2 would say about it: demote beats hold.
  const action: GuardAction = demote ? 'demote' : hold ? 'hold' : 'publish';
  return { action, rules, candidate: c, ...(replacement ? { replacement } : {}) };
}

/**
 * G-BRAND-CORROBORATE (a): the stage-2 transcription that contains the
 * brand's head token in full (at least 3 characters; 2 for non-Latin script),
 * or null.
 */
function corroboratingText(name: string, stage2Texts: readonly string[]): string | null {
  const head = brandHeadToken(name);
  if (!head || (head.length < 3 && !(isNonLatin(head) && head.length >= 2))) return null;
  return stage2Texts.find((t) => textHasToken(t, head)) ?? null;
}
const corroboratedByText = (name: string, stage2Texts: readonly string[]) => corroboratingText(name, stage2Texts) !== null;

function finalize(c: VlmCandidate): VlmCandidate {
  return { ...c, suggested_categories: categoriesFor(c) };
}

const PERSON_RULES: ReadonlySet<GuardRule> = new Set(['G-IDENTITY', 'G-PERSON-ROLE']);
function decision(c: VlmCandidate, action: GuardAction, rules: GuardRule[], note?: string): GuardDecision {
  const withheld = action === 'drop' && rules.some((r) => PERSON_RULES.has(r));
  return { candidateId: c.id, name: withheld ? '[withheld]' : c.name, action, rules, ...(note ? { note } : {}) };
}

function demotedObservation(c: VlmCandidate, id: string): VlmAnalysis['observations'][number] {
  return { id, text: c.name, kind: 'object', region_ids: [...c.region_ids] };
}

function nextObservationId(used: readonly { id: string }[]): string {
  const taken = new Set(used.map((o) => o.id));
  let n = used.length + 1;
  while (taken.has(`o${n}`)) n++;
  return `o${n}`;
}

function sanitizeHeadline(a: VlmAnalysis, publishable: readonly VlmCandidate[]): { title: string; interpretation: string; changed: boolean } {
  let title = a.title;
  let interpretation = a.interpretation;
  if (MEDIUM_RE.test(title)) {
    const stripped = stripMedium(title);
    title = wordCount(stripped) >= 2 ? stripped : (publishable[0]?.name.slice(0, 60) ?? NEUTRAL_TITLE);
  }
  if (MEDIUM_RE.test(interpretation)) {
    const stripped = stripMedium(interpretation);
    interpretation = wordCount(stripped) >= 2 ? stripped : NEUTRAL_INTERPRETATION;
  }
  return { title, interpretation, changed: title !== a.title || interpretation !== a.interpretation };
}

// ---- stage 1 -------------------------------------------------------------------

/**
 * Guards a stage-1 reading (a two-stage quick read, a v2 frame aggregate, or
 * the legacy full reading) before anything is resolved or published.
 * `twoStage` says whether a stage-2 enrichment can still confirm held claims;
 * without it, claims that would be held are dropped.
 */
export function guardQuickRead(a: VlmAnalysis, ctx: { twoStage: boolean }): Stage1Guard {
  const texts = sanitizeVisibleText(a.visible_text.map((t) => t.text));
  const keptText = new Set(texts.kept);
  const obs = sanitizeObservations(a.observations);
  const base: VlmAnalysis = {
    ...structuredClone(a),
    visible_text: a.visible_text.filter((t) => keptText.has(t.text)).map((t) => ({ ...t })),
    observations: obs.kept.map((o) => ({ ...o, region_ids: [...o.region_ids] })),
  };
  const dropped = { visibleText: texts.dropped.length, observations: obs.dropped.length };
  const decisions: GuardDecision[] = [];

  // G-QUAL: an unusable or flawed photo publishes no candidates at all.
  if (!a.quality.usable || a.quality.issue !== null) {
    for (const c of a.candidates) decisions.push(decision(c, 'drop', ['G-QUAL']));
    const headline = sanitizeHeadline(base, []);
    return {
      analysis: {
        ...base,
        title: headline.title,
        interpretation: headline.interpretation,
        candidates: [],
        quality: { usable: false, issue: a.quality.issue },
      },
      held: [],
      demoted: [],
      decisions,
      titleChanged: headline.changed,
      dropped,
    };
  }

  const facts = readingFacts(base, texts.kept, false);
  const publish: VlmCandidate[] = [];
  const held: VlmCandidate[] = [];
  const demoted: VlmCandidate[] = [];
  const names = new Set<string>();
  for (const original of base.candidates) {
    const v = evaluate(original, facts, { stage: 1, twoStage: ctx.twoStage, addition: false });
    let rules = v.rules;
    if (v.replacement) {
      // The "X-style" candidate is dropped; its replacement gets its own decision.
      decisions.push(decision(original, 'drop', ['G-STYLE-OF'], 'replaced_by_tag_query'));
      rules = rules.filter((r) => r !== 'G-STYLE-OF');
    }
    if (v.action === 'drop') {
      decisions.push(decision(v.candidate, 'drop', rules, v.note));
      continue;
    }
    // A replacement that repeats another candidate's name adds nothing.
    const key = candidateNameKey(v.candidate.name);
    if (names.has(key)) {
      decisions.push(decision(v.candidate, 'drop', rules, 'duplicate'));
      continue;
    }
    names.add(key);
    decisions.push(decision(v.candidate, v.action, rules, v.note));
    const out = finalize(v.candidate);
    if (v.action === 'hold') held.push(out);
    else if (v.action === 'demote') demoted.push(out);
    else publish.push(out);
  }
  for (const d of decisions) if (d.action === 'publish') d.rules.push('G-CATEGORY');

  const observations = [...base.observations];
  for (const c of demoted) observations.push(demotedObservation(c, nextObservationId(observations)));
  const headline = sanitizeHeadline(base, publish);
  return {
    analysis: { ...base, title: headline.title, interpretation: headline.interpretation, observations, candidates: publish },
    held,
    demoted,
    decisions,
    titleChanged: headline.changed,
    dropped,
  };
}

// ---- stage 2 -------------------------------------------------------------------

/**
 * Guards a merged stage-2 reading. `published` is the stage-1 guard's
 * analysis (what was published), `held` its held claims, and `merged`/`merge`
 * the result of mergeEnrichmentContext(published, enrichment, held).
 *  - published candidates stay, in order (FAST-02); an unsupported verdict is
 *    reported as an advisory veto;
 *  - held claims: no entry or unsupported -> drop; weak -> drop for
 *    brand-like, place, work and creator (and objects and cuisines), publish
 *    as a resembling non-anchor for styles and traditions; supported ->
 *    publish, brand-like only with G-BRAND-CORROBORATE (G-VERDICT);
 *  - additions: the stage-1 rules plus G-ADDITION-FLOOR; a claim that would
 *    be held has nothing left to confirm it and is dropped; brand-like
 *    additions publish only with G-BRAND-CORROBORATE.
 */
export function guardEnrichment(input: {
  published: VlmAnalysis;
  held: VlmCandidate[];
  merged: VlmAnalysis;
  merge: VlmMergeContext;
}): Stage2Guard {
  const { published, merged, merge } = input;
  const texts = sanitizeVisibleText(merged.visible_text.map((t) => t.text));
  const keptText = new Set(texts.kept);
  const stage2Texts = merge.stage2Text.filter((t) => keptText.has(t));
  const obs = sanitizeObservations(merged.observations);
  const usable = published.quality.usable && published.quality.issue === null;
  const byId = new Map(merged.candidates.map((c) => [c.id, c]));
  const verdictOf = (c: VlmCandidate) => merge.verdicts[candidateNameKey(c.name)];
  const decisions: GuardDecision[] = [];

  const publishedIds = new Set(published.candidates.map((c) => c.id));
  const kept = merged.candidates.filter((c) => publishedIds.has(c.id));
  const advisoryVetoes = kept.filter((c) => verdictOf(c) === 'unsupported').map((c) => c.name);

  const facts = readingFacts(
    { ...merged, title: published.title, interpretation: published.interpretation, observations: merged.observations },
    texts.kept,
    true,
  );
  const publishNow: VlmCandidate[] = [];
  const nonAnchorIds: string[] = [];
  const demotedObs: VlmCandidate[] = [];
  const names = new Set(kept.map((c) => candidateNameKey(c.name)));
  const accept = (c: VlmCandidate, rules: GuardRule[], note?: string) => {
    const key = candidateNameKey(c.name);
    if (names.has(key)) {
      decisions.push(decision(c, 'drop', rules, 'duplicate'));
      return false;
    }
    names.add(key);
    decisions.push(decision(c, 'publish', [...rules, 'G-CATEGORY'], note));
    publishNow.push(finalize(c));
    return true;
  };

  for (const id of merge.heldIds) {
    const c = byId.get(id);
    if (!c) continue;
    const guarded = { ...c, ...evidenceFor(c, texts.kept), domain: domainOf(c) };
    if (!usable) {
      decisions.push(decision(guarded, 'drop', ['G-QUAL']));
      continue;
    }
    const verdict = verdictOf(c);
    const brandLike = isBrandLike(guarded);
    const strong = brandLike || ['place', 'work', 'creator'].includes(c.type);
    if (!verdict || verdict === 'unsupported') {
      decisions.push(decision(guarded, 'drop', ['G-VERDICT'], verdict ?? 'no_confirmation'));
      continue;
    }
    if (verdict === 'weak') {
      if (strong || !['style', 'tradition'].includes(c.type)) {
        decisions.push(decision(guarded, 'drop', ['G-VERDICT'], 'weak'));
        continue;
      }
      if (accept({ ...guarded, relation: 'resembles' }, ['G-VERDICT'], 'weak: resembles, non-anchor')) nonAnchorIds.push(c.id);
      continue;
    }
    if (brandLike) {
      const read = corroboratingText(c.name, stage2Texts);
      if (!read) {
        decisions.push(decision(guarded, 'drop', ['G-VERDICT', 'G-BRAND-CORROBORATE'], 'not_read_at_stage_2'));
        continue;
      }
      // Its name is now read in the photo: the claim rests on text, and is depicted when certain enough.
      accept(
        {
          ...guarded,
          evidence: 'read_text',
          evidence_text: read.slice(0, 60),
          relation: guarded.certainty >= DEPICTED_MIN ? 'depicted' : 'resembles',
        },
        ['G-VERDICT', 'G-BRAND-CORROBORATE'],
      );
      continue;
    }
    accept(guarded, ['G-VERDICT']);
  }

  for (const id of merge.additionIds) {
    const c = byId.get(id);
    if (!c) continue;
    if (!usable) {
      decisions.push(decision(c, 'drop', ['G-QUAL']));
      continue;
    }
    const v = evaluate(c, facts, { stage: 2, twoStage: true, addition: true });
    const candidate = v.candidate;
    if (v.action === 'drop') {
      decisions.push(decision(candidate, 'drop', v.rules, v.note));
      continue;
    }
    if (isBrandLike(candidate)) {
      const head = brandHeadToken(candidate.name);
      const own =
        (candidate.evidence === 'read_text' || candidate.evidence === 'logo') &&
        !!head &&
        !!candidate.evidence_text &&
        textHasToken(candidate.evidence_text, head);
      if (!own || !corroboratedByText(candidate.name, stage2Texts)) {
        decisions.push(decision(candidate, 'drop', [...v.rules, 'G-BRAND-CORROBORATE'], 'not_read_at_stage_2'));
        continue;
      }
      if (v.action === 'hold') {
        // Corroborated by its own transcription; any other hold reason still has nothing left to confirm it.
        const other = v.rules.filter((r) => r === 'G-TEXT-ECHO' || r === 'G-LOWCERT');
        if (other.length) {
          decisions.push(decision(candidate, 'drop', [...v.rules, 'G-BRAND-CORROBORATE'], 'held_at_stage_2'));
          continue;
        }
      }
      accept(candidate, [...v.rules, 'G-BRAND-CORROBORATE']);
      continue;
    }
    if (v.action === 'hold') {
      decisions.push(decision(candidate, 'drop', v.rules, 'held_at_stage_2'));
      continue;
    }
    if (v.action === 'demote') {
      decisions.push(decision(candidate, 'demote', v.rules));
      demotedObs.push(candidate);
      continue;
    }
    accept(candidate, v.rules);
  }

  const observations = obs.kept.map((o) => ({ ...o, region_ids: [...o.region_ids] }));
  for (const c of demotedObs) observations.push(demotedObservation(c, nextObservationId(observations)));
  const analysis: VlmAnalysis = {
    ...structuredClone(merged),
    title: published.title,
    interpretation: published.interpretation,
    quality: { ...published.quality },
    visible_text: merged.visible_text.filter((t) => keptText.has(t.text)).map((t) => ({ ...t })),
    observations,
    candidates: [...kept.map((c) => ({ ...c })), ...publishNow],
  };
  return {
    publishNow,
    advisoryVetoes,
    nonAnchorIds,
    analysis,
    decisions,
    dropped: { visibleText: texts.dropped.length, observations: obs.dropped.length },
  };
}
