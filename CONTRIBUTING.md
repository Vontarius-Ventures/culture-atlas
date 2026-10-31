# Contributing

Thanks for helping. Issues and pull requests are welcome. For a large change, open an issue first so we can agree on the approach.

## Set up

You need Node 22, pnpm, PostgreSQL 16 and ffmpeg.

```bash
cp .env.example .env
pnpm install
pnpm db:setup
pnpm db:migrate
pnpm dev
```

Run `pnpm worker` and `pnpm media-worker` alongside `pnpm dev` for capture and analysis. Live discovery needs your own Qloo and Concentrate keys. Without them those features report as unavailable, and nothing is made up in their place.

Native apps: [apps/ios](apps/ios/README.md) and [apps/android](apps/android/README.md).

## Before you open a pull request

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm test` needs a PostgreSQL role to create throwaway databases; `pnpm db:setup` creates it, or set `TEST_DATABASE_URL`. If you change the web app, also run `pnpm test:e2e`.

Add or update tests for what you change. A bug fix should come with a test that fails without it.

## Rules the product depends on

- **Never invent results.** Everything shown as a Qloo or model result must come from a real response. An empty answer stays empty.
- **Qualify uncertainty.** What a model only thinks it sees is worded "resembles", and it doesn't drive recommendations by itself.
- **No fake portraits.** Artists and films with no owned image get a typographic poster.
- **No claims about people.** Don't identify people or infer their roles from a photo. The guardrails are in [docs/quality-plan.md](docs/quality-plan.md).
- **Keep captures private.** They're owner-scoped by default. Don't log images, tokens or personal data.
- **Never commit secrets.** Keys belong in a gitignored `.env`.
- **Respect Reduce Motion** in anything that animates.
- The product name is lowercase: **culture atlas**.

## Where things are

| Path | What it holds |
|---|---|
| `apps/web` | Next.js app, REST API and MCP endpoint |
| `apps/worker`, `apps/media-worker` | Analysis and discovery jobs; ffmpeg media preparation |
| `apps/ios`, `apps/android` | Native apps |
| `packages/domain`, `packages/providers` | Business logic; Qloo and model adapters |
| `db/migrations` | Forward-only database migrations |
| `docs`, `specs` | Architecture, pipeline, deployment and specifications |

By contributing, you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
