# Advanced Knowledge Engine completion contract

This stacked branch completes the advanced apologetics services after canonical identity/provenance and curated journeys/arguments.

## Timeline

Expose a published-only timeline endpoint that accepts a root/topic/domain query and bounded year/date range. Timeline records must come from canonical event/source/node metadata and be explicitly sorted; undated records must not be assigned invented dates. Return provenance identifiers so the UI can inspect the evidence behind each entry.

## Compare

Extend compare beyond common neighbors. A comparison package should contain the two published nodes, direct typed edges, shared neighbors, relevant lens assessments, definitional relationships, historical relationships and a bounded connecting path when one exists. Do not infer `contradiction` merely because traditions differ; only return canonical relationship types/assertions that are stored and published.

## Debate / argument battle

Expose published debate paths and a deterministic debate-session traversal contract over canonical path/argument data. A step may present an objection and published candidate responses. The server may score route completeness or evidence use, but never theological truth. No hidden unpublished answer route may leak to public clients. The result payload should identify missed published evidence/alternate routes and canonical nodes for mastery integration.

## Coverage dashboard

Admin-only coverage metrics must report at least:
- nodes by kind/state
- unsupported published claim-like nodes
- published edges lacking the required provenance should be zero; if any appear, flag critically
- unresolved/unapproved assertions
- unanswered objections (published objections with no published `responds_to` response edge)
- review backlog by dimension/state
- source/citation verification backlog
- duplicate/reconciliation candidates if available
- arguments with missing structural coverage
Metrics are editorial QA, not truth scoring.

## Search / performance

Keep all public graph/path traversals bounded. Instrument query duration and returned node/edge counts without logging sensitive payloads. Add cache headers only to immutable/published public responses where safe.

## AI-assisted authoring boundary

Add an admin-only authoring-assistance layer that is safe even without an external AI provider. It should support structured proposal records for duplicate candidates, extracted candidate claims, candidate relationships, candidate citations, argument decompositions, draft quiz/lesson linkage suggestions and missing-evidence findings. Proposals are untrusted and cannot mutate or publish canonical knowledge until an editor explicitly accepts them through ordinary governed write/review routes.

If no model/provider is configured, deterministic heuristics may create proposals and the API must clearly report provider=`heuristic`. Define an optional provider interface and environment contract without committing keys. Any future provider output remains proposal-only.

Persist proposals with prompt/input hash, provider/model metadata, proposal JSON, status (proposed/accepted/rejected/expired), actor/reviewer and timestamps. Never store secret prompts/credentials in public output. Accepted proposals record the canonical mutation IDs but do not bypass review/publication.

## Acceptance

- no public draft leakage
- no AI/heuristic auto-publish or auto-merge
- timeline never invents chronology
- debate never exposes unpublished branches
- comparison returns only stored published relationships/assessments
- coverage queries are bounded and admin-protected
- AI proposal acceptance requires normal admin mutation and subsequent review/publication
- typecheck, full tests and build pass
