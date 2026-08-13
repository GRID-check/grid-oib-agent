-- Reverse 0049: every curated skill becomes an offer again.
--
-- Dropping the column does NOT restore the pre-0049 fleet, and the difference
-- matters when reading a rollback plan. A published `delivery = 'standard'` row
-- was resolving for every organization with no activation row behind it; after
-- this migration it is an ordinary published offer, which means it appears on
-- every org's Skills tab and runs for NOBODY until each one switches it on.
--
-- So the rollback is safe in the sense that nothing breaks and no instruction is
-- destroyed — the bodies stay, the rows stay, the offers keep working — and
-- lossy in the sense that the fleet stops running whatever the standard skills
-- were saying. Withdraw those rows (`published = false`) before rolling back if
-- an offer nobody has taken up is not what you want them to become.
--
-- Re-applying 0049 does not bring them back either: the column is recreated with
-- the 'offer' default, so which rows were standard is not recorded anywhere
-- after this runs.
DROP INDEX IF EXISTS "idx_platform_skills_standard";
--> statement-breakpoint
ALTER TABLE "platform_skills"
  DROP CONSTRAINT IF EXISTS "platform_skills_delivery_check";
--> statement-breakpoint
ALTER TABLE "platform_skills" DROP COLUMN IF EXISTS "delivery";
