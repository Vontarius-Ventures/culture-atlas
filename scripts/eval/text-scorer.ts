import { z } from 'zod';
import { enforceExtraction, type RawExtraction } from '../../packages/providers/src/research/wikipedia';
import { stripSafetyClaims, violatedExclusions } from '../../packages/domain/src/composer/dietary';
import { normalizeName } from '../../packages/domain/src/compiler/text';
import {
  TEXT_FIXTURE_SCHEMAS,
  TEXT_FIXTURE_SCHEMA_KEYS,
  isTextFixtureSchemaKey,
  type TextFixtureSchemaKey,
} from './text-schemas';

/**
 * Pure content checks for the text roles (quality plan §8, T1–T10, plus the
 * additive T11–T13 below). A transport pass only proves a reply arrived and
 * parsed; these checks prove the reply is usable:
 *
 *   T1  completed and schema-valid
 *   T2  research: cited URLs outside the supplied sources (before enforcement) = 0
 *   T3  research: factual claims with no supplied URL (before enforcement) <= 20 %
 *   T4  research: kept claims after enforceExtraction >= min_kept_claims (2)
 *   T5  research: overview present and <= 150 words
 *   T6  composer: word and sentence limits
 *   T7  composer prose: proper-name sequences not taken from the input = 0
 *   T8  composer, judged on what production publishes: prose mentions no excluded
 *       ingredient (prose is not filtered); enough movie-night dishes survive the
 *       production dietary filter; Eat reasons (shown unfiltered) make no safety claim
 *   T9  run: latency p95 under the profile timeout, 0 timeouts   (summarizeTextRun)
 *   T10 run: every fixture passed, at least 5 fixtures            (summarizeTextRun)
 *   T11 research: kept claims (factual or interpretive) with a number or proper
 *       name that their sources do not contain <= 20 % (catches text invented
 *       under a real URL, and facts relabelled "interpretive" to skip enforcement)
 *   T12 any: forbidden strings (prompt-injection echoes, outside URLs) = 0
 *   T13 composer ideas: cites only real input ids, honours avoid lists and counts,
 *       Eat ideas grounded in a supplied reference >= min_items
 *
 * Nothing here calls a provider or stores outputs.
 */
export const TEXT_SCORER_VERSION = 'text-score-v1';

export const TEXT_GATES = {
  t2_outside_urls: 0,
  t3_unsourced_factual_share: 0.2,
  t4_min_kept_claims: 2,
  t5_max_overview_words: 150,
  t7_new_names: 0,
  t8_exclusion_violations: 0,
  t8_safety_claims: 0,
  /** plan_dish_ideas: share of the requested dishes that must survive the dietary filter. */
  t8_min_kept_share: 0.5,
  t11_unsupported_specific_share: 0.2,
  t12_forbidden_strings: 0,
  t13_invalid_inputs: 0,
  t13_avoid_repeats: 0,
  t10_min_fixtures: 5,
} as const;

const WordLimits = z
  .object({
    title_words: z.number().int().positive(),
    summary_words: z.number().int().positive(),
    summary_sentences: z.number().int().positive(),
    rationale_words: z.number().int().positive(),
    rationale_sentences: z.number().int().positive(),
    reason_words: z.number().int().positive(),
  })
  .partial()
  .strict();

/** Sibling `<fixture>.expect.json` of every text fixture. */
export const TextExpect = z
  .object({
    fixture: z.string().min(1),
    schema: z.enum(TEXT_FIXTURE_SCHEMA_KEYS as [TextFixtureSchemaKey, ...TextFixtureSchemaKey[]]),
    /** research: the URLs supplied in the prompt (the only citable ones). */
    source_urls: z.array(z.string()).default([]),
    /** research: verbatim supplied source text per URL (title + excerpt), for T11. */
    sources: z.array(z.object({ url: z.string(), title: z.string(), text: z.string() }).strict()).default([]),
    max_overview_words: z.number().int().positive().default(TEXT_GATES.t5_max_overview_words),
    min_kept_claims: z.number().int().nonnegative().default(TEXT_GATES.t4_min_kept_claims),
    /** Names the output may use beyond the input text (e.g. the reference name). */
    allowed_names: z.array(z.string()).default([]),
    /** composer: the data block exactly as supplied; T7 accepts names found in it. */
    input_text: z.string().default(''),
    exclusions: z.array(z.string()).default([]),
    word_limits: WordLimits.default({}),
    forbidden_strings: z.array(z.string()).default([]),
    /** composer ideas: valid `inputs` ids (i1..iN). */
    input_ids: z.array(z.string()).default([]),
    /** eat_dish_ideas: reference names a dish must cite (exactly, after normalizeName). */
    reference_names: z.array(z.string()).default([]),
    /** composer ideas: titles/names that must not be suggested again. */
    avoid: z.array(z.string()).default([]),
    min_items: z.number().int().nonnegative().default(1),
    max_items: z.number().int().positive().optional(),
  })
  .strict();
