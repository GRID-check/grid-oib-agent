-- Reverse 0148: a held document's reason lives in its error message again.
--
-- Lossy for nothing a build before 0148 reads: the job still writes the
-- `quarantined:` message beside the typed verdict, and the backfill left
-- `error_message` as it was, so every held row still carries its reason
-- there. What is lost is the verdict of a row whose message an earlier build
-- never wrote, and the count of reasons a decision left out.
ALTER TABLE "document_quarantine_decisions" DROP CONSTRAINT IF EXISTS "document_quarantine_decisions_reasons_omitted_check";
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions" DROP COLUMN IF EXISTS "reasons_omitted";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_quarantine_held_check";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_quarantine_shape_check";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "quarantine";
