-- Reverse 0030: drop the tenant boundary, leaving the data untouched.
--
-- Roles are NOT dropped. They may own grants elsewhere, and a deployment whose
-- connection string still points at grid_app_rw would lose its login mid-flight.
-- Dropping them is a deliberate operator step, documented in
-- docs/database/row-level-security.md.

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

-- CASCADE is deliberate: a leftover policy elsewhere depending on these
-- would otherwise abort the file AFTER the boundary was already removed.
DROP FUNCTION IF EXISTS grid_secure_table(text, text) CASCADE;
DROP FUNCTION IF EXISTS grid_secure_platform_table(text) CASCADE;
DROP FUNCTION IF EXISTS grid_current_org() CASCADE;
DROP FUNCTION IF EXISTS grid_current_user_id() CASCADE;
