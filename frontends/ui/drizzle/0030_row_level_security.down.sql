-- Reverse 0030: drop the tenant boundary, leaving the data untouched.
--
-- Roles are NOT dropped. They may own grants elsewhere, and a deployment whose
-- connection string still points at grid_app_rw would lose its login mid-flight.
-- Dropping them is a deliberate operator step, documented in
-- docs/database/row-level-security.md.

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', t);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

DROP FUNCTION IF EXISTS grid_secure_table(text, text);
DROP FUNCTION IF EXISTS grid_secure_platform_table(text);
DROP FUNCTION IF EXISTS grid_current_org();
DROP FUNCTION IF EXISTS grid_current_user_id();
