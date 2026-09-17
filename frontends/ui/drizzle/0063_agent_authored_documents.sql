-- Authorship is a column, and it is not responsibility (agent-authored
-- documents design, decisions 2, 6, 8 and 9).
--
-- ## What was wrong
--
-- A commissioned research run already produces a report; it is read out of the
-- run's file system, returned as a chat message and discarded. Filing it as a
-- `documents` row buys assignment, sharing, quota, preview, export and deletion
-- for free — everything that shipped with file-native work objects — and costs
-- exactly one thing the table cannot express today: WHOSE HAND wrote the bytes.
--
-- `created_by` is not that answer and must not be made into it. It names the
-- commissioning user, and it has to keep naming them: the export needs a human
-- to print and the audit needs a human to hold. ADR-0047's rule is that
-- provenance and responsibility are different questions, so a second column
-- answers the second one rather than overloading the first.
--
-- ## Three columns, because the seam is cheap now and expensive later
--
-- `authored_by` alone would be a two-value flag, and a flag is what forces the
-- next producer to be a migration plus an argument about what `agent` used to
-- mean. `user` and `agent` are the members that exist today; the column is
-- plain `text` with no CHECK on its VALUE, so `system` (a scheduled sync) or
-- `import` (a partner feed, a migration) are additions to a tuple in
-- TypeScript. That is anticipation, not a promise — nothing in this change
-- writes either value, and neither should be treated as existing until
-- something does.
--
-- `authored_by_producer` is the column that makes the anticipation more than a
-- gesture. A run id answers WHICH RUN and, exactly once, WHAT WROTE THIS — as
-- long as there is only ever one producer. The moment there are two (a
-- compliance export, an IFC take-off, a partner integration writing evidence),
-- "what made this file" becomes a join through job history that may have been
-- pruned by then. One nullable text column now is free; recovering the producer
-- from run ids afterwards is archaeology. It holds producer IDENTIFIERS —
-- `deep_research`, not "Tiefenrecherche" — because a display label is a
-- translation waiting to happen and this value has to survive one.
--
-- ## Why a non-`user` row must name both
--
-- The whole reason to record that a machine wrote a document is so somebody can
-- later ask what wrote it, in which run, on whose budget, from which question.
-- A row that says "not a person" and can answer neither is worse than no column
-- at all, because it looks like an audit trail. That is true of every producer,
-- not just this one, so the CHECK is written against `authored_by <> 'user'`
-- rather than against `'agent'` — a new member of the tuple arrives already
-- constrained instead of arriving as a hole nobody notices.
--
-- One-directional on purpose: both columns on a `'user'` row are legal. A
-- person saving an artefact a run showed them is not a contradiction, and a
-- biconditional would reject it while protecting nothing — the question this
-- constraint exists for is only ever asked of the rows no person wrote.
--
-- ## No backfill
--
-- Every existing row means exactly what the default says: a person uploaded it,
-- because until this migration there was no other way for a row to exist. This
-- is the `storage_bucket` reasoning applied again (ADR-0043, migration 0033) —
-- a default whose meaning is FIXED needs no scan, and a backfill would only
-- write the value the default already implies.
--
-- ## The `stored` status needs no migration
--
-- `documents.status` is plain `text` with no CHECK, so the new terminal state
-- `stored` — "the bytes are here and indexing was deliberately skipped" — is a
-- TypeScript change, the same way `scope = 'session'` was in 0049. It is
-- recorded here because the two land together: an agent-authored document is
-- never ingested, so it never reaches `processed`, and leaving it at `pending`
-- renders a spinner that never resolves because nothing will ever report on a
-- job that was never dispatched. `stored` is terminal and must stay out of the
-- poller's in-flight set (`lib/documents/reconcile-status.ts`).
--
-- ## Why the documents index is partial
--
-- "Show me everything Piloti wrote in this project" is a point query on
-- `(project_id, created_at DESC)`, and agent rows are the small minority of a
-- table that is overwhelmingly human uploads. A full index would carry an entry
-- for every one of them to serve a lookup that only ever asks about the few.
-- Same arrangement as `documents_conversation_idx` (0049): drizzle's index
-- builder cannot express a partial index, so it lives only here, with a NOTE
-- beside the column in schema/documents.ts.
--
-- `created_at DESC` is in the index rather than left to a sort because the
-- listing is newest-first and a partial index that still needs a sort node is
-- half an index.
--
-- The predicate names `'agent'` and not `<> 'user'`, which is the one place in
-- this change that does not widen with the tuple: a second producer will need
-- this index's predicate widened (and it can be, with a REINDEX-free
-- CREATE/DROP pair) or a second partial index of its own. Deliberate — today
-- there is exactly one producer, `<> 'user'` would index rows no query asks
-- for, and the surfaces that exist ask for Piloti specifically.
--
-- ## The folder uniqueness (decision 8)
--
-- The fixed `Berichte` destination is created on first use, and `project_folders`
-- has no uniqueness on `(project_id, parent_id, name)` — the only unique
-- constraint is `(id, project_id)`, which exists solely so the composite foreign
-- keys have something to reference. So two runs finishing at once both find no
-- folder, both create one, and the project ends up with two `Berichte` folders
-- and no way to say which is real. Get-or-create is not a transaction; a unique
-- index is what makes it one.
--
-- COALESCE over `parent_id` because a root folder's parent is NULL and NULL is
-- never equal to NULL in a unique index — without it, exactly the folders the
-- `Berichte` case is about (root-level, one per project) would stay uncontrolled
-- while every nested folder was protected. The sentinel is the nil UUID, which
-- cannot collide with a real `project_folders.id` (`gen_random_uuid()` is v4,
-- so it never produces the all-zero value).
--
-- The index is case- and whitespace-sensitive, which is deliberate: it is here
-- to stop a RACE between two identical writes, not to police what a human may
-- name a folder. `Berichte` and `berichte` as sibling folders is a product
-- question, and answering it in a unique index would reject folder names people
-- already have.
--
-- ## Existing data
--
-- This migration cannot know whether a deployment already has duplicate sibling
-- folder names — nothing has ever stopped one. `CREATE UNIQUE INDEX` would
-- report that as "could not create unique index", naming one key and leaving the
-- operator to find the rest. The DO block below fails FIRST with the full list,
-- because the resolution is a product decision (rename or merge; the documents
-- inside are real) and must not be guessed at by a migration. Nothing is
-- deduplicated automatically — silently dropping a folder would take its
-- documents' `folder_id` with it through the composite cascade.
--
-- ## RLS
--
-- Nothing to do. `documents` and `project_folders` were secured by 0031, and
-- adding columns or indexes does not move a table across the tenant boundary —
-- the policy is on the table, not on its column list. This migration makes no
-- `grid_secure_table()` call and is deliberately absent from
-- `rls-coverage.spec.ts`'s BOUNDARY_MIGRATIONS.
--
-- ## Locks
--
-- `ADD COLUMN ... DEFAULT` is catalog-only since Postgres 11 — the default is
-- stored in `pg_attribute` and materialised on rewrite, so no table rewrite
-- happens here. The CHECK is added NOT VALID and validated separately so the
-- ACCESS EXCLUSIVE lock covers only the catalog update while the scan runs under
-- SHARE UPDATE EXCLUSIVE; the scan rejects nothing, since `authored_by` is
-- `'user'` in every existing row.

