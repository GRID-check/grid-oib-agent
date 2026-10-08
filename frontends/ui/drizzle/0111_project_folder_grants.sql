-- 0109: folder access is read/write per role (ADR-0088).
--
-- A folder either INHERITS its parent's access (`access_mode = 'inherit'`, the
-- default and the state of every open folder; a root folder inherits the
-- project, so every member keeps what their project permissions allow) or has
-- its OWN access list (`'custom'`): rows in `project_folder_grants`, each a
-- WorkOS role slug and a level, `read` or `write`. A role not listed gets
-- nothing. The reserved slug `*` stands for every member of the project.
--
-- The roles are WorkOS slugs held as opaque strings (ADR-0007): who holds them
-- is WorkOS's answer, read from the token's `roles` claim at request time.
--
-- The rule over a path is in one place, `effectiveFolderLevel` in
-- `frontends/ui/src/lib/authz/folder-access.ts`: the minimum over the folder and
-- every ancestor that has its own list, so nesting only ever narrows. The
-- project permission (`project:documents:write`) stays the ceiling for writing.
--
-- A deleted project folder stays behind as a tombstone (`deleted_at`) with its
-- grants, so what was derived from it keeps answering with the access it had;
-- the unique name index therefore covers only living folders.
--
-- ## A custom list is never empty
--
-- "Nobody" is not a setting, and an admin clearing the last role means
-- "inherit". The grants live in their own table, which a CHECK cannot count,
-- so the rule is a DEFERRED constraint trigger on both tables: at commit, a
-- `custom` folder has between 1 and 20 grants. Deferred, so a service can
-- replace a list (delete, then insert) inside one transaction.
--
-- `access_changed_by` / `access_changed_at` say who set the list, for the
-- folder's own header; the audit trail has the history.
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "access_changed_by" text;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "access_changed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "access_mode" text DEFAULT 'inherit' NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_access_mode_check";
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_access_mode_check" CHECK ("access_mode" IN ('inherit', 'custom'));
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "deleted_by" text;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_project_folders_parent_name";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_folders_parent_name"
  ON "project_folders" (
    "organization_id",
    (coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    "name"
  )
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
COMMENT ON INDEX "uniq_project_folders_parent_name" IS
  'One LIVING folder per (organization, project, parent, name) - project is NULL for an Archiv folder (0063, 0102; partial since 0110, so a deleted folder''s tombstone does not hold its name). COALESCE to the nil UUID over project_id and parent_id because NULL never equals NULL in a unique index, which would leave root folders and every Archiv folder uncontrolled.';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_folder_grants" (
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "folder_id" uuid NOT NULL,
  "role_slug" text NOT NULL,
  "level" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_folder_grants_pk" PRIMARY KEY ("folder_id", "role_slug"),
  CONSTRAINT "project_folder_grants_level_check" CHECK ("level" IN ('read', 'write')),
  -- A WorkOS slug (no whitespace, at most 100 characters), or `*` for every
  -- member of the project. A slug may not start with `*`, so the two never meet.
  CONSTRAINT "project_folder_grants_role_check" CHECK (
    "role_slug" = '*' OR "role_slug" ~ '^[^*[:space:]][^[:space:]]{0,99}$'
  ),
  -- The folder's own project, so a grant cannot point across projects; and the
  -- project's organization, so the column the policy trusts is structural
  -- (`projects_id_organization_id_key`, migration 0067).
  CONSTRAINT "project_folder_grants_folder_fkey" FOREIGN KEY ("folder_id", "project_id")
    REFERENCES "project_folders"("id", "project_id") ON DELETE CASCADE,
  CONSTRAINT "project_folder_grants_project_fkey" FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects"("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
COMMENT ON TABLE "project_folder_grants" IS
  'One role''s access to a folder with its own access list (ADR-0088): read, or write. `*` is every project member. Effective access is the minimum over the folder and its ancestors with own lists; the project permission caps write.';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_folder_grants_project_idx" ON "project_folder_grants" ("project_id");
--> statement-breakpoint
SELECT grid_secure_table('project_folder_grants', 'organization_id = grid_current_org()');
--> statement-breakpoint
-- A folder with its own list says who set it.
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_access_custom_check";
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_access_custom_check" CHECK (
    "access_mode" = 'inherit' OR ("access_changed_by" IS NOT NULL AND "access_changed_at" IS NOT NULL)
  );
--> statement-breakpoint
-- The decision point probes a project for any folder with its own list on most
-- document reads; almost every folder inherits, so the index holds the few
-- that do not.
CREATE INDEX IF NOT EXISTS "project_folders_custom_access_idx"
  ON "project_folders" USING btree ("project_id") WHERE "access_mode" = 'custom';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_folder_access_list_check(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  mode text;
  grants integer;
BEGIN
  SELECT "access_mode" INTO mode FROM "project_folders" WHERE "id" = target;
  IF NOT FOUND OR mode <> 'custom' THEN
    RETURN;
  END IF;
  SELECT count(*) INTO grants FROM "project_folder_grants" WHERE "folder_id" = target;
  IF grants < 1 OR grants > 20 THEN
    RAISE EXCEPTION 'folder % has its own access list with % entries; it needs 1 to 20', target, grants
      USING ERRCODE = 'check_violation', CONSTRAINT = 'project_folder_grants_custom_list';
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_folder_access_list_on_folder() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM grid_folder_access_list_check(NEW."id");
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_folder_access_list_on_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM grid_folder_access_list_check(OLD."folder_id");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM grid_folder_access_list_check(NEW."folder_id");
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_access_list" ON "project_folders";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "project_folders_access_list"
  AFTER INSERT OR UPDATE OF "access_mode" ON "project_folders"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."access_mode" = 'custom')
  EXECUTE FUNCTION grid_folder_access_list_on_folder();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folder_grants_access_list" ON "project_folder_grants";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "project_folder_grants_access_list"
  AFTER INSERT OR UPDATE OR DELETE ON "project_folder_grants"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION grid_folder_access_list_on_grant();
