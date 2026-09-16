-- Reverse 0088: widen `delivery` back to two values and restore the index.
--
-- Lossy in exactly the way 0050's own down-migration is: WHICH rows were
-- `standard` is not recorded anywhere after the forward migration maps them to
-- `offer`, so nothing here can put them back. The tier exists again; the fleet
-- runs nothing under it until a platform owner re-promotes a row by hand.

ALTER TABLE "platform_skills"
  DROP CONSTRAINT IF EXISTS "platform_skills_delivery_check";
--> statement-breakpoint
ALTER TABLE "platform_skills"
  ADD CONSTRAINT "platform_skills_delivery_check"
  CHECK ("delivery" IN ('offer', 'standard'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_skills_standard"
  ON "platform_skills" ("name")
  WHERE "delivery" = 'standard' AND "published";
--> statement-breakpoint
COMMENT ON COLUMN "platform_skills"."delivery" IS
  'offer = listed on every org Skills tab, off until that org switches it on. standard = resolved for every org, never listed, not switchable, not shadowable by an org row. See docs/architecture/agent-skills.md.';