export type TextExpect = z.infer<typeof TextExpect>;

export interface TextScore {
  pass: boolean;
  metrics: Record<string, number>;
  reasons: string[];
}

export function words(text: string | null | undefined): number {
  return (text ?? '').trim().split(/\s+/).filter(Boolean).length;
}

export function sentences(text: string | null | undefined): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  return t.split(/(?<=[.!?])\s+(?=["'“‘(]?[\p{Lu}\d])/u).filter((s) => s.trim()).length;
}

/** Accent-folded lower-case words of a text. */
function foldedWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. */
export function boundedEditDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Lenient word support: the same word, a shared 5-letter stem (Japan/Japanese),
 * one edit within the first six letters (Rikiu/Rikyu, Kioto/Kyoto), or two
 * edits between words of 8+ letters (a source typo such as Voshinasa for
 * Yoshimasa). Lenient on purpose: T11 must catch invented specifics, not
 * modern romanizations or corrected typos.
 */
function wordSupported(token: string, vocabulary: ReadonlySet<string>): boolean {
  if (vocabulary.has(token)) return true;
  const head = token.slice(0, 6);
  for (const w of vocabulary) {
    if (token.length >= 5 && w.length >= 5 && w.slice(0, 5) === token.slice(0, 5)) return true;
    if (token.length >= 4 && w.length >= 4 && boundedEditDistance(head, w.slice(0, 6), 1) <= 1) return true;
    if (token.length >= 8 && w.length >= 8 && boundedEditDistance(token, w, 2) <= 2) return true;
  }
  return false;
}

const SMALL_NUMBERS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one',
];
const ORDINALS = [
  '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh',
  'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth',
  'twentieth', 'twenty-first',
];

function numberSupported(raw: string, sourceText: string): boolean {
  const folded = sourceText.toLowerCase();
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return true;
  if (new RegExp(`(^|[^0-9])${digits}([^0-9]|$)`).test(folded.replace(/,/g, ''))) return true;
  const n = Number(digits);
  const ordinal = /(st|nd|rd|th)$/i.test(raw) || /s$/i.test(raw);
  // "16th century" / "1500s" are supported by "sixteenth century".
  if (/s$/i.test(raw) && n >= 100 && n % 100 === 0) {
    const century = n / 100 + 1;
    if (ORDINALS[century] && folded.includes(ORDINALS[century]!)) return true;
  }
  if (ordinal && ORDINALS[n] && folded.includes(ORDINALS[n]!)) return true;
  if (!ordinal && SMALL_NUMBERS[n] && new RegExp(`\\b${SMALL_NUMBERS[n]}\\b`).test(folded)) return true;
  return false;
}

const SENTENCE_CAPS_STOP = new Set(['i', 'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'in', 'on', 'at', 'by', 'for', 'of', 'and', 'or', 'but', 'as', 'with']);

/** Numbers and capitalized words after the first word of a sentence. */
export function specificsOf(text: string): { numbers: string[]; names: string[] } {
  const numbers = [...text.matchAll(/\b\d[\d,]*(?:st|nd|rd|th|s)?\b/gi)].map((m) => m[0]);
  const names: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    tokens.slice(1).forEach((tok) => {
      const word = tok.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (word.length >= 3 && /^\p{Lu}/u.test(word) && !SENTENCE_CAPS_STOP.has(word.toLowerCase())) names.push(word);
    });
  }
  return { numbers, names };
}

/** Specifics of a claim that its cited source (title + text) does not contain. */
export function unsupportedSpecifics(claim: string, sourceText: string, allowed: readonly string[] = []): string[] {
  const vocabulary = new Set([...foldedWords(sourceText), ...allowed.flatMap(foldedWords)]);
  const { numbers, names } = specificsOf(claim);
  const missing: string[] = [];
  for (const n of numbers) if (!numberSupported(n, sourceText)) missing.push(n);
  for (const name of names) {
    const parts = foldedWords(name);
    if (parts.length && !parts.every((p) => wordSupported(p, vocabulary))) missing.push(name);
  }
  return missing;
}

const NAME_CONNECTORS = new Set(['no', 'de', 'da', 'di', 'del', 'van', 'von', 'der', 'la', 'le', 'du', 'bin', 'al']);

/**
 * Proper-name sequences (two or more capitalized words, connectors allowed
 * inside) in sentence-case prose. A sequence that opens a sentence loses its
 * first word, so "Pair Tampopo with…" is not read as a name.
 */
export function nameSequences(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?;:])\s+/)) {
    const tokens = sentence.split(/\s+/).map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '')).filter(Boolean);
    let run: string[] = [];
    let runStart = -1;
    const flush = () => {
      let r = run;
      if (runStart === 0) r = r.slice(1);
      while (r.length && NAME_CONNECTORS.has(r[r.length - 1]!.toLowerCase())) r = r.slice(0, -1);
      if (r.filter((t) => /^\p{Lu}/u.test(t)).length >= 2) out.push(r.join(' '));
      run = [];
      runStart = -1;
    };
    tokens.forEach((tok, i) => {
      const capital = /^\p{Lu}/u.test(tok) && !SENTENCE_CAPS_STOP.has(tok.toLowerCase());
      if (capital) {
        if (!run.length) runStart = i;
        run.push(tok);
      } else if (run.length && NAME_CONNECTORS.has(tok.toLowerCase())) run.push(tok);
      else if (run.length) flush();
    });
    if (run.length) flush();
  }
  return out;
}

