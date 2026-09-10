-- 0081: a conversation says which level of the hierarchy it belongs to.
--
-- ## The question this answers
--
-- The Büro-Chat (ADR-0054) is a conversation that belongs to the ORGANISATION
-- rather than to a project. The database already has rows like that — a
-- project-less `conversations` row is old, ordinary and reachable — and until
-- now the only thing distinguishing one from a project chat was the ABSENCE of
-- a value. Absence is not a statement. It cannot tell an office chat from a
-- project chat whose project was never stamped, from a project chat whose
-- project row was deleted, and every reader has had to guess which it was
-- looking at. Spec WS-9 names the failure that guessing produces: a
-- conversation without a project matching a project, in a list, a filter or a
-- deep link.
--
-- `scope` makes the level a fact the row carries, and the second CHECK makes
-- the fact and the column agree by construction: a `project` row HAS a project,
-- a `workspace` row has NONE. Neither half is expressible without the other,
-- which is the difference between an invariant and a convention.
--
-- ## Why two constraints and not one
--
-- They fail for different reasons and a reader should be told which. The first
-- rejects a value nothing knows how to render (`scope = 'buero'`); the second
-- rejects a shape the application cannot mean (`workspace` with a project).
-- Folded together, a violation would say only "the scope is wrong".
--
-- The value CHECK is what `documents.scope` deliberately does NOT have (see
-- schema/documents.ts): there a new shelf is a TypeScript change, because the
-- shelves are open-ended by design. Here the set is closed — two levels of a
-- hierarchy, both with a surface — so a third member is a migration, and the
-- migration is where anyone would look for what it means.
--
-- ## No `grid_secure_table` line
--
-- `conversations` joined the tenant boundary in 0031 and this is an ALTER. The
-- composite unique `(id, organization_id)` stays exactly as it is:
-- `conversation_mounts` will reference it in phase 3.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
-- `project` by default, so every existing writer keeps inserting what it always
-- inserted and no read path changes meaning on deploy (spec MG-4).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'scope'
  ) THEN
    ALTER TABLE "conversations" ADD COLUMN "scope" text DEFAULT 'project' NOT NULL;
  END IF;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The backfill, as a number in the deploy log
-- ---------------------------------------------------------------------------
-- Project-less rows are workspace rows already; this records what is true of
-- them rather than deciding anything new (spec MG-1). MG-1 also asks for the
-- count to be REPORTED, so it is raised rather than assumed: a deployment that
-- finds 4 000 of these has something to look at, and one that finds 0 has
-- learned that too. The default above has already stamped them `project`, so
-- the predicate is the column that actually decides, not the new one.
DO $$
DECLARE
  backfilled bigint;
BEGIN
  UPDATE "conversations" SET "scope" = 'workspace' WHERE "project_id" IS NULL;
  GET DIAGNOSTICS backfilled = ROW_COUNT;
  RAISE NOTICE '0081: backfilled % project-less conversation(s) to scope=workspace', backfilled;
END $$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. The invariants
-- ---------------------------------------------------------------------------
-- `NOT VALID` then `VALIDATE`, the shape 0049 uses: the second pass takes only
-- a SHARE UPDATE EXCLUSIVE lock, so a large table is not held against writes
-- for the length of a full scan. The backfill above has already made every row
-- satisfy both, so validation is expected to succeed — if it does not, the
-- deploy stops here with the row that disagrees, which is the right outcome.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_scope_known"
  CHECK ("scope" IN ('project', 'workspace'))
  NOT VALID;--> statement-breakpoint

ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_scope_known";--> statement-breakpoint

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_scope_matches_project"
  CHECK (("scope" = 'project') = ("project_id" IS NOT NULL))
  NOT VALID;--> statement-breakpoint

ALTER TABLE "conversations" VALIDATE CONSTRAINT "conversations_scope_matches_project";--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. The index the Büro sessions panel reads
-- ---------------------------------------------------------------------------
-- `WHERE organization_id = $1 AND scope = 'workspace' ORDER BY updated_at DESC`
-- (spec WS-8). `conversations_org_updated_idx` cannot serve it: `scope` sits
-- between its two columns, so the filter would mean reading every project
-- conversation in the tenant only to discard it.
CREATE INDEX IF NOT EXISTS "conversations_org_scope_updated_idx"
  ON "conversations" ("organization_id", "scope", "updated_at" DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. What the column means, in the catalog
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN "conversations"."scope" IS
  'Which level of the knowledge hierarchy this conversation belongs to (ADR-0054): project (the chat inside one project, and every legacy row with a project_id) or workspace (the Büro-Chat, which belongs to the organisation and has no project). Tied to project_id by conversations_scope_matches_project, so the absence of a project is never the only thing that says which this is.';
