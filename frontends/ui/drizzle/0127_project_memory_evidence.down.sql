-- Reverse 0127: no evidence on memory items.
--
-- Lossy, and deliberately so: the column holds only file names and pages that
-- the documents still carry, and an older build has no reader for it, so a
-- stale copy would only mislead.
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_evidence_check";
--> statement-breakpoint
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "evidence";