-- ---------------------------------------------------------------------------
-- 1. The columns
-- ---------------------------------------------------------------------------
ALTER TABLE "documents" ADD COLUMN "authored_by" text DEFAULT 'user' NOT NULL;

--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "authored_by_producer" text;

--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "authored_by_run_id" text;

-- ---------------------------------------------------------------------------
-- 2. A row no person wrote can always say what wrote it (see the header)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_authorship_requires_provenance"
  CHECK (
    "authored_by" = 'user'
    OR ("authored_by_producer" IS NOT NULL AND "authored_by_run_id" IS NOT NULL)
  )
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_authorship_requires_provenance";

-- ---------------------------------------------------------------------------
-- 3. The partial index (see the header)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE INDEX "documents_agent_authored_idx"
  ON "documents" ("project_id", "created_at" DESC)
  WHERE "authored_by" = 'agent';

-- ---------------------------------------------------------------------------
-- 4. What the columns mean, in the catalog
-- ---------------------------------------------------------------------------
--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by" IS
  'Whose hand wrote the bytes. user (somebody uploaded a file) and agent (a commissioned run produced it) are the members that exist today; the column carries no CHECK on its value, so a later producer is a TypeScript change. Provenance, never responsibility — created_by stays the commissioning human and assignment stays in resource_assignments (ADR-0047). Every row predating the column is user by definition, so there is no backfill.';

--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by_producer" IS
  'What wrote an authored_by <> user document, as a producer identifier (deep_research), never a display label. NULL for everything a person uploaded. Separate from authored_by_run_id because a run id only identifies the producer while there is exactly one, and recovering it later from pruned job history is archaeology.';

--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by_run_id" IS
  'The backend async job id of the run that wrote an authored_by <> user document; NULL for everything a person uploaded. Required together with authored_by_producer (documents_authorship_requires_provenance) because a machine-written document nobody can trace back to a run is an audit trail in appearance only.';

-- ---------------------------------------------------------------------------
-- 5. A project cannot hold two sibling folders with the same name
-- ---------------------------------------------------------------------------
--> statement-breakpoint
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(entry, E'\n  ' ORDER BY entry) INTO duplicates
  FROM (
    SELECT format(
             'project %s, parent %s, name %L (%s folders)',
             "project_id",
             coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),
             "name",
             count(*)
           ) AS entry
    FROM "project_folders"
    GROUP BY
      "project_id",
      coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),
      "name"
    HAVING count(*) > 1
  ) AS dupes;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot apply migration 0063: sibling folders already share a name, so the unique index cannot be built.\n  %\nResolve each one first by renaming or merging the folders through the application, so the documents filed inside them move with the decision. This migration deliberately does not deduplicate them: deleting a folder row cascades to documents.folder_id and would silently unfile real evidence.',
      duplicates;
  END IF;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_folders_parent_name"
  ON "project_folders" (
    "project_id",
    (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    "name"
  );

--> statement-breakpoint
COMMENT ON INDEX "uniq_project_folders_parent_name" IS
  'One folder per (project, parent, name). COALESCE over parent_id because a root folder has none and NULL never equals NULL in a unique index, which would leave root folders — the case the fixed Berichte destination is about — uncontrolled. It exists so get-or-create is safe under two runs finishing at once, not to police folder naming: it is case- and whitespace-sensitive on purpose.';
