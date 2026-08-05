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
--   the table owner    Runs migrations. RLS does NOT apply to a table's owner
--                      (we deliberately do not FORCE it), so DDL and data
--                      backfills keep working exactly as before. Ownership is
--                      therefore the real bypass in this design — and the owner
--                      is whichever role the deployment migrates as (`aiq` in
--                      compose and Kubernetes), NOT a role this migration
--                      names. `grid_app_owner` exists only in the local test
--                      harness.
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
-- It does NOT defend against anything that can issue arbitrary SQL as
-- grid_app_rw — a stolen credential, or a SQL-injection bug in the BFF. Two
-- reasons, both structural:
--
--   * GUCs are unprivileged, so `SET grid.organization_id` to any value works.
--   * grid_app_rw is a MEMBER of grid_app_platform, so `SET ROLE
--     grid_app_platform` is always available to it, and that lifts RLS and
--     grants write access to the platform_* tables. NOINHERIT means the bypass
--     must be ASKED for, not that it can be refused.
--
-- Closing that would need a second login role whose credential never enters the
-- tenant-facing process, or per-tenant credentials. We are not buying either.
-- Least privilege still bounds the damage (no DDL, no ownership), but do not
-- describe this boundary as more than it is.

-- ---------------------------------------------------------------------------
-- Roles: required, but NOT created here
-- ---------------------------------------------------------------------------
-- Roles are cluster-level objects, not schema, and creating them needs
-- privileges a migration has no business holding. Creating `grid_app_platform`
-- specifically requires BOTH CREATEROLE **and** BYPASSRLS — Postgres will not
-- let a role hand out an attribute it does not itself have:
--
--   ERROR:  permission denied to create role
--   DETAIL: Only roles with the BYPASSRLS attribute may create roles with the
--           BYPASSRLS attribute.
--
-- CloudNativePG's application user has neither, so an earlier version of this
-- migration failed every Kubernetes deploy. Granting a migration role BYPASSRLS
-- to work around that would be exactly backwards: the one credential that must
-- never be able to ignore the policies.
--
-- So provisioning belongs to the deployment, which already runs as an admin:
--
--   Kubernetes  deploy/pulumi/src/data/postgres.ts  (CloudNativePG managed roles)
--   Compose     deploy/compose/init-db.sql
--   Local tests scripts/rls-test-db.sh
--
-- This migration only asserts they are there, and says exactly what to do when
-- they are not — a clear failure at deploy time beats a half-applied boundary.

DO $$
DECLARE missing text;
BEGIN
  SELECT string_agg(expected, ', ' ORDER BY expected) INTO missing
  FROM unnest(ARRAY['grid_app_owner', 'grid_app_rw', 'grid_app_platform']) AS expected
  WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = expected);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION
      'row-level security roles are missing: %', missing
      USING HINT = 'Provision them in the deployment before migrating — see '
                   'docs/database/row-level-security.md. They are cluster-level '
                   'objects and are deliberately not created by this migration.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'grid_app_platform' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'grid_app_platform exists but does not hold BYPASSRLS'
      USING HINT = 'Cross-tenant work would silently see nothing. Fix the role '
                   'in the deployment, then re-run this migration.';
  END IF;

  IF NOT pg_has_role('grid_app_rw', 'grid_app_platform', 'MEMBER') THEN
    RAISE EXCEPTION 'grid_app_rw is not a member of grid_app_platform'
      USING HINT = 'Without the membership the platform step-up (SET LOCAL ROLE) '
                   'is rejected and every background sweep goes quiet.';
  END IF;
END
$$;

-- Table and schema privileges ARE the schema's business, and the owner can
-- grant them without any special role attribute.
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
-- `rls-coverage.spec.ts` asserts that, because two permissive policies OR
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
  -- The table's own identity/serial sequences, so a later table added by a
  -- later migration does not fail at INSERT with a confusing
  -- "permission denied for sequence" long after its SELECTs started working.
  EXECUTE format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO grid_app_rw, grid_app_platform');
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
-- Every table in grid_app appears exactly once below. `rls-coverage.spec.ts`
-- fails when a table in the drizzle schema is missing here, so a new table
-- cannot ship outside the boundary.

