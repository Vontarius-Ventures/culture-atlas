# Qloo fixtures

- `contract/`: **shape-only** fixtures built from the documented API (`/search`, `/v2/tags`, `/v2/insights` with explainability, `/v2/trending`, `/trends/entity`, error bodies). IDs are prefixed `FIXTURE-` / `fixture_` and names say "Fixture": they are NOT real Qloo data and are used only by adapter contract tests (`packages/providers/src/qloo/client.test.ts`). They are never served to users.
- `recordings/`: sanitized REAL responses written by `pnpm tsx scripts/probe-qloo.ts --record` once a key exists. Only these can be replayed (`QLOO_REPLAY_FIXTURES=true`, `QLOO_REPLAY_DIR=fixtures/qloo/recordings`), and every replayed result is flagged `is_replay` and labeled "Example result". Confirm Qloo's storage terms before committing recordings.
