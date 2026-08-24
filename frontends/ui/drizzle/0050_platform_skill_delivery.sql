-- A curated skill can be an OFFER or the fleet's STANDARD equipment.
--
-- ## The gap this closes
--
-- `platform_skills` (0047) gave the platform owner one channel into every
-- tenant, and that channel is an OFFER: the row is published, it appears on
-- every organization's Skills tab, and it runs only for the orgs that switched
-- it on (`curated_skill_activations`). Which is the right shape for a
-- capability — a tenant that does not want it should not have it.
--
-- It is the wrong shape for the other thing a platform owner writes: the house
-- instruction every organization is supposed to be running and none of them
-- should have to know about, let alone maintain a decision on. There was no way
-- to say that. The only always-on tier was `src/aiq_agent/skills/builtin/**` —
-- FILES, which means a code review and a deploy, and which are the deep-research
-- pipeline's own machinery rather than a place to put fleet policy.
--
-- `delivery` is that missing sentence, and it is deliberately a property of the
-- ROW rather than a second table: the document is identical either way (same
-- agentskills.io contract, same editor, same reviewer), and only its audience
-- differs. Two tables would have forked the write path to record one word.
--
--   'offer'     What 0047 shipped, and the default. Listed on every org's
--               Skills tab, OFF until that org switches it on.
--   'standard'  Fleet standard equipment. Resolved for EVERY organization with
--               no activation row and no decision to make, never listed on the
--               Skills tab, not switchable, and not shadowable by an org row of
--               the same name. Written, published and withdrawn by the platform
--               owner alone.
--
-- ## Why the default is 'offer'
--
-- Same reason `grid-catalog` defaults to machinery on the file tier and
-- `published` defaults to false here: the closed default is the one where a row
-- that says nothing about itself cannot surprise a tenant. Backfilling every
-- existing row to 'offer' preserves exactly the behaviour those rows have
-- today — nothing about the fleet changes when this migration runs.
--
-- Note the asymmetry with `published`, and that it is intentional. `published`
-- is closed in the sense of "invisible"; 'offer' is closed in the sense of
-- "requires consent". A published 'standard' row is the only combination that
-- imposes anything, and it takes two deliberate acts to reach.
--
-- ## Locks
--
-- `ADD COLUMN ... DEFAULT` is catalog-only in Postgres 11+ (the default is
-- stored in `pg_attribute` and materialised on read), so NOT NULL with a default
-- needs no rewrite and no scan. `platform_skills` is a small catalogue in any
-- case — an ACCESS EXCLUSIVE lock held for a catalog update is not a concern
-- here, but the property is worth stating because it is why the column can be
-- NOT NULL from the start rather than added nullable and tightened later.
--
-- ## RLS
--
-- Untouched. `platform_skills` was secured by `grid_secure_platform_table` in
-- 0047 — every tenant reads it, only the platform role writes it — and a new
-- column on a secured table stays inside that boundary. Which is also what makes
-- 'standard' enforceable rather than a convention: a tenant cannot write this
-- column, so a tenant cannot demote a standard skill into something it may
-- switch off.
ALTER TABLE "platform_skills"
  ADD COLUMN IF NOT EXISTS "delivery" text DEFAULT 'offer' NOT NULL;
--> statement-breakpoint

-- Two values, and the database is where that is said.
--
-- The BFF validates it at the write boundary too (`platformSkillDeliverySchema`),
-- but this is the constraint that survives a bad migration, a psql session and a
-- future writer. An unrecognised value here would not fail closed on its own:
-- the resolver asks `delivery = 'standard'`, so a typo would silently demote a
-- fleet instruction to an offer nobody was told to switch on.
ALTER TABLE "platform_skills"
  DROP CONSTRAINT IF EXISTS "platform_skills_delivery_check";
--> statement-breakpoint
ALTER TABLE "platform_skills"
  ADD CONSTRAINT "platform_skills_delivery_check"
  CHECK ("delivery" IN ('offer', 'standard'));
--> statement-breakpoint

-- The resolver's hot read: "every published standard skill", asked once per
-- org-skill resolution for every organization on the platform (behind the
-- 60s backend cache, but still the query that runs on a cache miss for a tenant
-- that has no skills of its own at all). Partial, because the rows it excludes
-- are the overwhelming majority of what a mature catalogue holds — drafts and
-- offers — and none of them can ever satisfy this predicate.
CREATE INDEX IF NOT EXISTS "idx_platform_skills_standard"
  ON "platform_skills" ("name")
  WHERE "delivery" = 'standard' AND "published";
--> statement-breakpoint

COMMENT ON COLUMN "platform_skills"."delivery" IS
  'offer = listed on every org Skills tab, off until that org switches it on. standard = resolved for every org, never listed, not switchable, not shadowable by an org row. See docs/architecture/agent-skills.md.';
