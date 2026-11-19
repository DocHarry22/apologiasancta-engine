# Public Supabase Knowledge Engine

This directory tracks the previously deployed public `knowledge-v2` reader.
Deploy `index.ts` and `publicGraph.mjs` together. It uses the project's existing
server secret through Supabase environment variables and accepts GET/OPTIONS
only; browser clients do not receive that secret.

The graph neighborhood and node evidence endpoints return the camelCase
contract consumed by both Apologia clients. Neighborhoods use bounded batch
queries, deduplicate cycles and exclude edges with missing endpoints. Public
assessments, assertions and node citations must match the published revision.
Evidence includes published source details. Metadata keys remain unchanged.

The deployment preserves its existing `verify_jwt=false` public-reader setting.
No authoring or publication endpoint is implemented here.

Run `npm test` from the repository root for traversal, DTO, handler and
revision-boundary checks. Handler tests execute the actual entrypoint with a
fixture query adapter; they do not publish fixture content to the database.

These repairs cover graph neighborhoods, evidence and transport compatibility.
The older topic/path/advanced research handlers still need full parity with the
Node engine before treating the Supabase reader as a complete replacement.
