-- Platform-controlled retrieval counts (Platform → Retrieval).
--
-- The counts every retrieval tool fetches/caps (knowledge_search top_k and
-- per-document diversity cap, the surface_documents card counts, the Tavily
-- web-search result counts, the RIS search/catalog counts) used to be
-- literals in the workflow YAML or hard-coded tool constants — changing them
-- meant a code edit and a backend redeploy. They are now admin decisions
-- taken at runtime: the platform owner edits them here and the backend picks
-- them up via GET /api/internal/retrieval-settings (TTL-cached, fail-open).
--
-- Global, NOT tenant-scoped (no organization_id) — mirroring
-- `platform_model_defaults`. Retrieval depth is a fleet-wide quality/cost
-- trade-off, not a tenant preference.
--
-- One row per catalog key (`lib/retrieval-settings/catalog.ts` /
-- `_BOUNDS` in src/aiq_agent/common/retrieval_settings.py). A missing row
-- means "use the boot default", so deleting a row returns that count to the
-- YAML/tool-constant value; values are catalog-validated before write.
CREATE TABLE IF NOT EXISTS "platform_retrieval_settings" (
  -- Catalog setting key, e.g. 'knowledge.top_k'. Not an enum: the catalog is
  -- code, and a key retired there must not need a migration to disappear here.
  "key" text PRIMARY KEY NOT NULL,
  -- The chosen count (whole chunks/results), catalog-validated before write.
  "value" integer NOT NULL,
  -- Optional change note from the owner ("deeper knowledge hits for pilot").
  "note" text,
  "updated_by" text NOT NULL,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
