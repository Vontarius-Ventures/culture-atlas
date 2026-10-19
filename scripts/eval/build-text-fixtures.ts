/**
 * Builds the text-role qualification fixtures (quality plan §8) from the
 * PRODUCTION prompt builders, so qualification tests the real prompts:
 *
 *   research_text  extractionRequest  (packages/providers/src/research/wikipedia.ts)
 *   composer       eatDishIdeasRequest (packages/domain/src/compiler/dishes.ts)
 *                  proseRequest, filmIdeasRequest, artistIdeasRequest, dishIdeasRequest
 *                  (packages/domain/src/composer/creative.ts)
 *
 * Inputs (committed): fixtures/eval/text-v1/sources.json (verbatim public-domain
 * excerpts at pinned commits) and cases.json. Outputs (committed):
 * text-v1/<role>/<id>.json ({system, prompt, schema}), <id>.expect.json and
 * text-v1/manifest.json (fixture hashes for the qualification artifact).
 *
 *   pnpm exec tsx scripts/eval/build-text-fixtures.ts            # write (hermetic)
 *   pnpm exec tsx scripts/eval/build-text-fixtures.ts --check    # exit 1 on drift
 *   pnpm exec tsx scripts/eval/build-text-fixtures.ts --verify-sources [--cache DIR]
 *       # downloads each pinned file (or reads DIR/<sha256>.txt), checks its sha256
 *       # and that every committed excerpt is exactly lines [from, to] of it
 *   pnpm exec tsx scripts/eval/build-text-fixtures.ts --refresh-excerpts --cache DIR
 *       # (re)writes the excerpts in sources.json from the verified files
 *
 * Research sources are never invented: the excerpt is cut from the pinned file
 * and published under that file's own URL (with line anchors). Text we wrote
 * (a reference name, a plan input) never sits under a real URL.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { extractionRequest } from '../../packages/providers/src/research/wikipedia';
import {
  artistIdeasRequest,
  dishIdeasRequest,
  filmIdeasRequest,
  proseRequest,
} from '../../packages/domain/src/composer/creative';
import { eatDishIdeasRequest } from '../../packages/domain/src/compiler/dishes';
import { PlanSnapshot } from '../../packages/domain/src/composer/plan-types';
import { REFERENCE_TYPES } from '../../packages/domain/src/enums';
import { TEXT_FIXTURE_SCHEMAS, type TextFixtureSchemaKey } from './text-schemas';
import { TEXT_GATES, TEXT_SCORER_VERSION, TextExpect } from './text-scorer';

export const TEXT_GOLDEN_SET = 'text-v1';
export const TEXT_V1_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/eval/text-v1');

export const TextSource = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    title: z.string().min(1),
    publisher: z.string().min(1),
    license: z.string().min(1),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    path: z.string().min(1),
    file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
    end_after: z.string().min(1).optional(),
    excerpt: z.string().min(1).optional(),
    excerpt_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict()
  .refine((s) => s.lines[0] <= s.lines[1], 'lines must be [from, to]');
export type TextSource = z.infer<typeof TextSource>;

export const SourcesFile = z
  .object({ version: z.literal(TEXT_GOLDEN_SET), note: z.string(), sources: z.array(TextSource).min(1) })
  .strict();
export type SourcesFile = z.infer<typeof SourcesFile>;

const Ref = z.object({ name: z.string().min(1), type: z.enum(REFERENCE_TYPES) }).strict();
const ItemInput = z
  .object({
    kind: z.enum(['capture', 'style', 'brand', 'artist', 'track', 'film', 'food', 'reference']),
    category: z.enum(['wear', 'play', 'watch', 'eat']).optional(),
    title: z.string().min(1),
    year: z.number().int().optional(),
    subtitle: z.string().optional(),
    detail: z.string().optional(),
    capture: z.object({ title: z.string(), interpretation: z.string() }).strict().optional(),
    anchors: z.array(Ref).default([]),
  })
  .strict();
const SnapshotInput = z
  .object({
    exploration: z.enum(['familiar', 'balanced', 'adventurous']),
    constraints: z
      .object({ dietary_exclusions: z.array(z.string()).default([]), instruction: z.string().nullable().default(null) })
      .strict()
      .default({ dietary_exclusions: [], instruction: null }),
    collection: z
      .object({ id: z.string(), name: z.string(), description: z.string().nullable(), revision: z.number().int() })
      .strict()
      .nullable()
      .default(null),
    items: z.array(ItemInput).min(1),
  })
  .strict();

const Common = { id: z.string().regex(/^[a-z0-9-]+$/), why: z.string().min(1), forbidden_strings: z.array(z.string()).default([]) };
const ResearchCase = z
  .object({ ...Common, name: z.string().min(1), type: z.enum(REFERENCE_TYPES), sources: z.array(z.string()).min(1).max(5) })
  .strict();
const ComposerCase = z.discriminatedUnion('schema', [
  z.object({ ...Common, schema: z.literal('eat_dish_ideas'), refs: z.array(Ref).min(1), grounding_names: z.array(z.string()).optional() }).strict(),
  z
    .object({
      ...Common,
      schema: z.literal('plan_prose'),
      snapshot: SnapshotInput,
      input: z.object({ film: z.string().nullable(), dishes: z.array(z.string()), artists: z.array(z.string()), weakInputs: z.array(z.string()) }).strict(),
    })
    .strict(),
  z
    .object({
      ...Common,
      schema: z.literal('film_ideas'),
      snapshot_from: z.string(),
      input: z.object({ count: z.number().int().positive(), avoidTitles: z.array(z.string()), extraInstruction: z.string().nullable() }).strict(),
    })
    .strict(),
  z
    .object({
      ...Common,
      schema: z.literal('artist_ideas'),
      snapshot_from: z.string(),
      input: z
        .object({ count: z.number().int().positive(), avoidNames: z.array(z.string()), film: z.string().nullable(), extraInstruction: z.string().nullable() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...Common,
      schema: z.literal('plan_dish_ideas'),
      snapshot: SnapshotInput,
      input: z
        .object({
          count: z.number().int().positive(),
          cuisineHints: z.array(z.string()),
          selectedDishes: z.array(z.string()),
          avoidTitles: z.array(z.string()),
          film: z.string().nullable(),
          extraInstruction: z.string().nullable(),
        })
        .strict(),
    })
    .strict(),
]);
export const CasesFile = z
  .object({ version: z.literal(TEXT_GOLDEN_SET), note: z.string(), research: z.array(ResearchCase), composer: z.array(ComposerCase) })
  .strict();
export type CasesFile = z.infer<typeof CasesFile>;

export const PLAN_PROSE_LIMITS = { title_words: 6, summary_words: 45, summary_sentences: 1, rationale_words: 70, rationale_sentences: 2 };
export const IDEA_REASON_WORDS = 45;
export const EAT_REASON_WORDS = 35;

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Lines [from, to] (1-based, inclusive), CR removed, whitespace collapsed, optionally cut after `endAfter`. */
export function excerptOf(content: string, lines: readonly [number, number], endAfter?: string): string {
  const all = content.replace(/\r/g, '').split('\n');
  if (lines[1] > all.length) throw new Error(`File has ${all.length} lines; excerpt needs ${lines[1]}.`);
  let text = all.slice(lines[0] - 1, lines[1]).join('\n').replace(/\s+/g, ' ').trim();
  if (endAfter) {
    const at = text.indexOf(endAfter);
    if (at < 0) throw new Error(`end_after text not found in lines ${lines[0]}-${lines[1]}.`);
    text = text.slice(0, at + endAfter.length);
  }
  return text;
}

