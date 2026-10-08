-- Reverse 0120. The repository's status writers keep their own guard; only a
-- writer outside them could move a quarantined row on again.
DROP TRIGGER IF EXISTS "documents_hold_quarantine" ON "documents";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_documents_hold_quarantine();
