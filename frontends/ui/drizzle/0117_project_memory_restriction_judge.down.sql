-- Reverse 0117. ORDER: roll the frontend back first; the newer build writes
-- `restriction_judge` with every judged restricted note.
--
-- Lossy: the panel stops saying which notes a model helped restrict. Each
-- verdict is still in the audit trail (`project.memory.restriction_judged`).
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restriction_judge_check";
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "restriction_judge";