export function sourcePageUrl(s: Pick<TextSource, 'repo' | 'commit' | 'path' | 'lines'>): string {
  return `https://github.com/${s.repo}/blob/${s.commit}/${s.path}#L${s.lines[0]}-L${s.lines[1]}`;
}
export function sourceRawUrl(s: Pick<TextSource, 'repo' | 'commit' | 'path'>): string {
  return `https://raw.githubusercontent.com/${s.repo}/${s.commit}/${s.path}`;
}

function snapshotOf(caseId: string, input: z.infer<typeof SnapshotInput>): PlanSnapshot {
  return PlanSnapshot.parse({
    template: 'movie_night',
    collection: input.collection,
    constraints: input.constraints,
    exploration: input.exploration,
    items: input.items.map((it, i) => ({
      item_id: `FIXTURE-item-${i + 1}`,
      saved_item_id: null,
      kind: it.kind,
      category: it.category ?? null,
      title: it.title,
      canonical_key: `fixture:${caseId}:${i + 1}`,
      subtitle: it.subtitle ?? null,
      year: it.year ?? null,
      detail: it.detail ?? null,
      anchors: it.anchors.map((a, j) => ({ reference_id: `FIXTURE-ref-${i + 1}-${j + 1}`, name: a.name, type: a.type, revision: 1 })),
      capture: it.capture
        ? { capture_id: `FIXTURE-capture-${i + 1}`, analysis_id: null, analysis_version: null, ...it.capture }
        : null,
    })),
  });
}

