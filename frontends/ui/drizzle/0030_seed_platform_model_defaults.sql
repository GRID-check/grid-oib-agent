-- Seed the fleet-wide default model, so the DATABASE — not the workflow YAML —
-- is what decides which model an organization runs on.
--
-- 0026 created `platform_model_defaults` but seeded nothing, which left the
-- three-layer resolution (org override → platform default → YAML `model_name`)
-- resolving through an EMPTY middle layer on every deployment where the owner
-- had not yet visited Platform → Models. The fleet then silently ran on
-- whatever literal happened to sit in `configs/config_oib_openrouter.yml` — a
-- model nobody ever declared as a decision, invisible in the admin surface and
-- absent from the audit trail. That is the defect this migration closes: the
-- middle layer is now populated from the start, so the YAML is a boot floor for
-- a BFF-less/dev process and nothing more.
--
-- ONLY seeds a table that is entirely empty. The `WHERE NOT EXISTS` guard is
-- deliberately table-level rather than per-row: a deployment where the platform
-- owner has already pinned even ONE group has an opinion of its own, and this
-- migration must not add six more rows underneath it. Re-running is a no-op.
--
-- `model_snapshot` stays NULL — it is catalog metadata captured at save time
-- (context length, pricing, `_zdr.safe`) and a migration has no catalog access.
-- Consequence: the admin UI cannot say whether the seeded model has a
-- Zero-Data-Retention endpoint until the first real save fills it in. Audit-only
-- data, never re-applied at runtime, so nothing about resolution depends on it.
--
-- `openai/gpt-5.6-luna` satisfies every group's capability gate in
-- `lib/model-config/agent-groups.ts`: it advertises `tools` (clarifier,
-- shallow_research, deep_research), carries a 1.05M context (deep_research
-- requires 131072), accepts image input (ingest_vlm), and is not a
-- reasoning-mandatory family, so `intent` — which runs `reasoning_effort: none`
-- — cannot trip the OpenRouter 400 that `isReasoningSafeForOff` guards against.
INSERT INTO "platform_model_defaults" ("agent_group", "model", "note", "updated_by", "updated_by_email")
SELECT
  seed."agent_group",
  'openai/gpt-5.6-luna',
  'Seeded default (migration 0030) — change under Platform → Models.',
  -- Sentinel actor, not a WorkOS user id: these rows were written by a
  -- migration, and the rollback below uses it to delete exactly what was
  -- seeded without touching a default an owner has since saved over.
  'system:migration-0030',
  NULL
FROM (
  VALUES
    ('intent'),
    ('clarifier'),
    ('shallow_research'),
    ('deep_research'),
    ('deep_research_router'),
    ('memory_reflection'),
    ('ingest_vlm')
) AS seed("agent_group")
WHERE NOT EXISTS (SELECT 1 FROM "platform_model_defaults");
