-- 0102: folders become a property of a SHELF (project | archiv), not of a project
-- (ADR-0078; reverses the "flat Archiv" half of ADR-0024).
--
-- ## What changes
--
-- `project_folders` held exactly one kind of folder: a project's. The org-wide
-- Archiv is the same table of documents (`scope = 'archiv'`, NULL project) and
-- wants the same tree, so the table gains the two columns that say whose a
-- folder is:
--
--   * `organization_id` - the tenant. Backfilled from `projects`, then NOT NULL.
--   * `scope`           - 'project' | 'archiv', the same vocabulary as
--                         `documents.scope`. DEFAULT 'project', because every
--                         row that exists today is one.
--
-- and `project_id` becomes nullable (an Archiv folder has no project). The CHECK
-- `(scope = 'project') = (project_id IS NOT NULL)` is the biconditional that
-- keeps the three columns telling one story.
--
-- ## The table keeps its name, deliberately
--
-- `project_folders` is now a misnomer for half its rows. Renaming it touches the
-- Python mirror and ten earlier migrations, buys nothing a reader of the schema
-- cannot learn from this comment and the one in schema/project-folders.ts, and
-- turns a column change into a table swap. It is a DELIBERATE DEFERRAL: do the
-- rename when something else forces a table swap, not before.
--
-- ## Tenancy and shelf, held by the database
--
-- 0031 tied a folder's parent and a document's folder to the same PROJECT and let
-- "same project" imply "same tenant". An Archiv folder has no project, so that
-- argument is gone and the tenant has to be stated:
--
--   * UNIQUE (id, organization_id, scope) is the FK target.
--   * `project_folders (parent_id, organization_id, scope)` -> that key: a folder's
--     parent is on its own shelf and in its own tenant.
--   * `documents (folder_id, organization_id, scope)` -> that key: a document's
--     folder is on its own shelf AND tenant. A project document cannot be filed in
--     an Archiv folder, an Archiv one cannot be filed in a project folder, and a
--     `session` document cannot be filed at all - no folder row can have scope
--     'session', so the key has nothing to match. Both FKs are MATCH SIMPLE and
--     skipped for a NULL parent / folder, which is the root.
--
-- The existing `(parent_id, project_id)` and `(folder_id, project_id)` keys stay:
-- they are what stops a folder of project A holding a document of project B
-- inside one tenant, which the new keys cannot see.
--
-- `documents_folder_requires_project` is widened, not dropped. Its job was to
-- make the project key checkable (MATCH SIMPLE skips a NULL `project_id`); the
-- new key now checks every folder reference whatever the project, so what the
-- CHECK still states is the shelf rule: a filed document is a project document
-- or an Archiv one.
--
-- ON DELETE CASCADE on the new document key, like the key it joins: the services
-- re-file documents and child folders into the parent BEFORE deleting a folder,
-- so the cascade is only a backstop and has to agree with the old one.
--
-- ## Uniqueness for both shelves
--
-- `uniq_project_folders_parent_name` was (project, parent, name). The new index is
-- (organization, project, parent, name), each nullable member behind COALESCE to
-- the nil UUID, because NULL is never equal to NULL in a unique index: without it
-- root folders (parent NULL) and every Archiv folder (project NULL) would be
-- uncontrolled and exactly the get-or-create races it exists for would reappear.
-- The nil UUID cannot collide with a real id (`gen_random_uuid()` is v4). Within
-- one tenant a project id determines the organization, so for every existing row
-- the new index rejects precisely what the old one did: no pre-check is needed.
--
-- ## RLS
--
-- The policy is re-installed on the new column. It no longer joins `projects`:
-- a plain column predicate is cheaper, reads no table, and cannot recurse (the
-- reason 0031 moved the folder rules into constraints). `grid_secure_table` is
-- idempotent: it drops the single `grid_tenant_isolation` policy and recreates it.
--
-- ## Locks
--
-- The two ADD COLUMNs are catalog-only (constant default / nullable) and the
-- backfill touches only `project_folders`, a small table. The new CHECKs and FKs on
-- `documents` are added NOT VALID and validated separately, so the ACCESS EXCLUSIVE
-- lock covers the catalog update only while the scan runs under a weaker one.

-- ---------------------------------------------------------------------------
-- 1. The columns, and the backfill of the tenant
-- ---------------------------------------------------------------------------
ALTER TABLE "project_folders" ADD COLUMN "organization_id" text;

--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN "scope" text DEFAULT 'project' NOT NULL;

--> statement-breakpoint
UPDATE "project_folders" f
   SET "organization_id" = p."organization_id"
  FROM "projects" p
 WHERE p."id" = f."project_id";

--> statement-breakpoint
ALTER TABLE "project_folders" ALTER COLUMN "organization_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "project_folders" ALTER COLUMN "project_id" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The shelf, as a database invariant
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_scope_check"
  CHECK ("scope" IN ('project', 'archiv'));

--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_scope_owner_check"
  CHECK (("scope" = 'project') = ("project_id" IS NOT NULL));

-- ---------------------------------------------------------------------------
-- 3. The key a parent and a document reference, and the parent's key
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_id_organization_id_scope_key"
  UNIQUE ("id", "organization_id", "scope");

--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_parent_id_organization_id_scope_fkey"
  FOREIGN KEY ("parent_id", "organization_id", "scope")
  REFERENCES "project_folders" ("id", "organization_id", "scope");

-- ---------------------------------------------------------------------------
-- 4. One folder per (tenant, project, parent, name)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_project_folders_parent_name";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_folders_parent_name"
  ON "project_folders" (
    "organization_id",
    (coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    "name"
  );

--> statement-breakpoint
COMMENT ON INDEX "uniq_project_folders_parent_name" IS
  'One folder per (organization, project, parent, name) - project is NULL for an Archiv folder. COALESCE to the nil UUID over project_id and parent_id because NULL never equals NULL in a unique index, which would leave root folders and every Archiv folder uncontrolled. It exists so get-or-create is safe under two runs finishing at once, not to police folder naming: it is case- and whitespace-sensitive on purpose.';

-- ---------------------------------------------------------------------------
-- 5. A document's folder is on its own shelf and tenant
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_folder_requires_project";

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_folder_requires_project"
  CHECK ("folder_id" IS NULL OR "project_id" IS NOT NULL OR "scope" = 'archiv')
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_folder_requires_project";

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_folder_id_organization_id_scope_fkey"
  FOREIGN KEY ("folder_id", "organization_id", "scope")
  REFERENCES "project_folders" ("id", "organization_id", "scope")
  ON DELETE CASCADE
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_folder_id_organization_id_scope_fkey";

-- ---------------------------------------------------------------------------
-- 6. RLS: the tenant column, not a join through projects
-- ---------------------------------------------------------------------------
--> statement-breakpoint
SELECT grid_secure_table('project_folders', 'organization_id = grid_current_org()');