/** Name sequences with at least one word that appears neither in the input nor in allowed names. */
export function newNames(text: string, inputText: string, allowed: readonly string[]): string[] {
  const vocabulary = new Set([...foldedWords(inputText), ...allowed.flatMap(foldedWords)]);
  return nameSequences(text).filter((seq) =>
    foldedWords(seq).some((w) => !NAME_CONNECTORS.has(w) && !wordSupported(w, vocabulary)),
  );
}

/** Texts in which stripSafetyClaims (the production filter) would remove a sentence. */
function safetyClaims(...texts: Array<string | null | undefined>): number {
  return texts.filter((t) => t && stripSafetyClaims(t) !== t.split(/(?<=[.!?])\s+/).join(' ').trim()).length;
}

function scoreResearch(raw: RawExtraction, expect: TextExpect, m: Record<string, number>, reasons: string[]): void {
  const allowed = new Set(expect.source_urls);
  const outside = new Set(raw.claims.flatMap((c) => c.source_urls.filter((u) => !allowed.has(u))));
  m.t2_outside_urls = outside.size;
  if (outside.size > TEXT_GATES.t2_outside_urls) reasons.push(`T2: cited URLs that were not supplied: ${[...outside].join(', ')}`);

  const factual = raw.claims.filter((c) => c.claim_type === 'factual');
  const unsourced = factual.filter((c) => !c.source_urls.some((u) => allowed.has(u)));
  m.t3_unsourced_factual_share = factual.length ? unsourced.length / factual.length : 0;
  if (m.t3_unsourced_factual_share > TEXT_GATES.t3_unsourced_factual_share)
    reasons.push(`T3: ${unsourced.length} of ${factual.length} factual claims cite no supplied URL`);

  const indexCount = raw.claims.length;
  m.raw_invalid_indexes = [...raw.overview_claim_indexes, ...raw.sections.flatMap((s) => s.claim_indexes)].filter(
    (i) => i < 0 || i >= indexCount,
  ).length;
  m.raw_overview_words = raw.overview_claim_indexes.reduce((n, i) => n + words(raw.claims[i]?.text), 0);

  const enforced = enforceExtraction(raw, expect.source_urls);
  m.t4_kept_claims = enforced.claims.length;
  if (enforced.claims.length < expect.min_kept_claims)
    reasons.push(`T4: ${enforced.claims.length} claims kept after enforcement, need ${expect.min_kept_claims}`);

  m.t5_overview_words = words(enforced.overview);
  if (!enforced.overview.trim()) reasons.push('T5: no overview after enforcement');
  else if (m.t5_overview_words > expect.max_overview_words)
    reasons.push(`T5: overview has ${m.t5_overview_words} words (max ${expect.max_overview_words})`);

  // Every kept claim, interpretive ones included: a claim labelled
  // "interpretive" skips URL enforcement, so specifics in it must still come
  // from the supplied sources (its cited ones, or any when it cites none).
  const byUrl = new Map(expect.sources.map((s) => [s.url, `${s.title}. ${s.text}`]));
  const allSources = [...byUrl.values()].join(' ');
  const keptFactual = enforced.claims;
  let unsupportedClaims = 0;
  for (const c of keptFactual) {
    const cited = c.source_urls.length ? c.source_urls.map((u) => byUrl.get(u) ?? '').join(' ') : allSources;
    const missing = unsupportedSpecifics(c.text, cited, expect.allowed_names);
    if (missing.length) {
      unsupportedClaims++;
      reasons.push(`T11 (detail): "${c.text.slice(0, 120)}" has specifics not in its cited source: ${missing.join(', ')}`);
    }
  }
  m.t11_unsupported_specific_share = keptFactual.length ? unsupportedClaims / keptFactual.length : 0;
  if (m.t11_unsupported_specific_share > TEXT_GATES.t11_unsupported_specific_share)
    reasons.push(`T11: ${unsupportedClaims} of ${keptFactual.length} kept claims state specifics their sources do not contain`);
}

