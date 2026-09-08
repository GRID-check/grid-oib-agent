-- Down for 0081. Deliberately NOT in `meta/_journal.json` — drizzle never
-- applies a `.down.sql`; it is the hand-run rollback companion.
--
-- What is lost: the DISTINCTION, not the rows. Dropping the column puts every
-- office conversation back to being recognisable only by its NULL project_id,
-- which is the pre-0081 ambiguity and the reason the column exists. The
-- conversations themselves survive and stay readable; the Büro surface is
-- behind the `workspace-chat` flag, so with the flag off the product behaves
-- exactly as it did before the feature (spec MG-4, NF-8).
--
-- Order matters: the constraints reference the column, so they go first.
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_scope_matches_project";--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_scope_known";--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_org_scope_updated_idx";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "scope";
