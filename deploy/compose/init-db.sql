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
-- Runtime login for the row-level-security roles (ADR-0041)
-- =============================================================================
-- The roles themselves, their grants and the policies are created by drizzle
-- migration 0030 — it owns the boundary so that any database the migrations
-- have run against has it. All this adds is a LOGIN password for the runtime
-- role, because a password is a deployment secret and does not belong in a
-- migration checked into git.
--
-- The dev default below is exactly that: a DEV default, matching `aiq_dev`
-- alongside it, for a compose stack on a laptop. Real deployments set
-- GRID_APP_RUNTIME_PASSWORD (see deploy/.env.example) and Kubernetes takes it
-- from the Pulumi secret instead.
--
-- Ordering note: this runs on every start and the migration may not have run
-- yet on a brand-new volume, so the role is created here if absent. Migration
-- 0030 is written to adopt an existing role rather than fail.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'grid_app_rw') THEN
    CREATE ROLE grid_app_rw LOGIN NOINHERIT PASSWORD 'grid_app_rw_dev';  -- pragma: allowlist secret (dev default; real deployments set GRID_APP_RUNTIME_PASSWORD)
  ELSE
    ALTER ROLE grid_app_rw LOGIN PASSWORD 'grid_app_rw_dev';  -- pragma: allowlist secret (dev default; real deployments set GRID_APP_RUNTIME_PASSWORD)
  END IF;
END
$$;

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
