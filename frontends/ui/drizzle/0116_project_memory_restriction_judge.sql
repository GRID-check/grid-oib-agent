-- 0116: a restricted note says when a language model helped decide who may
-- read it (ADR-0084; AI Act transparency).
--
-- When a chat could list a restricted folder it did not read, the memory judge
-- decides whether a note draws on it. Its verdict was audited
-- (`project.memory.restriction_judged`) but not kept with the note, so the
-- Projektspeicher's lock could not tell a reader whether a read or the judge
-- put its folders there.
--
-- `restriction_judge` is the verdict (`drawn`, `none`, `failed`), set when the
-- note is written. Only on a RESTRICTED note: an open note is shown to people
-- who may not know a restricted folder exists, and a marker on it would tell
-- them the chat could list one. The open verdicts stay in the audit trail.
-- Existing rows stay NULL: whether the judge was asked for them is unknown.
ALTER TABLE "project_memory" ADD COLUMN IF NOT EXISTS "restriction_judge" text;
--> statement-breakpoint
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restriction_judge_check";
--> statement-breakpoint
ALTER TABLE "project_memory"
  ADD CONSTRAINT "project_memory_restriction_judge_check" CHECK (
    "restriction_judge" IS NULL
    OR (
      "restriction_judge" IN ('drawn', 'none', 'failed')
      AND "restricted_folder_ids" IS NOT NULL
    )
  );
