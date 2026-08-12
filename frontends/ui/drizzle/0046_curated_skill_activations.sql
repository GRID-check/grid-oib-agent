-- An organization's decision about a platform-CURATED skill: on, or off.
--
-- Platform skills are files, not rows (they ship under
-- src/aiq_agent/skills/builtin/<collection>/ and reach the BFF through the
-- generated @/lib/skills/platform-skills module). Two kinds, and only one of
-- them concerns this table:
--
--   internal   The deep-research pipeline's own machinery — how it computes a
--              table, how it writes a report. Never listed, never switchable,
--              always resolved. This is every builtin shipping today, and it
--              is the DEFAULT: a skill that says nothing is machinery.
--
--   curated    A capability published TO organizations (metadata
--              `grid-catalog: curated`). Offered on the Skills tab and off
--              until the organization switches it on. That is this table.
--
-- No row means the default, and for a curated skill the default is OFF: the
-- platform sends it down, the organization decides whether to run it.
--
-- Deliberately not a `skills` row with enabled = false: a skills row carries a
-- body, and a body is a copy that drifts from the file it came from the first
-- time the skill is improved. That was the flaw in the "clone a platform
-- skill" flow this replaces. Only the decision is stored here.
CREATE TABLE IF NOT EXISTS "curated_skill_activations" (
  "organization_id" text NOT NULL,
  -- The platform skill's `name`. Text, not a foreign key: the referent is a
  -- file in the repository, not a row. A decision about a skill that no longer
  -- ships is inert, and survives if that skill ever comes back.
  "skill_name" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "updated_by" text NOT NULL,
  "updated_by_email" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "curated_skill_activations_pkey" PRIMARY KEY ("organization_id","skill_name")
);
--> statement-breakpoint
-- The read path is "every decision this org has made", served on skill
-- resolution. The primary key's leading column already serves it; this index
-- makes the org-wide scan explicit for offboarding deletes.
CREATE INDEX IF NOT EXISTS "idx_curated_skill_activations_organization_id"
  ON "curated_skill_activations"("organization_id");

-- ---------------------------------------------------------------------------
-- The tenant boundary (ADR-0041) — grid_secure_table() was defined by 0031 and
-- stays installed; each new table joins the boundary in the migration that
-- creates it, or it is unreadable for the runtime role.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
SELECT grid_secure_table('curated_skill_activations', 'organization_id = grid_current_org()');
