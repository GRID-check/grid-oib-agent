-- 0104: a project folder can be restricted to WorkOS roles (ADR-0078).
--
-- `restricted_roles` names the organization roles (WorkOS slugs, e.g.
-- `org-geschaeftsfuehrung`) whose holders may see the folder, everything in it,
-- and everything later filed below it. NULL is open, the state every folder had
-- before this migration. An empty array is not a restriction anybody could
-- satisfy, so it is refused: "nobody" is not a setting, and an admin clearing
-- the last role means "open", which is NULL.
--
-- The roles are WorkOS slugs held as opaque strings (ADR-0007): who holds them
-- is WorkOS's answer, read from the token's `roles` claim at request time.
--
-- `restricted_by` / `restricted_at` say who drew the line, for the folder's
-- own header ("eingeschränkt von …"); the audit trail has the history.
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "restricted_roles" text[];
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "restricted_by" text;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "restricted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_restricted_roles_check";
--> statement-breakpoint
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_restricted_roles_check" CHECK (
    "restricted_roles" IS NULL
    OR (cardinality("restricted_roles") BETWEEN 1 AND 20 AND "restricted_by" IS NOT NULL AND "restricted_at" IS NOT NULL)
  );
--> statement-breakpoint
-- The decision point reads a project's restricted folders on most document
-- reads; almost every folder is open, so the index holds only the few that are not.
CREATE INDEX IF NOT EXISTS "project_folders_restricted_idx"
  ON "project_folders" USING btree ("project_id") WHERE "restricted_roles" IS NOT NULL;