function dataBlockOf(prompt: string): string {
  const m = /<data>[\s\S]*<\/data>/.exec(prompt);
  if (!m) throw new Error('Composer prompt has no <data> block.');
  return m[0];
}

interface BuiltRequest {
  system: string;
  prompt: string;
  schemaName: string;
  maxTokens?: number;
  schema: unknown;
}

/** The production request must be the one the registry describes (wire name, cap, zod schema). */
function checkAgainstRegistry(key: TextFixtureSchemaKey, req: BuiltRequest): void {
  const entry = TEXT_FIXTURE_SCHEMAS[key];
  if (req.schemaName !== entry.schemaName || req.maxTokens !== entry.maxTokens || req.schema !== entry.schema)
    throw new Error(`Production builder for ${key} no longer matches TEXT_FIXTURE_SCHEMAS; update the registry deliberately.`);
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Pure: committed inputs -> map of relative path -> file content. */
export function buildTextFixtures(sourcesFile: SourcesFile, casesFile: CasesFile): Map<string, string> {
  const files = new Map<string, string>();
  const sources = new Map(sourcesFile.sources.map((s) => [s.id, s]));
  const ids = new Set<string>();
  const claim = (id: string) => {
    if (ids.has(id)) throw new Error(`Duplicate case id ${id}.`);
    ids.add(id);
  };
  const emit = (role: 'research_text' | 'composer', id: string, key: TextFixtureSchemaKey, req: BuiltRequest, expect: unknown) => {
    checkAgainstRegistry(key, req);
    if (TEXT_FIXTURE_SCHEMAS[key].role !== role) throw new Error(`${id}: ${key} is not a ${role} schema.`);
    files.set(`${role}/${id}.json`, json({ system: req.system, prompt: req.prompt, schema: key }));
    files.set(`${role}/${id}.expect.json`, json(TextExpect.parse(expect)));
  };

  for (const c of casesFile.research) {
    claim(c.id);
    const docs = c.sources.map((sid) => {
      const s = sources.get(sid);
      if (!s) throw new Error(`${c.id}: unknown source ${sid}.`);
      if (!s.excerpt || s.excerpt_sha256 !== sha256(s.excerpt))
        throw new Error(`${c.id}: source ${sid} has no verified excerpt; run --refresh-excerpts.`);
      return { url: sourcePageUrl(s), title: s.title, publisher: s.publisher, extract: s.excerpt };
    });
    const req = extractionRequest({ name: c.name, type: c.type, sources: docs });
    emit('research_text', c.id, 'reference_notes', req, {
      fixture: c.id,
      schema: 'reference_notes',
      source_urls: docs.map((d) => d.url),
      sources: docs.map((d) => ({ url: d.url, title: d.title, text: d.extract.slice(0, 4000) })),
      allowed_names: [c.name],
      forbidden_strings: c.forbidden_strings,
    });
  }

  const snapshots = new Map<string, PlanSnapshot>();
  for (const c of casesFile.composer) if ('snapshot' in c) snapshots.set(c.id, snapshotOf(c.id, c.snapshot));
  const snapshotFor = (id: string, from: string) => {
    const s = snapshots.get(from);
    if (!s) throw new Error(`${id}: snapshot_from ${from} is not a case with a snapshot.`);
    return s;
  };
  const planExpect = (c: { id: string; forbidden_strings: string[] }, key: TextFixtureSchemaKey, snapshot: PlanSnapshot, prompt: string, extra: Record<string, unknown>) => ({
    fixture: c.id,
    schema: key,
    input_text: dataBlockOf(prompt),
    exclusions: snapshot.constraints.dietary_exclusions,
    input_ids: snapshot.items.map((_, i) => `i${i + 1}`),
    forbidden_strings: c.forbidden_strings,
    ...extra,
  });

  for (const c of casesFile.composer) {
    claim(c.id);
    switch (c.schema) {
      case 'eat_dish_ideas': {
        const req = eatDishIdeasRequest(c.refs);
        emit('composer', c.id, c.schema, req, {
          fixture: c.id,
          schema: c.schema,
          input_text: req.prompt,
          reference_names: c.grounding_names ?? c.refs.map((r) => r.name),
          forbidden_strings: c.forbidden_strings,
          word_limits: { reason_words: EAT_REASON_WORDS },
          min_items: 1,
          max_items: 3,
        });
        break;
      }
      case 'plan_prose': {
        const snapshot = snapshots.get(c.id)!;
        const req = proseRequest(snapshot, c.input);
        emit('composer', c.id, c.schema, req, planExpect(c, c.schema, snapshot, req.prompt, { word_limits: PLAN_PROSE_LIMITS }));
        break;
      }
      case 'film_ideas': {
        const snapshot = snapshotFor(c.id, c.snapshot_from);
        const req = filmIdeasRequest(snapshot, c.input);
        emit('composer', c.id, c.schema, req, planExpect(c, c.schema, snapshot, req.prompt, {
          avoid: c.input.avoidTitles,
          max_items: c.input.count,
          word_limits: { reason_words: IDEA_REASON_WORDS },
        }));
        break;
      }
      case 'artist_ideas': {
        const snapshot = snapshotFor(c.id, c.snapshot_from);
        const req = artistIdeasRequest(snapshot, c.input);
        emit('composer', c.id, c.schema, req, planExpect(c, c.schema, snapshot, req.prompt, {
          avoid: c.input.avoidNames,
          max_items: c.input.count,
          word_limits: { reason_words: IDEA_REASON_WORDS },
        }));
        break;
      }
      case 'plan_dish_ideas': {
        const snapshot = snapshots.get(c.id)!;
        const req = dishIdeasRequest(snapshot, c.input);
        emit('composer', c.id, c.schema, req, planExpect(c, c.schema, snapshot, req.prompt, {
          avoid: c.input.avoidTitles,
          max_items: c.input.count,
          min_items: Math.ceil(c.input.count * TEXT_GATES.t8_min_kept_share),
          word_limits: { reason_words: IDEA_REASON_WORDS },
        }));
        break;
      }
    }
  }

  const byRole = (role: string) =>
    [...files.keys()].filter((f) => f.startsWith(`${role}/`) && !f.endsWith('.expect.json')).sort();
  const hashes = Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([f, c]) => [f, sha256(c)]));
  files.set(
    'manifest.json',
    json({
      golden_set: TEXT_GOLDEN_SET,
      scorer_version: TEXT_SCORER_VERSION,
      roles: { research_text: byRole('research_text'), composer: byRole('composer') },
      files: hashes,
      golden_sha256: sha256(JSON.stringify(hashes)),
    }),
  );
  return files;
}

