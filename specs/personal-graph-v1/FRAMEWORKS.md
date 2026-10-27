# Culture Atlas: open-source graph framework research

Researched 2026-10-27. Primary documentation and repository licenses checked at the URLs below. These are architecture recommendations, not a deployed or benchmarked solution. Pin a release/commit and recheck its license before implementation; current main-branch documentation can describe features beyond a stable release.

## Recommendation

Keep Atlas's authoritative preferences, interaction events, evidence, ownership and accepted relationships in PostgreSQL. Add pgvector for candidate retrieval when needed. Test Graphiti behind Atlas's own service as an optional temporal extraction/query layer. Do not let an LLM-generated fact or an embedding similarity become accepted cultural evidence automatically. My assessment is that this offers the lowest migration risk while preserving an upgrade path to graph-native storage.

The strongest three candidates play different roles:

| Candidate | Best Atlas role | Main limitation |
| --- | --- | --- |
| PostgreSQL + pgvector; Apache AGE optional | Authoritative private preferences and accepted cultural relationships | Atlas implements preference learning, evidence gates and relationship semantics |
| Graphiti core + a supported graph backend | Temporal graph construction, evolving agent context and historical retrieval | Atlas still owns authorization, recommendation quality and evidence admission |
| Cognee | Configurable document/memory ingestion and dataset-based retrieval | Core Postgres graph adapter is demo-only; production Postgres adapter is separately licensed |

LightRAG is a useful alternative for ingesting and searching a public research corpus. It is a weaker match for the primary personal-preference graph. None of these projects is a ready-made, validated cultural recommender.

## Graphiti: closest functional match for evolving temporal context

