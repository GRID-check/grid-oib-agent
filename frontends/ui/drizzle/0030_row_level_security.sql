-- Row-level security: the database becomes the last line of tenant isolation.
--
-- Until now `organization_id = $1` in a repository WHERE clause was the ONLY
-- thing standing between two tenants' data. That is one forgotten clause away
-- from a cross-tenant leak, in seventeen repositories that keep growing, and
-- nothing in the stack would notice. This migration makes Postgres enforce the
-- same rule underneath the application, so a missing WHERE clause returns zero
-- rows instead of somebody else's.
--
-- ## Three roles
--
--   grid_app_owner     Owns every table; runs migrations. RLS does NOT apply to
--                      a table's owner (we deliberately do not FORCE it), so
--                      DDL and data backfills keep working exactly as before.
--   grid_app_rw        The runtime role the BFF connects as. DML only — no DDL,
--                      no ownership — so every policy below APPLIES to it.
--   grid_app_platform  BYPASSRLS. Deliberate cross-organization access (the
--                      platform admin tier, background workers that sweep every
--                      tenant). Reachable only via `SET LOCAL ROLE`, never by
--                      connecting, so a bypass is visible as `current_user` in
--                      pg_stat_activity and the query log rather than implied.
--
-- Role ATTRIBUTES are not inherited through membership, so granting
-- grid_app_platform to grid_app_rw does not leak BYPASSRLS: it only makes the
-- explicit `SET LOCAL ROLE grid_app_platform` legal. grid_app_rw is NOINHERIT
-- so that privileges do not leak implicitly either.
--
-- ## What this defends against, and what it does not
--
-- It defends against APPLICATION BUGS — the missing or wrong tenant predicate.
-- That is the realistic, recurring threat and RLS closes it completely.
--
-- It does NOT defend against a stolen grid_app_rw credential: GUCs are
-- unprivileged, so anyone holding the credential can set grid.organization_id
-- to any value. Defending against that needs per-tenant credentials, which
-- costs a connection pool per tenant. Least privilege still bounds the damage
-- (no DDL, no other databases, no writes to platform configuration). This is
-- stated plainly here so nobody mistakes the boundary for one it is not.

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Created here rather than only in deployment scripts so the invariant travels
-- with the schema: any database this migration has run against has the roles.
-- The migrating role therefore needs CREATEROLE. No passwords are set — those
-- are secrets and belong in the deployment's secret store, never in git.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_owner') THEN
    CREATE ROLE grid_app_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_platform') THEN
    CREATE ROLE grid_app_platform NOLOGIN BYPASSRLS;
  ELSE
    ALTER ROLE grid_app_platform BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_rw') THEN
    CREATE ROLE grid_app_rw LOGIN NOINHERIT;
  ELSE
    ALTER ROLE grid_app_rw NOINHERIT;
  END IF;
END
$$;

-- The runtime role may become the platform role, but only by saying so.
GRANT grid_app_platform TO grid_app_rw;

GRANT USAGE ON SCHEMA public TO grid_app_rw, grid_app_platform;

-- Nobody gets to create objects in `public` by default (PostgreSQL 15+ already
-- revokes this, but say it explicitly so the posture survives a restore from an
-- older dump).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- The tenant context
-- ---------------------------------------------------------------------------
-- One definition of where the active tenant comes from. Policies call these
-- instead of spelling out `current_setting(...)`, so the GUC name is written
-- once and every policy reads as the rule it encodes.
--
-- `current_setting(..., true)` returns NULL when the GUC is unset, and
-- `organization_id = NULL` is NULL, which is not TRUE, so a query with no
-- tenant context matches NO rows. Fail-closed is the default, not a policy
-- each table has to remember.

CREATE OR REPLACE FUNCTION grid_current_org() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('grid.organization_id', true), '') $$;

COMMENT ON FUNCTION grid_current_org() IS
  'Active tenant for this transaction, from the grid.organization_id GUC. NULL when unset, which makes every tenant policy match zero rows.';

CREATE OR REPLACE FUNCTION grid_current_user_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('grid.user_id', true), '') $$;

COMMENT ON FUNCTION grid_current_user_id() IS
  'Acting user for this transaction, from the grid.user_id GUC. Used by tables keyed to a person rather than an organization.';

-- ---------------------------------------------------------------------------
-- grid_secure_table: how a table joins the tenant boundary
-- ---------------------------------------------------------------------------
-- Enabling RLS, writing the policy and granting DML are three statements that
-- must agree, and a table is silently cross-tenant readable if you do the third
-- without the first two. This bundles them so joining the boundary is one line
-- that states the tenancy rule and nothing else.
--
-- The policy is PERMISSIVE and there is exactly one per table by construction;
-- `rls-policies.spec.ts` asserts that, because two permissive policies OR
-- together and the second one would silently widen the first.

