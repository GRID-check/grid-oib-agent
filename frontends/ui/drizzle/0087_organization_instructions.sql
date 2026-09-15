-- 0087: organization_instructions — one standing instruction block per tenant.
--
-- ## Why
--
-- Forcing a skill onto a turn is gone in both of its forms: the platform's
-- `delivery: 'standard'` tier (0088) and the composer's `skills` array on the
-- WS envelope. Neither was a good home for "how this office wants Piloti to
-- work": the first was the PLATFORM's instruction wearing a tenant-shaped
-- switch, the second was a per-message choice standing in for a standing
-- preference, re-made (or forgotten) on every send.
--
-- A standing preference is a property of the ORGANIZATION. This table is that
-- property: one bounded text an org admin writes once, sent to the backend on
-- every turn as `X-Grid-Org-Instructions` (base64url, the encoding
-- `X-Grid-Project-Context` already uses because Node rejects `\n` in a header
-- value).
--
-- ## Why a table rather than a key in `organizations.settings`
--
-- The jsonb bag holds the other tenant-chosen settings (`webSearchEnabled`,
-- `zdrOnly`, ADR-0022) and would have fitted the shape of this one. Three
-- things it cannot hold:
--
--   * THE BOUND. 1500 characters is a cost and a safety property of every
--     turn, not a preference, so it is stated in SQL where it survives a
--     backfill, a psql session and a writer that never read the TypeScript.
--     The backend caps at the same number; a CHECK is what stops the two from
--     ever being discovered to disagree in production.
--   * ATTRIBUTION. `updated_by` answers "who told the agent to do that" — the
--     first question anybody asks of an instruction that shaped an answer. The
--     bag carries one `updated_at` for every key in it together.
--   * ITS OWN READ. This value sits on the WS-upgrade hot path, so it wants its
--     own cache entry and its own invalidation rather than sharing both with
--     everything else in the bag.
--
-- ## No row means no instructions
--
-- Clearing the text DELETES the row (`@/lib/org-instructions/service`), so
-- "never written" and "written, then emptied" are one state and not two. The
-- CHECK forbids the empty string for the same reason: a row that says nothing
-- is a row that would encode a header carrying nothing.
--
-- ## RLS
--
-- Tenant data keyed directly by the organization, secured exactly as
-- `organizations` (0031) and `curated_skill_activations` (0046) are. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "organization_instructions" (
  "organization_id" text PRIMARY KEY NOT NULL,
  "instructions" text NOT NULL,
  "updated_by" text NOT NULL,
  "updated_by_email" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The bound the backend also enforces (1500 characters). Stated on
  -- `char_length`, not `octet_length`: the cap the editor counts down from is
  -- characters, and an umlaut must not cost two of them.
  CONSTRAINT "organization_instructions_length"
    CHECK (char_length("instructions") <= 1500),
  -- An empty block is the absence of a block. The service deletes the row
  -- instead of writing one; this is the layer that holds when something else
  -- tries.
  CONSTRAINT "organization_instructions_not_blank"
    CHECK (btrim("instructions") <> '')
);
--> statement-breakpoint
COMMENT ON TABLE "organization_instructions" IS
  'One standing instruction block per organization, written by an org:settings:manage holder and sent to the agent on every turn as X-Grid-Org-Instructions. Standing preferences on form, focus and workflow only: it never overrides Piloti''s own rules and never supplies a normative value.';
--> statement-breakpoint
SELECT grid_secure_table('organization_instructions', 'organization_id = grid_current_org()');
