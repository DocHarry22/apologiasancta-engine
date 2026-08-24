# Supabase Knowledge Engine migration

The canonical Knowledge Engine target is the dedicated Supabase project:

`akpxlqktnavtptudyxlp`

Project URL:

`https://akpxlqktnavtptudyxlp.supabase.co`

## Codex MCP setup

Run locally in Codex:

```bash
codex mcp add supabase --url 'https://mcp.supabase.com/mcp?project_ref=akpxlqktnavtptudyxlp&features=docs%2Caccount%2Cdatabase%2Cdebugging%2Cdevelopment%2Cfunctions%2Cbranching'
codex mcp login supabase
```

Verify with `/mcp`.

Optional Agent Skills:

```bash
npx skills add supabase/agent-skills
```

## Deployment model

- PostgreSQL is the source of truth for Knowledge Engine data.
- Public read APIs are served by the `knowledge` Supabase Edge Function.
- Publication/provenance invariants remain enforced in PostgreSQL.
- Never expose a Supabase secret/service-role key to the browser, Android app, or repository.
- Render remains a temporary migration dependency until the production data export has been imported and all required API routes have been moved.

## Current Edge endpoint

`https://akpxlqktnavtptudyxlp.supabase.co/functions/v1/knowledge`

Implemented public routes include health, published nodes, published node assessments, published sources, published topics, and timeline reads.

## Data migration

The target schema has been provisioned, but production rows are intentionally not fabricated. A Render PostgreSQL backup or connection string with read access is required to perform the final data transfer. Once supplied, import into the Supabase target and validate node/edge/source/revision counts plus publication invariants before retiring Render.