function limit(value: number, max: number | undefined, label: string, reasons: string[]): number {
  if (max === undefined || value <= max) return 0;
  reasons.push(`T6: ${label} is ${value} (max ${max})`);
  return 1;
}

interface ProseOut {
  title: string;
  summary: string;
  rationale?: string | null;
}

function scoreProse(p: ProseOut, expect: TextExpect, m: Record<string, number>, reasons: string[]): void {
  const w = expect.word_limits;
  m.t6_limit_violations =
    limit(words(p.title), w.title_words, 'title words', reasons) +
    limit(words(p.summary), w.summary_words, 'summary words', reasons) +
    limit(sentences(p.summary), w.summary_sentences, 'summary sentences', reasons) +
    limit(words(p.rationale), w.rationale_words, 'rationale words', reasons) +
    limit(sentences(p.rationale), w.rationale_sentences, 'rationale sentences', reasons);
  const prose = [p.summary, p.rationale ?? ''].join(' ');
  const names = newNames(prose, expect.input_text, expect.allowed_names);
  m.t7_new_names = names.length;
  if (names.length > TEXT_GATES.t7_new_names) reasons.push(`T7: names not in the input: ${names.join(', ')}`);
  // What movie-night.ts shows: the title as written, summary and rationale
  // with safety sentences stripped.
  const shown = [stripSafetyClaims(p.summary), p.rationale ? stripSafetyClaims(p.rationale) : ''].join(' ');
  const violated = violatedExclusions({ title: p.title, description: shown }, expect.exclusions);
  m.t8_exclusion_violations = violated.length;
  if (violated.length) reasons.push(`T8: mentions excluded ${violated.join(', ')}`);
  // Reported, not gated: movie-night.ts strips such sentences from the
  // summary and rationale before anything is shown.
  m.t8_raw_safety_claims = safetyClaims(p.title, p.summary, p.rationale);
}

function countLimits(n: number, expect: TextExpect, m: Record<string, number>, reasons: string[]): void {
  m.t13_items = n;
  if (n < expect.min_items) reasons.push(`T13: ${n} items, need at least ${expect.min_items}`);
  if (expect.max_items !== undefined && n > expect.max_items)
    reasons.push(`T13: ${n} items, asked for at most ${expect.max_items}`);
}