CREATE OR REPLACE FUNCTION grid_secure_table(target text, tenancy_predicate text)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', target);
  EXECUTE format(
    'CREATE POLICY grid_tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
    target, tenancy_predicate, tenancy_predicate);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO grid_app_rw, grid_app_platform', target);
END
$$;

COMMENT ON FUNCTION grid_secure_table(text, text) IS
  'Put a table inside the tenant boundary: enable RLS, install the single grid_tenant_isolation policy from the given predicate, and grant DML to the runtime roles. Every tenant table must call this.';

-- Read-only for tenants, writable only by the platform tier. Deliberately
-- grants no INSERT/UPDATE/DELETE to grid_app_rw at all, so a tenant-facing bug
-- cannot rewrite platform-wide configuration even in its own transaction.
CREATE OR REPLACE FUNCTION grid_secure_platform_table(target text)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('DROP POLICY IF EXISTS grid_tenant_isolation ON %I', target);
  EXECUTE format('CREATE POLICY grid_tenant_isolation ON %I FOR SELECT USING (true)', target);
  EXECUTE format('GRANT SELECT ON %I TO grid_app_rw', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO grid_app_platform', target);
END
$$;

COMMENT ON FUNCTION grid_secure_platform_table(text) IS
  'Platform-wide configuration: every tenant may read it, only the platform role may write it. Not tenant data, so no organization predicate.';

-- ---------------------------------------------------------------------------
-- The boundary, table by table
-- ---------------------------------------------------------------------------
-- Every table in grid_app appears exactly once below. `rls-policies.spec.ts`
-- fails when a table in the drizzle schema is missing here, so a new table
-- cannot ship outside the boundary.

-- Tables carrying organization_id: the tenant is the row's own column.
SELECT grid_secure_table('agent_profiler_spans',      'organization_id = grid_current_org()');
SELECT grid_secure_table('answer_feedback',           'organization_id = grid_current_org()');
SELECT grid_secure_table('budget_policies',           'organization_id = grid_current_org()');
SELECT grid_secure_table('citation_events',           'organization_id = grid_current_org()');
SELECT grid_secure_table('conversations',             'organization_id = grid_current_org()');
SELECT grid_secure_table('deletion_queue',            'organization_id = grid_current_org()');
SELECT grid_secure_table('documents',                 'organization_id = grid_current_org()');
SELECT grid_secure_table('inbox_items',               'organization_id = grid_current_org()');
SELECT grid_secure_table('legal_holds',               'organization_id = grid_current_org()');
SELECT grid_secure_table('llm_usage_events',          'organization_id = grid_current_org()');
SELECT grid_secure_table('llm_usage_rollups',         'organization_id = grid_current_org()');
SELECT grid_secure_table('mention_requests',          'organization_id = grid_current_org()');
SELECT grid_secure_table('org_llm_credentials',       'organization_id = grid_current_org()');
SELECT grid_secure_table('org_model_config_versions', 'organization_id = grid_current_org()');
SELECT grid_secure_table('org_model_configs',         'organization_id = grid_current_org()');
SELECT grid_secure_table('project_memory',            'organization_id = grid_current_org()');
SELECT grid_secure_table('projects',                  'organization_id = grid_current_org()');
SELECT grid_secure_table('resource_shares',           'organization_id = grid_current_org()');
SELECT grid_secure_table('workflow_runs',             'organization_id = grid_current_org()');
SELECT grid_secure_table('workflows',                 'organization_id = grid_current_org()');

-- The organization registry itself: a tenant sees its own row and no other.
SELECT grid_secure_table('organizations', 'workos_organization_id = grid_current_org()');

-- Child tables with no organization_id of their own. The parent's column is the
-- truth; denormalising a copy onto the child would create a second source of it
-- that can silently disagree. The parent lookup is a primary-key probe, and
-- Postgres plans it as a semi-join rather than a per-row subquery.
SELECT grid_secure_table('messages',
  'EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.organization_id = grid_current_org())');
SELECT grid_secure_table('conversation_reads',
  'EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.organization_id = grid_current_org())');
SELECT grid_secure_table('project_folders',
  'EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

-- Keyed to a person, not an organization: preferences follow the user across
-- every organization they belong to, so the user GUC is the tenancy rule.
SELECT grid_secure_table('user_preferences', 'workos_user_id = grid_current_user_id()');

-- Platform-wide configuration: every tenant reads, only the platform tier writes.
SELECT grid_secure_platform_table('platform_model_defaults');
SELECT grid_secure_platform_table('platform_retrieval_settings');
SELECT grid_secure_platform_table('platform_workflow_templates');

-- Sequences behind the SERIAL primary keys; INSERT fails without USAGE.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO grid_app_rw, grid_app_platform;

-- Deliberately NO `ALTER DEFAULT PRIVILEGES`. A table added by a later
-- migration is unreadable until it calls grid_secure_table(), so the failure
-- mode for forgetting is a loud "permission denied" rather than a quiet
-- cross-tenant read. The safe default is worth the one extra line per table.
