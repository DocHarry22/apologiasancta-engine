# Apologia Sancta Knowledge Engine

This service implements the canonical identity and provenance foundation described by the updated Knowledge Engine architecture. The public Galaxy, Learn, Quiz, Articles, Debate, and Admin surfaces should progressively consume this API rather than create parallel theological data models.

## Phase A integrity rules

1. Reusable propositions and evidence receive stable canonical IDs.
2. Claim-like nodes contain one atomic proposition.
3. Edges use a bounded relationship vocabulary.
4. A relationship is not self-authenticating: substantive publication requires attributable edge assertions and review evidence.
5. Node, edge, and source revisions are immutable snapshots with SHA-256 content hashes.
6. Reviews bind to a specific immutable revision hash.
7. Publication is allowed only when the current revision has the required approved reviews.
8. Assessments are lens-specific and never overwrite the underlying proposition.
9. Exact citations remain distinct from source identity and interpretation.
10. Duplicate/reconciliation results are advisory; the server never auto-merges canonical objects.

## Database

The Knowledge Engine uses PostgreSQL. In production it reuses `DATABASE_URL` from the managed Apologia Sancta Postgres instance unless `KNOWLEDGE_DATABASE_URL` is deliberately set.

Environment:

```text
KNOWLEDGE_ENGINE_REQUIRED=true
KNOWLEDGE_DB_POOL_MAX=6
# KNOWLEDGE_DATABASE_URL=...   # optional override
```

`npm run build` compiles the service. `npm run knowledge:migrate` applies the idempotent schema. Render runs the migration before the server starts.

Schema groups:

- identity: `knowledge_nodes`, aliases, node versions
- relationships: edges, edge versions, edge assertions
- evidence: sources, source versions, citations
- perspective: assessments and claim-family membership
- governance: reviews and publication events

## Public API

Published records only:

```text
GET /knowledge/status
GET /knowledge/search?q=trinity&kind=claim
GET /knowledge/nodes/:id
GET /knowledge/nodes/:id/evidence
GET /knowledge/nodes/:id/assessments?lens=catholic
GET /knowledge/neighborhood?nodeId=claim:...&depth=2&lens=catholic
GET /knowledge/compare?left=claim:...&right=claim:...
```

Neighborhood traversal is intentionally bounded to depth 0-3 and a capped number of nodes. The client should progressively fetch local constellations instead of requesting a database-wide graph.

## Knowledge Foundry admin API

All routes require the existing `ADMIN_TOKEN`. `X-Editor-Id` may additionally attribute editorial actions.

```text
POST  /admin/knowledge/nodes
PATCH /admin/knowledge/nodes/:id
POST  /admin/knowledge/edges
POST  /admin/knowledge/edge-assertions
POST  /admin/knowledge/sources
POST  /admin/knowledge/citations
PUT   /admin/knowledge/assessments
PUT   /admin/knowledge/claim-families/member
GET   /admin/knowledge/reconcile?q=...
GET   /admin/knowledge/nodes/:id
GET   /admin/knowledge/neighborhood?nodeId=...
POST  /admin/knowledge/reviews
POST  /admin/knowledge/publish
```

### Publication example

1. Create a draft node.
2. Attach evidence/sources and any relevant assertions/assessments.
3. Record a `source` review for the current revision hash.
4. Record a `doctrinal` review for a node/edge revision.
5. Publish the same revision ID.
6. Any later edit creates a new revision and therefore requires new review evidence before republishing.

Sources currently require an approved source review. Nodes and edges require both source and doctrinal approval.

## Reconciliation

`GET /admin/knowledge/reconcile` currently provides deterministic lexical suggestions over titles and propositions. It is deliberately conservative: it is a candidate finder, not an automatic merge system. A later semantic-embedding layer may improve recall, but the merge/reuse decision remains editorial.

## Compatibility migration

The existing `apologia-graph` application still contains topic-owned `connections` and `links`. The next migration step is to inventory those records, emit globally addressable nodes/edges/sources with preserved legacy IDs, attach provenance assertions, and replace the Graph's private graph builder with a Knowledge Engine neighborhood adapter. Existing UI behavior remains available during that transition.

## Security and production behavior

- invalid canonical input is rejected as HTTP 400;
- admin mutation routes use the existing production admin-token boundary;
- public queries expose published data only;
- authoring preview routes may include unpublished data but remain admin-only;
- the database schema migration gates production startup when `KNOWLEDGE_ENGINE_REQUIRED=true`;
- server-side database credentials are never exposed to the browser or APK.
