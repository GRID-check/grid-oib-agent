-- Reverse 0030: drop the tenant boundary, leaving the data untouched.
--
-- Roles are NOT dropped. They may own grants elsewhere, and a deployment whose
-- connection string still points at grid_app_rw would lose its login mid-flight.
-- Dropping them is a deliberate operator step, documented in
-- docs/database/row-level-security.md.

-- 0031 must come off FIRST. Its policies on `messages` and `conversation_reads`
-- call grid_current_org(), and the `DROP FUNCTION … CASCADE` at the bottom of
-- this file would take them with it — without an error, because that is what
-- CASCADE is for. The tables would keep RLS enabled with no policy left, which
-- reads as zero rows for the runtime role while `\d` still says "protected".
-- Silent, and in the direction that looks like a data-loss bug rather than a
-- rollback mistake. Refuse instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'organization_id'
  ) THEN
    RAISE EXCEPTION 'migration 0031 is still applied'
      USING HINT = 'Roll back 0031_messages_organization_id.down.sql first: its policies '
                   'depend on grid_current_org(), and the CASCADE in this file would drop '
                   'them silently, leaving both tables RLS-enabled with no policy.';
  END IF;
END
$$;

-- Only tables THIS migration secured. An earlier version looped over every
-- table in `public`, which silently disabled row-level security on any table
-- with its own unrelated policy — leaving the policy in place, so `\d` still
-- looked protected while the table had become readable by everyone.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    WHERE p.polname = 'grid_tenant_isolation'
      AND c.relnamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- Without this the rollback would turn the least-privilege runtime role into an
-- UNBOUNDED one: still holding DML on all 28 tables, now with no policies
-- filtering it. The roles deliberately survive (see below), so their privileges
-- must not.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM grid_app_rw, grid_app_platform;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM grid_app_rw, grid_app_platform;
REVOKE USAGE ON SCHEMA public FROM grid_app_rw, grid_app_platform;

-- The composite keys are part of the boundary too, and they were the ONLY
-- thing left un-reversed here: 0030 adds `project_folders_id_project_id_key`
-- unconditionally, so rolling back and re-applying failed at that line with
-- "constraint already exists" — a rollback that cannot be rolled forward again
-- is not a rollback. Restore the single-column keys with the referential
-- actions they had in 0005/0007/0009 (parent: NO ACTION; document folder:
-- ON DELETE CASCADE).
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_folder_id_project_id_fkey;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_folder_requires_project;
ALTER TABLE documents
  ADD CONSTRAINT documents_folder_id_project_folders_id_fk
  FOREIGN KEY (folder_id) REFERENCES project_folders (id) ON DELETE CASCADE;

ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_parent_id_project_id_fkey;
ALTER TABLE project_folders
  ADD CONSTRAINT project_folders_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES project_folders (id);

-- Last, because both foreign keys above referenced it.
ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_id_project_id_key;

-- CASCADE is deliberate: a leftover policy elsewhere depending on these
-- would otherwise abort the file AFTER the boundary was already removed.
DROP FUNCTION IF EXISTS grid_secure_table(text, text) CASCADE;
DROP FUNCTION IF EXISTS grid_secure_platform_table(text) CASCADE;
DROP FUNCTION IF EXISTS grid_current_org() CASCADE;
DROP FUNCTION IF EXISTS grid_current_user_id() CASCADE;