-- Tenant tables whose rows point at nothing outside themselves: the tenant is
-- the row's own column, and that is the whole rule.
SELECT grid_secure_table('agent_profiler_spans',      'organization_id = grid_current_org()');
SELECT grid_secure_table('answer_feedback',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
SELECT grid_secure_table('budget_policies',           'organization_id = grid_current_org()');
SELECT grid_secure_table('citation_events',           'organization_id = grid_current_org()');
SELECT grid_secure_table('conversations',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
SELECT grid_secure_table('deletion_queue',            'organization_id = grid_current_org()');
SELECT grid_secure_table('documents',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
SELECT grid_secure_table('inbox_items',               'organization_id = grid_current_org()');
SELECT grid_secure_table('legal_holds',               'organization_id = grid_current_org()');
SELECT grid_secure_table('llm_usage_events',          'organization_id = grid_current_org()');
SELECT grid_secure_table('llm_usage_rollups',         'organization_id = grid_current_org()');
SELECT grid_secure_table('mention_requests',          'organization_id = grid_current_org()');
SELECT grid_secure_table('org_llm_credentials',       'organization_id = grid_current_org()');
SELECT grid_secure_table('org_model_config_versions', 'organization_id = grid_current_org()');
SELECT grid_secure_table('org_model_configs',
  'organization_id = grid_current_org() AND (active_version_id IS NULL OR EXISTS (SELECT 1 FROM org_model_config_versions v WHERE v.id = active_version_id AND v.organization_id = grid_current_org()))');
SELECT grid_secure_table('project_memory',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
SELECT grid_secure_table('projects',                  'organization_id = grid_current_org()');
SELECT grid_secure_table('resource_shares',           'organization_id = grid_current_org()');
SELECT grid_secure_table('workflow_runs',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM workflows w WHERE w.id = workflow_id AND w.organization_id = grid_current_org())');
SELECT grid_secure_table('workflows',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

-- The organization registry itself: a tenant sees its own row and no other.
SELECT grid_secure_table('organizations', 'workos_organization_id = grid_current_org()');

-- Child tables with no organization_id of their own. The parent's column is the
-- truth; denormalising a copy onto the child would create a second source of it
-- that can silently disagree.
--
-- COST, measured — this is NOT free, and an earlier version of this comment
-- claimed it was ("Postgres plans it as a semi-join"). It does not: a policy's
-- EXISTS is expanded after sublink pull-up, so it can never become a semi-join.
-- It becomes a hashed SubPlan for a small tenant, and a PER-ROW correlated
-- SubPlan for a large one. Loading 1000 messages for a tenant with 100k
-- conversations measured 6.7x slower and 104x the buffers of the same query as
-- the RLS-exempt owner — and it scales with the TENANT's conversation count,
-- not with what was asked for.
--
-- The fix, when that bites, is an `organization_id` column on `messages` kept
-- honest by a composite foreign key to `conversations (id, organization_id)` —
-- which answers the "second source of truth" objection, because the database
-- then refuses to let the two disagree. Measured at 0.70 ms vs 4.01 ms. Not
-- done here because it needs a backfill; tracked as the follow-up in ADR-0041.
SELECT grid_secure_table('messages',
  'EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.organization_id = grid_current_org())');
SELECT grid_secure_table('conversation_reads',
  'EXISTS (SELECT 1 FROM conversations c WHERE c.id = conversation_id AND c.organization_id = grid_current_org())');
SELECT grid_secure_table('project_folders',
  'EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

-- ---------------------------------------------------------------------------
-- Folder parentage: a constraint, not a policy
-- ---------------------------------------------------------------------------
-- `project_folders.parent_id` and `documents.folder_id` can each point at
-- another tenant's folder, which is the same hole the predicates above close
-- for every other foreign key. They CANNOT be closed the same way: a policy on
-- `project_folders` that reads `project_folders` is refused outright —
--
--   ERROR:  infinite recursion detected in policy for relation "project_folders"
--
-- and because `documents`' policy joined that table, it took `documents` down
-- with it. Both tables were completely unreadable for the runtime role.
--
-- So the rule moves into the schema, where it is both cheaper and stronger:
-- a composite foreign key makes a folder's parent, and a document's folder,
-- belong to the SAME PROJECT. The project is already pinned to the tenant by
-- the policies above, so same-project implies same-organization — enforced by
-- the database on every write, with no policy, no subquery and no recursion.

ALTER TABLE project_folders
  ADD CONSTRAINT project_folders_id_project_id_key UNIQUE (id, project_id);

ALTER TABLE project_folders DROP CONSTRAINT IF EXISTS project_folders_parent_id_fkey;
ALTER TABLE project_folders
  ADD CONSTRAINT project_folders_parent_id_project_id_fkey
  FOREIGN KEY (parent_id, project_id) REFERENCES project_folders (id, project_id);

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_folder_id_project_folders_id_fk;
ALTER TABLE documents
  ADD CONSTRAINT documents_folder_id_project_id_fkey
  FOREIGN KEY (folder_id, project_id) REFERENCES project_folders (id, project_id)
  ON DELETE CASCADE;

-- Keyed to a person, not an organization: preferences follow the user across
-- every organization they belong to, so the user GUC is the tenancy rule.
SELECT grid_secure_table('user_preferences', 'workos_user_id = grid_current_user_id()');

-- Platform-wide configuration: every tenant reads, only the platform tier writes.
SELECT grid_secure_platform_table('platform_model_defaults');
SELECT grid_secure_platform_table('platform_retrieval_settings');
SELECT grid_secure_platform_table('platform_workflow_templates');

-- Sequences behind the SERIAL primary keys; INSERT fails without USAGE.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO grid_app_rw, grid_app_platform;

-- The helpers above take a RAW predicate string and run DDL with it. They are
-- SECURITY INVOKER, so a non-owner calling one fails at the first ALTER TABLE —
-- but EXECUTE defaults to PUBLIC, and the day somebody "fixes" a permissions
-- error by adding SECURITY DEFINER, that raw predicate becomes arbitrary SQL as
-- the owner. Take the invitation away, and pin the search path.
ALTER FUNCTION grid_secure_table(text, text) SET search_path = pg_catalog, public;
ALTER FUNCTION grid_secure_platform_table(text) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION grid_secure_table(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION grid_secure_platform_table(text) FROM PUBLIC;
-- NEVER make these SECURITY DEFINER.

-- Deliberately NO `ALTER DEFAULT PRIVILEGES`. A table added by a later
-- migration is unreadable until it calls grid_secure_table(), so the failure
-- mode for forgetting is a loud "permission denied" rather than a quiet
-- cross-tenant read. The safe default is worth the one extra line per table.
