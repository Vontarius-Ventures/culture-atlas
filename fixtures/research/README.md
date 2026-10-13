# Research fixtures

The research adapter tests (`packages/providers/src/research/wikipedia.test.ts`) build documented-shape Wikipedia Action API (`list=search`) and REST `/page/summary` responses inline, with filler text that is not quoted Wikipedia content. Wikipedia was not reachable from the build sandbox (egress proxy), so no real summaries were recorded. When adding recordings here, keep only the summary fields the adapter reads (title, description, short extract, `content_urls`, `wikibase_item`), and note the page URL and the CC BY-SA 4.0 license.