function inputsAndAvoid(
  items: ReadonlyArray<{ name: string; inputs?: readonly string[]; reason?: string }>,
  expect: TextExpect,
  m: Record<string, number>,
  reasons: string[],
): void {
  const ids = new Set(expect.input_ids);
  const invalid = items.flatMap((it) => (it.inputs ?? []).filter((i) => !ids.has(i)));
  m.t13_invalid_inputs = invalid.length;
  if (invalid.length) reasons.push(`T13: cites unknown input ids ${[...new Set(invalid)].join(', ')}`);
  const uncited = items.filter((it) => !(it.inputs ?? []).length).length;
  m.t13_uncited_items = uncited;
  if (uncited) reasons.push(`T13: ${uncited} item(s) cite no input`);
  const avoid = new Set(expect.avoid.map(normalizeName));
  const repeats = items.filter((it) => avoid.has(normalizeName(it.name))).map((it) => it.name);
  m.t13_avoid_repeats = repeats.length;
  if (repeats.length) reasons.push(`T13: repeats avoided ${repeats.join(', ')}`);
  const maxReason = expect.word_limits.reason_words;
  const reasonsTooLong = maxReason === undefined ? 0 : items.filter((it) => words(it.reason) > maxReason).length;
  m.t6_limit_violations = reasonsTooLong;
  if (reasonsTooLong) reasons.push(`T6: ${reasonsTooLong} reason(s) longer than ${expect.word_limits.reason_words} words`);
}

/**
 * Scores one text-role reply against its fixture's expectations.
 * `schema` is the fixture's schema key; `output` is the parsed JSON reply
 * (anything: it is validated here). Never throws on bad output.
 */
