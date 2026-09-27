-- Reverse 0093: legal holds go back to being read by the purger alone.
--
-- ORDER against a deployed purger matters: `purger/db.js` calls
-- `grid_legal_hold_blocks` from its claim query, so roll the purger back to the
-- previous image BEFORE running this, or every claim fails with "function does
-- not exist" and nothing is purged until it is. The BFF's own check
-- (`lib/compliance/holds.ts`) calls it too and would answer 500 on every delete.
--
-- No data changes shape here; dropping the triggers only removes the backstop.

DROP TRIGGER IF EXISTS "conversations_legal_hold_guard" ON "conversations";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_legal_hold_guard" ON "documents";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_refuse_held_delete();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_legal_hold_blocks(text, text, text);
--> statement-breakpoint
DROP INDEX IF EXISTS "legal_holds_org_active_idx";
