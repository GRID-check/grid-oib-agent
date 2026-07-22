# ADR-0027: Database schema is owned by the application, not the infrastructure

- **Status:** Accepted
- **Date:** 2026-07-22
- **Deciders:** Platform engineering
- **Related:** ADR-0021 (DB-claimed workers), the Pulumi K8s deployment (`deploy/pulumi`)

## Context

The backend job/knowledge tables (`job_info`, `job_access`, `job_events`,
`summaries`, `research_job_queue`, `ingest_jobs`, and the LangGraph
`checkpoint*` tables) were being declared in **three** places:

1. `deploy/compose/init-db.sql` (the Postgres container's init script),
2. `deploy/pulumi/src/data/postgres.ts` `JOBS_SQL`/`CHECKPOINTS_SQL` (the K8s
   pg-init Job), and
3. the application's runtime `_ensure_schema` helpers (`jobs/access.py`,
   `jobs/event_store.py`, `jobs/queue.py`, `knowledge/summary_store.py`, …) plus
   NAT's `JobStore` and the LangGraph checkpointer.

Only (3) is authoritative: it runs on every boot and performs the
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` migrations and index creation the SQL
bootstraps don't. (1) and (2) are redundant belt-and-suspenders that must be
hand-kept in sync — and weren't: `job_access.organization_id` (added by the app)
is absent from the Pulumi `JOBS_SQL`, i.e. real drift. A scaling-review index
change briefly made it worse by writing the same index in all three.

Industry practice is consistent here: **IaC provisions database *infrastructure*
(instances, databases, roles, networking); it should not own the *schema***
(tables, columns, indexes), which is sequential, versioned, and coupled to
application code — the domain of migrations, not declarative infra state.

## Decision

The **application owns the schema**; the **infrastructure provisions only the
databases and roles**.

- Frontend (`grid_app`): drizzle migrations (already the case).
- Backend (`aiq_jobs`, `aiq_checkpoints`): the runtime `_ensure_schema` helpers +
  NAT `JobStore` + the LangGraph checkpointer are the single source of truth for
  their tables and indexes. New indexes go there (e.g. `idx_job_access_org`,
  `idx_job_events_created_at`), not in the bootstraps.
- Infra (`deploy/pulumi` CloudNativePG `Cluster.bootstrap.postInitSQL`, compose
  `init-db.sql`): create the three databases + the app role only.

## Consequences

- **Positive:** no schema drift class; one place to change a table; indexes and
  columns are guaranteed present because the code that uses them also creates
  them.
- **Negative / follow-up:** the backend's `CREATE TABLE IF NOT EXISTS` +
  `ADD COLUMN IF NOT EXISTS` "ensure on boot" is a lightweight migration, not a
  versioned one. A proper backend migration tool (Atlas / Alembic), mirroring
  the frontend's drizzle, is the recommended next step.
- **This ADR's immediate scope:** stop *adding* schema to the bootstraps (done —
  the scaling indexes live only in the app ensure). Fully removing the redundant
  table DDL from `init-db.sql` / the Pulumi pg-init Job is a follow-up that must
  first confirm NAT's `JobStore` self-creates `job_info` on a virgin database
  (so nothing relies on the bootstrap pre-seeding), then be validated with a
  `pulumi up` against a fresh cluster.