export function scoreTextFixture(schema: string, expectInput: unknown, output: unknown): TextScore {
  const metrics: Record<string, number> = {};
  const reasons: string[] = [];
  const fail = (reason: string): TextScore => ({ pass: false, metrics: { ...metrics, t1_schema_valid: 0 }, reasons: [...reasons, reason] });
  if (!isTextFixtureSchemaKey(schema)) return fail(`T1: unknown fixture schema ${schema}`);
  const expectParsed = TextExpect.safeParse(expectInput);
  if (!expectParsed.success) return fail(`expect file invalid: ${expectParsed.error.issues[0]?.message ?? 'unknown'}`);
  const expect = expectParsed.data;
  if (expect.schema !== schema) return fail(`expect file is for ${expect.schema}, fixture is ${schema}`);
  const parsed = TEXT_FIXTURE_SCHEMAS[schema].schema.safeParse(output);
  if (!parsed.success) return fail(`T1: reply does not match ${schema}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  metrics.t1_schema_valid = 1;

  const serialized = JSON.stringify(parsed.data).toLowerCase();
  const forbidden = expect.forbidden_strings.filter((f) => serialized.includes(f.toLowerCase()));
  metrics.t12_forbidden_strings = forbidden.length;
  if (forbidden.length) reasons.push(`T12: output contains forbidden text: ${forbidden.join(', ')}`);

  switch (schema) {
    case 'reference_notes':
      scoreResearch(parsed.data as RawExtraction, expect, metrics, reasons);
      break;
    case 'plan_prose':
      scoreProse(parsed.data as ProseOut, expect, metrics, reasons);
      break;
    case 'film_ideas': {
      const films = (parsed.data as { films: Array<{ title: string; inputs: string[]; reason: string }> }).films;
      countLimits(films.length, expect, metrics, reasons);
      inputsAndAvoid(films.map((f) => ({ ...f, name: f.title })), expect, metrics, reasons);
      break;
    }
    case 'artist_ideas': {
      const artists = (parsed.data as { artists: Array<{ name: string; inputs: string[]; reason: string }> }).artists;
      countLimits(artists.length, expect, metrics, reasons);
      inputsAndAvoid(artists, expect, metrics, reasons);
      break;
    }
    case 'plan_dish_ideas': {
      const dishes = (parsed.data as {
        dishes: Array<{ title: string; description: string; cuisine?: string | null; ingredients: string[]; inputs: string[]; reason: string }>;
      }).dishes;
      // T8 is judged on what production would publish: movie-night.ts drops
      // every dish violatedExclusions flags (a deliberately conservative
      // lexicon) and strips safety sentences. The raw counts are reported; the
      // gate is that enough dishes survive that filter.
      if (expect.max_items !== undefined && dishes.length > expect.max_items)
        reasons.push(`T13: ${dishes.length} items, asked for at most ${expect.max_items}`);
      inputsAndAvoid(dishes.map((d) => ({ ...d, name: d.title })), expect, metrics, reasons);
      const violating = dishes.filter((d) => violatedExclusions(d, expect.exclusions).length);
      metrics.t13_items = dishes.length;
      metrics.t8_raw_exclusion_violations = violating.length;
      metrics.t8_raw_safety_claims = safetyClaims(...dishes.flatMap((d) => [d.description, d.reason]));
      metrics.t8_kept_after_filter = dishes.length - violating.length;
      if (metrics.t8_kept_after_filter < expect.min_items)
        reasons.push(
          `T8: ${metrics.t8_kept_after_filter} dish(es) survive the dietary filter, need ${expect.min_items} (dropped: ${violating.map((d) => d.title).join(', ') || 'none'})`,
        );
      break;
    }
    case 'eat_dish_ideas': {
      const dishes = (parsed.data as { dishes: Array<{ name: string; cuisine: string; reason: string; reference_names: string[] }> }).dishes;
      const refs = new Set(expect.reference_names.map(normalizeName));
      const grounded = dishes.filter((d) => d.reference_names.some((n) => refs.has(normalizeName(n))));
      metrics.t13_items = dishes.length;
      metrics.t13_grounded_items = grounded.length;
      if (grounded.length < expect.min_items)
        reasons.push(`T13: ${grounded.length} dish(es) cite a supplied reference exactly, need ${expect.min_items}`);
      if (expect.max_items !== undefined && dishes.length > expect.max_items)
        reasons.push(`T13: ${dishes.length} dishes, at most ${expect.max_items} allowed`);
      const tooLong = expect.word_limits.reason_words
        ? dishes.filter((d) => words(d.reason) > expect.word_limits.reason_words! || sentences(d.reason) > 1).length
        : 0;
      metrics.t6_limit_violations = tooLong;
      if (tooLong) reasons.push(`T6: ${tooLong} reason(s) longer than one short sentence`);
      metrics.t8_safety_claims = safetyClaims(...dishes.map((d) => d.reason));
      if (metrics.t8_safety_claims) reasons.push('T8: asserts a dietary safety claim');
      break;
    }
  }

  const gated = reasons.filter((r) => !r.startsWith('T11 (detail)'));
  return { pass: gated.length === 0, metrics, reasons };
}

export interface TextRunRow {
  fixture: string;
  /** 'complete' or the failure outcome (timeout, http_429, invalid_response, ...). */
  outcome: string;
  latencyMs?: number;
  score?: TextScore;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** T9 and T10 over one role's run. Aggregates only (safe for a qualification artifact). */
export function summarizeTextRun(
  rows: readonly TextRunRow[],
  opts: { timeoutMs: number; minimumFixtures?: number },
): TextScore {
  const min = opts.minimumFixtures ?? TEXT_GATES.t10_min_fixtures;
  const reasons: string[] = [];
  const latencies = rows.filter((r) => r.outcome === 'complete' && r.latencyMs !== undefined).map((r) => r.latencyMs!);
  const p95 = percentile(latencies, 95);
  const timeouts = rows.filter((r) => r.outcome === 'timeout').length;
  const passed = rows.filter((r) => r.outcome === 'complete' && r.score?.pass).length;
  const valid = rows.filter((r) => r.outcome === 'complete' && r.score?.metrics.t1_schema_valid === 1).length;
  const metrics: Record<string, number> = {
    t1_valid_share: rows.length ? valid / rows.length : 0,
    t9_p95_ms: p95 ?? -1,
    t9_timeouts: timeouts,
    t10_fixtures_total: rows.length,
    t10_fixtures_passed: passed,
  };
  if (valid !== rows.length) reasons.push(`T1: ${rows.length - valid} of ${rows.length} replies missing or invalid`);
  if (timeouts) reasons.push(`T9: ${timeouts} timeout(s)`);
  if (p95 === null) reasons.push('T9: no completed reply');
  else if (p95 >= opts.timeoutMs) reasons.push(`T9: p95 ${p95} ms is not under the ${opts.timeoutMs} ms timeout`);
  if (rows.length < min) reasons.push(`T10: ${rows.length} fixtures, need at least ${min}`);
  if (passed !== rows.length) reasons.push(`T10: ${rows.length - passed} fixture(s) failed: ${rows.filter((r) => !(r.outcome === 'complete' && r.score?.pass)).map((r) => r.fixture).join(', ')}`);
  return { pass: reasons.length === 0, metrics, reasons };
}
