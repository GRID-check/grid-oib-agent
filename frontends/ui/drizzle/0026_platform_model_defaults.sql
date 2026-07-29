-- Platform-controlled default model per agent group (ADR-0014, extended).
--
-- Before this table the default model for every agent group lived in the
-- workflow YAML (`configs/config_oib_openrouter.yml`, `llms:` → `model_name`),
-- so switching the fleet to a newer model meant editing a file and redeploying
-- the backend. It is now an admin decision taken at runtime: the platform owner
-- picks the default here and EVERY organization that has not chosen its own
-- model for that group follows on its next turn.
--
-- Global, NOT tenant-scoped (no organization_id) — mirroring
-- `platform_workflow_templates` (ADR-0016/0027). A tenant's own choice still
-- lives in `org_model_config_versions` and always wins; this table is the layer
-- underneath it. The YAML `model_name` survives only as the boot fallback for
-- when no row exists here (fresh install) or the BFF is unreachable.
--
-- One row per agent group (`lib/model-config/agent-groups.ts` /
-- `AgentGroup` in src/aiq_agent/common/model_overrides.py). Deleting a row
-- returns that group to the YAML default.
CREATE TABLE IF NOT EXISTS "platform_model_defaults" (
  -- Agent group id, e.g. 'shallow_research'. Not an enum: the registry is code,
  -- and an id retired there must not need a migration to disappear from here.
  "agent_group" text PRIMARY KEY NOT NULL,
  -- The chosen model id (OpenRouter `author/slug`), catalog-validated against
  -- the group's capability requirements before it is written.
  "model" text NOT NULL,
  -- Catalog metadata at save time (context length, pricing, supported
  -- parameters) plus `_zdr.safe` — whether the model has a Zero-Data-Retention
  -- endpoint, so ZDR tenants inheriting this default can be warned. Pure audit,
  -- never re-applied.
  "model_snapshot" jsonb,
  -- Optional change note from the owner ("switched the fleet to v4.1").
  "note" text,
  "updated_by" text NOT NULL,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
