# Render → Supabase Knowledge Engine migration runbook

This is a one-time, operator-authorized PostgreSQL data transfer. GitHub merging
or a successful CI check does **not** execute it or change Render's production
`DATABASE_URL`. The migration workflow remains manual-only.

## Current destination baseline (13 October 2026)

- Supabase project: `akpxlqktnavtptudyxlp` (DoCHEng).
- PostgreSQL 17; `public.knowledge_schema_meta` has one schema version 3 row.
- All 24 Knowledge content, provenance, revision, and audit tables exist but
  had zero records when checked.
- These existing schema metadata records must be **preserved**.

## Prerequisites

1. Confirm that the Render source PostgreSQL database is accessible and is the
   actual production database holding Knowledge Engine records.
2. Make a source backup/snapshot. Verify the Supabase target project ID.
3. Confirm that both databases contain the same Knowledge Engine tables and
   that source schema version is no newer than target schema version.
4. In the **apologiasancta-engine** GitHub repository, configure independent
   `SOURCE_DATABASE_URL` (Render source) and `SUPABASE_DATABASE_URL`
   (Supabase destination) secrets in the **production** GitHub Actions
   environment, or repository secrets if appropriate. Use connection URLs
   directly from the respective providers, with SSL enabled. Prefer a supported
   Supabase IPv4 session-pooler connection string if a runner cannot reach a
   direct IPv6 endpoint.
5. Never paste either credential in issues, PR comments, workflow inputs,
   commit messages, screenshots, or public chat.

## First run: preflight, no changes

Open **Actions → Migrate Knowledge data to Supabase → Run workflow**
on the latest `main` branch. Leave `dry_run=true` (default).

The workflow must print `ok: true, dryRun: true` and nonzero source Knowledge
content counts; each destination content table must be zero. The destination
`knowledge_schema_meta` may (and should) have a row.

Stop if the source contains no Knowledge records or tables, the target has
content, metadata versions differ incompatibly, or the connection cannot be
established. **Do not create dummy rows just to make this check pass.**

## Execute once

After reviewing successful preflight output, run the workflow again with
`dry_run=false`.

The script:
- uses a repeatable-read, read-only snapshot on the source;
- holds a single destination transaction with locks on target content tables;
- never truncates or overwrites schema metadata or other application tables;
- refuses nonempty destination content, missing schemas, and empty source data;
- inserts source records in dependency order; and
- verifies every copied table's row count before committing. Any failure
  triggers destination transaction rollback.

The workflow is serialized via GitHub Actions concurrency. Record the run URL
and commit SHA for the operator's audit trail.

## Reconciliation and cutover

Connect to destination Supabase and compare exact counts for all 24 Knowledge
content tables with the successful run's `sourceCounts` and `verifiedCounts`.
Confirm a representative published record includes its revision, source and
citation; exercise the public API and editorial authorization/RLS checks.
Review the database security advisors before granting any additional API access.

This migration only copies data: **it does not reconfigure the Render Engine or
Hostinger UI to use Supabase**. The production `render.yaml` currently reads
`DATABASE_URL` from `apologiasancta-postgres`. Plan a separate, rehearsed
cutover with backups, new database URL, health checks, and rollback procedure.
