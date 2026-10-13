# culture atlas

Capture something you like. Discover more you will like.

culture atlas turns photos into cultural discoveries, lets people save mixed interests into private collections, and creates experiences such as movie nights from selected items. The planned service combines vision models, Qloo cultural intelligence, and optional World Sensor image imports.

## Current status

The repository contains the planning and visual design handoff plus the application foundation: a pnpm TypeScript monorepo with the database schema, shared contracts (schemas, authorization, jobs, idempotency), provider interfaces and the REST/MCP wiring. Most domain services and provider adapters are still typed stubs that return `501 not_implemented`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module ownership and conventions, and [docs/capability-matrix.md](docs/capability-matrix.md) for provider status (the Qloo key is still pending).

## Development

Requirements: Node 22, pnpm 10, PostgreSQL 16.

```sh
pnpm install
pnpm db:setup      # start PostgreSQL, create role + databases
pnpm db:migrate    # apply db/migrations
cp .env.example .env         # fill in what you have; empty values and absent keys degrade gracefully
pnpm dev           # web + REST + MCP on http://localhost:3000
pnpm worker        # job worker
pnpm test          # unit + integration tests (isolated database per run)
pnpm typecheck && pnpm lint && pnpm build
```

## Start here

1. Read the [build specification](specs/cultural-discovery-build-spec.md).
2. Read the [visual design guide](design/cultural-atlas-v1/DESIGN-GUIDE.md).
3. Open the [mockup gallery](design/cultural-atlas-v1/index.html) locally to inspect all seven desktop/mobile concepts.
4. Use the [design tokens](design/cultural-atlas-v1/tokens.css) when implementing the interface.

The specification governs behavior and permissions, the design guide governs canonical tokens and component rules, and the mockups guide composition. The product name and wordmark are exactly **culture atlas**, in lowercase.

## Research

- [World Sensor integration review](research/world-sensor-qloo-integration.md)
- [Qloo feasibility and original concept review](research/qloo-style-feasibility.md)

These dated source reviews provide background. The current build specification supersedes the earlier virality concept. Provider capabilities and hackathon requirements should be rechecked before implementation and submission.

World Sensor stays in its separate repository: [WorldCompilerSensor](https://github.com/Vontarius-Ventures/WorldCompilerSensor).

## Repository contents

- `specs/`: implementation baseline and acceptance checks
- `design/cultural-atlas-v1/`: visual guide, gallery, tokens, generation history, and seven mockups
- `research/`: related technical source reviews

The repository is private for development. The specification records public licensed source as a submission requirement; publication and license selection remain release steps.
