-- Platform-controlled reasoning effort ("thinking level") per agent group.
--
-- How hard a role thinks was a build-time fact: `reasoning_effort` in the
-- workflow YAML (`configs/config_oib_openrouter.yml`), so retuning the
-- cost/quality trade-off meant a commit and a backend redeploy. It is now an
-- admin decision taken at runtime under Platform → Models, alongside the model
-- itself — the two levers that decide what a turn costs and how good it is now
-- sit on the same screen.
--
-- Global, NOT tenant-scoped (no organization_id) — mirroring
-- `platform_model_defaults` (ADR-0014) and `platform_retrieval_settings`
-- (0029). Effort is a fleet-wide quality/cost trade-off, and unlike the model
-- there is deliberately NO org layer: a tenant choosing its own model is a
-- product feature, a tenant dialling its own reasoning spend is not.
--
-- A missing row means "use the workflow YAML value for that role", so deleting
-- a row hands the group back to the config file. That is why this is a separate
-- table rather than a column on `platform_model_defaults`: `model` there is NOT
-- NULL, so a shared row would force an owner to pin a model in order to change
-- the thinking level, and to pin a thinking level in order to change the model.
CREATE TABLE IF NOT EXISTS "platform_reasoning_efforts" (
  -- Agent group id, e.g. 'deep_research'. Not an enum: the registry is code,
  -- and an id retired there must not need a migration to disappear from here.
  "agent_group" text PRIMARY KEY NOT NULL,
  -- OpenRouter's UNIFIED effort vocabulary, passed through verbatim:
  -- none | minimal | low | medium | high | xhigh. Never a provider-native tier
  -- name (DeepSeek's "max") — OpenRouter rejects those. It maps the requested
  -- level to the nearest one the effective model supports, server-side, so this
  -- value stays valid when the group's model changes underneath it.
  "effort" text NOT NULL,
  -- Optional change note from the owner ("cheaper deep research for the pilot").
  "note" text,
  "updated_by" text NOT NULL,
  "updated_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
