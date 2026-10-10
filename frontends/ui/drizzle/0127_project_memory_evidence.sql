-- 0127: project_memory.evidence — the documents a memory item was read from.
--
-- A decision the closing extraction drafts from a project's own documents
-- (docs/design/closed-project-experience.md) is stored as `distillation` with
-- `verification: source_grounded`. Its evidence is the list of documents and
-- pages it was read from, shown as „aus den Unterlagen erschlossen (Datei,
-- S. n)". Only the file name and the page are kept: the quotes stay in the
-- extraction, so a memory row never carries document text beyond its own
-- content.
--
-- NULL for every other item, which is all rows written before this migration
-- and every item a person or the agent writes by hand. The CHECK keeps the
-- column an array when it is set, so a reader can iterate it without a guard.
ALTER TABLE "project_memory" ADD COLUMN IF NOT EXISTS "evidence" jsonb;
--> statement-breakpoint
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_evidence_check";
--> statement-breakpoint
ALTER TABLE "project_memory"
  ADD CONSTRAINT "project_memory_evidence_check" CHECK (
    "evidence" IS NULL OR jsonb_typeof("evidence") = 'array'
  );
