# text-v1: text-role golden set

Qualification fixtures for the two text roles (quality plan §8):

| Role | Directory | Fixtures | Production call |
| --- | --- | --- | --- |
| `research_text` | `research_text/` | 6 × `reference_notes` | research claim extraction (`extractionRequest`, `packages/providers/src/research/wikipedia.ts`) |
| `composer` | `composer/` | 3 × `eat_dish_ideas` | Eat dish ideas on every photo analysis (`eatDishIdeasRequest`, `packages/domain/src/compiler/dishes.ts`) |
| | | 5 × `plan_prose`, 1 × `film_ideas`, 1 × `artist_ideas`, 1 × `plan_dish_ideas` | movie-night composer (`packages/domain/src/composer/creative.ts`) |

Each `<id>.json` is `{system, prompt, schema}`: the exact request the
production builder makes (same system prompt, prompt, wire schema name and
output cap, see `scripts/eval/text-schemas.ts`). Each `<id>.expect.json` holds
what `scoreTextFixture` (`scripts/eval/text-scorer.ts`) checks. `manifest.json`
pins every file by sha256 (`golden_sha256` is the value a qualification
artifact binds).

## Rules

- **Generated, never hand-edited.** Edit `cases.json` or `sources.json`, then
  run `pnpm exec tsx scripts/eval/build-text-fixtures.ts`. The test
  `scripts/eval/build-text-fixtures.test.ts` fails when the committed files
  differ from what the production builders produce, so a prompt change cannot
  leave qualification running an old prompt.
- **Research sources are real.** Wikipedia is not reachable from the build
  sandbox, so the sources are verbatim excerpts of public-domain books
  (Project Gutenberg texts mirrored by the GITenberg organisation) at pinned
  commits. `sources.json` records repository, commit, path, the file's sha256,
  the line range and the excerpt with its sha256. The URL given to the model is
  the file's own GitHub URL at that commit with line anchors. Text we wrote (a
  reference name, a plan input, an injection attempt) never appears under a
  source URL. Check the excerpts against the pinned files with
  `pnpm exec tsx scripts/eval/build-text-fixtures.ts --verify-sources`.
- **Composer inputs are synthetic** (`FIXTURE-` ids). The people they name are
  public historical or creative figures used as cultural references (a tea
  master, an author, musicians, film titles), never the subject of a photo.
- **Adversarial cases:** a prompt injection in a research reference name
  (`research-injection-reference-name`), in an Eat reference name
  (`eat-dish-ideas-injection`) and in a plan instruction
  (`plan-prose-limits-injection`). Their `forbidden_strings` must not appear in
  the reply.
- No model output is committed here. Live replies stay in the operator's
  directory.
