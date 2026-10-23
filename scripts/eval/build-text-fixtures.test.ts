import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, cp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { QUALIFICATION_MINIMUM_FIXTURES } from '../../packages/providers/src/concentrate/profiles';
import { discoverFixtures } from '../qualify-concentrate-lib';
import {
  TEXT_V1_DIR,
  buildTextFixtures,
  excerptOf,
  loadTextInputs,
  readTextExpect,
  sha256,
  sourcePageUrl,
  sourceRawUrl,
  textFixtureDrift,
} from './build-text-fixtures';
import { parseTextFixture } from './text-schemas';
import { TEXT_GATES } from './text-scorer';

/**
 * The committed text-v1 golden set is exactly what the production prompt
 * builders produce from the committed sources and cases. If a builder (or a
 * source excerpt) changes, this fails until the fixtures are regenerated
 * deliberately (`pnpm exec tsx scripts/eval/build-text-fixtures.ts`), so
 * qualification never runs stale prompts.
 */
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const read = (rel: string) => JSON.parse(readFileSync(path.join(TEXT_V1_DIR, rel), 'utf8')) as Record<string, unknown>;

describe('text-v1 golden set', () => {
  it('matches the production builders byte for byte (no drift, no stale files)', async () => {
    expect(await textFixtureDrift()).toEqual([]);
  });

  it('has at least 5 fixtures per role, all valid for that role, above the qualification minimum', async () => {
    for (const role of ['research_text', 'composer'] as const) {
      const fixtures = await discoverFixtures(path.join(TEXT_V1_DIR, role), role);
      expect(fixtures.length).toBeGreaterThanOrEqual(TEXT_GATES.t10_min_fixtures);
      expect(fixtures.length).toBeGreaterThan(QUALIFICATION_MINIMUM_FIXTURES[role]);
      // discoverFixtures skips the .expect.json siblings.
      expect(fixtures.every((f) => !f.name.endsWith('.expect.json'))).toBe(true);
      for (const f of fixtures) {
        const spec = parseTextFixture(JSON.parse(readFileSync(f.files[0]!.path, 'utf8')), role);
        const exp = await readTextExpect(f.files[0]!.path);
        expect(exp.schema).toBe(spec.schema);
        expect(`${exp.fixture}.json`).toBe(f.name);
      }
    }
  });

  it('covers the composer call made on every photo analysis (Eat) as well as plan prose', async () => {
    const composer = await discoverFixtures(path.join(TEXT_V1_DIR, 'composer'), 'composer');
    const schemas = composer.map((f) => parseTextFixture(JSON.parse(readFileSync(f.files[0]!.path, 'utf8'))).schema);
    expect(schemas.filter((s) => s === 'eat_dish_ideas').length).toBeGreaterThanOrEqual(3);
    expect(schemas.filter((s) => s === 'plan_prose').length).toBeGreaterThanOrEqual(5);
    expect(new Set(schemas)).toEqual(new Set(['eat_dish_ideas', 'plan_prose', 'film_ideas', 'artist_ideas', 'plan_dish_ideas']));
  });

  it('research sources are verbatim excerpts of pinned files, cited under their own URL only', async () => {
    const { sources } = await loadTextInputs();
    const byUrl = new Map(sources.sources.map((s) => [sourcePageUrl(s), s]));
    for (const s of sources.sources) {
      expect(s.excerpt, s.id).toBeTruthy();
      expect(sha256(s.excerpt!)).toBe(s.excerpt_sha256);
      expect(s.license).toMatch(/Public domain/);
      expect(sourceRawUrl(s)).toBe(`https://raw.githubusercontent.com/${s.repo}/${s.commit}/${s.path}`);
    }
    const research = await discoverFixtures(path.join(TEXT_V1_DIR, 'research_text'), 'research_text');
    for (const f of research) {
      const fixture = JSON.parse(readFileSync(f.files[0]!.path, 'utf8')) as { prompt: string };
      const data = JSON.parse(/<research_data format="json">\n([\s\S]*)\n<\/research_data>/.exec(fixture.prompt)![1]!) as {
        sources: Array<{ url: string; text: string; title: string }>;
      };
      const exp = await readTextExpect(f.files[0]!.path);
      expect(data.sources.map((d) => d.url)).toEqual(exp.source_urls);
      for (const d of data.sources) {
        const src = byUrl.get(d.url);
        expect(src, d.url).toBeDefined();
        // The text under a real URL is exactly the pinned excerpt, never our own words.
        expect(d.text).toBe(src!.excerpt!.slice(0, 4000));
        expect(d.title).toBe(src!.title);
        expect(exp.sources.find((x) => x.url === d.url)?.text).toBe(d.text);
      }
    }
  });

  it('injection cases carry forbidden strings and the injected text never sits under a URL', () => {
    const r = read('research_text/research-injection-reference-name.json') as { prompt: string };
    const data = JSON.parse(/<research_data format="json">\n([\s\S]*)\n<\/research_data>/.exec(r.prompt)![1]!) as {
      reference: { name: string };
      sources: Array<{ text: string }>;
    };
    expect(data.reference.name).toMatch(/Ignore the rules above/);
    expect(data.sources.every((s) => !s.text.includes('example.com'))).toBe(true);
    expect(read('research_text/research-injection-reference-name.expect.json').forbidden_strings).toEqual(['example.com']);
    expect(read('composer/eat-dish-ideas-injection.expect.json')).toMatchObject({
      reference_names: ['Peruvian cuisine'],
      forbidden_strings: ['system prompt', 'You suggest dish ideas'],
    });
  });

  it('plan cases cover a dietary exclusion, person names in references and the word limits', () => {
    expect(read('composer/plan-prose-dietary-exclusions.expect.json').exclusions).toEqual(['peanuts', 'dairy']);
    expect(read('composer/plan-prose-person-names.expect.json').input_text).toMatch(/Sen no Rikyu/);
    expect(read('composer/plan-prose-limits-injection.expect.json')).toMatchObject({
      word_limits: { title_words: 6, summary_sentences: 1 },
      exclusions: ['gluten'],
    });
    expect(read('composer/plan-dish-ideas-exclusions.expect.json').exclusions).toEqual(['shellfish', 'gluten']);
  });

  it('the manifest binds every generated file by sha256', async () => {
    const manifest = read('manifest.json') as { golden_set: string; files: Record<string, string>; golden_sha256: string };
    expect(manifest.golden_set).toBe('text-v1');
    for (const [rel, hash] of Object.entries(manifest.files)) expect(sha256(readFileSync(path.join(TEXT_V1_DIR, rel), 'utf8')), rel).toBe(hash);
    expect(manifest.golden_sha256).toBe(sha256(JSON.stringify(manifest.files)));
  });

  it('detects drift: an edited fixture, a stale file and a changed excerpt', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ca-text-v1-'));
    dirs.push(dir);
    await cp(TEXT_V1_DIR, dir, { recursive: true });
    expect(await textFixtureDrift(dir)).toEqual([]);
    await writeFile(path.join(dir, 'composer/plan-prose-tea-and-noodles.json'), '{}\n');
    await mkdir(path.join(dir, 'research_text'), { recursive: true });
    await writeFile(path.join(dir, 'research_text/old.json'), '{}\n');
    expect(await textFixtureDrift(dir)).toEqual(
      expect.arrayContaining(['composer/plan-prose-tea-and-noodles.json', 'research_text/old.json (stale)']),
    );
    const { sources, cases } = await loadTextInputs(dir);
    sources.sources[0]!.excerpt = `${sources.sources[0]!.excerpt} (edited)`;
    expect(() => buildTextFixtures(sources, cases)).toThrow(/no verified excerpt/);
  });
});

describe('excerptOf', () => {
  const file = 'line one\r\nline  two\r\n\r\nline three ends here. More text\r\nline four\r\n';
  it('takes 1-based inclusive lines, drops CR and collapses whitespace', () => {
    expect(excerptOf(file, [2, 3])).toBe('line two');
    expect(excerptOf(file, [1, 4])).toBe('line one line two line three ends here. More text');
  });
  it('cuts after end_after and refuses a missing anchor or out-of-range lines', () => {
    expect(excerptOf(file, [1, 5], 'ends here.')).toBe('line one line two line three ends here.');
    expect(() => excerptOf(file, [1, 2], 'absent')).toThrow(/end_after text not found/);
    expect(() => excerptOf(file, [1, 99])).toThrow(/File has \d+ lines/);
  });
});