Graphiti is a self-hosted Python framework with episode-backed facts, validity windows, typed ontologies and hybrid retrieval. Zep is a separate managed/BYOC product built around Graphiti; its governance and operating features should not be assumed to be part of the open-source library. Graphiti currently documents Neo4j, FalkorDB and Neptune among its backends. Atlas could call an internal Python service from its TypeScript backend. [Official README](https://github.com/getzep/graphiti)

The current repository license is **Apache-2.0**, not the MIT license found in older descriptions. [Actual LICENSE](https://github.com/getzep/graphiti/blob/main/LICENSE)

Its reference REST/MCP servers explicitly have no authentication, authorization or prompt-injection protection. Their `group_id` partitions are not an authorization boundary: a caller can operate on any group. Use the library behind Atlas's existing account/grant checks rather than exposing those reference servers. [Reference-server warning](https://github.com/getzep/graphiti#reference-mcp-and-rest-servers)

The edge model stores group, endpoints, source episodes and temporal fields including `created_at`, `valid_at`, `invalid_at` and `expired_at`. That is useful machinery for changing preferences, but source provenance does not itself prove that a relationship is correct. [Edge implementation](https://github.com/getzep/graphiti/blob/main/graphiti_core/edges.py)

**Atlas adaptation:** deterministic user events remain authoritative. Feed only approved structured records into Graphiti; use extracted document relationships as proposals pending Atlas evidence validation. Preserve Atlas IDs in typed nodes and edges. Never let automatic contradiction resolution overwrite an explicit user preference or source record.

## Cognee: broader ingestion and memory pipeline

Cognee is a Python memory platform for turning documents, code and conversations into searchable knowledge. Its core repository is Apache-2.0 and self-hostable. Cloud documentation describes a separate managed offering. [Repository](https://github.com/topoteretes/cognee), [LICENSE](https://github.com/topoteretes/cognee/blob/main/LICENSE), [Documentation index](https://docs.cognee.ai/llms.txt)

Cognee documents dataset-scoped read/write/delete/share permissions, per-user/dataset graph and vector isolation, and runtime permission resolution. These features require backend access-control mode and compatible dataset handlers. Atlas must map its existing identities and resource grants correctly rather than introducing a parallel account system. [Permission model](https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/overview), [Setup](https://docs.cognee.ai/setup-configuration/permissions)

The bundled **Postgres graph store is explicitly a demo**, with serialized writes and no raw Cypher search support. The production Postgres graph adapter is a separately licensed product. Local/embedded stores also have operational ceilings; backend choice matters. Do not interpret “supports PostgreSQL” as an open-source production all-Postgres solution. [Graph-store documentation](https://docs.cognee.ai/setup-configuration/graph-stores)

**Atlas adaptation:** shortlist if flexible public-source ingestion is the priority. Validate supported graph/vector combinations, concurrency, deletion and user isolation in the exact release. Preference scoring and evidence acceptance remain Atlas modules.

## LightRAG: strongest as a public research retrieval component

LightRAG is MIT-licensed Python graph/vector RAG. Its retrieval modes combine entity, relationship and text-chunk context; it supports citations and external storage. Current documentation recommends PostgreSQL for production storage and REST integration, while default in-process/file stores are described as evaluation-oriented. [Repository](https://github.com/HKUDS/LightRAG), [LICENSE](https://github.com/HKUDS/LightRAG/blob/main/LICENSE)

The API server is unauthenticated by default; its documentation says a comprehensive account system is still undeveloped. Workspace partitioning and UI separation are not sufficient evidence of Atlas-grade per-person authorization. [API authentication documentation](https://github.com/HKUDS/LightRAG/blob/main/docs/LightRAG-API-Server.md#api-key-and-authentication)

**Atlas adaptation:** use a private internal deployment to propose cultural facts from a curated public corpus. Accept only claims with checked source passages into Atlas's canonical graph. Do not use its generated graph as the authoritative personal-taste model or evidence-quality gate.

## Storage choices

**PostgreSQL + pgvector:** pgvector provides vector similarity within Postgres and works with ordinary Postgres clients. This fits Atlas's TypeScript services without a second source of truth. Vectors retrieve plausible candidates; they do not prove semantic relationships. Postgres row-security policies can add defense in depth, but table owners normally bypass them, so runtime roles and policies need explicit design and tests. [pgvector](https://github.com/pgvector/pgvector), [Postgres RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)

**Apache AGE:** an Apache-2.0 Postgres extension adding property graphs and openCypher alongside SQL. Current main README lists Postgres 11–18 support. Pin an AGE release compatible with Atlas's exact Postgres version and verify extension installation/hosting support. AGE supplies storage/query machinery, not agent memory, evidence validation or recommendations. Do not assume existing relational row policies automatically secure every Cypher traversal. [README and compatibility](https://github.com/apache/age), [LICENSE](https://github.com/apache/age/blob/master/LICENSE)

**Neo4j:** Community Edition is GPLv3; Enterprise and managed offerings have separate commercial terms. Official multi-database creation documentation is marked Enterprise. Native graph traversal and Python/JavaScript drivers make it a viable Graphiti backend, but a database per customer should not be assumed available in Community Edition. Preserve ownership checks in Atlas and assess edition-specific access control/operating requirements. [License overview](https://neo4j.com/legal-terms/), [Community source license](https://github.com/neo4j/neo4j/blob/2026.01/LICENSE.txt), [Multiple databases](https://neo4j.com/docs/operations-manual/current/database-administration/standard-databases/create-databases/)

**FalkorDB:** supported by Graphiti, but its current database license is SSPLv1. Treat it as source-available with additional service terms, not as equivalent to an Apache/MIT component. It is not my first choice for this specifically open-source baseline. [Actual license](https://github.com/FalkorDB/FalkorDB/blob/master/LICENSE.txt)

**Kuzu:** the official repository was archived on October 10, 2025. Older framework examples may still mention it, but avoid it as the foundation of a new Atlas deployment without an explicitly maintained successor. [Archived repository](https://github.com/kuzudb/kuzu)

## Recommendation learning remains separate

Graph/memory frameworks preserve and retrieve relationships; Atlas still needs an explicit recommender. The MIT-licensed Recommenders project supplies algorithms, data preparation and offline evaluation examples. It can help establish ranking baselines, but does not supply Atlas's provenance model or tenant-safe graph backend. [Recommenders repository](https://github.com/recommenders-team/recommenders)

Compare a deterministic content-based baseline against graph-path ranking before training a graph neural network. Evaluate future held-out positive actions, usefulness, unsupported explanation rate, novelty, diversity and exposure feedback. Never treat a system-generated recommendation as a positive preference without a user action.

## Required proof before adoption

Use the same Atlas ontology and event fixtures across candidates. Require: two users with overlapping interests cannot retrieve each other's private events; revoked access immediately affects graph reads and queued work; removing a like reverses its derived contributions; source retraction disables dependent explanations; retries do not duplicate preferences; every recommended cultural connection has an accepted typed evidence path; unknown sources cannot become public truth; growth has per-account depth/work/spend limits. Measure these alongside usefulness and latency. Framework popularity or a successful RAG demo is not an acceptance test.
