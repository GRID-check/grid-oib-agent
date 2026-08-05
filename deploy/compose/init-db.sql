-- =============================================================================
-- AI-Q Blueprint - Database Initialization (idempotent — safe to re-run)
-- =============================================================================
--
-- Run by the backend init container on every pod start. All statements are
-- idempotent (IF NOT EXISTS) so re-runs are safe.
--
-- Databases:
--   - aiq_jobs         (job metadata, events, document metadata)
--   - aiq_checkpoints  (LangGraph conversation state)
--   - grid_app         (Next.js BFF application state)
--
-- Tables in aiq_jobs:
--   - job_info      — NAT JobStore metadata (status, timestamps, expiry)
--   - job_access    — AIQ-owned job ownership/access control metadata
--   - job_events    — SSE streaming events and job event persistence
--   - document_metadata — Per-document metadata: summary, tags, doc_class,
--                     display_title (collection + filename keyed; was `summaries`)
--
-- Tables in aiq_checkpoints:
--   - checkpoints           — LangGraph conversation checkpoints
--   - checkpoint_blobs      — LangGraph binary state data
--   - checkpoint_writes     — LangGraph pending writes
--   - checkpoint_migrations — LangGraph schema version tracking
--
-- =============================================================================

-- Create checkpoints database if it doesn't exist
SELECT 'CREATE DATABASE aiq_checkpoints' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'aiq_checkpoints')\gexec

-- Create grid_app database if it doesn't exist
SELECT 'CREATE DATABASE grid_app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'grid_app')\gexec

-- Grant permissions
GRANT ALL PRIVILEGES ON DATABASE aiq_jobs TO aiq;
GRANT ALL PRIVILEGES ON DATABASE aiq_checkpoints TO aiq;
GRANT ALL PRIVILEGES ON DATABASE grid_app TO aiq;

-- =============================================================================
-- Row-level-security roles (ADR-0041)
-- =============================================================================
-- These are CLUSTER-level objects, so they are provisioned here rather than by
-- drizzle migration 0030 — which only asserts they exist, and says so loudly if
-- they do not. That split is not tidiness: creating `grid_app_platform`
-- requires the creator to hold BYPASSRLS itself, and the migration role must
-- never hold that. This script runs as the compose superuser, so it can.
-- Kubernetes does the same job through CloudNativePG's managed roles.
--
-- Note this file runs ONLY when Postgres initialises a fresh data directory.
-- On an existing volume the `grid-migrate` service's `ensure-rls-roles.mjs`
-- creates whichever roles are absent and keeps `grid_app_rw`'s password in step
-- with GRID_APP_DATABASE_URL instead.
--
-- WHO ACTUALLY OWNS THE SCHEMA HERE: `aiq`, the compose superuser — not
-- `grid_app_owner`. This stack points GRID_APP_MIGRATION_DATABASE_URL at `aiq`,
-- and only the test harness (`scripts/rls-test-db.sh`) migrates as
-- `grid_app_owner`. That is deliberate: the harness runs the restricted shape on
-- purpose, because it is the shape that catches privilege mistakes a
-- superuser-run migration hides. `grid_app_owner` is provisioned here anyway so
-- migration 0030's role assertion passes and so a deployment can switch the
-- migration credential over without a schema change.
--
-- And note what ownership means for RLS: 0030 uses ENABLE ROW LEVEL SECURITY,
-- not FORCE, so whoever owns a table is exempt from its policies. That is the
-- reason migrations and backfills work at all — they run as the owner — and the
-- reason the SERVING tier must never connect as one. `grid_app_rw` is what the
-- app uses, and it owns nothing.
--
-- The dev password below is exactly that: a DEV default, matching `aiq_dev`
-- alongside it, for a compose stack on a laptop.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_owner') THEN
    -- Owns the schema and runs migrations. Deliberately no CREATEROLE and no
    -- BYPASSRLS: it is the one credential that must not be able to ignore the
    -- policies it installs.
    CREATE ROLE grid_app_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD 'grid_app_owner_dev';  -- pragma: allowlist secret (compose dev default)
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_platform') THEN
    CREATE ROLE grid_app_platform NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_rw') THEN
    CREATE ROLE grid_app_rw LOGIN NOINHERIT PASSWORD 'grid_app_rw_dev';  -- pragma: allowlist secret (dev default; real deployments set GRID_APP_RUNTIME_PASSWORD)
  END IF;
END
$$;

-- The runtime role may BECOME the platform role, but only by explicitly asking
-- (`SET LOCAL ROLE`). NOINHERIT above is what makes that explicit.
GRANT grid_app_platform TO grid_app_rw;

-- =============================================================================
-- Create tables in aiq_jobs database
-- =============================================================================
\connect aiq_jobs

-- Job metadata table (NAT JobStore)
CREATE TABLE IF NOT EXISTS job_info (
    job_id VARCHAR PRIMARY KEY,
    status VARCHAR NOT NULL,
    config_file VARCHAR,
    error VARCHAR,
    output_path VARCHAR,
    created_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE,
    expiry_seconds INTEGER,
    output VARCHAR,
    is_expired BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_job_info_status ON job_info(status);
CREATE INDEX IF NOT EXISTS idx_job_info_created_at ON job_info(created_at);

CREATE TABLE IF NOT EXISTS job_access (
    job_id VARCHAR PRIMARY KEY,
    owner_auth_type VARCHAR NOT NULL,
    owner_subject VARCHAR NOT NULL,
    owner_email VARCHAR,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_access_owner ON job_access(owner_auth_type, owner_subject);

-- Job events table (SSE streaming, event persistence)
CREATE TABLE IF NOT EXISTS job_events (
    id SERIAL PRIMARY KEY,
    job_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    event_data TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id);
CREATE INDEX IF NOT EXISTS idx_job_events_job_id_id ON job_events(job_id, id);

-- Per-document metadata table (summary + tags + doc_class + display_title).
-- Formerly named `summaries`; existing deployments are renamed in place at
-- runtime by DocumentMetadataStore (ALTER TABLE ... RENAME), preserving rows.
-- Only the summary column is created here; the optional columns are added by the
-- store's in-place migration on first access (always exercised on a live DB).
CREATE TABLE IF NOT EXISTS document_metadata (
    collection VARCHAR(256) NOT NULL,
    filename VARCHAR(512) NOT NULL,
    summary TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (collection, filename)
);

CREATE INDEX IF NOT EXISTS idx_document_metadata_collection ON document_metadata(collection);

-- =============================================================================
-- Create LangGraph checkpoint tables in aiq_checkpoints database
-- These must exist before backends connect. Previously left to the app,
-- but if postgres restarts without a backend restart, the tables are lost
-- and running backends crash with "relation checkpoints does not exist".
-- =============================================================================
\connect aiq_checkpoints

CREATE TABLE IF NOT EXISTS checkpoint_migrations (
    v INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint JSONB NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

CREATE TABLE IF NOT EXISTS checkpoint_blobs (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL,
    version TEXT NOT NULL,
    type TEXT NOT NULL,
    blob BYTEA,
    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
);

CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    blob BYTEA NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);
