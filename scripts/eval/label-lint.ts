import type { PhotoLabel } from './labels';
import { forbiddenCovered } from './scorer';

/**
 * Label lint (round 4, docs/quality-plan.md §19.8): finds names a label both accepts and forbids.
 *
 * For every expected or acceptable entry it builds sample names (the entry's name, its aliases and the
 * literal readings of its pattern, sampleNames) and tests each against the label's forbidden candidate
 * patterns. An overlap that score-v10 resolves (the good entry's match strictly contains the forbidden
 * match, forbiddenCovered) is reported as `resolved`; any other is a conflict the labeller decides
 * before the set is frozen (the forbidden pattern wins it). Whoever prepares a new blind split runs
 * `pnpm eval:lint-labels --golden <dir>` before the freeze.
 */
export interface LabelOverlap {
  photoId: string;
  list: 'expected' | 'acceptable';
  sample: string;
  forbidden: string;
  resolved: boolean;
}

const MAX_SAMPLES = 64;

/** Splits a regex source on top-level `|` (outside groups and classes). */
function splitTop(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inClass = false;
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') {
      cur += ch + (src[i + 1] ?? '');
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      cur += ch;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Index of the `)` closing the group that opens at `start`. */
function closeOf(src: string, start: number): number {
  let depth = 0;
  let inClass = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '\\') {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') inClass = true;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return src.length - 1;
}

const cap = (xs: string[]) => [...new Set(xs)].slice(0, MAX_SAMPLES);
const product = (a: string[], b: string[]) => cap(a.flatMap((x) => b.map((y) => x + y)));

/** Literal readings of one alternative (no top-level `|`). */
function expandSeq(src: string): string[] {
  let acc = [''];
  let i = 0;
  while (i < src.length) {
    let atom: string[];
    const ch = src[i]!;
    if (ch === '(') {
      const end = closeOf(src, i);
      let inner = src.slice(i + 1, end);
      const look = /^\?(?:[=!]|<[=!])/.test(inner);
      inner = inner.replace(/^\?(?::|[=!]|<[=!]|<[A-Za-z]\w*>)/, '');
      atom = look ? [''] : cap(splitTop(inner).flatMap(expandSeq));
      i = end + 1;
    } else if (ch === '[') {
      let end = i + 1;
      while (end < src.length && src[end] !== ']') end += src[end] === '\\' ? 2 : 1;
      const body = src.slice(i + 1, end).replace(/^\^/, '');
      const first = body.startsWith('\\') ? body.slice(1, 2) : body.slice(0, 1);
      atom = [first === 's' ? ' ' : first];
      i = end + 1;
    } else if (ch === '\\') {
      const e = src[i + 1] ?? '';
      atom =
        e === 'b' || e === 'B'
          ? ['']
          : e === 's'
            ? [' ']
            : e === 'd'
              ? ['1']
              : e === 'w'
                ? ['a']
                : [e];
      i += 2;
    } else if (ch === '^' || ch === '$') {
      atom = [''];
      i++;
    } else if (ch === '.') {
      atom = ['x'];
      i++;
    } else {
      atom = [ch];
      i++;
    }
    const q = src[i];
    if (q === '?') {
      atom = cap(['', ...atom]);
      i++;
    } else if (q === '*') {
      atom = [''];
      i++;
    } else if (q === '+') {
      i++;
    } else if (q === '{') {
      const end = src.indexOf('}', i);
      const min = Number.parseInt(src.slice(i + 1, end), 10) || 0;
      atom = min === 0 ? [''] : atom.map((a) => a.repeat(min));
      i = end + 1;
    }
    if (src[i] === '?') i++; // lazy quantifier
    acc = product(acc, atom);
  }
  return acc;
}

/** Sample names an entry's pattern accepts: the literal readings of each alternative (at most MAX_SAMPLES). */
export function sampleNames(pattern: string): string[] {
  return cap(
    splitTop(pattern)
      .flatMap(expandSeq)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => /\p{L}/u.test(s)),
  );
}

/** Names the label both accepts and forbids (candidate field). */
export function labelOverlaps(label: PhotoLabel): LabelOverlap[] {
  const out: LabelOverlap[] = [];
  const forbidden = label.forbidden.filter((f) => f.field === 'candidate');
  for (const list of ['expected', 'acceptable'] as const) {
    for (const entry of label[list]) {
      const samples = cap([
        ...(entry.name ? [entry.name] : []),
        ...entry.aliases,
        ...(entry.pattern ? sampleNames(entry.pattern) : []),
      ]);
      for (const sample of samples)
        for (const f of forbidden)
          if (new RegExp(f.pattern, 'iu').test(sample))
            out.push({
              photoId: label.id,
              list,
              sample,
              forbidden: f.pattern,
              resolved: !entry.requires_text && forbiddenCovered(label, sample, f),
            });
    }
  }
  return out;
}
