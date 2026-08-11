-- Reverse 0044: conversations forget which job produced them.
--
-- A clean inverse — 0044 only ADDED things, so removing them puts the table
-- back exactly as 0043 left it.
--
-- ## What is lost
--
-- The provenance itself. After this, a conversation a job produced is
-- indistinguishable from one a person started: it keeps its title, its
-- messages, its project visibility and its owner (the job's owner, who never
-- typed in it), and it reappears in that owner's personal chat history because
-- the column the client filters on is gone. That is unavoidable and it is not
-- data loss in the dangerous sense — `job_runs.conversation_id` still records
-- which run landed where, so the link survives in the direction 0043 built it.
--
-- Dropping in the reverse order of creation: index, then constraint, then
-- column. `DROP COLUMN` would take both dependents with it anyway; naming them
-- keeps the rollback honest about everything it removes.
DROP INDEX IF EXISTS "conversations_job_id_idx";
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_job_id_fkey";
--> statement-breakpoint
-- The column comment goes with the column; no separate `COMMENT ... IS NULL`
-- is needed (unlike 0043's comments, which were placed on columns that survive
-- its rollback).
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "job_id";