/** `<dir>/<id>.json` -> parsed `<dir>/<id>.expect.json` (for the qualification run's scorer call). */
export async function readTextExpect(fixturePath: string): Promise<TextExpect> {
  const expectPath = fixturePath.replace(/\.json$/, '.expect.json');
  if (expectPath === fixturePath) throw new Error(`${fixturePath} is not a .json fixture.`);
  return TextExpect.parse(JSON.parse(await readFile(expectPath, 'utf8')));
}

export async function loadTextInputs(dir = TEXT_V1_DIR): Promise<{ sources: SourcesFile; cases: CasesFile }> {
  const sources = SourcesFile.parse(JSON.parse(await readFile(path.join(dir, 'sources.json'), 'utf8')));
  const cases = CasesFile.parse(JSON.parse(await readFile(path.join(dir, 'cases.json'), 'utf8')));
  return { sources, cases };
}

/** Generated files that differ from (or are missing in) dir, plus stale generated files. */
export async function textFixtureDrift(dir = TEXT_V1_DIR): Promise<string[]> {
  const { sources, cases } = await loadTextInputs(dir);
  const want = buildTextFixtures(sources, cases);
  const drift: string[] = [];
  for (const [rel, content] of want) {
    const have = await readFile(path.join(dir, rel), 'utf8').catch(() => null);
    if (have !== content) drift.push(rel);
  }
  for (const role of ['research_text', 'composer']) {
    const names = await readdir(path.join(dir, role)).catch(() => [] as string[]);
    for (const n of names) if (!want.has(`${role}/${n}`)) drift.push(`${role}/${n} (stale)`);
  }
  return drift;
}

async function writeAll(dir: string): Promise<number> {
  const { sources, cases } = await loadTextInputs(dir);
  const files = buildTextFixtures(sources, cases);
  for (const role of ['research_text', 'composer']) await rm(path.join(dir, role), { recursive: true, force: true });
  for (const [rel, content] of files) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
  return files.size;
}

/** Reads DIR/<file_sha256>.txt or downloads the pinned raw file; always checks the sha256. */
async function pinnedFile(s: TextSource, cache?: string): Promise<string> {
  let buf: Buffer | null = null;
  if (cache) {
    try {
      buf = await readFile(path.join(cache, `${s.file_sha256}.txt`));
    } catch {
      buf = null;
    }
  }
  if (!buf) {
    const res = await fetch(sourceRawUrl(s));
    if (!res.ok) throw new Error(`${s.id}: HTTP ${res.status} for ${sourceRawUrl(s)}`);
    buf = Buffer.from(await res.arrayBuffer());
    if (cache) {
      await mkdir(cache, { recursive: true });
      await writeFile(path.join(cache, `${sha256(buf)}.txt`), buf);
    }
  }
  if (sha256(buf) !== s.file_sha256) throw new Error(`${s.id}: sha256 of ${s.path} differs from the pinned value.`);
  return buf.toString('utf8');
}

async function main(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dir = arg('dir') ? path.resolve(arg('dir')!) : TEXT_V1_DIR;
  if (argv.includes('--refresh-excerpts') || argv.includes('--verify-sources')) {
    const file = path.join(dir, 'sources.json');
    const parsed = SourcesFile.parse(JSON.parse(await readFile(file, 'utf8')));
    let mismatches = 0;
    for (const s of parsed.sources) {
      const excerpt = excerptOf(await pinnedFile(s, arg('cache')), s.lines, s.end_after);
      if (argv.includes('--refresh-excerpts')) {
        s.excerpt = excerpt;
        s.excerpt_sha256 = sha256(excerpt);
      } else if (excerpt !== s.excerpt || s.excerpt_sha256 !== sha256(excerpt)) {
        mismatches++;
        console.error(`[text-fixtures] ${s.id}: committed excerpt differs from lines ${s.lines.join('-')} of the pinned file`);
      } else console.log(`[text-fixtures] ${s.id}: verified (${excerpt.length} chars)`);
    }
    if (argv.includes('--refresh-excerpts')) await writeFile(file, json(parsed));
    return mismatches ? 1 : 0;
  }
  if (argv.includes('--check')) {
    const drift = await textFixtureDrift(dir);
    for (const d of drift) console.error(`[text-fixtures] out of date: ${d}`);
    if (!drift.length) console.log('[text-fixtures] fixtures match the production builders');
    return drift.length ? 1 : 0;
  }
  const n = await writeAll(dir);
  console.log(`[text-fixtures] wrote ${n} files to ${path.relative(process.cwd(), dir)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`[text-fixtures] ${(error as Error).message}`);
      process.exit(2);
    },
  );
}
